"""Authenticated browser-to-Gemini Live audio relay.

The browser sends raw 16-bit mono PCM at 16 kHz as binary WebSocket frames.
Gemini audio is returned as raw 16-bit mono PCM at 24 kHz. The provider key
never leaves this server.

Production safeguards:
- a per-user daily budget of live minutes and a maximum session length;
- one active live session per user (a newer tab or device takes over);
- every completed spoken exchange is saved to the AI conversation history;
- Gemini session-resumption handles keep the assistant's memory across
  reconnects, and fresh sessions are seeded with recent conversation history.
"""

import asyncio
import base64
import json
import logging
import time
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from websockets.asyncio.client import connect

from .config import settings
from .db import SessionLocal
from .events import publish, r
from .knowledge import get_relay_system_prompt
from .languages import resolve_language
from .models import Conversation, Membership, Message, Session, now
from .security import aware, digest, same_origin, trusted_origin

router = APIRouter()
log = logging.getLogger("relay.live")

GEMINI_LIVE_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)

# Close codes understood by the browser client (never retried).
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_REPLACED = 4409
CLOSE_LIMIT = 4429

HEARTBEAT_SECONDS = 10
HISTORY_CHARS = 6000
HISTORY_MESSAGES = 20


def _origin_allowed(ws: WebSocket) -> bool:
    origin = (ws.headers.get("origin") or "").rstrip("/")
    return not origin or trusted_origin(origin) or same_origin(origin, ws.headers)


# Low start sensitivity keeps background noise from being "heard" as speech
# (which Gemini would otherwise transcribe as random words, sometimes in another
# language), while high end sensitivity plus a short silence window keeps
# replies fast. Prefix padding preserves the first syllable of each utterance.
REALTIME_INPUT_CONFIG = {
    "automaticActivityDetection": {
        "disabled": False,
        "startOfSpeechSensitivity": "START_SENSITIVITY_LOW",
        "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
        "prefixPaddingMs": 300,
        "silenceDurationMs": 550,
    },
    "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
}


# ---------------------------------------------------------------- helpers


def usage_key(user_id: str) -> str:
    return f"ai:live:secs:{user_id}:{now().strftime('%Y%m%d')}"


def active_key(user_id: str) -> str:
    return f"ai:live:active:{user_id}"


def handle_key(user_id: str, conversation_id: str) -> str:
    return f"ai:live:handle:{user_id}:{conversation_id}"


async def used_seconds(user_id: str) -> int:
    try:
        return int(await r.get(usage_key(user_id)) or 0)
    except Exception:
        return 0


async def add_usage(user_id: str, seconds: float) -> int:
    """Add live seconds to today's budget. One session per user means one writer."""
    total = await used_seconds(user_id) + max(0, round(seconds))
    try:
        await r.set(usage_key(user_id), str(total), ex=2 * 24 * 3600)
    except Exception:
        log.warning("Could not record live voice usage for %s", user_id)
    return total


def setup_message(language: str, handle: str | None) -> dict:
    """The Gemini Live setup frame for a session in ``language``."""
    return {
        "setup": {
            "model": f"models/{settings.ai_live_model}",
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}},
            },
            "systemInstruction": {
                "parts": [{"text": get_relay_system_prompt(is_voice=True, language=language)}]
            },
            "realtimeInputConfig": REALTIME_INPUT_CONFIG,
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "contextWindowCompression": {"slidingWindow": {}},
            "sessionResumption": {"handle": handle} if handle else {},
        }
    }


def history_turns(messages: list[Message]) -> list[dict]:
    """Recent conversation (oldest first) as Gemini turns, within a char budget."""
    turns: list[dict] = []
    size = 0
    for m in reversed(messages):  # newest first, so the budget keeps the latest
        body = (m.body or "").strip()
        if not body or m.deleted:
            continue
        if size + len(body) > HISTORY_CHARS:
            break
        size += len(body)
        turns.insert(0, {"role": "user" if m.sender_id else "model", "parts": [{"text": body}]})
    # Gemini expects the history to end on a model turn before new user input.
    while turns and turns[-1]["role"] != "model":
        turns.pop()
    return turns


async def load_history(conversation_id: str) -> list[dict]:
    async with SessionLocal() as db:
        rows = (
            await db.scalars(
                select(Message)
                .where(Message.conversation_id == conversation_id, Message.deleted == False)  # noqa: E712
                .order_by(Message.seq.desc())
                .limit(HISTORY_MESSAGES)
            )
        ).all()
    return history_turns(list(reversed(rows)))


async def save_exchange(conversation_id: str, user_id: str, heard: str, said: str) -> bool:
    """Persist one spoken exchange so it appears in the chat history."""
    heard, said = heard.strip(), said.strip()
    if not heard or not said:
        return False  # skip greetings and turns with nothing understood
    async with SessionLocal() as db:
        db.add(Message(conversation_id=conversation_id, sender_id=user_id, client_id=str(uuid4()), body=heard))
        await db.flush()
        db.add(Message(conversation_id=conversation_id, sender_id=None, client_id=str(uuid4()), body=said))
        await db.commit()
    await publish(conversation_id, "conversation.updated", {})
    return True


CONNECT_ATTEMPTS = 2


async def _connect_provider(url: str):
    """Open the provider socket, retrying once on transient network failures."""
    for attempt in range(1, CONNECT_ATTEMPTS + 1):
        try:
            return await connect(url, open_timeout=10, ping_interval=20, ping_timeout=20, max_size=4 * 1024 * 1024)
        except (TimeoutError, OSError) as exc:
            if attempt == CONNECT_ATTEMPTS:
                raise
            log.warning("Gemini Live connect failed (%s); retrying", type(exc).__name__)
            await asyncio.sleep(0.5)


async def open_gemini(language: str, handle: str | None):
    """Connect and complete setup; returns (socket, resumed)."""
    url = f"{GEMINI_LIVE_URL}?key={quote(settings.ai_api_key)}"
    for attempt_handle in ([handle, None] if handle else [None]):
        gemini = await _connect_provider(url)
        await gemini.send(json.dumps(setup_message(language, attempt_handle)))
        first = json.loads(await asyncio.wait_for(gemini.recv(), timeout=15))
        if "setupComplete" in first:
            return gemini, attempt_handle is not None
        await gemini.close()
        log.warning("Gemini Live setup rejected (resume=%s): %s", bool(attempt_handle), str(first)[:300])
    raise RuntimeError("Gemini Live setup failed")


# ---------------------------------------------------------------- endpoint


@router.websocket("/ai/live/{conversation_id}")
async def live_voice(ws: WebSocket, conversation_id: str):
    # Reconnects after a dropped network pass greet=0 so the assistant doesn't
    # restart the conversation with a fresh greeting.
    greet = ws.query_params.get("greet", "1") != "0"
    _, language = resolve_language(ws.query_params.get("lang"))
    if not settings.ai_api_key:
        await ws.close(code=CLOSE_FORBIDDEN, reason="Gemini is not configured")
        return
    if not _origin_allowed(ws):
        await ws.close(code=CLOSE_FORBIDDEN, reason="Invalid origin")
        return

    session_id = digest(ws.cookies.get("relay_session", ""))
    async with SessionLocal() as db:
        session = await db.get(Session, session_id)
        membership = await db.get(Membership, (conversation_id, session.user_id)) if session else None
        conversation = await db.get(Conversation, conversation_id) if membership else None
        if (
            not session
            or aware(session.expires_at) <= now()
            or not membership
            or not conversation
            or conversation.kind != "ai"
        ):
            await ws.close(code=CLOSE_UNAUTHORIZED, reason="Unauthorized")
            return
        user_id = session.user_id

    await ws.accept()
    daily_budget = settings.ai_live_daily_minutes * 60
    used = await used_seconds(user_id)
    if used >= daily_budget:
        await ws.send_json(
            {
                "type": "error",
                "message": f"You've used today's {settings.ai_live_daily_minutes} minutes of Live voice. "
                "Text chat is still available, and Live resets at midnight UTC.",
            }
        )
        await ws.close(code=CLOSE_LIMIT, reason="Daily live limit reached")
        return

    # Newest session wins: a second tab/device takes over and the old one closes.
    token = str(uuid4())
    try:
        await r.set(active_key(user_id), token, ex=HEARTBEAT_SECONDS * 4)
    except Exception:
        pass

    started = time.monotonic()
    last_tick = started
    session_limit = settings.ai_live_max_session_minutes * 60
    gemini = None
    try:
        handle = None
        if not greet:
            try:
                handle = await r.get(handle_key(user_id, conversation_id))
            except Exception:
                handle = None
        gemini, resumed = await open_gemini(language, handle)
        remaining = int(min(daily_budget - used, session_limit))
        await ws.send_json({"type": "ready", "remaining_seconds": remaining, "resumed": resumed})

        if not resumed:
            turns = await load_history(conversation_id)
            if turns:
                await gemini.send(json.dumps({"clientContent": {"turns": turns, "turnComplete": False}}))
        if greet:
            await gemini.send(
                json.dumps(
                    {
                        "clientContent": {
                            "turns": [
                                {
                                    "role": "user",
                                    "parts": [
                                        {"text": f"Greet me in {language} in one short sentence and invite me to speak."}
                                    ],
                                }
                            ],
                            "turnComplete": True,
                        }
                    }
                )
            )

        async def browser_to_gemini():
            while True:
                message = await ws.receive()
                if message.get("type") == "websocket.disconnect":
                    return
                if message.get("bytes") is not None:
                    audio = base64.b64encode(message["bytes"]).decode("ascii")
                    await gemini.send(
                        json.dumps({"realtimeInput": {"audio": {"data": audio, "mimeType": "audio/pcm;rate=16000"}}})
                    )
                elif message.get("text"):
                    try:
                        command = json.loads(message["text"])
                    except ValueError:
                        continue
                    kind = command.get("type")
                    if kind == "ping":
                        await ws.send_json({"type": "pong", "t": command.get("t")})
                        continue
                    if kind in ("mute", "close"):
                        await gemini.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))
                    if kind == "close":
                        return

        async def gemini_to_browser():
            heard, said = "", ""
            async for raw in gemini:
                event = json.loads(raw)
                update = event.get("sessionResumptionUpdate")
                if update and update.get("resumable") and update.get("newHandle"):
                    try:
                        await r.set(handle_key(user_id, conversation_id), update["newHandle"], ex=2 * 3600)
                    except Exception:
                        pass
                content = event.get("serverContent", {})
                if content.get("interrupted"):
                    await ws.send_json({"type": "interrupted"})
                if content.get("inputTranscription", {}).get("text"):
                    text = content["inputTranscription"]["text"]
                    heard += text
                    await ws.send_json({"type": "input_transcript", "text": text})
                if content.get("outputTranscription", {}).get("text"):
                    text = content["outputTranscription"]["text"]
                    said += text
                    await ws.send_json({"type": "output_transcript", "text": text})
                for part in content.get("modelTurn", {}).get("parts", []):
                    inline = part.get("inlineData", {})
                    if inline.get("data") and inline.get("mimeType", "").startswith("audio/"):
                        await ws.send_bytes(base64.b64decode(inline["data"]))
                if content.get("turnComplete") or content.get("interrupted"):
                    if content.get("turnComplete"):
                        await ws.send_json({"type": "turn_complete"})
                    try:
                        if await save_exchange(conversation_id, user_id, heard, said):
                            await ws.send_json({"type": "saved"})
                    except Exception:
                        log.exception("Could not save live voice exchange")
                    heard, said = "", ""
                if "goAway" in event:
                    # Gemini is about to end the session; the browser reconnects
                    # and resumes with the stored handle.
                    await ws.send_json({"type": "go_away"})

        async def heartbeat():
            nonlocal last_tick
            while True:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                tick = time.monotonic()
                total = await add_usage(user_id, tick - last_tick)
                last_tick = tick
                try:
                    owner = await r.get(active_key(user_id))
                    if owner and owner != token:
                        await ws.send_json(
                            {"type": "error", "message": "Live voice moved to another tab or device."}
                        )
                        await ws.close(code=CLOSE_REPLACED, reason="Replaced by a newer session")
                        return
                    await r.set(active_key(user_id), token, ex=HEARTBEAT_SECONDS * 4)
                except Exception:
                    pass
                if total >= daily_budget or tick - started >= session_limit:
                    reason = (
                        "You've reached today's Live voice limit."
                        if total >= daily_budget
                        else f"Live sessions end after {settings.ai_live_max_session_minutes} minutes. Start again anytime."
                    )
                    await ws.send_json({"type": "error", "message": reason})
                    await ws.close(code=CLOSE_LIMIT, reason="Live limit reached")
                    return

        tasks = [
            asyncio.create_task(browser_to_gemini()),
            asyncio.create_task(gemini_to_browser()),
            asyncio.create_task(heartbeat()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            task.result()
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:
        log.exception("Gemini Live session failed: %s", exc)
        try:
            await ws.send_json({"type": "error", "message": "Real-time Gemini voice is unavailable."})
            await ws.close(code=1011)
        except Exception:
            pass
    finally:
        await add_usage(user_id, time.monotonic() - last_tick)
        try:
            if await r.get(active_key(user_id)) == token:
                await r.delete(active_key(user_id))
        except Exception:
            pass
        if gemini is not None:
            try:
                await gemini.close()
            except Exception:
                pass
