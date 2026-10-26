from datetime import timedelta
from uuid import uuid4
import pytest
from sqlalchemy import select
from app.models import Session, Message, Generation, Attachment, now
from app import ai
from app.config import settings


async def direct(a, b):
    r = await a.post(
        "/conversations", json={"kind": "direct", "user_ids": [b.user["id"]]}
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def send(a, cid, body="Hello", client_id=None):
    return await a.post(
        f"/conversations/{cid}/messages",
        json={"body": body, "client_id": client_id or str(uuid4())},
    )


async def test_auth_logout_expiry_csrf(clients, env):
    a, b, c = clients
    a.headers["x-csrf-token"] = "wrong"
    assert (await a.post("/auth/logout")).status_code == 403
    a.headers["x-csrf-token"] = (await a.get("/auth/me")).json()["csrf"]
    assert (await a.post("/auth/logout")).status_code == 204
    assert (await a.get("/auth/me")).status_code == 401
    login = await a.post(
        "/auth/login", json={"username": "alice", "password": "test-password-123"}
    )
    assert login.status_code == 200
    async with env[0]() as db:
        for s in (await db.scalars(select(Session))).all():
            s.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    assert (await b.get("/auth/me")).status_code == 401


async def test_isolation_idempotency_pagination_receipts(clients):
    a, b, c = clients
    cid = await direct(a, b)
    assert (await c.get(f"/conversations/{cid}/messages")).status_code == 404
    assert (await send(c, cid)).status_code == 404
    retry = str(uuid4())
    m = (await send(a, cid, client_id=retry)).json()
    assert (await send(a, cid, client_id=retry)).json()["id"] == m["id"]
    second = (await send(a, cid, "Second")).json()
    third = (await send(b, cid, "Third")).json()
    page = (await b.get(f"/conversations/{cid}/messages?limit=2")).json()
    assert [x["body"] for x in page["items"]] == ["Second", "Third"] and page[
        "has_more"
    ]
    older = (
        await b.get(f"/conversations/{cid}/messages?before={page['next_cursor']}")
    ).json()
    assert [x["body"] for x in older["items"]] == ["Hello"]
    recovery = (await b.get(f"/conversations/{cid}/messages?after={m['seq']}")).json()
    assert [x["id"] for x in recovery["items"]] == [second["id"], third["id"]]
    assert (await b.get("/conversations")).json()[0]["unread"] == 2
    await b.post(
        f"/conversations/{cid}/receipts", json={"seq": third["seq"], "read": True}
    )
    await b.post(f"/conversations/{cid}/receipts", json={"seq": m["seq"], "read": True})
    assert (await b.get("/conversations")).json()[0]["unread"] == 0
    assert (
        await b.patch("/messages/" + m["id"], json={"body": "hijack"})
    ).status_code == 403


async def test_group_roles_and_reply_access(clients):
    a, b, c = clients
    group = (
        await a.post(
            "/conversations",
            json={"kind": "group", "title": "Team", "user_ids": [b.user["id"]]},
        )
    ).json()["id"]
    assert (
        await b.post(f"/conversations/{group}/members", json={"user_id": c.user["id"]})
    ).status_code == 403
    assert (
        await a.post(
            f"/conversations/{group}/members",
            json={"user_id": b.user["id"], "role": "admin"},
        )
    ).status_code == 200
    assert (
        await b.post(f"/conversations/{group}/members", json={"user_id": c.user["id"]})
    ).status_code == 200
    assert (
        await b.delete(f"/conversations/{group}/members/{a.user['id']}")
    ).status_code == 403
    private = await direct(a, c)
    m = (await send(a, private)).json()
    assert (
        await b.post(
            f"/conversations/{group}/messages",
            json={"client_id": str(uuid4()), "body": "reply", "reply_id": m["id"]},
        )
    ).status_code == 404


async def test_attachment_authorization(clients, env):
    a, b, c = clients
    cid = await direct(a, b)
    async with env[0]() as db:
        item = Attachment(
            conversation_id=cid,
            owner_id=a.user["id"],
            storage_key="test",
            filename="a.txt",
            content_type="text/plain",
            size=3,
            status="ready",
        )
        db.add(item)
        await db.commit()
        aid = item.id
    assert (await c.get(f"/attachments/{aid}/download")).status_code == 404
    assert (await b.get(f"/attachments/{aid}/download")).status_code == 404
    assert (
        await a.post(
            f"/conversations/{cid}/attachments",
            files={"file": ("x.html", b"<script/>", "text/html")},
        )
    ).status_code == 415


class GoodProvider:
    async def stream(self, messages):
        yield {"delta": "Hello from test"}
        yield {"usage": 8}


class BadProvider:
    async def stream(self, messages):
        raise RuntimeError("test failure")
        yield {}


async def test_ai_stream_failure_limits_and_isolation(clients, env, monkeypatch):
    a, b, c = clients
    cid = (await a.post("/conversations", json={"kind": "ai"})).json()["id"]
    monkeypatch.setattr(settings, "ai_api_key", "test-only")
    monkeypatch.setattr(ai, "provider", GoodProvider())
    res = await a.post(
        f"/conversations/{cid}/ai/stream",
        json={"client_id": str(uuid4()), "body": "Hello"},
    )
    assert "event: done" in res.text
    assert (await b.get(f"/conversations/{cid}/messages")).status_code == 404
    monkeypatch.setattr(ai, "provider", BadProvider())
    res = await a.post(
        f"/conversations/{cid}/ai/stream",
        json={"client_id": str(uuid4()), "body": "Fail"},
    )
    assert "event: error" in res.text
    async with env[0]() as db:
        gs = (
            await db.scalars(select(Generation).order_by(Generation.created_at))
        ).all()
        assert [g.status for g in gs] == ["completed", "failed"]
        assert gs[0].tokens == 8
    monkeypatch.setattr(settings, "ai_daily_limit", 2)
    assert (
        await a.post(
            f"/conversations/{cid}/ai/stream",
            json={"client_id": str(uuid4()), "body": "over quota"},
        )
    ).status_code == 429


async def test_ai_cancellation(clients, env, monkeypatch):
    a, b, c = clients
    cid = (await a.post("/conversations", json={"kind": "ai"})).json()["id"]
    monkeypatch.setattr(settings, "ai_api_key", "test-only")

    class CancellingProvider:
        async def stream(self, messages):
            async with env[0]() as db:
                g = await db.scalar(select(Generation))
                await env[1].set("ai:stop:" + g.id, "1")
            yield {"delta": "must not persist"}

    monkeypatch.setattr(ai, "provider", CancellingProvider())
    res = await a.post(
        f"/conversations/{cid}/ai/stream",
        json={"client_id": str(uuid4()), "body": "cancel"},
    )
    assert "event: cancelled" in res.text
    async with env[0]() as db:
        assert (await db.scalar(select(Generation))).status == "cancelled"
        assert len((await db.scalars(select(Message))).all()) == 1


async def test_auth_validation_and_cross_origin(clients):
    a, b, c = clients
    assert (
        await a.post(
            "/auth/register",
            json={"username": "alice", "password": "test-password-123"},
        )
    ).status_code == 409
    assert (
        await a.post(
            "/auth/login", json={"username": "alice", "password": "incorrect-password"}
        )
    ).status_code == 401
    a.headers["origin"] = "https://untrusted.example"
    assert (
        await a.post(
            "/auth/login", json={"username": "alice", "password": "test-password-123"}
        )
    ).status_code == 403
    assert (
        await a.patch(
            "/profile", json={"display_name": "Changed", "show_presence": True}
        )
    ).status_code == 403


async def test_summary_reauthorizes_and_rejects_changed_snapshot(clients, monkeypatch):
    a, b, c = clients
    private = await direct(b, c)
    hidden = (await send(b, private, "private content")).json()
    ai_id = (await a.post("/conversations", json={"kind": "ai"})).json()["id"]
    monkeypatch.setattr(settings, "ai_api_key", "test-only")
    monkeypatch.setattr(ai, "provider", GoodProvider())
    assert (
        await a.post(
            f"/conversations/{ai_id}/ai/stream",
            json={
                "body": "summarize",
                "client_id": str(uuid4()),
                "selected_ids": [hidden["id"]],
                "selected_snapshots": {hidden["id"]: "private content"},
            },
        )
    ).status_code == 404
    visible = await direct(a, b)
    m = (await send(b, visible, "original")).json()
    await b.patch("/messages/" + m["id"], json={"body": "changed"})
    assert (
        await a.post(
            f"/conversations/{ai_id}/ai/stream",
            json={
                "body": "summarize",
                "client_id": str(uuid4()),
                "selected_ids": [m["id"]],
                "selected_snapshots": {m["id"]: "original"},
            },
        )
    ).status_code == 409
    result = await a.post(
        f"/conversations/{ai_id}/ai/stream",
        json={
            "body": "summarize",
            "client_id": str(uuid4()),
            "selected_ids": [m["id"]],
            "selected_snapshots": {m["id"]: "changed"},
        },
    )
    assert "event: done" in result.text


async def test_upload_worker_download_and_delete(clients, env, monkeypatch):
    import io
    from app import attachments, worker

    objects = {}

    class Store:
        def put_object(self, **kw):
            objects[kw["Key"]] = kw["Body"]

        def get_object(self, **kw):
            return {"Body": io.BytesIO(objects[kw["Key"]])}

        def delete_object(self, **kw):
            objects.pop(kw["Key"], None)

    monkeypatch.setattr(attachments, "s3", Store)
    monkeypatch.setattr(worker, "s3", Store)
    monkeypatch.setattr(worker, "SessionLocal", env[0])
    a, b, c = clients
    cid = await direct(a, b)
    result = await a.post(
        f"/conversations/{cid}/attachments",
        files={"file": ("notes.txt", b"Private notes", "text/plain")},
    )
    assert result.status_code == 201
    aid = result.json()["id"]
    await worker.tick()
    m = await a.post(
        f"/conversations/{cid}/messages",
        json={"client_id": str(uuid4()), "attachment_ids": [aid]},
    )
    assert m.status_code == 200, m.text
    download = await b.get(f"/attachments/{aid}/download")
    assert download.content == b"Private notes"
    assert download.headers["content-disposition"].startswith("attachment;")
    assert (await c.get(f"/attachments/{aid}/download")).status_code == 404
    assert (await b.delete("/messages/" + m.json()["id"])).status_code == 403
    await a.delete("/messages/" + m.json()["id"])
    await worker.tick()
    assert not objects
    assert (await b.get(f"/attachments/{aid}/download")).status_code == 404


async def test_ai_unconfigured_and_stop_authorization(clients, env, monkeypatch):
    a, b, c = clients
    cid = (await a.post("/conversations", json={"kind": "ai"})).json()["id"]
    monkeypatch.setattr(settings, "ai_api_key", "")
    assert (
        await a.post(
            f"/conversations/{cid}/ai/stream",
            json={"client_id": str(uuid4()), "body": "Hello"},
        )
    ).status_code == 503
    async with env[0]() as db:
        g = Generation(user_id=a.user["id"], conversation_id=cid)
        db.add(g)
        await db.commit()
        gid = g.id
    assert (await b.post(f"/ai/generations/{gid}/stop")).status_code == 404
    assert (await a.post(f"/ai/generations/{gid}/stop")).status_code == 200


async def test_concurrent_retry_postgres(clients, env):
    import os, asyncio

    if not os.environ.get("TEST_DATABASE_URL"):
        pytest.skip("PostgreSQL concurrency check")
    a, b, c = clients
    cid = await direct(a, b)
    client_id = str(uuid4())
    responses = await asyncio.gather(
        send(a, cid, "Once", client_id), send(a, cid, "Once", client_id)
    )
    assert all(r.status_code == 200 for r in responses)
    assert responses[0].json()["id"] == responses[1].json()["id"]
    assert len((await a.get(f"/conversations/{cid}/messages")).json()["items"]) == 1


async def test_ai_voice_mode_asks_for_spoken_replies(clients, env, monkeypatch):
    a, _, _ = clients
    cid = (await a.post("/conversations", json={"kind": "ai"})).json()["id"]
    monkeypatch.setattr(settings, "ai_api_key", "test-only")
    prompts = []

    class RecordingProvider:
        async def stream(self, messages):
            prompts.append(messages[0]["content"])
            yield {"delta": "Sure."}

    monkeypatch.setattr(ai, "provider", RecordingProvider())
    for voice in (False, True):
        res = await a.post(
            f"/conversations/{cid}/ai/stream",
            json={"client_id": str(uuid4()), "body": "Hi", "voice": voice},
        )
        assert "event: done" in res.text
    assert "read aloud" not in prompts[0]
    assert "read aloud" in prompts[1]
