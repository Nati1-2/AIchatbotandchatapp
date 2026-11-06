import json, logging, time
from uuid import uuid4
import redis.asyncio as redis
from fastapi import HTTPException
from .config import settings
from .contracts import Event, MessageOut, TypingPayload, PresencePayload, ReadPayload

log = logging.getLogger("relay")

import fakeredis.aioredis as fakeredis


class ResilientRedis:
    """Real Redis when reachable, an in-process fallback only while it is not.

    The fallback keeps a single-instance development server usable without
    Redis, but it cannot fan events out between processes, so it is logged
    loudly. After a failure the remote is retried every RETRY_SECONDS instead
    of being abandoned for the life of the process.
    """

    RETRY_SECONDS = 30

    def __init__(self, remote_url: str):
        self._fallback = fakeredis.FakeRedis(decode_responses=True)
        self._remote = None
        self._down_until = 0.0
        if remote_url:
            try:
                self._remote = redis.from_url(
                    remote_url,
                    decode_responses=True,
                    socket_connect_timeout=2,
                    health_check_interval=30,
                )
            except Exception as e:
                log.error(f"Invalid REDIS_URL ({e}); using in-memory fallback.")

    @property
    def _remote_failed(self) -> bool:
        return self._remote is None or time.monotonic() < self._down_until

    @_remote_failed.setter
    def _remote_failed(self, failed: bool) -> None:
        self._down_until = time.monotonic() + self.RETRY_SECONDS if failed else 0.0

    @property
    def using_fallback(self) -> bool:
        return self._remote_failed

    async def probe(self) -> bool:
        """Check connectivity once at startup and log which store is in use."""
        if self._remote is None:
            log.warning("REDIS_URL not set: events use an in-memory store (single process only).")
            return False
        try:
            await self._remote.ping()
            self._remote_failed = False
            log.info("Connected to Redis.")
            return True
        except Exception as e:
            self._remote_failed = True
            level = log.error if settings.environment == "production" else log.warning
            level(
                f"Redis is unreachable ({e}). Using an in-memory fallback: real-time events "
                "will not reach other processes until Redis is available."
            )
            return False

    def pubsub(self, **kwargs):
        if not self._remote_failed:
            try:
                return self._remote.pubsub(**kwargs)
            except Exception as e:
                log.warning(f"Remote Redis pubsub failed ({e}). Falling back to in-memory store.")
                self._remote_failed = True
        return self._fallback.pubsub(**kwargs)

    async def eval(self, script: str, numkeys: int, *args):
        if not self._remote_failed:
            try:
                return await self._remote.eval(script, numkeys, *args)
            except Exception as e:
                log.warning(f"Remote Redis eval failed ({e}). Falling back to in-memory store.")
                self._remote_failed = True
        if "DEL" in script and len(args) >= 2:
            key, expected = args[0], args[1]
            try:
                current = await self._fallback.get(key)
                if current == expected:
                    await self._fallback.delete(key)
                    return 1
            except Exception:
                pass
            return 0
        elif "INCR" in script and len(args) >= 1:
            key = args[0]
            seconds = args[1] if len(args) > 1 else 60
            try:
                val = await self._fallback.incr(key)
                if val == 1:
                    await self._fallback.expire(key, seconds)
                return val
            except Exception:
                return 1
        return 0

    async def _execute(self, name: str, *args, **kwargs):
        if not self._remote_failed:
            try:
                fn = getattr(self._remote, name)
                return await fn(*args, **kwargs)
            except Exception as e:
                log.warning(f"Remote Redis operation '{name}' failed ({e}). Falling back to in-memory store.")
                self._remote_failed = True
        fn = getattr(self._fallback, name)
        return await fn(*args, **kwargs)

    def __getattr__(self, name: str):
        return lambda *args, **kwargs: self._execute(name, *args, **kwargs)


r = ResilientRedis(settings.redis_url)


async def publish(cid, event_type, payload):
    model = (
        MessageOut
        if event_type
        in ("message.created", "message.updated", "message.deleted", "reaction.updated")
        else {
            "typing.updated": TypingPayload,
            "presence.updated": PresencePayload,
            "conversation.read": ReadPayload,
        }.get(event_type)
    )
    if model:
        payload = model.model_validate(payload).model_dump()
    event = Event(
        event_id=str(uuid4()), type=event_type, conversation_id=cid, payload=payload
    ).model_dump()
    try:
        await r.publish("relay:events", json.dumps(event, default=str))
    except Exception:
        pass


async def limit(key, maximum, seconds):
    try:
        count = await r.eval(
            "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
            1,
            key,
            seconds,
        )
        if int(count) > maximum:
            raise HTTPException(429, "Too many requests. Please try again later.")
    except HTTPException:
        raise
    except Exception:
        pass
