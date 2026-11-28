"""Automatic alerts: new battles for the country / MU, and a weekly damage summary."""
import asyncio
from datetime import datetime, timezone
from typing import Any

import discord
from discord.ext import commands, tasks

import config
import store
import warera

STATE_FILE = "data/alerts_state.json"
MAX_STATE = 400


def _ids(items: Any) -> set[str]:
    out: set[str] = set()
    for x in items or []:
        if isinstance(x, str):
            out.add(x)
        elif isinstance(x, dict):
            v = x.get("mu") or x.get("muId") or x.get("_id") or x.get("id")
            if isinstance(v, str):
                out.add(v)
    return out


def battle_matches(battle: dict, country_id: str, mu_id: str) -> tuple[bool, bool]:
    """(involves the country, has orders for the MU)"""
    sides = [battle.get("attacker") or {}, battle.get("defender") or {}]
    is_country = bool(country_id) and any(str(s.get("country")) == country_id for s in sides)
    is_mu = bool(mu_id) and any(mu_id in _ids(s.get("muOrders")) for s in sides)
    return is_country, is_mu


def decide_alerts(state: dict, battles: list[dict], country_id: str, mu_id: str) -> list[tuple[dict, bool, bool]]:
    """Return [(battle, country_alert, mu_alert)] for things not announced yet and update state in place.
    state = {"initialized": bool, "battles": {battle_id: ["c", "m"]}}.
    The first run only records what is already running, so a restart never floods the channel."""
    known: dict[str, list[str]] = state.setdefault("battles", {})
    first_run = not state.get("initialized")
    out = []
    active_ids = set()
    for b in battles:
        bid = str(b.get("_id") or b.get("id") or "")
        if not bid:
            continue
        active_ids.add(bid)
        is_c, is_m = battle_matches(b, country_id, mu_id)
        done = set(known.get(bid, []))
        new_c = is_c and "c" not in done
        new_m = is_m and "m" not in done
        if is_c:
            done.add("c")
        if is_m:
            done.add("m")
        known[bid] = sorted(done)
        if (new_c or new_m) and not first_run:
            out.append((b, new_c, new_m))
    for bid in list(known):
        if bid not in active_ids and len(known) > MAX_STATE:
            known.pop(bid, None)
    state["initialized"] = True
    return out


def week_key(now: datetime) -> str:
    y, w, _ = now.isocalendar()
    return f"{y}-W{w:02d}"


def weekly_due(state: dict, now: datetime, day: int, hour: int) -> bool:
    return now.weekday() == day and now.hour >= hour and state.get("last_weekly") != week_key(now)


class AlertsCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self._mu_id = ""
        self._mu_country = ""
        self._mu_resolved = False

    async def cog_load(self) -> None:
        self.battle_loop.change_interval(seconds=config.battle_poll_seconds())
        self.battle_loop.start()
        self.weekly_loop.start()

    async def cog_unload(self) -> None:
        self.battle_loop.cancel()
        self.weekly_loop.cancel()

    async def _resolve_mu(self) -> None:
        if self._mu_resolved:
            return
        query = config.mu_query()
        try:
            from cogs.mu import _search_mu_ids, _pick_best_mu
            ids = await _search_mu_ids(query)
            if ids:
                mu, _ = await _pick_best_mu(ids)
                self._mu_id = str(getattr(mu, "_id", None) or getattr(mu, "id", None) or ids[0])
                self._mu_country = str(getattr(mu, "country_id", None) or getattr(mu, "countryId", None) or getattr(mu, "country", None) or "")
                self._mu_resolved = True
        except Exception:
            pass  # try again next tick

    async def _channel(self, channel_id: int | None):
        if not channel_id:
            return None
        ch = self.bot.get_channel(channel_id)
        if ch is None:
            try:
                ch = await self.bot.fetch_channel(channel_id)
            except Exception:
                return None
        return ch

    async def _names(self, battle: dict) -> tuple[str, str, str]:
        async def country_name(cid: str) -> str:
            try:
                c = await warera.call("country.getCountryById", {"countryId": cid})
                return str(c.get("name") or cid)
            except Exception:
                return cid

        att = (battle.get("attacker") or {})
        dfn = (battle.get("defender") or {})
        a, d = await asyncio.gather(country_name(str(att.get("country"))), country_name(str(dfn.get("country"))))
        region = ""
        rid = dfn.get("region") or att.get("region")
        if rid:
            try:
                r = await warera.call("region.getById", {"regionId": rid})
                region = str(r.get("name") or "")
            except Exception:
                pass
        return a, d, region

    @tasks.loop(seconds=120)
    async def battle_loop(self) -> None:
        channel_id = config.alert_channel_id()
        if not channel_id:
            return
        await self._resolve_mu()
        country_id = config.country_id() or self._mu_country
        mu_id = self._mu_id
        if not country_id and not mu_id:
            return
        try:
            data = await warera.call("battle.getBattles", {"isActive": True, "limit": 100}, use_cache=False)
        except Exception:
            return
        battles = (data or {}).get("items") if isinstance(data, dict) else None
        if not isinstance(battles, list):
            return

        alerts = await store.update(STATE_FILE, {}, lambda st: decide_alerts(st, battles, country_id, mu_id))
        channel = await self._channel(channel_id)
        if channel is None:
            return
        for battle, new_c, new_m in alerts:
            a, d, region = await self._names(battle)
            reasons = []
            if new_c:
                reasons.append("دولتنا طرف في المعركة")
            if new_m:
                reasons.append("الوحدة عليها أوردر")
            embed = discord.Embed(
                title=f"⚔️ معركة جديدة: {a} ضد {d}",
                description=(f"📍 {region}\n" if region else "") + " • ".join(reasons),
                color=discord.Color.red(),
            )
            try:
                await channel.send(embed=embed)
            except Exception:
                pass

    @battle_loop.before_loop
    async def _before_battle(self) -> None:
        await self.bot.wait_until_ready()

    @tasks.loop(minutes=5)
    async def weekly_loop(self) -> None:
        channel_id = config.weekly_channel_id()
        if not channel_id:
            return
        now = datetime.now(timezone.utc)
        state = store.read(STATE_FILE, {})
        if not weekly_due(state, now, config.weekly_day(), config.weekly_hour()):
            return
        channel = await self._channel(channel_id)
        if channel is None:
            return
        from cogs.player import _load_links, collect_weekly_rows, _weekly_embed
        links = _load_links()
        if not links:
            return
        rows = await collect_weekly_rows(links)
        try:
            await channel.send(embed=_weekly_embed(rows, "📊 ملخص الضرر الأسبوعي"))
        except Exception:
            return

        def mark(st: dict) -> None:
            st["last_weekly"] = week_key(now)

        await store.update(STATE_FILE, {}, mark)

    @weekly_loop.before_loop
    async def _before_weekly(self) -> None:
        await self.bot.wait_until_ready()


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AlertsCog(bot))
