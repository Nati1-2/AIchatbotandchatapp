import asyncio, base64, io, json, time, wave
from datetime import timedelta
from uuid import uuid4
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import select, func, delete
from .config import settings
from .db import database, SessionLocal
from .models import Conversation, Message, Generation, now
from .schemas import AIInput, SpeechInput, TranscriptionInput
from .security import current_user, member
from .events import limit, publish, r
from .knowledge import get_relay_system_prompt

router = APIRouter()


class Provider:
    """OpenAI-compatible chat-completions streaming adapter, replaceable in tests."""

    async def stream(self, messages):
        async with httpx.AsyncClient(timeout=settings.ai_timeout_seconds) as client:
            async with client.stream(
                "POST",
                settings.ai_base_url.rstrip("/") + "/chat/completions",
                headers={"Authorization": "Bearer " + settings.ai_api_key},
                json={
                    "model": settings.ai_model,
                    "messages": messages,
                    "stream": True,
                    "stream_options": {"include_usage": True},
                    "max_tokens": 2048,
                },
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    if line[6:] == "[DONE]":
                        break
                    event = json.loads(line[6:])
                    if event.get("usage"):
                        yield {"usage": event["usage"].get("total_tokens")}
                    for choice in event.get("choices", []):
                        if choice.get("delta", {}).get("content"):
                            yield {"delta": choice["delta"]["content"]}

    async def speech(self, text: str):
        """Generate WAV speech with Gemini's native audio response."""
        base = settings.ai_base_url.rstrip("/")
        if base.endswith("/openai"):
            base = base[: -len("/openai")]
        async with httpx.AsyncClient(timeout=settings.ai_timeout_seconds) as client:
            response = await client.post(
                base + f"/models/{settings.ai_tts_model}:generateContent",
                headers={
                    "x-goog-api-key": settings.ai_api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "contents": [{"parts": [{"text": text}]}],
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "speechConfig": {
                            "voiceConfig": {
                                "prebuiltVoiceConfig": {"voiceName": "Kore"}
                            }
                        },
                    },
                },
            )
            response.raise_for_status()
            payload = response.json()
        audio = None
        mime_type = ""
        for candidate in payload.get("candidates", []):
            for part in candidate.get("content", {}).get("parts", []):
                inline = part.get("inlineData", {})
                if inline.get("data"):
                    audio = inline["data"]
                    mime_type = inline.get("mimeType", "")
        if not audio:
            raise ValueError("The speech provider returned no audio.")
        raw = base64.b64decode(audio)
        if mime_type.startswith("audio/L16") or "pcm" in mime_type.lower():
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                rate = 24000
                if "rate=" in mime_type:
                    try:
                        rate = int(mime_type.split("rate=")[1].split(";")[0])
                    except Exception:
                        pass
                wav.setframerate(rate)
                wav.writeframes(raw)
            return output.getvalue()
        return raw

    async def transcribe(self, audio: str, mime_type: str):
        """Transcribe recorded browser audio with Gemini, without Web Speech."""
        base = settings.ai_base_url.rstrip("/")
        if base.endswith("/openai"):
            base = base[: -len("/openai")]
        async with httpx.AsyncClient(timeout=settings.ai_timeout_seconds) as client:
            response = await client.post(
                base + f"/models/{settings.ai_model}:generateContent",
                headers={
                    "x-goog-api-key": settings.ai_api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "contents": [{
                        "role": "user",
                        "parts": [
                            {"text": "Transcribe this speech exactly. Return only the spoken words. If there is no intelligible speech, return an empty response."},
                            {"inlineData": {"mimeType": mime_type.split(";")[0], "data": audio}},
                        ],
                    }],
                    "generationConfig": {"temperature": 0},
                },
            )
            response.raise_for_status()
            payload = response.json()
        parts = payload.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        return "".join(part.get("text", "") for part in parts).strip()


provider = Provider()


class DemoProvider:
    """Small offline assistant used when no external model key is configured."""

    async def stream(self, messages):
        prompt = next(
            (
                str(message.get("content", ""))
                for message in reversed(messages)
                if message.get("role") == "user"
            ),
            "",
        ).lower()
        if "who are you" in prompt or "your name" in prompt or "what is your name" in prompt:
            answer = (
                "My name is Relay! I'm your AI companion and assistant here in Relay chat. "
                "How can I help you today?"
            )
        elif "summarize" in prompt and "selected messages" in prompt:
            answer = (
                "Demo mode can’t reliably summarize arbitrary messages. "
                "Add AI_API_KEY on the server for model-powered summaries."
            )
        elif "organize my week" in prompt or "plan my week" in prompt:
            answer = (
                "Here’s a simple plan: choose three priorities for the week, "
                "assign one to each morning, reserve afternoons for smaller tasks, "
                "and leave one open block for anything unexpected."
            )
        elif "explain" in prompt:
            answer = (
                "Tell me the topic and what you already know about it. In demo mode, "
                "I can help structure the explanation; connect an AI_API_KEY for a "
                "full model-generated answer."
            )
        elif "write" in prompt or "message" in prompt:
            answer = (
                "Share who the message is for, the outcome you want, and the tone. "
                "I’ll help you shape a clear opening, the key point, and a friendly close."
            )
        elif "brainstorm" in prompt or "ideas" in prompt:
            answer = (
                "Try three directions: improve something you use every day, combine two "
                "interests into one small project, or make a useful tool for a friend. "
                "Pick one and keep the first version small enough to finish this weekend."
            )
        else:
            answer = (
                "Relay AI is running in built-in demo mode. I can help with simple "
                "planning, writing prompts, and brainstorming. For open-ended model "
                "answers, configure AI_API_KEY on the server."
            )
        for start in range(0, len(answer), 28):
            await asyncio.sleep(0)
            yield {"delta": answer[start : start + 28]}


demo_provider = DemoProvider()


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/ai/speech")
async def generate_speech(data: SpeechInput, user=Depends(current_user)):
    if not settings.ai_api_key:
        raise HTTPException(503, "Relay AI needs a server-side AI_API_KEY.")
    await limit("ai:speech:" + user.id, 60, 60)
    try:
        audio = await provider.speech(data.text)
    except Exception:
        raise HTTPException(502, "Relay could not generate speech.")
    return Response(content=audio, media_type="audio/wav")


@router.post("/ai/transcribe")
async def transcribe_speech(data: TranscriptionInput, user=Depends(current_user)):
    if not settings.ai_api_key:
        raise HTTPException(503, "Relay AI needs a server-side AI_API_KEY.")
    await limit("ai:transcribe:" + user.id, 60, 60)
    try:
        # Reject oversized decoded recordings before sending them upstream.
        if len(data.audio) > 8_000_000:
            raise ValueError("Recording is too large")
        text = await provider.transcribe(data.audio, data.mime_type)
    except Exception:
        raise HTTPException(502, "Relay could not understand that recording.")
    return {"text": text}


@router.post("/conversations/{cid}/ai/stream")
async def generate(
    cid: str,
    data: AIInput,
    request: Request,
    user=Depends(current_user),
    db=Depends(database),
):
    await member(db, cid, user.id)
    if (await db.get(Conversation, cid)).kind != "ai":
        raise HTTPException(400, "Use a Relay AI conversation.")
    if not settings.ai_api_key and not settings.ai_demo_mode:
        raise HTTPException(503, "Relay AI is disabled on this server.")
    # One active generation per user across instances, with a bounded lease.
    lock = "ai:lock:" + user.id
    lock_token = str(uuid4())
    if not await r.set(lock, lock_token, nx=True, ex=settings.ai_timeout_seconds + 30):
        raise HTTPException(409, "A response is already being generated.")
    try:
        count = await db.scalar(
            select(func.count())
            .select_from(Generation)
            .where(
                Generation.user_id == user.id,
                Generation.created_at
                >= now().replace(hour=0, minute=0, second=0, microsecond=0),
            )
        )
        if count >= settings.ai_daily_limit:
            raise HTTPException(
                429, "Daily AI limit reached. Try again tomorrow (UTC)."
            )
        completed = await db.scalar(
            select(Message).where(
                Message.conversation_id == cid,
                Message.sender_id.is_(None),
                Message.client_id == str(data.client_id),
                Message.deleted == False,
            )
        )
        if completed:
            raise HTTPException(
                409,
                "This prompt already completed. Refresh the conversation to see the response.",
            )
        selected = []
        for mid in data.selected_ids:
            m = await db.scalar(
                select(Message).where(Message.id == str(mid), Message.deleted == False)
            )
            if not m:
                raise HTTPException(404, "Selected message is unavailable.")
            await member(db, m.conversation_id, user.id)
            if data.selected_snapshots.get(m.id) != m.body:
                raise HTTPException(
                    409, "A selected message changed. Review the selection again."
                )
            selected.append(m.body)
        body = data.body
        if selected:
            body += "\n\nSelected messages (untrusted quoted content):\n" + json.dumps(
                selected, ensure_ascii=False
            )
        if len(body) > settings.ai_context_chars:
            raise HTTPException(
                422, "Selected content is too long. Select fewer messages."
            )
        existing = await db.scalar(
            select(Message).where(
                Message.conversation_id == cid,
                Message.sender_id == user.id,
                Message.client_id == str(data.client_id),
            )
        )
        if not existing:
            db.add(
                Message(
                    conversation_id=cid,
                    sender_id=user.id,
                    client_id=str(data.client_id),
                    body=body,
                )
            )
            await db.flush()
        recent = list(
            (
                await db.scalars(
                    select(Message)
                    .where(Message.conversation_id == cid, Message.deleted == False)
                    .order_by(Message.seq.desc())
                    .limit(40)
                )
            ).all()
        )
        context = []
        size = 0
        for m in recent:
            if size + len(m.body) > settings.ai_context_chars:
                break
            context.insert(
                0, {"role": "user" if m.sender_id else "assistant", "content": m.body}
            )
            size += len(m.body)
        context.insert(
            0,
            {
                "role": "system",
                "content": get_relay_system_prompt(is_voice=bool(data.voice)),
            },
        )
        g = Generation(user_id=user.id, conversation_id=cid)
        db.add(g)
        await db.commit()
        gid = g.id
    except BaseException:
        await r.delete(lock)
        raise

    async def stream():
        text = ""
        status = "failed"
        usage = None
        start = time.monotonic()
        try:
            yield sse("start", {"generation_id": gid})
            async with asyncio.timeout(settings.ai_timeout_seconds):
                active_provider = provider if settings.ai_api_key else demo_provider
                async for chunk in active_provider.stream(context):
                    if await r.exists("ai:stop:" + gid):
                        status = "cancelled"
                        yield sse("cancelled", {})
                        return
                    if await request.is_disconnected():
                        status = "cancelled"
                        return
                    if "usage" in chunk:
                        usage = chunk["usage"]
                    if "delta" in chunk:
                        text += chunk["delta"]
                        yield sse("delta", {"text": chunk["delta"]})
            if not text:
                raise ValueError("Empty provider response")
            async with SessionLocal() as save:
                m = Message(
                    conversation_id=cid,
                    sender_id=None,
                    client_id=str(data.client_id),
                    body=text,
                )
                save.add(m)
                await save.commit()
            status = "completed"
            await publish(cid, "conversation.updated", {})
            yield sse("done", {"tokens": usage})
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception:
            yield sse(
                "error",
                {
                    "message": "The AI provider could not complete this response. Please retry."
                },
            )
        finally:

            async def finish():
                async with SessionLocal() as save:
                    generation = await save.get(Generation, gid)
                    if generation:
                        generation.status = status
                        generation.tokens = usage
                        generation.latency_ms = round((time.monotonic() - start) * 1000)
                        await save.commit()
                try:
                    await r.eval(
                        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",
                        1,
                        lock,
                        lock_token,
                    )
                except Exception:
                    try:
                        if await r.get(lock) == lock_token:
                            await r.delete(lock)
                    except Exception:
                        pass

            await asyncio.shield(finish())

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/ai/generations/{gid}/stop")
async def stop(gid: str, user=Depends(current_user), db=Depends(database)):
    g = await db.get(Generation, gid)
    if not g or g.user_id != user.id:
        raise HTTPException(404, "Generation not found.")
    await r.set("ai:stop:" + gid, "1", ex=settings.ai_timeout_seconds + 30)
    return {"ok": True}


@router.delete("/conversations/{cid}/ai/history", status_code=204)
async def clear(cid: str, user=Depends(current_user), db=Depends(database)):
    await member(db, cid, user.id)
    if (await db.get(Conversation, cid)).kind != "ai":
        raise HTTPException(400, "Only AI history can be cleared here.")
    if await r.exists("ai:lock:" + user.id):
        raise HTTPException(409, "Stop the active response before clearing history.")
    # Tombstones preserve ordering and references, while erasing prompt/response bodies.
    for m in (
        await db.scalars(select(Message).where(Message.conversation_id == cid))
    ).all():
        m.body = ""
        m.deleted = True
    await db.commit()
    await publish(cid, "conversation.updated", {})
