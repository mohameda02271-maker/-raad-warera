import re
from typing import Any
from pathlib import Path
from typing import Optional
import json
import os
from datetime import datetime, timezone
import discord
from discord import app_commands
from discord.ext import commands, tasks
import asyncio
import config
import perms
import store
import warera

REMINDERS_FILE = "reminders.json"


def _fmt_num(n: float | int) -> str:
    n = float(n or 0)
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.2f}B"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return f"{int(n):,}"


def _parse_iso(iso_str: str | None) -> datetime | None:
    if not iso_str:
        return None
    try:
        dt = datetime.fromisoformat(str(iso_str).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _to_discord_ts(iso_str: str | None) -> str:
    if not iso_str:
        return ""
    dt = _parse_iso(iso_str)
    if dt:
        ts = int(dt.timestamp())
        return f"<t:{ts}:R> (<t:{ts}:t>)"
    return f"`{str(iso_str)[:16].replace('T', ' ')} UTC`"


def _fmt_exact_num(val) -> str:
    if isinstance(val, int):
        return f"{val:,}"
    if isinstance(val, float):
        s = f"{val:,.1f}"
        if s.endswith(".0"):
            s = s[:-2]
        return s
    return str(val)


def _extract_bar_pair(obj):
    if obj is None:
        return None, None
    if isinstance(obj, dict):
        cur = obj.get("currentBarValue", obj.get("current", obj.get("cur")))
        mx = obj.get("value", obj.get("max", obj.get("total")))
        return cur, mx
    cur = getattr(obj, "currentBarValue", None)
    if cur is None:
        cur = getattr(obj, "current", None)
    if cur is None:
        cur = getattr(obj, "cur", None)
    mx = getattr(obj, "value", None)
    if mx is None:
        mx = getattr(obj, "max", None)
    if mx is None:
        mx = getattr(obj, "total", None)
    return cur, mx


async def _resolve_name(raw_val, fetcher) -> str:
    if not raw_val:
        return "None"
    if not isinstance(raw_val, str):
        name = getattr(raw_val, "name", None) or getattr(raw_val, "title", None)
        if name:
            return str(name)
        raw_val = getattr(raw_val, "id", None) or getattr(raw_val, "_id", None) or str(raw_val)
    try:
        obj = await fetcher(raw_val)
        if obj:
            name = getattr(obj, "name", None) or getattr(obj, "title", None)
            if name:
                return str(name)
    except Exception:
        pass
    return str(raw_val)


def _get_skill_level(skill_obj) -> float:
    if skill_obj is None:
        return 0.0
    if isinstance(skill_obj, dict):
        val = skill_obj.get("level", 0)
        return float(val) if isinstance(val, (int, float)) else 0.0
    val = getattr(skill_obj, "level", 0)
    return float(val) if isinstance(val, (int, float)) else 0.0


def _is_eco_player(skills_obj, user_obj) -> bool:
    """Compare war skill levels vs eco skill levels to classify eco vs war player."""
    if skills_obj is None:
        return True

    def _get(name: str):
        if isinstance(skills_obj, dict):
            return skills_obj.get(name)
        return getattr(skills_obj, name, None)

    war_keys = ("attack", "armor", "dodge", "precision", "criticalChance", "criticalDamages")
    eco_keys = ("companies", "production", "management", "energy")

    war_level = sum(_get_skill_level(_get(k)) for k in war_keys)
    eco_level = sum(_get_skill_level(_get(k)) for k in eco_keys)

    # Pure eco when war skill levels are 0, or eco levels outweigh/equal war levels
    if war_level <= 0:
        return True
    return eco_level >= war_level


def _fmt_bar(skill_obj, kind: str = "health") -> str:
    cur, mx = _extract_bar_pair(skill_obj)
    icon = "💚" if kind == "health" else "🍽️"
    if isinstance(cur, (int, float)) and isinstance(mx, (int, float)) and mx > 0:
        pct = max(0, min(100, int(round((cur / mx) * 100))))
        return f"{icon} **{_fmt_exact_num(cur)} / {_fmt_exact_num(mx)}** `({pct}%)`"
    if isinstance(cur, (int, float)):
        return f"{icon} **{_fmt_exact_num(cur)}**"
    if isinstance(mx, (int, float)):
        return f"{icon} **{_fmt_exact_num(mx)}**"
    return "Hidden"

def _load_reminders() -> list[dict]:
    return store.read(REMINDERS_FILE, [])


LINKS_FILE = Path("data/linked_players.json")
PREV_WARRIOR_FILE = Path("data/weekly_warrior_history.json")
ECO_ROLE_NAMES = ("🌱 Eco Farmer", "Eco Farmer", "eco")
WAR_ROLE_NAMES = ("⚔️ War Fighter", "War Fighter", "war")
GREAT_WARRIOR_ROLE_NAMES = ("👑 Great Warrior", "Great Warrior")
PREV_WARRIOR_ROLE_NAMES = ("🏅 Former Champion", "Former Champion")
TARGET_MU_NAME = "kemet-core"


def _load_links() -> dict[str, dict[str, Any]]:
    return store.read(LINKS_FILE, {})


async def _update_links(fn):
    """Change the links file under a lock. fn gets the dict and edits it in place."""
    return await store.update(LINKS_FILE, {}, fn)


def _find_linked_member_id(game_username: str, game_user_id: Any = None) -> int | None:
    links = _load_links()
    uname_l = (game_username or "").strip().lower()
    uid_s = str(game_user_id).strip() if game_user_id is not None else ""
    for discord_id_str, info in links.items():
        if not isinstance(info, dict):
            continue
        linked_uname = str(info.get("game_username") or "").strip().lower()
        linked_uid = str(info.get("game_user_id") or "").strip()
        if (uname_l and linked_uname == uname_l) or (uid_s and linked_uid and linked_uid == uid_s):
            try:
                return int(discord_id_str)
            except ValueError:
                return None
    return None


def _find_role(guild: discord.Guild, candidates: tuple[str, ...]) -> discord.Role | None:
    lowered = {c.strip().lower() for c in candidates}
    for role in guild.roles:
        if role.name.strip().lower() in lowered:
            return role
    return None


async def _get_or_create_role(
    guild: discord.Guild,
    candidates: tuple[str, ...],
    color: discord.Color,
    changes: list[str],
    reason: str,
) -> discord.Role | None:
    existing = _find_role(guild, candidates)
    if existing:
        return existing

    me = guild.me
    if me is None or not me.guild_permissions.manage_roles:
        changes.append(f"⚠️ البوت يحتاج صلاحية Manage Roles لإنشاء رول ({candidates[0]})")
        return None

    try:
        created = await guild.create_role(
            name=candidates[0],
            color=color,
            reason=reason,
        )
        changes.append(f"✨ تم إنشاء رول {created.name}")
        return created
    except discord.Forbidden:
        changes.append(f"⚠️ لا توجد صلاحية كافية لإنشاء رول ({candidates[0]})")
        return None
    except Exception as e:
        changes.append(f"⚠️ تعذر إنشاء رول ({candidates[0]}): {e}")
        return None


def _get_weekly_damage(user_obj) -> float:
    rankings = getattr(user_obj, "rankings", None)
    weekly = (
        getattr(rankings, "weeklyUserDamages", None)
        or getattr(rankings, "userWeeklyDamages", None)
    ) if rankings else None
    val = getattr(weekly, "value", 0) if weekly else 0
    return float(val) if isinstance(val, (int, float)) else 0.0


async def _is_top_kemet_core_weekly(user_obj, mu_name: str, mu_raw: Any) -> bool:
    is_kemet = (mu_name or "").strip().lower() == TARGET_MU_NAME
    if not is_kemet and mu_raw is not None:
        resolved = await _resolve_name(mu_raw, warera.mu.get_by_id)
        is_kemet = (resolved or "").strip().lower() == TARGET_MU_NAME
    if not is_kemet:
        return False

    target_uid = getattr(user_obj, "id", None) or getattr(user_obj, "_id", None)
    target_uname = (getattr(user_obj, "username", None) or "").strip().lower()
    target_dmg = _get_weekly_damage(user_obj)

    mu_obj = None
    for fn_name in ("get_by_id", "get_by_query", "get"):
        fn = getattr(warera.mu, fn_name, None)
        if callable(fn) and mu_raw is not None:
            try:
                mu_obj = await fn(mu_raw)
                if mu_obj:
                    break
            except Exception:
                continue

    members_raw = []
    if mu_obj is not None:
        for attr in ("members", "users", "memberIds", "userIds"):
            val = getattr(mu_obj, attr, None)
            if isinstance(val, (list, tuple)) and val:
                members_raw = list(val)
                break

    if not members_raw:
        return True

    max_dmg = target_dmg
    for m in members_raw:
        member_obj = m
        if isinstance(m, (str, int)):
            for fn_name in ("get_by_id", "get_by_query"):
                fn = getattr(warera.user, fn_name, None)
                if callable(fn):
                    try:
                        member_obj = await fn(m)
                        break
                    except Exception:
                        member_obj = None
        if member_obj is None:
            continue
        m_uid = getattr(member_obj, "id", None) or getattr(member_obj, "_id", None)
        m_uname = (getattr(member_obj, "username", None) or "").strip().lower()
        if (target_uid is not None and m_uid == target_uid) or (target_uname and m_uname == target_uname):
            continue
        m_dmg = _get_weekly_damage(member_obj)
        if m_dmg > max_dmg:
            return False

    return True


def _load_prev_warrior_history() -> dict[str, Any]:
    if not PREV_WARRIOR_FILE.exists():
        return {"previous_champions": []}
    data = store.read(PREV_WARRIOR_FILE, {})
    champs = data.get("previous_champions")
    return {"previous_champions": list(champs) if isinstance(champs, list) else []}


def _save_prev_warrior_history(history: dict[str, Any]) -> None:
    store.write_atomic(PREV_WARRIOR_FILE, history)


def _record_previous_champion(user_obj) -> None:
    uid = str(getattr(user_obj, "id", None) or getattr(user_obj, "_id", None) or "").strip()
    uname = str(getattr(user_obj, "username", None) or "").strip().lower()
    history = _load_prev_warrior_history()
    champs = history["previous_champions"]
    exists = any(
        (uid and str(c.get("id") or "").strip() == uid)
        or (uname and str(c.get("username") or "").strip().lower() == uname)
        for c in champs
        if isinstance(c, dict)
    )
    if not exists and (uid or uname):
        champs.append({"id": uid, "username": uname})
        _save_prev_warrior_history(history)


def _is_previous_champion(user_obj) -> bool:
    uid = str(getattr(user_obj, "id", None) or getattr(user_obj, "_id", None) or "").strip()
    uname = str(getattr(user_obj, "username", None) or "").strip().lower()
    history = _load_prev_warrior_history()
    for c in history["previous_champions"]:
        if not isinstance(c, dict):
            continue
        if (uid and str(c.get("id") or "").strip() == uid) or (
            uname and str(c.get("username") or "").strip().lower() == uname
        ):
            return True
    return False


async def _resolve_guild_member(guild: Optional[discord.Guild], user_id: Optional[int]) -> Optional[discord.Member]:
    if guild is None or user_id is None:
        return None
    member = guild.get_member(user_id)
    if member is not None:
        return member
    try:
        return await guild.fetch_member(user_id)
    except Exception:
        return None


def _apply_style_prefix_to_nick(current_nick: str, is_eco: bool) -> str:
    prefix = "🌱 " if is_eco else "⚔️ "
    cleaned = re.sub(r"^(?:[🌱⚔️]\s*)+", "", current_nick.strip())
    base_name = cleaned or current_nick.strip()
    new_nick = f"{prefix}{base_name}"
    return new_nick[:32]


def _format_style_nick(game_name: str | None, fallback_name: str, is_eco: bool) -> str:
    badge = "🌱" if is_eco else "⚔️"
    source_name = (game_name or "").strip() or (fallback_name or "").strip() or "Player"
    cleaned = re.sub(r"^(?:[🌱⚔️👑🏅]\s*)+", "", source_name).strip()
    core = cleaned or source_name
    return f"{badge} {core}"[:32]


async def _assign_mu_role(
    guild: Optional[discord.Guild],
    member: Optional[discord.Member],
    mu_name: Optional[str],
    mu_raw: Any,
) -> list[str]:
    notes: list[str] = []
    if guild is None or member is None:
        return notes

    clean_name = (mu_name or "").strip()
    if not clean_name and mu_raw not in (None, "", False):
        clean_name = f"MU-{mu_raw}".strip()
    if not clean_name:
        return notes

    role_label = clean_name if clean_name.lower().startswith("mu") else f"MU: {clean_name}"
    role_label = role_label[:100]

    me = guild.me
    can_manage = bool(me and getattr(getattr(me, "guild_permissions", None), "manage_roles", False))
    top_pos = getattr(getattr(me, "top_role", None), "position", 0) if me else 0

    target_role = discord.utils.find(
        lambda r: r.name.lower() == role_label.lower() or r.name.lower() == clean_name.lower(),
        guild.roles,
    )

    if target_role is None:
        if not can_manage:
            notes.append(f"⚠️ Missing Manage Roles to create `{role_label}`")
            return notes
        try:
            target_role = await guild.create_role(name=role_label, reason="Auto MU role assignment")
            notes.append(f"➕ Created role `{target_role.name}`")
        except discord.Forbidden:
            notes.append(f"⚠️ Forbidden creating role `{role_label}`")
            return notes
        except Exception as exc:
            notes.append(f"⚠️ Error creating role `{role_label}`: {exc}")
            return notes

    if not can_manage or target_role.position >= top_pos:
        notes.append(f"⚠️ Role `{target_role.name}` is above bot or Manage Roles missing")
        return notes

    # إزالة أي رتبة وحدة سابقة مختلفة عن رتبة الوحدة الحالية
    old_mu_roles = [
        r for r in member.roles
        if r.id != target_role.id
        and r != guild.default_role
        and r.position < top_pos
        and (r.name.lower().startswith("mu:") or r.name.lower().startswith("mu "))
    ]
    if old_mu_roles:
        try:
            await member.remove_roles(*old_mu_roles, reason="Update MU role")
        except discord.Forbidden:
            notes.append(f"⚠️ Forbidden removing old MU role for `{member.display_name}`")

    if target_role not in member.roles:
        try:
            await member.add_roles(target_role, reason="Assign MU role")
            notes.append(f"🛡️ Assigned `{target_role.name}`")
        except discord.Forbidden:
            notes.append(f"⚠️ Forbidden assigning `{target_role.name}`")
        except Exception as exc:
            notes.append(f"⚠️ Error assigning `{target_role.name}`: {exc}")

    return notes


async def _sync_member_roles(
    guild: Optional[discord.Guild],
    member: Optional[discord.Member],
    user_obj,
    is_eco: bool,
    mu_name: str,
    mu_raw: Any,
) -> list[str]:
    if guild is None or member is None:
        return []

    changes: list[str] = []
    eco_role = await _get_or_create_role(
        guild, ECO_ROLE_NAMES, discord.Color.green(), changes, "Auto-create Eco role"
    )
    war_role = await _get_or_create_role(
        guild, WAR_ROLE_NAMES, discord.Color.red(), changes, "Auto-create War role"
    )
    warrior_role = await _get_or_create_role(
        guild, GREAT_WARRIOR_ROLE_NAMES, discord.Color.gold(), changes, "Auto-create Great Warrior role"
    )

    desired_style_role = eco_role if is_eco else war_role
    other_style_role = war_role if is_eco else eco_role

    try:
        if other_style_role and other_style_role in member.roles:
            await member.remove_roles(other_style_role, reason="Updated playstyle role")
            changes.append(f"➖ {other_style_role.name}")
        if desired_style_role and desired_style_role not in member.roles:
            await member.add_roles(desired_style_role, reason="Updated playstyle role")
            changes.append(f"➕ {desired_style_role.name}")

        raw_name = member.nick or member.display_name or member.name
        new_nick = _format_style_nick(None, raw_name, is_eco)
        if member.nick != new_nick:
            try:
                await member.edit(nick=new_nick, reason="Add playstyle badge to nickname")
                changes.append(f"🏷️ {new_nick}")
            except discord.Forbidden:
                changes.append("⚠️ تعذر تغيير الاسم (تحقق من Manage Nicknames ورتبة العضو/المالك)")

        prev_warrior_role = await _get_or_create_role(
            guild, PREV_WARRIOR_ROLE_NAMES, discord.Color.orange(), changes, "Auto-create Previous Champion role"
        )
        is_top_warrior = await _is_top_kemet_core_weekly(user_obj, mu_name, mu_raw)
        if is_top_warrior:
            if warrior_role and warrior_role not in member.roles:
                await member.add_roles(warrior_role, reason="Top weekly damage in kemet-core")
                changes.append(f"👑 {warrior_role.name}")
            if prev_warrior_role and prev_warrior_role in member.roles:
                await member.remove_roles(prev_warrior_role, reason="Currently #1 weekly damage in kemet-core")
                changes.append(f"➖ {prev_warrior_role.name}")
        else:
            if warrior_role and warrior_role in member.roles:
                await member.remove_roles(warrior_role, reason="No longer top weekly damage in kemet-core")
                changes.append(f"➖ {warrior_role.name}")
                _record_previous_champion(user_obj)
            if prev_warrior_role and _is_previous_champion(user_obj) and prev_warrior_role not in member.roles:
                await member.add_roles(prev_warrior_role, reason="Former top weekly damage in kemet-core")
                changes.append(f"🏅 {prev_warrior_role.name}")
    except discord.Forbidden:
        changes.append("⚠️ تأكد من صلاحية Manage Roles ورفع رتبة البوت فوق الرولات")
    except Exception as e:
        changes.append(f"⚠️ {type(e).__name__}: {e}")

    mu_notes = await _assign_mu_role(guild, member, mu_name, mu_raw)
    if mu_notes:
        changes.extend(mu_notes)
    return changes


PILL_GROUP_SECONDS = 120  # reminders ending within this window of each other go out as one message


def _link_key(info: dict, disc_id: str = "") -> str:
    """Best lookup key for a linked player: the game user id (direct, cacheable) first."""
    return str(
        info.get("game_user_id")
        or info.get("game_username")
        or info.get("username")
        or info.get("user_id")
        or disc_id
    )


async def _fetch_user_safe(query: str):
    try:
        return await warera.user.get_by_query(query)
    except Exception:
        return None


async def _fetch_links_users(links: dict) -> dict[str, Any]:
    """Fetch every linked player concurrently (warera.py caps parallel requests and retries on 429)."""
    async def one(disc_id: str, info: dict):
        return disc_id, await _fetch_user_safe(_link_key(info, disc_id))

    pairs = await asyncio.gather(*(one(k, v) for k, v in links.items() if isinstance(v, dict)))
    return dict(pairs)


def _weekly_row(u, fallback_name: str):
    name = getattr(u, "username", None) or fallback_name
    rankings = getattr(u, "rankings", None)
    weekly = (
        getattr(rankings, "weeklyUserDamages", None)
        or getattr(rankings, "userWeeklyDamages", None)
    ) if rankings else None
    wk_dmg = float(getattr(weekly, "value", 0) or _get_weekly_damage(u) or 0)
    wk_rank = getattr(weekly, "rank", None)
    total = getattr(rankings, "userDamages", None) if rankings else None
    tot_dmg = float(getattr(total, "value", 0) or 0)
    rank_str = f"#{int(wk_rank):,}" if isinstance(wk_rank, (int, float)) else "—"
    return (wk_dmg, tot_dmg, name, rank_str)


async def collect_weekly_rows(links: dict) -> list[tuple]:
    users = await _fetch_links_users(links)
    rows = []
    for disc_id, info in links.items():
        u = users.get(disc_id)
        if u:
            rows.append(_weekly_row(u, _link_key(info, disc_id)))
    rows.sort(key=lambda r: (r[0], r[1]), reverse=True)
    return rows


def _pill_debuff_end(u) -> datetime | None:
    """End time of the player's pill debuff, or None when there is no active debuff."""
    buffs = getattr(u, "buffs", None)
    if not buffs:
        return None
    codes = getattr(buffs, "debuffCodes", None) or []
    end = _parse_iso(getattr(buffs, "debuffEndAt", None))
    if codes and end and end.timestamp() > datetime.now(timezone.utc).timestamp():
        return end
    return None


async def _strip_member_roles(guild: Optional[discord.Guild], member: Optional[discord.Member]) -> list[str]:
    """Remove the Eco/War/Great Warrior/Former Champion and MU roles the bot hands out."""
    if guild is None or member is None:
        return []
    names = {
        n.strip().lower()
        for group in (ECO_ROLE_NAMES, WAR_ROLE_NAMES, GREAT_WARRIOR_ROLE_NAMES, PREV_WARRIOR_ROLE_NAMES)
        for n in group
    }
    me = guild.me
    top_pos = getattr(getattr(me, "top_role", None), "position", 0) if me else 0
    targets = [
        r for r in member.roles
        if r != guild.default_role
        and (r.name.strip().lower() in names or r.name.lower().startswith(("mu:", "mu ")))
    ]
    removable = [r for r in targets if r.position < top_pos]
    notes: list[str] = []
    if removable:
        try:
            await member.remove_roles(*removable, reason="Unlinked from WarEra")
            notes.extend(f"➖ {r.name}" for r in removable)
        except discord.Forbidden:
            notes.append("⚠️ ما قدرتش أشيل الرولات (Manage Roles أو ترتيب رتبة البوت)")
    skipped = [r for r in targets if r.position >= top_pos]
    if skipped:
        notes.append("⚠️ رولات فوق رتبة البوت: " + ", ".join(r.name for r in skipped))
    return notes


class PlayerCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def cog_load(self):
        self.check_reminders.start()

    async def cog_unload(self):
        self.check_reminders.cancel()

    @tasks.loop(seconds=30)
    async def check_reminders(self):
        if not _load_reminders():
            return
        now_ts = int(datetime.now(timezone.utc).timestamp())

        def take_ready(reminders: list) -> list[list[dict]]:
            """Pull out finished reminders. Reminders for one channel that end within
            PILL_GROUP_SECONDS of each other are sent as ONE message, once the last of them is done."""
            groups: list[list[dict]] = []
            by_channel: dict[int, list[dict]] = {}
            for r in reminders:
                by_channel.setdefault(r.get("channel_id"), []).append(r)
            for items in by_channel.values():
                items.sort(key=lambda r: r.get("end_ts", 0))
                while items:
                    first = items[0].get("end_ts", 0)
                    group = [r for r in items if r.get("end_ts", 0) <= first + PILL_GROUP_SECONDS]
                    if now_ts < max(r.get("end_ts", 0) for r in group):
                        break
                    groups.append(group)
                    items = [r for r in items if r not in group]
            ready_ids = {id(r) for g in groups for r in g}
            reminders[:] = [r for r in reminders if id(r) not in ready_ids]
            return groups

        groups = await store.update(REMINDERS_FILE, [], take_ready)
        for group in groups:
            await self._send_pill_group(group)

    async def _send_pill_group(self, group: list[dict]) -> None:
        channel_id = group[0].get("channel_id")
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(channel_id)
            except Exception:
                return
        lines = [f"<@{r['discord_user_id']}> — **{r['username']}**" for r in group]
        embed = discord.Embed(
            title="💊 Pill Debuff Ended!",
            description="جاهزين لحبة جديدة:\n" + "\n".join(lines),
            color=discord.Color.green(),
        )
        mentions = discord.AllowedMentions(users=True)
        try:
            await channel.send(
                content=" ".join(f"<@{r['discord_user_id']}>" for r in group),
                embed=embed,
                allowed_mentions=mentions,
            )
        except Exception:
            pass

    @check_reminders.before_loop
    async def before_check_reminders(self):
        await self.bot.wait_until_ready()

    @app_commands.command(name="player", description="Show player stats & sync roles (defaults to your linked account)")
    @app_commands.describe(player="Player Username or User ID (optional if linked)")
    async def player(self, interaction: discord.Interaction, player: Optional[str] = None):
        await interaction.response.defer()
        try:
            links = _load_links()
            linked_entry = links.get(str(interaction.user.id))
            query = (player or "").strip()
            if not query:
                if linked_entry and linked_entry.get("game_username"):
                    query = str(linked_entry["game_username"])
                else:
                    await interaction.followup.send(
                        "❌ اكتب اسم اللاعب أو اربط حسابك أولاً باستخدام `/link <username>`."
                    )
                    return

            u = await warera.user.get_by_query(query)

            username = getattr(u, "username", None) or "Unknown"
            avatar = getattr(u, "avatarUrl", None)

            mu_raw = getattr(u, "mu", None) or getattr(u, "muId", None)
            country_raw = getattr(u, "country", None) or getattr(u, "countryId", None)
            mu_name = await _resolve_name(mu_raw, warera.mu.get_by_id)
            country_name = await _resolve_name(country_raw, warera.country.get_by_id)

            rankings = getattr(u, "rankings", None)
            weekly = (
                getattr(rankings, "weeklyUserDamages", None)
                or getattr(rankings, "userWeeklyDamages", None)
            ) if rankings else None
            weekly_dmg = getattr(weekly, "value", 0) or 0
            weekly_rank = getattr(weekly, "rank", None)
            weekly_tier = getattr(weekly, "tier", None)

            rank_text = f"#{int(weekly_rank):,}" if isinstance(weekly_rank, (int, float)) else "Unranked"
            if weekly_tier:
                rank_text += f" ({weekly_tier})"

            total = getattr(rankings, "userDamages", None) if rankings else None
            total_dmg = getattr(total, "value", 0) or 0

            skills = getattr(u, "skills", None)
            hp_text = _fmt_bar(getattr(skills, "health", None) if skills else None, "health")
            hg_text = _fmt_bar(getattr(skills, "hunger", None) if skills else None, "hunger")

            buffs = getattr(u, "buffs", None)
            if buffs is None:
                pill_text = "❌ No Pill"
            else:
                buff_codes = getattr(buffs, "buffCodes", None) or []
                debuff_codes = getattr(buffs, "debuffCodes", None) or []
                if buff_codes:
                    pill_text = f"✅ Active ({', '.join(map(str, buff_codes))})"
                    end_ts = _to_discord_ts(getattr(buffs, "buffEndAt", None))
                    if end_ts:
                        pill_text += f"\nEnds: {end_ts}"
                elif debuff_codes:
                    pill_text = f"⚠️ Debuff ({', '.join(map(str, debuff_codes))})"
                    end_ts = _to_discord_ts(getattr(buffs, "debuffEndAt", None))
                    if end_ts:
                        pill_text += f"\nEnds: {end_ts}"
                else:
                    pill_text = "❌ No Pill"

            is_eco = _is_eco_player(skills, u)
            status_line = (
                "مقاطع الحرب ورايح يحلب البقرة • الاخ بيلعب المزرعه السعيده"
                if is_eco
                else "عايش في ميدان المعركة وناسي الدنيا • كيمت كور فرحانه بيك"
            )

            embed = discord.Embed(
                title=f"👤 {username}",
                description=f"**{status_line}**",
                color=discord.Color.gold()
            )
            if avatar:
                embed.set_thumbnail(url=avatar)

            embed.add_field(name="🛡️ MU", value=mu_name, inline=True)
            embed.add_field(name="🌍 Country", value=country_name, inline=True)
            embed.add_field(name="⚔️ Total Damage", value=_fmt_num(total_dmg), inline=True)
            embed.add_field(name="💥 Weekly Damage", value=_fmt_num(weekly_dmg), inline=True)
            embed.add_field(name="🏆 Weekly Rank", value=rank_text, inline=True)
            embed.add_field(name="💊 Pill Status", value=pill_text, inline=False)
            embed.add_field(name="Health", value=hp_text, inline=True)
            embed.add_field(name="Hunger", value=hg_text, inline=True)

            embed.set_footer(text="design & engineer by great-ayyubi")

            target_member: Optional[discord.Member] = None
            if interaction.guild:
                if not player and isinstance(interaction.user, discord.Member):
                    target_member = interaction.user
                else:
                    game_uid = getattr(u, "id", None) or getattr(u, "_id", None)
                    linked_discord_id = _find_linked_member_id(username, game_uid)
                    if linked_discord_id:
                        target_member = await _resolve_guild_member(interaction.guild, linked_discord_id)

            role_changes = await _sync_member_roles(
                interaction.guild, target_member, u, is_eco, mu_name, mu_raw
            )
            if role_changes and target_member:
                embed.add_field(
                    name="🎭 Roles Updated",
                    value=f"{target_member.mention}: " + " • ".join(role_changes),
                    inline=False,
                )

            await interaction.followup.send(embed=embed)
        except Exception as e:
            await interaction.followup.send(f"❌ Error: `{e}`")

    @app_commands.command(name="pill_remind", description="Set a reminder when a player's pill debuff ends")
    @app_commands.describe(
        player="Player Username or User ID",
        member="Discord member to mention (defaults to you)",
        channel="Channel to send the reminder in (defaults to this channel)"
    )
    async def pill_remind(
        self,
        interaction: discord.Interaction,
        player: str,
        member: discord.Member | None = None,
        channel: discord.TextChannel | None = None
    ):
        await interaction.response.defer()
        try:
            if member is not None and member.id != interaction.user.id and not perms.is_owner(interaction):
                await interaction.followup.send(perms.NO_PERMISSION_MSG)
                return
            target_member = member or interaction.user
            target_channel = channel or interaction.channel

            u = await warera.user.get_by_query(player)
            username = getattr(u, "username", None) or player
            buffs = getattr(u, "buffs", None)

            debuff_end_dt = _pill_debuff_end(u)
            if debuff_end_dt:
                end_ts = int(debuff_end_dt.timestamp())
                await self._add_reminder(target_member.id, target_channel.id, username, end_ts)
                embed = discord.Embed(
                    title="⏰ Pill Reminder Set",
                    description=(
                        f"I will mention {target_member.mention} in {target_channel.mention} "
                        f"when **{username}**'s debuff ends:\n<t:{end_ts}:R> (<t:{end_ts}:t>)"
                    ),
                    color=discord.Color.blue()
                )
                await interaction.followup.send(embed=embed)
                return

            debuff_codes = (getattr(buffs, "debuffCodes", None) or []) if buffs else []
            if debuff_codes:
                await interaction.followup.send(f"✅ **{username}**'s debuff has already ended! Ready for a pill.")
                return

            buff_codes = (getattr(buffs, "buffCodes", None) or []) if buffs else []
            buff_end_ts = _to_discord_ts(getattr(buffs, "buffEndAt", None) if buffs else None)
            if buff_codes:
                await interaction.followup.send(
                    f"💊 **{username}** currently has an active pill ({', '.join(map(str, buff_codes))}). "
                    f"It ends {buff_end_ts or 'soon'}. Run `/pill_remind` again once the debuff starts!"
                )
                return

            await interaction.followup.send(f"✅ **{username}** has no active debuff right now. You can take a pill!")
        except Exception as e:
            await interaction.followup.send(f"❌ Error: `{e}`")

    async def _add_reminder(self, discord_user_id: int, channel_id: int, username: str, end_ts: int) -> None:
        def add(reminders: list) -> None:
            reminders[:] = [
                r for r in reminders
                if not (r.get("discord_user_id") == discord_user_id and str(r.get("username", "")).lower() == username.lower())
            ]
            reminders.append({
                "discord_user_id": discord_user_id,
                "channel_id": channel_id,
                "username": username,
                "end_ts": end_ts,
            })

        await store.update(REMINDERS_FILE, [], add)

    @app_commands.command(name="pill_remind_all", description="MU Owner: one pill alert for all linked members whose debuff is running")
    @app_commands.describe(channel="Channel for the alert (defaults to this channel)")
    @perms.owner_only()
    async def pill_remind_all(self, interaction: discord.Interaction, channel: discord.TextChannel | None = None):
        await interaction.response.defer()
        links = {k: v for k, v in _load_links().items() if k.isdigit()}
        if not links:
            await interaction.followup.send("❌ لا توجد حسابات مربوطة بعد.")
            return
        target_channel = channel or interaction.channel
        users = await _fetch_links_users(links)
        queued, waiting = [], []
        for disc_id, info in links.items():
            u = users.get(disc_id)
            name = (getattr(u, "username", None) if u else None) or str(info.get("game_username") or disc_id)
            end = _pill_debuff_end(u) if u else None
            if end:
                await self._add_reminder(int(disc_id), target_channel.id, name, int(end.timestamp()))
                queued.append((end, name))
            else:
                waiting.append(name)
        queued.sort(key=lambda t: t[0])
        embed = discord.Embed(title="⏰ Pill alert (group)", color=discord.Color.blue())
        embed.description = (
            f"هبعت رسالة واحدة في {target_channel.mention} لما الديباف يخلص "
            f"(اللي بيخلصوا خلال {PILL_GROUP_SECONDS // 60} دقايق من بعض بيتجمعوا في رسالة)."
        )
        if queued:
            embed.add_field(
                name=f"Debuff شغال ({len(queued)})",
                value="\n".join(f"**{n}** — <t:{int(e.timestamp())}:R>" for e, n in queued)[:1024],
                inline=False,
            )
        if waiting:
            embed.add_field(name=f"مفيش debuff دلوقتي ({len(waiting)})", value="، ".join(waiting)[:1024], inline=False)
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="link", description="Link your Discord account to your WarEra game profile")
    @app_commands.describe(
        player="Your WarEra Username or User ID",
        member="Discord member to link (MU Owner only)"
    )
    async def link(
        self,
        interaction: discord.Interaction,
        player: str,
        member: Optional[discord.Member] = None,
    ):
        await interaction.response.defer()
        try:
            if member is not None and member.id != interaction.user.id and not perms.is_owner(interaction):
                await interaction.followup.send(perms.NO_PERMISSION_MSG)
                return
            target = member or interaction.user
            u = await warera.user.get_by_query(player)
            username = getattr(u, "username", None) or player
            game_uid = getattr(u, "id", None) or getattr(u, "_id", None)

            def set_link(links: dict) -> None:
                links[str(target.id)] = {"game_username": username, "game_user_id": game_uid}

            await _update_links(set_link)

            mu_raw = getattr(u, "mu", None) or getattr(u, "muId", None)
            mu_name = await _resolve_name(mu_raw, warera.mu.get_by_id)
            skills = getattr(u, "skills", None)
            is_eco = _is_eco_player(skills, u)

            guild_member = await _resolve_guild_member(interaction.guild, target.id)
            role_changes = await _sync_member_roles(
                interaction.guild, guild_member, u, is_eco, mu_name, mu_raw
            )

            msg = f"✅ تم ربط {target.mention} بحساب اللعبة **{username}**."
            if role_changes:
                msg += "\n🎭 **الرولات:** " + " • ".join(role_changes)
            await interaction.followup.send(msg)
        except Exception as e:
            await interaction.followup.send(f"❌ Error: `{e}`")

    @app_commands.command(name="unlink", description="Unlink a Discord account from a WarEra profile")
    @app_commands.describe(member="Discord member to unlink (MU Owner only; defaults to you)")
    async def unlink(self, interaction: discord.Interaction, member: Optional[discord.Member] = None):
        if member is not None and member.id != interaction.user.id and not perms.is_owner(interaction):
            await interaction.response.send_message(perms.NO_PERMISSION_MSG, ephemeral=True)
            return
        await interaction.response.defer()
        target = member or interaction.user

        def drop(links: dict):
            return links.pop(str(target.id), None)

        removed = await _update_links(drop)
        if not removed:
            await interaction.followup.send(f"ℹ️ {target.mention} غير مربوط بأي حساب حالياً.")
            return
        guild_member = await _resolve_guild_member(interaction.guild, target.id)
        notes = await _strip_member_roles(interaction.guild, guild_member)
        msg = f"🔓 تم فك ربط {target.mention} بنجاح."
        if notes:
            msg += "\n🎭 " + " • ".join(notes)
        await interaction.followup.send(msg)

    async def _fetch_user_obj(self, query: str):
        return await _fetch_user_safe(query)

    def _extract_pill_info(self, u) -> str:
        buffs = getattr(u, "buffs", None)
        if not buffs:
            return "❌ No Pill"

        buff_codes = list(getattr(buffs, "buffCodes", None) or [])
        debuff_codes = list(getattr(buffs, "debuffCodes", None) or [])

        ends_val = None
        for attr in (
            "buffEndsAt", "buff_ends_at", "endsAt", "ends_at",
            "expiresAt", "expires_at", "pillEndsAt", "pill_ends_at",
            "debuffEndsAt", "debuff_ends_at",
        ):
            val = getattr(buffs, attr, None) or getattr(u, attr, None)
            if val:
                ends_val = val
                break

        ts = ""
        if ends_val:
            if isinstance(ends_val, datetime):
                ts = _to_discord_ts(ends_val.isoformat())
            elif isinstance(ends_val, (int, float)):
                ts = _to_discord_ts(datetime.fromtimestamp(ends_val).isoformat())
            else:
                ts = _to_discord_ts(str(ends_val))

        if buff_codes:
            codes = ", ".join(map(str, buff_codes))
            return f"✅ {codes}" + (f" ({ts})" if ts else "")
        if debuff_codes:
            codes = ", ".join(map(str, debuff_codes))
            return f"⚠️ Debuff ({codes})" + (f" ({ts})" if ts else "")
        return "❌ No Pill"

    @app_commands.command(name="help", description="Show Kemet-core commands and automatic role/nickname features")
    async def help_cmd(self, interaction: discord.Interaction):
        embed = discord.Embed(
            title="📋 Kemet-core — Commands & Features",
            color=discord.Color.gold(),
            description=(
                "• `/link` — Link your Discord account to your game profile & sync roles\n"
                "• `/player` — View stats (`MU`, damage, rank, pill, health, hunger) & sync roles\n"
                "• `/pill_remind` — Set a reminder for pill / debuff timing\n"
                "• `/pill_remind_all` — MU Owner: one grouped alert for everyone's pill debuff\n"
                "• `/unlink` — Unlink your Discord account from a game profile (removes the bot's roles)\n"
                "• `/mu_roster` — MU Owner readiness sheet (pill, timer, health, hunger)\n"
                "• `/mu_weekly` — MU Owner weekly & total damage leaderboard\n"
                "• `/mu_sync` — MU Owner bulk role/nickname sync & unlinked audit"
            ),
        )
        embed.set_footer(text="design & engineer by great-ayyubi")
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="mu_roster", description="MU Owner: View linked members readiness (pill, health, hunger, style)")
    @perms.owner_only()
    async def mu_roster(self, interaction: discord.Interaction):
        await interaction.response.defer()
        links = _load_links()
        if not links:
            await interaction.followup.send("❌ لا توجد حسابات مربوطة بعد.")
            return

        subset = dict(list(links.items())[:20])
        users = await _fetch_links_users(subset)
        blocks = []
        war_cnt = 0
        eco_cnt = 0

        for disc_id, info in subset.items():
            u = users.get(disc_id)
            member = await _resolve_guild_member(interaction.guild, int(disc_id)) if disc_id.isdigit() else None

            name = getattr(u, "username", None) or (member.display_name if member else _link_key(info, disc_id))
            skills = getattr(u, "skills", None) if u else None
            is_eco = _is_eco_player(skills, u) if u else False
            if is_eco:
                eco_cnt += 1
            else:
                war_cnt += 1

            badge = "🌱" if is_eco else "⚔️"
            hp_text = _fmt_bar(getattr(skills, "health", None) if skills else None, "health") if u else "—"
            hg_text = _fmt_bar(getattr(skills, "hunger", None) if skills else None, "hunger") if u else "—"
            pill_text = self._extract_pill_info(u) if u else "❌ Unknown"

            blocks.append(
                f"{badge} **{name}**\n"
                f"💊 Pill: {pill_text}\n"
                f"❤️ HP: {hp_text}  •  🍖 HG: {hg_text}"
            )

        embed = discord.Embed(
            title="🛡️ MU Readiness Roster",
            color=discord.Color.gold(),
            description="\n\n".join(blocks)[:4000] if blocks else "لا توجد بيانات متاحة.",
        )
        embed.add_field(
            name="Style Breakdown",
            value=f"⚔️ War: **{war_cnt}**  |  🌱 Eco: **{eco_cnt}**",
            inline=False,
        )
        embed.set_footer(text="design & engineer by great-ayyubi")
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="mu_weekly", description="MU Owner: Weekly & total damage leaderboard for linked members")
    @perms.owner_only()
    async def mu_weekly(self, interaction: discord.Interaction):
        await interaction.response.defer()
        links = _load_links()
        if not links:
            await interaction.followup.send("❌ لا توجد حسابات مربوطة بعد.")
            return

        rows = await collect_weekly_rows(links)
        embed = _weekly_embed(rows, "📊 MU Weekly Damage Standings")
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="mu_sync", description="MU Owner: Bulk sync roles/nicknames and audit linked/unlinked members")
    @perms.owner_only()
    async def mu_sync(self, interaction: discord.Interaction):
        await interaction.response.defer()
        links = _load_links()
        synced = 0
        issues = []

        digit_links = {k: v for k, v in links.items() if k.isdigit() and isinstance(v, dict)}
        users = await _fetch_links_users(digit_links)

        for disc_id, info in digit_links.items():
            member = await _resolve_guild_member(interaction.guild, int(disc_id))
            if not member:
                issues.append(f"• ID `{disc_id}`: خارج السيرفر")
                continue

            u = users.get(disc_id)
            try:
                skills_obj = getattr(u, "skills", None) if u else None
                is_eco_val = _is_eco_player(skills_obj, u) if u else False
                mu_raw_val = (getattr(u, "mu", None) or getattr(u, "muId", None)) if u else info.get("mu")
                mu_name_val = await _resolve_name(mu_raw_val, warera.mu.get_by_id) if mu_raw_val else ""
                res = await _sync_member_roles(interaction.guild, member, u, is_eco_val, mu_name_val, mu_raw_val)
                synced += 1
                bad = [x for x in (res or []) if "⚠️" in x]
                if bad:
                    issues.append(f"• {member.display_name}: {bad[0]}")
            except discord.Forbidden:
                issues.append(f"• {member.display_name}: صلاحيات أو ترتيب رتب")
            except Exception as exc:
                issues.append(f"• {member.display_name}: {exc}")

        total_members = len([m for m in interaction.guild.members if not m.bot]) if interaction.guild else 0
        other_members = max(total_members - len(links), 0)

        embed = discord.Embed(
            title="🔄 MU Bulk Sync & MU Roles",
            color=discord.Color.gold(),
            description=(
                f"• الحسابات المربوطة: **{len(links)}**\n"
                f"• تمت مزامنة وحداتهم ورتبهم: **{synced}**\n"
                f"• أعضاء آخرون في السيرفر (غير مربوطين): **{other_members}**"
            ),
        )
        if issues:
            embed.add_field(
                name="Notes",
                value="\n".join(issues[:10]),
                inline=False,
            )
        embed.set_footer(text="design & engineer by great-ayyubi")
        await interaction.followup.send(embed=embed)


def _weekly_embed(rows: list[tuple], title: str) -> discord.Embed:
    lines = [
        f"**{idx}.** {name}\n💥 Weekly: **{_fmt_num(wk)}** • ⚔️ Total: {_fmt_num(tot)} • 🏆 {rk}"
        for idx, (wk, tot, name, rk) in enumerate(rows[:15], start=1)
    ]
    embed = discord.Embed(
        title=title,
        color=discord.Color.gold(),
        description="\n\n".join(lines) if lines else "لا توجد بيانات دمج متاحة.",
    )
    embed.set_footer(text="design & engineer by great-ayyubi")
    return embed


async def setup(bot: commands.Bot):
    await bot.add_cog(PlayerCog(bot))
