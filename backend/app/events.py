import json
from uuid import uuid4
import redis.asyncio as redis
from fastapi import HTTPException
from .config import settings
from .contracts import Event, MessageOut, TypingPayload, PresencePayload, ReadPayload

r = redis.from_url(settings.redis_url, decode_responses=True)


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
    except redis.RedisError:
        pass  # Durable writes succeed; clients reconcile via polling/reconnect.


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
