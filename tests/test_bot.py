import asyncio
import os
import sys
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import config  # noqa: E402
import perms  # noqa: E402
import store  # noqa: E402
import warera  # noqa: E402
from cogs import alerts, player  # noqa: E402


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def tmp_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    for k in ("OWNER_ROLE_ID", "OWNER_USER_ID"):
        monkeypatch.delenv(k, raising=False)
    warera.clear_cache()
    store._locks.clear()
    yield


def fake_interaction(user_id=1, role_ids=(), admin=False, guild=None):
    user = MagicMock()
    user.id = user_id
    user.roles = [SimpleNamespace(id=i) for i in role_ids]
    user.guild_permissions = SimpleNamespace(administrator=admin)
    it = MagicMock()
    it.user = user
    it.guild = guild
    it.response.defer = AsyncMock()
    it.response.send_message = AsyncMock()
    it.response.is_done = MagicMock(return_value=False)
    it.followup.send = AsyncMock()
    return it


# ---------- (1) permissions ----------
def test_owner_by_role_user_admin(monkeypatch):
    assert not perms.is_owner(fake_interaction())
    assert perms.is_owner(fake_interaction(admin=True))
    monkeypatch.setenv("OWNER_ROLE_ID", "55, 66")
    assert perms.is_owner(fake_interaction(role_ids=[66]))
    assert not perms.is_owner(fake_interaction(role_ids=[7]))
    monkeypatch.setenv("OWNER_USER_ID", "42")
    assert perms.is_owner(fake_interaction(user_id=42))


def test_owner_commands_have_check():
    cog = player.PlayerCog(MagicMock())
    cmds = {c.name: c for c in cog.get_app_commands()}
    for name in ("mu_roster", "mu_weekly", "mu_sync", "pill_remind_all"):
        assert cmds[name].checks, name
        assert run(cmds[name].checks[0](fake_interaction())) is False
        assert run(cmds[name].checks[0](fake_interaction(admin=True))) is True


def test_help_defined_once_and_lists_new_commands():
    cog = player.PlayerCog(MagicMock())
    names = [c.name for c in cog.get_app_commands()]
    assert names.count("help") == 1
    assert {"link", "unlink", "player", "pill_remind", "pill_remind_all", "mu_roster", "mu_weekly", "mu_sync"} <= set(names)


def test_link_other_member_denied_for_non_owner():
    cog = player.PlayerCog(MagicMock())
    it = fake_interaction(user_id=1)
    other = MagicMock(); other.id = 2
    run(player.PlayerCog.link.callback(cog, it, "Someone", other))
    it.followup.send.assert_awaited_once_with(perms.NO_PERMISSION_MSG)
    assert store.read("data/linked_players.json", {}) == {}


def test_unlink_other_member_denied_for_non_owner():
    cog = player.PlayerCog(MagicMock())
    store.write_atomic("data/linked_players.json", {"2": {"game_username": "x"}})
    it = fake_interaction(user_id=1)
    other = MagicMock(); other.id = 2
    run(player.PlayerCog.unlink.callback(cog, it, other))
    assert "2" in store.read("data/linked_players.json", {})
    it.response.send_message.assert_awaited_once()


# ---------- (2) link / unlink ----------
def fake_role(name, pos, rid):
    r = MagicMock(); r.name = name; r.position = pos; r.id = rid
    return r


def test_link_self_message_has_single_roles_line(monkeypatch):
    cog = player.PlayerCog(MagicMock())
    u = SimpleNamespace(username="Bob", id="a" * 24, mu=None, skills=None)
    monkeypatch.setattr(warera.user, "get_by_query", AsyncMock(return_value=u))
    monkeypatch.setattr(player, "_sync_member_roles", AsyncMock(return_value=["➕ ⚔️ War Fighter"]))
    monkeypatch.setattr(player, "_resolve_guild_member", AsyncMock(return_value=MagicMock()))
    it = fake_interaction(user_id=9)
    it.user.mention = "<@9>"
    run(player.PlayerCog.link.callback(cog, it, "Bob", None))
    msg = it.followup.send.await_args.args[0]
    assert msg.count("War Fighter") == 1
    assert store.read("data/linked_players.json", {})["9"]["game_username"] == "Bob"


def test_unlink_strips_roles(monkeypatch):
    store.write_atomic("data/linked_players.json", {"9": {"game_username": "Bob"}})
    default = fake_role("@everyone", 0, 1)
    eco, war, mu, other, high = (fake_role("🌱 Eco Farmer", 2, 2), fake_role("⚔️ War Fighter", 3, 3),
                                 fake_role("MU: KEMET", 4, 4), fake_role("Mods", 5, 5), fake_role("MU: High", 50, 6))
    member = MagicMock()
    member.roles = [default, eco, war, mu, other, high]
    member.remove_roles = AsyncMock()
    guild = MagicMock()
    guild.default_role = default
    guild.me.top_role.position = 10
    monkeypatch.setattr(player, "_resolve_guild_member", AsyncMock(return_value=member))
    it = fake_interaction(user_id=9, guild=guild)
    it.user.mention = "<@9>"
    cog = player.PlayerCog(MagicMock())
    run(player.PlayerCog.unlink.callback(cog, it, None))
    removed = set(member.remove_roles.await_args.args)
    assert removed == {eco, war, mu}          # Mods stays, role above the bot is skipped and reported
    assert store.read("data/linked_players.json", {}) == {}
    assert "MU: High" in it.followup.send.await_args.args[0]


# ---------- (3) concurrency, cache, 429, lock ----------
def test_store_concurrent_updates_all_land():
    async def go():
        await asyncio.gather(*(store.update("data/x.json", [], lambda l, i=i: l.append(i)) for i in range(60)))
    run(go())
    assert sorted(store.read("data/x.json", [])) == list(range(60))
    assert not os.path.exists("data/x.json.tmp")


class FakeResp:
    def __init__(self, status, text, headers=None):
        self.status, self._t, self.headers = status, text, headers or {}
    async def text(self): return self._t
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False


class FakeSession:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), 0
    def get(self, url, params=None, headers=None):
        self.calls += 1
        return self.responses.pop(0)


def test_429_retried_then_cached(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    s = FakeSession([FakeResp(429, "slow", {"Retry-After": "1"}), FakeResp(429, "slow"), FakeResp(200, '{"result":{"data":{"a":1}}}')])
    out = run(warera._get_json(s, "/trpc/x", {"k": 1}, {}))
    assert out["result"]["data"]["a"] == 1 and s.calls == 3
    again = run(warera._get_json(s, "/trpc/x", {"k": 1}, {}))      # served from cache
    assert again == out and s.calls == 3


def test_429_gives_up_with_message(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    s = FakeSession([FakeResp(429, "slow")] * 10)
    with pytest.raises(RuntimeError, match="429"):
        run(warera._get_json(s, "/trpc/y", {}, {}))
    assert s.calls == warera.MAX_RETRIES_429 + 1


def test_users_fetched_concurrently(monkeypatch):
    async def slow(q):
        await asyncio.sleep(0.1)
        return SimpleNamespace(username=q)
    monkeypatch.setattr(warera.user, "get_by_query", slow)
    links = {str(i): {"game_user_id": f"id{i}"} for i in range(10)}
    t = time.perf_counter()
    users = run(player._fetch_links_users(links))
    assert len(users) == 10 and time.perf_counter() - t < 0.5     # serial would be 1.0s


def test_weekly_rows_sorted(monkeypatch):
    def mk(name, wk):
        return SimpleNamespace(username=name, rankings=SimpleNamespace(
            weeklyUserDamages=SimpleNamespace(value=wk, rank=1), userDamages=SimpleNamespace(value=5)))
    data = {"a": mk("A", 10), "b": mk("B", 99)}
    monkeypatch.setattr(warera.user, "get_by_query", AsyncMock(side_effect=lambda q: data[q]))
    rows = run(player.collect_weekly_rows({"1": {"game_user_id": "a"}, "2": {"game_user_id": "b"}}))
    assert [r[2] for r in rows] == ["B", "A"]


# ---------- (4) alerts ----------
def battle(bid, att_country="A", def_country="B", mu_orders=()):
    return {"_id": bid, "attacker": {"country": att_country, "muOrders": list(mu_orders)},
            "defender": {"country": def_country, "muOrders": []}}


def test_decide_alerts_first_run_silent_then_new_and_no_repeat():
    st = {}
    assert alerts.decide_alerts(st, [battle("1", "EG")], "EG", "MU1") == []      # seeded, silent
    out = alerts.decide_alerts(st, [battle("1", "EG"), battle("2", "X", "EG")], "EG", "MU1")
    assert [(b["_id"], c, m) for b, c, m in out] == [("2", True, False)]
    assert alerts.decide_alerts(st, [battle("1", "EG"), battle("2", "X", "EG")], "EG", "MU1") == []
    out = alerts.decide_alerts(st, [battle("2", "X", "EG", mu_orders=["MU1"])], "EG", "MU1")   # orders arrive later
    assert [(c, m) for _, c, m in out] == [(False, True)]
    assert alerts.decide_alerts(st, [battle("3", "P", "Q")], "EG", "MU1") == []   # unrelated battle


def test_mu_orders_as_dicts():
    assert alerts.battle_matches(battle("1", mu_orders=[{"mu": "MU1"}]), "", "MU1") == (False, True)


def test_weekly_due_once_per_week():
    mon_19 = datetime(2026, 11, 30, 19, tzinfo=timezone.utc)      # Monday
    assert datetime(2026, 11, 30).weekday() == 0
    st = {}
    assert alerts.weekly_due(st, mon_19, 0, 18)
    assert not alerts.weekly_due(st, mon_19.replace(hour=17), 0, 18)
    st["last_weekly"] = alerts.week_key(mon_19)
    assert not alerts.weekly_due(st, mon_19, 0, 18)
    assert not alerts.weekly_due({}, mon_19.replace(day=1, month=12), 0, 18)   # Tuesday


def test_weekly_loop_posts_and_marks(monkeypatch):
    monkeypatch.setenv("WEEKLY_CHANNEL_ID", "5")
    monkeypatch.setenv("WEEKLY_DAY", str(datetime.now(timezone.utc).weekday()))
    monkeypatch.setenv("WEEKLY_HOUR", "0")
    store.write_atomic("data/linked_players.json", {"1": {"game_user_id": "a"}})
    u = SimpleNamespace(username="A", rankings=SimpleNamespace(
        weeklyUserDamages=SimpleNamespace(value=5, rank=2), userDamages=SimpleNamespace(value=9)))
    monkeypatch.setattr(warera.user, "get_by_query", AsyncMock(return_value=u))
    chan = MagicMock(); chan.send = AsyncMock()
    bot = MagicMock(); bot.get_channel = MagicMock(return_value=chan)
    cog = alerts.AlertsCog.__new__(alerts.AlertsCog); cog.bot = bot
    run(alerts.AlertsCog.weekly_loop.coro(cog)); run(alerts.AlertsCog.weekly_loop.coro(cog))
    assert chan.send.await_count == 1                        # second tick: already posted this week
    assert store.read(alerts.STATE_FILE, {})["last_weekly"]


# ---------- (5) grouped pill alert ----------
def test_pill_reminders_one_message_per_group(monkeypatch):
    now = int(datetime.now(timezone.utc).timestamp())
    store.write_atomic("reminders.json", [
        {"discord_user_id": 1, "channel_id": 7, "username": "A", "end_ts": now - 30},
        {"discord_user_id": 2, "channel_id": 7, "username": "B", "end_ts": now - 10},
        {"discord_user_id": 3, "channel_id": 7, "username": "C", "end_ts": now + 60},    # within the group window, not done yet
        {"discord_user_id": 4, "channel_id": 7, "username": "D", "end_ts": now + 3600},  # much later: separate alert
    ])
    chan = MagicMock(); chan.send = AsyncMock()
    bot = MagicMock(); bot.get_channel = MagicMock(return_value=chan)
    cog = player.PlayerCog.__new__(player.PlayerCog); cog.bot = bot
    run(player.PlayerCog.check_reminders.coro(cog))
    assert chan.send.await_count == 0                      # waits for C so A, B, C go out together
    assert len(store.read("reminders.json", [])) == 4

    data = store.read("reminders.json", [])
    data[2]["end_ts"] = now - 1
    store.write_atomic("reminders.json", data)
    run(player.PlayerCog.check_reminders.coro(cog))
    assert chan.send.await_count == 1
    embed = chan.send.await_args.kwargs["embed"]
    assert all(n in embed.description for n in ("<@1>", "<@2>", "<@3>")) and "<@4>" not in embed.description
    assert [r["username"] for r in store.read("reminders.json", [])] == ["D"]


def test_pill_remind_all_queues_only_active_debuffs(monkeypatch):
    future = datetime.fromtimestamp(time.time() + 600, timezone.utc).isoformat()
    users = {
        "u1": SimpleNamespace(username="A", buffs=SimpleNamespace(debuffCodes=["x"], debuffEndAt=future)),
        "u2": SimpleNamespace(username="B", buffs=None),
    }
    store.write_atomic("data/linked_players.json", {"1": {"game_user_id": "u1"}, "2": {"game_user_id": "u2"}})
    monkeypatch.setattr(warera.user, "get_by_query", AsyncMock(side_effect=lambda q: users[q]))
    cog = player.PlayerCog(MagicMock())
    it = fake_interaction(admin=True)
    chan = MagicMock(); chan.id = 7; chan.mention = "#c"
    run(player.PlayerCog.pill_remind_all.callback(cog, it, chan))
    rem = store.read("reminders.json", [])
    assert [(r["discord_user_id"], r["channel_id"]) for r in rem] == [(1, 7)]


def test_config_defaults(monkeypatch):
    monkeypatch.delenv("ALERT_CHANNEL_ID", raising=False)
    assert config.alert_channel_id() is None and config.weekly_day() == 0 and config.battle_poll_seconds() >= 60


def test_bot_loads_all_cogs_and_commands():
    import discord
    from discord.ext import commands

    async def go():
        bot = commands.Bot(command_prefix="!", intents=discord.Intents.default())
        for ext in ("cogs.mu", "cogs.player", "cogs.alerts"):
            await bot.load_extension(ext)
        return sorted(c.name for c in bot.tree.get_commands())
    names = run(go())
    assert names == sorted(["mu", "link", "unlink", "player", "pill_remind", "pill_remind_all",
                            "help", "mu_roster", "mu_weekly", "mu_sync"])
