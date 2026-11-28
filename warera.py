import asyncio
import json
import re
import time
from types import SimpleNamespace
import aiohttp

_API_KEY = None
BASE_URL = "https://api2.warera.io"

def set_api_key(api_key: str) -> None:
    global _API_KEY
    _API_KEY = api_key

def get_api_key():
    return _API_KEY

class _SafeObj(SimpleNamespace):
    def __getattr__(self, name):
        return None

def _clean_err(text: str) -> str:
    return text.strip().replace("\n", " ")[:220]

def _unwrap(payload):
    if isinstance(payload, dict):
        res = payload.get("result")
        if isinstance(res, dict):
            data = res.get("data")
            if isinstance(data, dict) and "json" in data:
                return data["json"]
            if data is not None:
                return data
        for key in ("data", "json", "user", "player", "mu", "country"):
            if isinstance(payload.get(key), dict):
                return payload[key]
    return payload

def _to_obj(data):
    data = _unwrap(data)
    if isinstance(data, dict):
        return _SafeObj(**{k: _to_obj(v) for k, v in data.items()})
    if isinstance(data, list):
        return [_to_obj(x) for x in data]
    return data

def _headers():
    h = {"Accept": "application/json"}
    if _API_KEY:
        h["Authorization"] = f"Bearer {_API_KEY}"
        h["X-API-Key"] = _API_KEY
    return h

# --- rate limit handling + short cache -------------------------------------------------
CACHE_TTL = 60.0          # seconds a successful answer is reused
MAX_CONCURRENCY = 5       # simultaneous requests to the API
MAX_RETRIES_429 = 4
_cache: dict[tuple, tuple[float, object]] = {}
_sem: asyncio.Semaphore | None = None


def _semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(MAX_CONCURRENCY)
    return _sem


def clear_cache() -> None:
    _cache.clear()


async def _get_json(session, path: str, payload: dict, headers: dict, use_cache: bool = True):
    """GET a tRPC path. Returns parsed JSON, retries on HTTP 429 with backoff.
    Raises RuntimeError with the status text on other errors."""
    key = (path, json.dumps(payload, sort_keys=True))
    if use_cache:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_TTL:
            return hit[1]
    last = ""
    for attempt in range(MAX_RETRIES_429 + 1):
        async with _semaphore():
            async with session.get(
                f"{BASE_URL}{path}", params={"input": json.dumps(payload)}, headers=headers
            ) as resp:
                text = await resp.text()
                status = resp.status
                retry_after = resp.headers.get("Retry-After")
                if status < 400:
                    data = json.loads(text) if text else {}
                    if use_cache:
                        _cache[key] = (time.monotonic(), data)
                    return data
        last = f"GET {path} -> {status}: {_clean_err(text)}"
        if status == 429 and attempt < MAX_RETRIES_429:
            try:
                wait = float(retry_after) if retry_after else 0.0
            except ValueError:
                wait = 0.0
            await asyncio.sleep(min(max(wait, 2.0 * (attempt + 1)), 30.0))
            continue
        break
    raise RuntimeError(last)


async def call(proc: str, payload: dict | None = None, use_cache: bool = True):
    """Generic tRPC read, e.g. call("battle.getBattles", {"isActive": True, "limit": 100}).
    Returns the unwrapped data as plain Python (dict/list), not an object."""
    async with aiohttp.ClientSession() as session:
        raw = await _get_json(session, f"/trpc/{proc}", payload or {}, _headers(), use_cache)
    return _unwrap_plain(raw)


def _unwrap_plain(raw):
    if isinstance(raw, dict):
        res = raw.get("result")
        if isinstance(res, dict) and "data" in res:
            data = res["data"]
            if isinstance(data, dict) and "json" in data:
                return data["json"]
            return data
    return raw


async def _call_trpc_get(paths: list[str], entity_id: str, id_keys: list[str]):
    eid = str(entity_id).strip()
    headers = _headers()
    last_err = "Unknown error"
    async with aiohttp.ClientSession() as session:
        for path in paths:
            for key in id_keys:
                try:
                    raw = await _get_json(session, path, {key: eid}, headers)
                    return _to_obj(raw)
                except Exception as e:
                    last_err = f"{e} [{key}]"
    raise RuntimeError(last_err)


def _extract_user_id(raw, query_lower: str) -> str | None:
    d = _unwrap(raw)
    if isinstance(d, dict):
        for k in ("_id", "id", "userId"):
            if isinstance(d.get(k), str) and d[k]:
                return d[k]
        user_ids = d.get("userIds")
        if isinstance(user_ids, list) and user_ids:
            first = user_ids[0]
            if isinstance(first, str):
                return first
            if isinstance(first, dict):
                return first.get("_id") or first.get("id") or first.get("userId")
        for list_key in ("users", "items", "results"):
            arr = d.get(list_key)
            if isinstance(arr, list) and arr:
                for item in arr:
                    if isinstance(item, dict) and str(item.get("username", "")).lower() == query_lower:
                        return item.get("_id") or item.get("id") or item.get("userId")
                first = arr[0]
                if isinstance(first, str):
                    return first
                if isinstance(first, dict):
                    return first.get("_id") or first.get("id") or first.get("userId")
    elif isinstance(d, list) and d:
        for item in d:
            if isinstance(item, dict) and str(item.get("username", "")).lower() == query_lower:
                return item.get("_id") or item.get("id") or item.get("userId")
        first = d[0]
        if isinstance(first, str):
            return first
        if isinstance(first, dict):
            return first.get("_id") or first.get("id") or first.get("userId")
    return None

async def _search_user_id(query: str) -> str:
    q = query.strip()
    q_low = q.lower()
    headers = _headers()
    candidates = [
        ("/trpc/search.searchAnything", {"searchText": q}),
        ("/trpc/user.getUserByUsername", {"username": q}),
        ("/trpc/user.searchUsers", {"searchText": q}),
        ("/trpc/user.search", {"query": q}),
    ]
    last_err = f"Player '{q}' not found."
    async with aiohttp.ClientSession() as session:
        for path, payload in candidates:
            try:
                raw = await _get_json(session, path, payload, headers)
                uid = _extract_user_id(raw, q_low)
                if uid:
                    return uid
                last_err = f"Player '{q}' not found."
            except Exception as e:
                last_err = str(e)
    raise RuntimeError(last_err)

class _EndpointClient:
    def __init__(self, paths: list[str], id_keys: list[str]):
        self.paths = paths
        self.id_keys = id_keys

    async def get_by_id(self, entity_id: str):
        return await _call_trpc_get(self.paths, entity_id, self.id_keys)

class _UserClient(_EndpointClient):
    async def get_by_query(self, query: str):
        q = str(query).strip()
        if re.fullmatch(r"[0-9a-fA-F]{24}", q):
            return await self.get_by_id(q)
        uid = await _search_user_id(q)
        return await self.get_by_id(uid)

user = _UserClient(["/trpc/user.getUserById", "/trpc/user.getUserLite"], ["userId"])
mu = _EndpointClient(["/trpc/mu.getById"], ["muId"])
country = _EndpointClient(["/trpc/country.getCountryById"], ["countryId"])
