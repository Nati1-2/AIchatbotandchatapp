import asyncio, json, logging, secrets, time
from contextlib import asynccontextmanager
from uuid import uuid4
from argon2.exceptions import VerifyMismatchError, InvalidHashError
from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    Query,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, func, or_, text
from sqlalchemy.exc import IntegrityError
from .config import ai_available, settings
from .db import database, SessionLocal
from .models import *
from .schemas import *
from .contracts import *
from .security import (
    current_user,
    member,
    new_session,
    public_user,
    hasher,
    digest,
    aware,
    valid_request_origin,
)
from .events import r, publish, limit

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("relay")

# Demo credentials are public, so computing a production-strength Argon2 hash
# for them on every cold start adds no security. This precomputed, valid
# Argon2id hash keeps Render's resource-constrained free instances responsive.
DEMO_PASSWORD_HASH = (
    "$argon2id$v=19$m=8192,t=1,p=1$Ej46s1wDIlHqfsVKobZmqA$"
    "fh6lj7FikQZN06OYvc3sKUeH5fzPO0T80tnVlvkU7Rw"
)


async def init_schema_and_demo():
    try:
        from .models import Base, User
        from .db import engine, SessionLocal
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        log.info("Database schema verified and tables ensured.")

        async with SessionLocal() as db:
            for username, name in [("alex", "Alex Morgan"), ("jordan", "Jordan Lee")]:
                u = await db.scalar(select(User).where(User.username == username))
                if not u:
                    u = User(
                        username=username,
                        display_name=name,
                        password_hash=DEMO_PASSWORD_HASH,
                    )
                    db.add(u)
                else:
                    # Demo accounts intentionally keep the documented password.
                    u.password_hash = DEMO_PASSWORD_HASH
            await db.commit()
            log.info("Demo users (alex, jordan) verified.")
    except Exception as e:
        log.error(f"Database initialization warning: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Finish schema/demo initialization before accepting traffic.  Starting it
    # in the background made fresh deployments intermittently reject the demo
    # login while the database was still being prepared.
    await init_schema_and_demo()
    yield

app = FastAPI(title="Relay API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_log(request, call_next):
    request.state.request_id = str(uuid4())
    start = time.monotonic()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    log.info(
        json.dumps(
            {
                "request_id": request.state.request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "ms": round((time.monotonic() - start) * 1000),
            }
        )
    )
    return response


@app.exception_handler(HTTPException)
async def http_error(request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.status_code,
                "message": exc.detail,
                "request_id": getattr(request.state, "request_id", ""),
            }
        },
    )


@app.exception_handler(Exception)
async def unexpected_error(request, exc):
    request_id = getattr(request.state, "request_id", "")
    log.error(json.dumps({"request_id": request_id, "error_type": type(exc).__name__}))
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": 500,
                "message": "Relay could not complete this request. Please try again.",
                "request_id": request_id,
            }
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": 422,
                "message": "Check the submitted fields.",
                "fields": [
                    {"field": ".".join(map(str, e["loc"])), "message": e["msg"]}
                    for e in exc.errors()
                ],
            }
        },
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/ready")
async def ready(db=Depends(database)):
    await db.execute(text("SELECT 1"))
    await r.ping()
    return {"status": "ready"}


def check_origin(request):
    """Validate Origin header for login/register."""
    if not valid_request_origin(request):
        raise HTTPException(403, "Invalid origin.")


async def auth_limit(request, username):
    await limit("auth:ip:" + request.client.host, 30, 300)
    await limit("auth:user:" + username, 10, 300)


@app.post("/auth/register", status_code=201, response_model=SessionOut)
async def register(
    data: Credentials, request: Request, response: Response, db=Depends(database)
):
    check_origin(request)
    await auth_limit(request, data.username)
    user = User(
        username=data.username,
        display_name=data.display_name.strip() or data.username,
        password_hash=await asyncio.to_thread(hasher.hash, data.password),
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "Username is already taken.")
    return await new_session(db, user, response)


@app.post("/auth/login", response_model=SessionOut)
async def login(
    data: Credentials, request: Request, response: Response, db=Depends(database)
):
    check_origin(request)
    await auth_limit(request, data.username)
    user = await db.scalar(select(User).where(User.username == data.username))
    valid = False
    if user:
        try:
            valid = await asyncio.to_thread(
                hasher.verify, user.password_hash, data.password
            )
        except (VerifyMismatchError, InvalidHashError):
            pass
    else:
        await asyncio.to_thread(hasher.hash, data.password)
    if not valid:
        raise HTTPException(401, "Incorrect username or password.")
    return await new_session(db, user, response)


@app.get("/auth/me", response_model=SessionOut)
async def me(request: Request, user=Depends(current_user)):
    return {
        "user": public_user(user),
        "csrf": request.state.session.csrf,
        "ai_configured": ai_available(),
    }


@app.post("/auth/logout", status_code=204)
async def logout(
    request: Request,
    response: Response,
    user=Depends(current_user),
    db=Depends(database),
):
    await db.delete(await db.get(Session, request.state.session.id))
    await db.commit()
    response.delete_cookie("relay_session", path="/", secure=settings.secure_cookies, samesite="none" if settings.secure_cookies else "lax")


@app.delete("/auth/sessions", status_code=204)
async def revoke(response: Response, user=Depends(current_user), db=Depends(database)):
    from sqlalchemy import delete

    await db.execute(delete(Session).where(Session.user_id == user.id))
    await db.commit()
    response.delete_cookie("relay_session", path="/", secure=settings.secure_cookies, samesite="none" if settings.secure_cookies else "lax")


@app.patch("/profile", response_model=UserOut)
async def profile(data: ProfileInput, user=Depends(current_user), db=Depends(database)):
    user.display_name = data.display_name.strip()
    user.show_presence = data.show_presence
    await db.commit()
    return public_user(user)


@app.get("/users", response_model=list[UserOut])
async def users(
    q: str = Query(min_length=2, max_length=32),
    user=Depends(current_user),
    db=Depends(database),
):
    rows = (
        await db.scalars(
            select(User)
            .where(
                User.username.contains(q.lower(), autoescape=True), User.id != user.id
            )
            .limit(20)
        )
    ).all()
    return [public_user(x) for x in rows]


async def conversation_out(db, c, user_id):
    members = (
        await db.scalars(select(Membership).where(Membership.conversation_id == c.id))
    ).all()
    pref = await db.get(Preference, (c.id, user_id))
    own = next(m for m in members if m.user_id == user_id)
    last = await db.scalar(
        select(Message)
        .where(Message.conversation_id == c.id)
        .order_by(Message.seq.desc())
        .limit(1)
    )
    unread = await db.scalar(
        select(func.count())
        .select_from(Message)
        .where(
            Message.conversation_id == c.id,
            Message.seq > own.read_seq,
            or_(Message.sender_id != user_id, Message.sender_id.is_(None)),
            Message.deleted == False,
        )
    )
    people = []
    for m in members:
        u = await db.get(User, m.user_id)
        people.append(
            {
                **public_user(u),
                "role": m.role,
                "read_seq": m.read_seq,
                "delivered_seq": m.delivered_seq,
                "last_seen": u.last_seen.isoformat() if u.show_presence else None,
                "online": bool(await r.exists("presence:" + u.id))
                if u.show_presence
                else False,
            }
        )
    title = c.title
    if c.kind == "direct":
        title = next(
            (p["display_name"] for p in people if p["id"] != user_id), "Saved messages"
        )
    return {
        "id": c.id,
        "kind": c.kind,
        "title": title,
        "members": people,
        "unread": unread,
        "pinned": pref.pinned if pref else False,
        "muted": pref.muted if pref else False,
        "last_message": (
            "Message deleted" if last.deleted else (last.body or "Attachment")
        )
        if last
        else "",
        "updated_at": (last.created_at if last else c.created_at).isoformat(),
    }


@app.get("/conversations", response_model=list[ConversationOut])
async def conversations(user=Depends(current_user), db=Depends(database)):
    rows = (
        await db.scalars(
            select(Conversation).join(Membership).where(Membership.user_id == user.id)
        )
    ).all()
    return [await conversation_out(db, c, user.id) for c in rows]


@app.post("/conversations", response_model=ConversationOut)
async def create_conversation(
    data: ConversationInput, user=Depends(current_user), db=Depends(database)
):
    ids = set(map(str, data.user_ids)) | {user.id}
    if data.kind == "direct" and len(ids) != 2:
        raise HTTPException(422, "Choose one recipient.")
    if data.kind == "group" and (len(ids) < 2 or not data.title.strip()):
        raise HTTPException(422, "A group needs a name and another member.")
    if data.kind == "ai":
        ids = {user.id}
    for i in ids:
        if not await db.get(User, i):
            raise HTTPException(404, "User not found.")
    key = (
        ":".join(sorted(ids))
        if data.kind == "direct"
        else ("ai:" + user.id if data.kind == "ai" else None)
    )
    if key:
        c = await db.scalar(select(Conversation).where(Conversation.direct_key == key))
        if c:
            return await conversation_out(db, c, user.id)
    c = Conversation(
        kind=data.kind,
        title="Relay AI" if data.kind == "ai" else data.title.strip(),
        direct_key=key,
    )
    db.add(c)
    try:
        await db.flush()
        for i in ids:
            db.add(
                Membership(
                    conversation_id=c.id,
                    user_id=i,
                    role="owner" if i == user.id else "member",
                )
            )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        c = await db.scalar(select(Conversation).where(Conversation.direct_key == key))
        if not c:
            raise HTTPException(409, "Please retry.")
    await publish(c.id, "conversation.updated", {})
    return await conversation_out(db, c, user.id)


@app.patch("/conversations/{cid}/preferences")
async def preferences(
    cid: str, data: PreferenceInput, user=Depends(current_user), db=Depends(database)
):
    await member(db, cid, user.id)
    p = await db.get(Preference, (cid, user.id))
    if not p:
        p = Preference(conversation_id=cid, user_id=user.id)
        db.add(p)
    p.pinned = data.pinned
    p.muted = data.muted
    await db.commit()
    return {"ok": True}


@app.post("/conversations/{cid}/members")
async def add_member(
    cid: str, data: MemberInput, user=Depends(current_user), db=Depends(database)
):
    own = await member(db, cid, user.id)
    c = await db.get(Conversation, cid)
    if (
        c.kind != "group"
        or own.role not in ("owner", "admin")
        or (data.role == "admin" and own.role != "owner")
    ):
        raise HTTPException(
            403, "Only the owner can appoint admins; admins can add members."
        )
    if not await db.get(User, str(data.user_id)):
        raise HTTPException(404, "User not found.")
    m = await db.get(Membership, (cid, str(data.user_id)))
    if m and (m.role == "owner" or (own.role == "admin" and m.role == "admin")):
        raise HTTPException(403, "Cannot change this role.")
    if not m:
        m = Membership(conversation_id=cid, user_id=str(data.user_id))
        db.add(m)
    m.role = data.role
    await db.commit()
    await publish(cid, "conversation.updated", {})
    return {"ok": True}


@app.delete("/conversations/{cid}/members/{uid}", status_code=204)
async def remove_member(
    cid: str, uid: str, user=Depends(current_user), db=Depends(database)
):
    own = await member(db, cid, user.id)
    target = await member(db, cid, uid)
    c = await db.get(Conversation, cid)
    if (
        c.kind != "group"
        or target.role == "owner"
        or (
            uid != user.id
            and (
                own.role == "member" or (own.role == "admin" and target.role == "admin")
            )
        )
    ):
        raise HTTPException(403, "You cannot remove this member.")
    await db.delete(target)
    await db.commit()
    await publish(cid, "conversation.updated", {})


async def message_out(db, m):
    reactions = (
        await db.scalars(select(Reaction).where(Reaction.message_id == m.id))
    ).all()
    attachments = (
        (
            await db.scalars(
                select(Attachment).where(
                    Attachment.message_id == m.id, Attachment.status == "ready"
                )
            )
        ).all()
        if not m.deleted
        else []
    )
    u = await db.get(User, m.sender_id) if m.sender_id else None
    return {
        "id": m.id,
        "seq": m.seq,
        "client_id": m.client_id,
        "conversation_id": m.conversation_id,
        "sender_id": m.sender_id,
        "sender_name": u.display_name if u else "Relay AI",
        "body": "" if m.deleted else m.body,
        "reply_id": m.reply_id,
        "created_at": m.created_at.isoformat(),
        "edited": m.edited,
        "deleted": m.deleted,
        "reactions": []
        if m.deleted
        else [{"emoji": x.emoji, "user_id": x.user_id} for x in reactions],
        "attachments": [
            {
                "id": a.id,
                "filename": a.filename,
                "content_type": a.content_type,
                "size": a.size,
            }
            for a in attachments
        ],
    }


@app.get("/conversations/{cid}/messages", response_model=HistoryOut)
async def history(
    cid: str,
    before: int | None = None,
    after: int | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    user=Depends(current_user),
    db=Depends(database),
):
    await member(db, cid, user.id)
    q = select(Message).where(Message.conversation_id == cid)
    if before is not None:
        q = q.where(Message.seq < before)
    if after is not None:
        q = q.where(Message.seq > after)
    rows = list(
        (
            await db.scalars(
                q.order_by(
                    Message.seq.asc() if after is not None else Message.seq.desc()
                ).limit(limit + 1)
            )
        ).all()
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    rows.sort(key=lambda m: m.seq)
    return {
        "items": [await message_out(db, m) for m in rows],
        "has_more": has_more,
        "next_cursor": (rows[-1].seq if after is not None else rows[0].seq)
        if rows
        else None,
    }


@app.post("/conversations/{cid}/messages", response_model=MessageOut)
async def send(
    cid: str, data: SendInput, user=Depends(current_user), db=Depends(database)
):
    await member(db, cid, user.id)
    conversation = await db.scalar(
        select(Conversation).where(Conversation.id == cid).with_for_update()
    )
    if conversation.kind == "ai":
        raise HTTPException(400, "Use the AI streaming endpoint.")
    await limit("send:" + user.id, 120, 60)
    existing = await db.scalar(
        select(Message).where(
            Message.conversation_id == cid,
            Message.sender_id == user.id,
            Message.client_id == str(data.client_id),
        )
    )
    if existing:
        return await message_out(db, existing)
    if not data.body.strip() and not data.attachment_ids:
        raise HTTPException(422, "Write a message or attach a file.")
    if data.reply_id:
        reply = await db.scalar(
            select(Message).where(
                Message.id == str(data.reply_id), Message.conversation_id == cid
            )
        )
        if not reply:
            raise HTTPException(404, "Reply target not found.")
    attachments = []
    for aid in data.attachment_ids:
        a = await db.get(Attachment, str(aid), with_for_update=True)
        if (
            not a
            or a.owner_id != user.id
            or a.conversation_id != cid
            or a.message_id
            or a.status != "ready"
        ):
            raise HTTPException(400, "Attachment is unavailable or still processing.")
        attachments.append(a)
    m = Message(
        conversation_id=cid,
        sender_id=user.id,
        client_id=str(data.client_id),
        body=data.body.strip(),
        reply_id=str(data.reply_id) if data.reply_id else None,
    )
    db.add(m)
    try:
        await db.flush()
        for a in attachments:
            a.message_id = m.id
        await db.commit()
    except IntegrityError:
        await db.rollback()
        m = await db.scalar(
            select(Message).where(
                Message.conversation_id == cid,
                Message.sender_id == user.id,
                Message.client_id == str(data.client_id),
            )
        )
        if not m:
            raise HTTPException(409, "Concurrent change; retry.")
    out = await message_out(db, m)
    await publish(cid, "message.created", out)
    return out


async def authorized_message(db, mid, user):
    m = await db.scalar(select(Message).where(Message.id == mid))
    if not m:
        raise HTTPException(404, "Message not found.")
    await member(db, m.conversation_id, user.id)
    return m


@app.patch("/messages/{mid}", response_model=MessageOut)
async def edit(
    mid: str, data: EditInput, user=Depends(current_user), db=Depends(database)
):
    m = await authorized_message(db, mid, user)
    if m.sender_id != user.id or m.deleted:
        raise HTTPException(403, "Only your own active messages can be edited.")
    if (await db.get(Conversation, m.conversation_id)).kind == "ai":
        raise HTTPException(400, "Retry the AI prompt instead.")
    m.body = data.body.strip()
    m.edited = True
    await db.commit()
    out = await message_out(db, m)
    await publish(m.conversation_id, "message.updated", out)
    return out


@app.delete("/messages/{mid}", status_code=204)
async def delete_message(mid: str, user=Depends(current_user), db=Depends(database)):
    m = await authorized_message(db, mid, user)
    own = await member(db, m.conversation_id, user.id)
    c = await db.get(Conversation, m.conversation_id)
    if m.sender_id != user.id and not (
        c.kind in ("group", "ai") and own.role in ("owner", "admin")
    ):
        raise HTTPException(403, "You cannot delete this message.")
    m.body = ""
    m.deleted = True
    for a in (
        await db.scalars(select(Attachment).where(Attachment.message_id == m.id))
    ).all():
        a.status = "delete"
    await db.commit()
    await publish(m.conversation_id, "message.deleted", await message_out(db, m))


@app.post("/messages/{mid}/reactions", response_model=MessageOut)
async def react(
    mid: str, data: ReactionInput, user=Depends(current_user), db=Depends(database)
):
    m = await authorized_message(db, mid, user)
    if m.deleted:
        raise HTTPException(400, "Message was deleted.")
    existing = await db.get(Reaction, (mid, user.id, data.emoji))
    if existing:
        await db.delete(existing)
    else:
        db.add(Reaction(message_id=mid, user_id=user.id, emoji=data.emoji))
    await db.commit()
    out = await message_out(db, m)
    await publish(m.conversation_id, "reaction.updated", out)
    return out


@app.post("/conversations/{cid}/receipts")
async def receipt(
    cid: str, data: ReceiptInput, user=Depends(current_user), db=Depends(database)
):
    m = await member(db, cid, user.id)
    # Serialize receipt updates so multiple tabs cannot move a cursor backwards.
    m = await db.scalar(
        select(Membership)
        .where(Membership.conversation_id == cid, Membership.user_id == user.id)
        .with_for_update()
    )
    maximum = (
        await db.scalar(
            select(func.max(Message.seq)).where(Message.conversation_id == cid)
        )
        or 0
    )
    seq = min(data.seq, maximum)
    m.delivered_seq = max(m.delivered_seq, seq)
    if data.read:
        m.read_seq = max(m.read_seq, seq)
    await db.commit()
    await publish(
        cid,
        "conversation.read",
        {"user_id": user.id, "read_seq": m.read_seq, "delivered_seq": m.delivered_seq},
    )
    return {"ok": True}


@app.websocket("/ws")
async def websocket(ws: WebSocket):
    ws_origin = (ws.headers.get("origin") or "").rstrip("/")
    ws_host = (ws.headers.get("x-forwarded-host") or ws.headers.get("host") or "")
    ws_proto = ws.headers.get("x-forwarded-proto") or "https"
    ws_same = f"{ws_proto}://{ws_host}".rstrip("/")
    origin_ok = (
        not ws_origin
        or ws_origin == ws_same
        or (settings.frontend_origin and ws_origin == settings.frontend_origin)
        or settings.environment != "production"
    )
    if not origin_ok:
        await ws.close(code=4403)
        return
    session_id = digest(ws.cookies.get("relay_session", ""))
    async with SessionLocal() as db:
        session = await db.get(Session, session_id)
        if not session or aware(session.expires_at) <= now():
            await ws.close(code=4401)
            return
        uid = session.user_id
    await ws.accept()
    pubsub = r.pubsub()
    await pubsub.subscribe("relay:events")

    async def session_valid():
        async with SessionLocal() as db:
            s = await db.get(Session, session_id)
            return bool(s and aware(s.expires_at) > now())

    async def reader():
        async for item in pubsub.listen():
            if item["type"] != "message":
                continue
            if not await session_valid():
                await ws.close(code=4401)
                return
            event = json.loads(item["data"])
            async with SessionLocal() as db:
                if await db.get(Membership, (event["conversation_id"], uid)):
                    await ws.send_json(event)

    task = asyncio.create_task(reader())
    try:
        while True:
            if not await session_valid():
                await ws.close(code=4401)
                break
            await r.set("presence:" + uid, "1", ex=45)
            try:
                data = await asyncio.wait_for(ws.receive_json(), timeout=20)
            except asyncio.TimeoutError:
                await ws.send_json({"v": 1, "type": "ping"})
                continue
            if not isinstance(data, dict):
                raise ValueError("Expected object")
            request_id = data.get("request_id")
            if data.get("type") == "pong":
                continue
            ClientEvent.model_validate(data)
            cid = data.get("conversation_id")
            async with SessionLocal() as db:
                if not await db.get(Membership, (cid, uid)):
                    await ws.send_json(
                        {
                            "v": 1,
                            "type": "error",
                            "request_id": request_id,
                            "payload": {
                                "code": 403,
                                "message": "Not a conversation member.",
                            },
                        }
                    )
                    continue
                u = await db.get(User, uid)
                if data.get("v") != 1 or data.get("type") not in (
                    "typing.updated",
                    "presence.updated",
                ):
                    await ws.send_json(
                        {
                            "v": 1,
                            "type": "error",
                            "request_id": request_id,
                            "payload": {"code": 422, "message": "Unsupported event."},
                        }
                    )
                    continue
                await limit("ws:" + uid, 120, 60)
                if data["type"] == "typing.updated":
                    await r.set(f"typing:{cid}:{uid}", "1", ex=5)
                    await publish(
                        cid,
                        "typing.updated",
                        {"user_id": uid, "name": u.display_name, "expires_in": 5},
                    )
                elif u.show_presence:
                    await publish(
                        cid, "presence.updated", {"user_id": uid, "online": True}
                    )
                await ws.send_json(
                    {
                        "v": 1,
                        "type": "ack",
                        "request_id": request_id,
                        "payload": {"accepted": True},
                    }
                )
    except (WebSocketDisconnect, RuntimeError):
        pass
    except (ValueError, TypeError, HTTPException):
        await ws.close(code=4400)
    finally:
        task.cancel()
        await pubsub.aclose()
        async with SessionLocal() as db:
            u = await db.get(User, uid)
            if u:
                u.last_seen = now()
                await db.commit()


from .attachments import router as attachment_router
from .ai import router as ai_router
from .live import router as live_router

app.include_router(attachment_router)
app.include_router(ai_router)
app.include_router(live_router)
