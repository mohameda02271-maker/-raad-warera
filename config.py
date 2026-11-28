"""Settings read from environment variables (.env). Read at call time, so edits apply after a restart."""
import os


def _ints(name: str) -> set[int]:
    out: set[int] = set()
    for part in (os.getenv(name) or "").replace(";", ",").split(","):
        part = part.strip()
        if part.isdigit():
            out.add(int(part))
    return out


def _int(name: str, default: int | None = None) -> int | None:
    val = (os.getenv(name) or "").strip()
    return int(val) if val.isdigit() else default


def owner_role_ids() -> set[int]:
    return _ints("OWNER_ROLE_ID")


def owner_user_ids() -> set[int]:
    return _ints("OWNER_USER_ID")


def alert_channel_id() -> int | None:
    return _int("ALERT_CHANNEL_ID")


def weekly_channel_id() -> int | None:
    return _int("WEEKLY_CHANNEL_ID") or alert_channel_id()


def weekly_day() -> int:
    """0 = Monday ... 6 = Sunday (UTC)."""
    d = _int("WEEKLY_DAY", 0)
    return d if d is not None and 0 <= d <= 6 else 0


def weekly_hour() -> int:
    h = _int("WEEKLY_HOUR", 18)
    return h if h is not None and 0 <= h <= 23 else 18


def battle_poll_seconds() -> int:
    return max(60, _int("BATTLE_POLL_SECONDS", 120) or 120)


def country_id() -> str:
    return (os.getenv("COUNTRY_ID") or "").strip()


def mu_query() -> str:
    return (os.getenv("MU_ID") or "KEMET-CORE").strip()
