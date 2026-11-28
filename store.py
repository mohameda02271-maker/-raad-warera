"""JSON files with an asyncio lock and atomic writes (write to a temp file, then replace)."""
import asyncio
import json
import os
from pathlib import Path
from typing import Any, Callable

_locks: dict[str, asyncio.Lock] = {}


def _lock(path: Path) -> asyncio.Lock:
    key = str(path)
    if key not in _locks:
        _locks[key] = asyncio.Lock()
    return _locks[key]


def read(path: str | Path, default: Any) -> Any:
    p = Path(path)
    if not p.exists():
        return default
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default
    return data if isinstance(data, type(default)) else default


def write_atomic(path: str | Path, data: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


async def update(path: str | Path, default: Any, fn: Callable[[Any], Any]) -> Any:
    """Read, let fn change the data in place (or return a new value), write back, all under one lock.
    Returns whatever fn returns."""
    p = Path(path)
    async with _lock(p):
        data = read(p, default)
        result = fn(data)
        write_atomic(p, data)
        return result
