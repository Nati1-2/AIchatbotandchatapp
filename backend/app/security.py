import hashlib, ipaddress, secrets
from urllib.parse import urlsplit
from datetime import timedelta, timezone
from argon2 import PasswordHasher
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from .db import database
from .models import Session, User, Membership, now
from .config import ai_available, settings

hasher = PasswordHasher()


def is_local_origin(origin: str) -> bool:
    """localhost, loopback, private-network IPs and *.local hosts.

    Development trusts these so the app can be opened from a phone on the same
    Wi-Fi, without trusting arbitrary websites.
    """
    try:
        host = (urlsplit(origin).hostname or "").lower()
    except ValueError:
        return False
    if host in ("localhost", "::1") or host.endswith(".localhost") or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def trusted_origin(origin: str) -> bool:
    """Origins allowed to make credentialed cross-origin requests (CORS)."""
    origin = origin.rstrip("/")
    if settings.frontend_origin and origin == settings.frontend_origin.rstrip("/"):
        return True
    return settings.environment != "production" and is_local_origin(origin)


def same_origin(origin: str, headers) -> bool:
    host = headers.get("x-forwarded-host") or headers.get("host") or ""
    # Some proxy chains append values. The first value is the public-facing
    # scheme supplied by the edge proxy.
    proto = (headers.get("x-forwarded-proto") or "https").split(",", 1)[0].strip()
    return origin.rstrip("/") == f"{proto}://{host}".rstrip("/")


def valid_request_origin(request: Request) -> bool:
    """Return whether a browser request came from a trusted origin."""
    origin = (request.headers.get("origin") or "").rstrip("/")
    if not origin:
        return True
    return trusted_origin(origin) or same_origin(origin, request.headers)


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
        if not valid_request_origin(request) or not secrets.compare_digest(
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
        "ai_configured": ai_available(),
    }


def public_user(user):
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "show_presence": user.show_presence,
    }
