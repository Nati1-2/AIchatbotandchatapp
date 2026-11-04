import json, logging
from uuid import uuid4
import redis.asyncio as redis
from fastapi import HTTPException
from .config import settings
from .contracts import Event, MessageOut, TypingPayload, PresencePayload, ReadPayload

log = logging.getLogger("relay")

import fakeredis.aioredis as fakeredis


class ResilientRedis:
    def __init__(self, remote_url: str):
        self._fallback = fakeredis.FakeRedis(decode_responses=True)
        self._remote = None
        self._remote_failed = False
        if (
            remote_url
            and "localhost:6379" not in remote_url
            and "127.0.0.1:6379" not in remote_url
        ):
            try:
                self._remote = redis.from_url(remote_url, decode_responses=True)
            except Exception:
                self._remote_failed = True
        else:
            self._remote_failed = True

    def pubsub(self, **kwargs):
        if self._remote and not self._remote_failed:
            try:
                return self._remote.pubsub(**kwargs)
            except Exception as e:
                log.warning(f"Remote Redis pubsub failed ({e}). Falling back to in-memory store.")
                self._remote_failed = True
        return self._fallback.pubsub(**kwargs)

    async def eval(self, script: str, numkeys: int, *args):
        if self._remote and not self._remote_failed:
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
        if self._remote and not self._remote_failed:
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
