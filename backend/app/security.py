import hashlib, secrets
from datetime import timedelta, timezone
from argon2 import PasswordHasher
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from .db import database
from .models import Session, User, Membership, now
from .config import settings

hasher = PasswordHasher()


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def aware(dt):
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


async def current_user(request: Request, db=Depends(database)):
    token = request.cookies.get("relay_session", "")
    if not token:
        raise HTTPException(401, "Please sign in again.")
    try:
        session = await db.get(Session, digest(token))
    except Exception:
        raise HTTPException(401, "Please sign in again.")
    if not session or aware(session.expires_at) <= now():
        raise HTTPException(401, "Please sign in again.")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        req_origin = (request.headers.get("origin") or "").rstrip("/")
        host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").rstrip("/")
        proto = request.headers.get("x-forwarded-proto") or "https"
        same_origin = f"{proto}://{host}".rstrip("/")
        is_valid_origin = (
            not req_origin
            or req_origin == same_origin
            or (settings.frontend_origin and req_origin == settings.frontend_origin.rstrip("/"))
            or settings.environment != "production"
        )
        if not is_valid_origin or not secrets.compare_digest(
            request.headers.get("x-csrf-token", ""), session.csrf
        ):
            raise HTTPException(403, "Invalid CSRF token or origin.")
    request.state.session = session
    return await db.get(User, session.user_id)


async def member(db, cid, user_id):
    m = await db.get(Membership, (cid, user_id))
    if not m:
        raise HTTPException(404, "Conversation not found.")
    return m


async def new_session(db, user, response):
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    db.add(
        Session(
            id=digest(token),
            user_id=user.id,
            csrf=csrf,
            expires_at=now() + timedelta(days=settings.session_days),
        )
    )
    await db.commit()
    response.set_cookie(
        "relay_session",
        token,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="none" if settings.secure_cookies else "lax",
        max_age=settings.session_days * 86400,
        path="/",
    )
    return {
        "user": public_user(user),
        "csrf": csrf,
        "ai_configured": bool(settings.ai_api_key),
    }


def public_user(user):
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "show_presence": user.show_presence,
    }
