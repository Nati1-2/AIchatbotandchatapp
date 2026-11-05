"""Authenticated browser-to-Gemini Live audio relay.

The browser sends raw 16-bit mono PCM at 16 kHz as binary WebSocket frames.
Gemini audio is returned as raw 16-bit mono PCM at 24 kHz. The provider key
never leaves this server.
"""

import asyncio
import base64
import json
import logging
from urllib.parse import quote

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect

from .config import settings
from .db import SessionLocal
from .knowledge import get_relay_system_prompt
from .models import Conversation, Membership, Session, now
from .security import aware, digest

router = APIRouter()
log = logging.getLogger("relay.live")

GEMINI_LIVE_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)


def _origin_allowed(ws: WebSocket) -> bool:
    origin = (ws.headers.get("origin") or "").rstrip("/")
    host = ws.headers.get("x-forwarded-host") or ws.headers.get("host") or ""
    proto = (ws.headers.get("x-forwarded-proto") or "https").split(",", 1)[0]
    same = f"{proto}://{host}".rstrip("/")
    return bool(
        not origin
        or origin == same
        or (settings.frontend_origin and origin == settings.frontend_origin)
        or settings.environment != "production"
    )


@router.websocket("/ai/live/{conversation_id}")
async def live_voice(ws: WebSocket, conversation_id: str):
    if not settings.ai_api_key:
        await ws.close(code=4403, reason="Gemini is not configured")
        return
    if not _origin_allowed(ws):
        await ws.close(code=4403, reason="Invalid origin")
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
            await ws.close(code=4401, reason="Unauthorized")
            return

    await ws.accept()
    provider_url = f"{GEMINI_LIVE_URL}?key={quote(settings.ai_api_key)}"
    try:
        async with connect(
            provider_url,
            open_timeout=15,
            ping_interval=20,
            ping_timeout=20,
            max_size=4 * 1024 * 1024,
        ) as gemini:
            await gemini.send(
                json.dumps(
                    {
                        "setup": {
                            "model": f"models/{settings.ai_live_model}",
                            "generationConfig": {
                                "responseModalities": ["AUDIO"],
                                "speechConfig": {
                                    "voiceConfig": {
                                        "prebuiltVoiceConfig": {"voiceName": "Kore"}
                                    }
                                },
                            },
                            "systemInstruction": {
                                "parts": [{"text": get_relay_system_prompt(is_voice=True)}]
                            },
                            "inputAudioTranscription": {},
                            "outputAudioTranscription": {},
                            "contextWindowCompression": {"slidingWindow": {}},
                        }
                    }
                )
            )

            first = json.loads(await gemini.recv())
            if "setupComplete" not in first:
                raise RuntimeError(f"Gemini Live setup failed: {first}")
            await ws.send_json({"type": "ready"})
            # Make the assistant speak first, matching the existing Live UX.
            await gemini.send(
                json.dumps(
                    {
                        "clientContent": {
                            "turns": [{"role": "user", "parts": [{"text": "Greet me briefly and invite me to speak."}]}],
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
                            json.dumps(
                                {
                                    "realtimeInput": {
                                        "audio": {
                                            "data": audio,
                                            "mimeType": "audio/pcm;rate=16000",
                                        }
                                    }
                                }
                            )
                        )
                    elif message.get("text"):
                        command = json.loads(message["text"])
                        if command.get("type") in ("mute", "close"):
                            await gemini.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))
                        if command.get("type") == "close":
                            return

            async def gemini_to_browser():
                async for raw in gemini:
                    event = json.loads(raw)
                    content = event.get("serverContent", {})
                    if content.get("interrupted"):
                        await ws.send_json({"type": "interrupted"})
                    for key, kind in (
                        ("interimInputTranscription", "input_interim"),
                        ("inputTranscription", "input_transcript"),
                        ("outputTranscription", "output_transcript"),
                    ):
                        if content.get(key, {}).get("text"):
                            await ws.send_json({"type": kind, "text": content[key]["text"]})
                    for part in content.get("modelTurn", {}).get("parts", []):
                        inline = part.get("inlineData", {})
                        if inline.get("data") and inline.get("mimeType", "").startswith("audio/"):
                            await ws.send_bytes(base64.b64decode(inline["data"]))
                    if content.get("turnComplete"):
                        await ws.send_json({"type": "turn_complete"})

            tasks = [
                asyncio.create_task(browser_to_gemini()),
                asyncio.create_task(gemini_to_browser()),
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
