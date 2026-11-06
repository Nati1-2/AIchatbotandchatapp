"""Gemini Live relay: auth, usage limits, transcript saving and resumption.

The provider is replaced by a scripted fake so these run offline; a fake
browser socket drives the real endpoint coroutine.
"""

import asyncio
import base64
import json

import pytest
from sqlalchemy import select

from app import live
from app.config import settings
from app.models import Message


class FakeBrowser:
    def __init__(self, cookie: str | None, query: dict | None = None):
        self.cookies = {"relay_session": cookie} if cookie else {}
        self.query_params = query or {}
        self.headers = {"origin": "http://localhost:3000", "host": "test"}
        self.sent: list = []
        self.closed: tuple[int, str] | None = None
        self.accepted = False
        self._incoming: asyncio.Queue = asyncio.Queue()

    async def accept(self):
        self.accepted = True

    async def close(self, code=1000, reason=""):
        self.closed = (code, reason)

    async def send_json(self, data):
        self.sent.append(data)

    async def send_bytes(self, data):
        self.sent.append(bytes(data))

    async def receive(self):
        return await self._incoming.get()

    def types(self):
        return [m["type"] for m in self.sent if isinstance(m, dict)]


class FakeGemini:
    def __init__(self, events: list[dict]):
        self.events = events
        self.outgoing: list[dict] = []
        self.closed = False

    async def send(self, raw):
        self.outgoing.append(json.loads(raw))

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for event in self.events:
            await asyncio.sleep(0)
            yield json.dumps(event)


AUDIO = base64.b64encode(b"\x01\x00" * 8).decode()

EXCHANGE = [
    {"serverContent": {"inputTranscription": {"text": "What is "}}},
    {"serverContent": {"inputTranscription": {"text": "Relay?"}}},
    {"serverContent": {"outputTranscription": {"text": "Relay is a messenger."}}},
    {"serverContent": {"modelTurn": {"parts": [{"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": AUDIO}}]}}},
    {"serverContent": {"turnComplete": True}},
    {"sessionResumptionUpdate": {"resumable": True, "newHandle": "handle-123"}},
]


@pytest.fixture
async def live_env(env, clients, monkeypatch):
    factory, fake_redis = env
    a, _, _ = clients
    monkeypatch.setattr(live, "SessionLocal", factory)
    monkeypatch.setattr(live, "r", fake_redis)
    published = []

    async def fake_publish(cid, kind, payload):
        published.append((cid, kind))

    monkeypatch.setattr(live, "publish", fake_publish)
    monkeypatch.setattr(settings, "ai_api_key", "test-only")
    cid = (await a.post("/conversations", json={"kind": "ai"})).json()["id"]
    cookie = a.cookies.get("relay_session")
    return {"factory": factory, "redis": fake_redis, "cid": cid, "cookie": cookie, "user": a.user["id"], "published": published}


def use_gemini(monkeypatch, gemini: FakeGemini, resumed=False):
    calls = []

    async def fake_open(language, handle):
        calls.append({"language": language, "handle": handle})
        return gemini, resumed

    monkeypatch.setattr(live, "open_gemini", fake_open)
    return calls


async def test_live_requires_a_signed_in_member(live_env, monkeypatch):
    calls = use_gemini(monkeypatch, FakeGemini([]))
    browser = FakeBrowser(cookie=None)
    await live.live_voice(browser, live_env["cid"])
    assert browser.closed[0] == live.CLOSE_UNAUTHORIZED
    assert not browser.accepted and not calls


async def test_live_exchange_streams_audio_saves_transcript_and_stores_handle(live_env, monkeypatch):
    gemini = FakeGemini(EXCHANGE)
    calls = use_gemini(monkeypatch, gemini)
    browser = FakeBrowser(live_env["cookie"], {"lang": "fr-FR"})
    await asyncio.wait_for(live.live_voice(browser, live_env["cid"]), timeout=5)

    assert calls == [{"language": "French", "handle": None}]
    types = browser.types()
    assert types[0] == "ready"
    assert {"input_transcript", "output_transcript", "turn_complete", "saved"} <= set(types)
    assert any(isinstance(m, bytes) for m in browser.sent), "audio must be relayed"
    # Greeting is requested in the chosen language.
    greeting = gemini.outgoing[-1]["clientContent"]["turns"][0]["parts"][0]["text"]
    assert "French" in greeting

    async with live_env["factory"]() as db:
        rows = (await db.scalars(select(Message).where(Message.conversation_id == live_env["cid"]).order_by(Message.seq))).all()
    assert [(m.sender_id is not None, m.body) for m in rows] == [
        (True, "What is Relay?"),
        (False, "Relay is a messenger."),
    ]
    assert (live_env["cid"], "conversation.updated") in live_env["published"]
    fake_redis = live_env["redis"]
    assert await fake_redis.get(live.handle_key(live_env["user"], live_env["cid"])) == "handle-123"
    assert await fake_redis.get(live.active_key(live_env["user"])) is None, "session lock released"
    assert gemini.closed


async def test_reconnect_resumes_with_handle_and_skips_greeting_and_history(live_env, monkeypatch):
    await live_env["redis"].set(live.handle_key(live_env["user"], live_env["cid"]), "handle-abc")
    gemini = FakeGemini([])
    calls = use_gemini(monkeypatch, gemini, resumed=True)
    browser = FakeBrowser(live_env["cookie"], {"greet": "0"})
    await asyncio.wait_for(live.live_voice(browser, live_env["cid"]), timeout=5)
    assert calls[0]["handle"] == "handle-abc"
    assert browser.sent[0]["resumed"] is True
    assert gemini.outgoing == [], "a resumed session must not replay history or greet again"


async def test_fresh_session_is_seeded_with_recent_history(live_env, monkeypatch):
    async with live_env["factory"]() as db:
        db.add(Message(conversation_id=live_env["cid"], sender_id=live_env["user"], client_id="c1", body="My name is Sam."))
        db.add(Message(conversation_id=live_env["cid"], sender_id=None, client_id="c1", body="Nice to meet you, Sam."))
        await db.commit()
    gemini = FakeGemini([])
    use_gemini(monkeypatch, gemini)
    await asyncio.wait_for(live.live_voice(FakeBrowser(live_env["cookie"]), live_env["cid"]), timeout=5)
    seeded = gemini.outgoing[0]["clientContent"]
    assert seeded["turnComplete"] is False
    assert [t["role"] for t in seeded["turns"]] == ["user", "model"]
    assert seeded["turns"][0]["parts"][0]["text"] == "My name is Sam."


async def test_daily_limit_blocks_new_sessions(live_env, monkeypatch):
    monkeypatch.setattr(settings, "ai_live_daily_minutes", 1)
    await live_env["redis"].set(live.usage_key(live_env["user"]), "60")
    calls = use_gemini(monkeypatch, FakeGemini([]))
    browser = FakeBrowser(live_env["cookie"])
    await live.live_voice(browser, live_env["cid"])
    assert browser.closed[0] == live.CLOSE_LIMIT
    assert browser.types() == ["error"] and "minutes" in browser.sent[0]["message"]
    assert not calls, "no provider session may be opened over budget"


async def test_usage_is_recorded(live_env):
    user = live_env["user"]
    assert await live.add_usage(user, 12.4) == 12
    assert await live.add_usage(user, 30) == 42
    assert await live.used_seconds(user) == 42


async def test_greeting_only_turn_is_not_saved(live_env):
    assert await live.save_exchange(live_env["cid"], live_env["user"], "", "Hello there!") is False
    assert await live.save_exchange(live_env["cid"], live_env["user"], "  ", "") is False


def test_history_turns_respects_budget_and_ends_on_model_turn():
    def msg(body, user=True, deleted=False):
        return Message(body=body, sender_id="u" if user else None, deleted=deleted, client_id="x", conversation_id="c")

    turns = live.history_turns(
        [
            msg("old question " + "x" * live.HISTORY_CHARS),  # too big for the budget
            msg("hi"),
            msg("hello!", user=False),
            msg("removed", deleted=True),
            msg("unanswered question"),
        ]
    )
    assert [(t["role"], t["parts"][0]["text"]) for t in turns] == [("user", "hi"), ("model", "hello!")]


def test_setup_message_includes_resumption_and_language():
    fresh = live.setup_message("English", None)["setup"]
    assert fresh["sessionResumption"] == {}
    assert "ALWAYS reply in English" in fresh["systemInstruction"]["parts"][0]["text"]
    assert live.setup_message("English", "h1")["setup"]["sessionResumption"] == {"handle": "h1"}


class SilentGemini(FakeGemini):
    """A provider session that stays open until cancelled."""

    def __init__(self):
        super().__init__([])

    async def _iterate(self):
        await asyncio.Event().wait()
        yield ""  # pragma: no cover


async def test_newer_session_takes_over(live_env, monkeypatch):
    monkeypatch.setattr(live, "HEARTBEAT_SECONDS", 0.05)
    use_gemini(monkeypatch, SilentGemini())
    browser = FakeBrowser(live_env["cookie"])
    task = asyncio.create_task(live.live_voice(browser, live_env["cid"]))
    # Wait until this session is live and holds the lock (DB speed varies).
    for _ in range(500):
        if browser.types()[:1] == ["ready"] and await live_env["redis"].get(live.active_key(live_env["user"])):
            break
        await asyncio.sleep(0.01)
    await live_env["redis"].set(live.active_key(live_env["user"]), "another-device")
    await asyncio.wait_for(task, timeout=5)
    assert browser.closed[0] == live.CLOSE_REPLACED
    assert "another tab or device" in browser.sent[-1]["message"]
    # The newer session's lock must survive the old one closing.
    assert await live_env["redis"].get(live.active_key(live_env["user"])) == "another-device"


async def test_session_length_limit_closes_session(live_env, monkeypatch):
    monkeypatch.setattr(live, "HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(settings, "ai_live_max_session_minutes", 0)
    use_gemini(monkeypatch, SilentGemini())
    browser = FakeBrowser(live_env["cookie"])
    await asyncio.wait_for(live.live_voice(browser, live_env["cid"]), timeout=5)
    assert browser.closed[0] == live.CLOSE_LIMIT
    assert "Live sessions end after" in browser.sent[-1]["message"]


async def test_provider_connect_retries_once_on_network_blip(monkeypatch):
    attempts = []

    async def flaky_connect(url, **kwargs):
        attempts.append(url)
        if len(attempts) == 1:
            raise TimeoutError("timed out during opening handshake")
        return "socket"

    monkeypatch.setattr(live, "connect", flaky_connect)
    assert await live._connect_provider("wss://example") == "socket"
    assert len(attempts) == 2


async def test_provider_connect_gives_up_after_retry(monkeypatch):
    async def down(url, **kwargs):
        raise OSError("unreachable")

    monkeypatch.setattr(live, "connect", down)
    with pytest.raises(OSError):
        await live._connect_provider("wss://example")
