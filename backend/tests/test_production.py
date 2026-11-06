"""Server-wide search, group lifecycle and storage hygiene."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from app import worker
from app.models import Attachment


async def send(client, cid, body):
    res = await client.post(f"/conversations/{cid}/messages", json={"client_id": str(uuid4()), "body": body})
    assert res.status_code == 200, res.text
    return res.json()


async def group(owner, *members, title="Team"):
    res = await owner.post(
        "/conversations",
        json={"kind": "group", "title": title, "user_ids": [m.user["id"] for m in members]},
    )
    assert res.status_code == 200, res.text
    return res.json()["id"]


async def roles(client, cid):
    convo = next(c for c in (await client.get("/conversations")).json() if c["id"] == cid)
    return {m["id"]: m["role"] for m in convo["members"]}


# ------------------------------------------------------------------ search


async def test_search_covers_all_my_conversations_and_nothing_else(clients):
    a, b, c = clients
    team = await group(a, b)
    secret = await group(b, c, title="Private")
    await send(a, team, "Launch plan is ready")
    await send(b, team, "the LAUNCH moved to Friday")
    await send(b, secret, "launch codes, do not share")

    res = (await a.get("/search", params={"q": "launch"})).json()
    bodies = [i["snippet"] for i in res["items"]]
    assert bodies == ["the LAUNCH moved to Friday", "Launch plan is ready"], "newest first, case-insensitive"
    assert all(i["conversation_id"] == team for i in res["items"]), "never leaks other groups"
    assert res["items"][0]["sender_name"] == "Bobby"


async def test_search_treats_wildcards_literally_and_skips_deleted(clients):
    a, b, _ = clients
    team = await group(a, b)
    await send(a, team, "100% done")
    await send(a, team, "1000 items")
    gone = await send(a, team, "100% secret")
    await a.delete(f"/messages/{gone['id']}")
    res = (await a.get("/search", params={"q": "100%"})).json()
    assert [i["snippet"] for i in res["items"]] == ["100% done"]
    assert (await a.get("/search", params={"q": "x"})).status_code == 422


async def test_search_paginates_and_filters_by_conversation(clients):
    a, b, _ = clients
    team = await group(a, b)
    other = await group(a, b, title="Other")
    for n in range(32):
        await send(a, team, f"note {n}")
    await send(a, other, "note elsewhere")
    first = (await a.get("/search", params={"q": "note", "conversation_id": team})).json()
    assert len(first["items"]) == 30 and first["has_more"]
    rest = (await a.get("/search", params={"q": "note", "conversation_id": team, "before": first["next_cursor"]})).json()
    assert len(rest["items"]) == 2 and not rest["has_more"]


# ------------------------------------------------------------------ groups


async def test_owner_transfers_ownership(clients):
    a, b, c = clients
    cid = await group(a, b, c)
    assert (await b.post(f"/conversations/{cid}/owner", json={"user_id": c.user["id"]})).status_code == 403
    assert (await a.post(f"/conversations/{cid}/owner", json={"user_id": b.user["id"]})).status_code == 200
    current = await roles(a, cid)
    assert current[b.user["id"]] == "owner" and current[a.user["id"]] == "admin"


async def test_owner_leaving_hands_group_to_an_admin(clients):
    a, b, c = clients
    cid = await group(a, b, c)
    await a.post(f"/conversations/{cid}/members", json={"user_id": c.user["id"], "role": "admin"})
    assert (await a.delete(f"/conversations/{cid}/members/{a.user['id']}")).status_code == 204
    current = await roles(b, cid)
    assert a.user["id"] not in current
    assert current[c.user["id"]] == "owner", "admins inherit before members"


async def test_last_member_leaving_deletes_the_group(clients):
    a, b, _ = clients
    cid = await group(a, b)
    await a.delete(f"/conversations/{cid}/members/{b.user['id']}")
    assert (await a.delete(f"/conversations/{cid}/members/{a.user['id']}")).status_code == 204
    assert cid not in [c["id"] for c in (await a.get("/conversations")).json()]


async def test_only_owner_deletes_group(clients):
    a, b, _ = clients
    cid = await group(a, b)
    await send(a, cid, "hello")
    assert (await b.delete(f"/conversations/{cid}")).status_code == 403
    assert (await a.delete(f"/conversations/{cid}")).status_code == 204
    assert cid not in [c["id"] for c in (await b.get("/conversations")).json()]
    assert (await b.get(f"/conversations/{cid}/messages")).status_code == 404


async def test_direct_and_ai_chats_cannot_be_deleted_as_groups(clients):
    a, b, _ = clients
    direct = (await a.post("/conversations", json={"kind": "direct", "user_ids": [b.user["id"]]})).json()["id"]
    assert (await a.delete(f"/conversations/{direct}")).status_code == 403


# ------------------------------------------------------------------ storage


class FakeBucket:
    def __init__(self, objects):
        self.objects = dict(objects)
        self.deleted = []

    def list_objects_v2(self, **kwargs):
        keys = sorted(self.objects)
        start = int(kwargs.get("ContinuationToken") or 0)
        page = keys[start : start + 2]  # tiny pages exercise pagination
        return {
            "Contents": [{"Key": k, "LastModified": self.objects[k]} for k in page],
            "IsTruncated": start + 2 < len(keys),
            "NextContinuationToken": str(start + 2),
        }

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)


async def test_orphan_sweep_removes_only_old_unreferenced_objects(env, clients, monkeypatch):
    factory, _ = env
    a, b, _ = clients
    cid = await group(a, b)
    monkeypatch.setattr(worker, "SessionLocal", factory)
    old = datetime.now(timezone.utc) - timedelta(hours=3)
    fresh = datetime.now(timezone.utc)
    async with factory() as db:
        db.add(Attachment(conversation_id=cid, owner_id=a.user["id"], storage_key="kept", filename="a.txt", content_type="text/plain", size=1))
        await db.commit()
    bucket = FakeBucket({"kept": old, "orphan-1": old, "orphan-2": old, "uploading": fresh, "orphan-3": old})
    assert await worker.sweep_orphans(bucket) == 3
    assert sorted(bucket.deleted) == ["orphan-1", "orphan-2", "orphan-3"]


# ------------------------------------------------------------------ origins

from app.config import settings  # noqa: E402
from app.security import trusted_origin  # noqa: E402


def test_development_trusts_local_network_but_not_websites(monkeypatch):
    monkeypatch.setattr(settings, "environment", "development")
    monkeypatch.setattr(settings, "frontend_origin", "http://localhost:3000")
    for ok in ("http://localhost:3000", "http://127.0.0.1:3000", "http://192.168.1.20:3000", "http://relay.local:3000"):
        assert trusted_origin(ok), ok
    for bad in ("https://evil.example", "http://8.8.8.8", "http://localhost.evil.example", "null"):
        assert not trusted_origin(bad), bad


def test_production_trusts_only_the_configured_frontend(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "frontend_origin", "https://relay.example.com")
    assert trusted_origin("https://relay.example.com")
    assert not trusted_origin("http://localhost:3000")
    assert not trusted_origin("http://192.168.1.20:3000")


async def test_cors_rejects_untrusted_sites(clients, monkeypatch):
    a, _, _ = clients
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "frontend_origin", "https://relay.example.com")
    res = await a.get("/health", headers={"origin": "https://evil.example"})
    assert "access-control-allow-origin" not in res.headers
    res = await a.get("/health", headers={"origin": "https://relay.example.com"})
    assert res.headers["access-control-allow-origin"] == "https://relay.example.com"
