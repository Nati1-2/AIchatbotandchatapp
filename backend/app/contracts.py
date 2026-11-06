"""Validated public response and live-event contracts; no ORM secrets escape."""

from typing import Literal
from pydantic import BaseModel, Field


class UserOut(BaseModel):
    id: str
    username: str
    display_name: str
    show_presence: bool


class SessionOut(BaseModel):
    user: UserOut
    csrf: str
    ai_configured: bool = False


class MemberOut(UserOut):
    role: Literal["owner", "admin", "member"]
    read_seq: int
    delivered_seq: int
    last_seen: str | None
    online: bool


class ConversationOut(BaseModel):
    id: str
    kind: Literal["direct", "group", "ai"]
    title: str
    members: list[MemberOut]
    unread: int
    pinned: bool
    muted: bool
    last_message: str
    updated_at: str


class AttachmentOut(BaseModel):
    id: str
    filename: str
    content_type: str
    size: int


class ReactionOut(BaseModel):
    emoji: str
    user_id: str


class MessageOut(BaseModel):
    id: str
    seq: int
    client_id: str
    conversation_id: str
    sender_id: str | None
    sender_name: str
    body: str
    reply_id: str | None
    created_at: str
    edited: bool
    deleted: bool
    reactions: list[ReactionOut]
    attachments: list[AttachmentOut]


class HistoryOut(BaseModel):
    items: list[MessageOut]
    has_more: bool
    next_cursor: int | None


class TypingPayload(BaseModel):
    user_id: str
    name: str
    expires_in: int = 5


class PresencePayload(BaseModel):
    user_id: str
    online: bool


class ReadPayload(BaseModel):
    user_id: str
    read_seq: int
    delivered_seq: int


class Event(BaseModel):
    v: Literal[1] = 1
    event_id: str
    type: Literal[
        "message.created",
        "message.updated",
        "message.deleted",
        "reaction.updated",
        "typing.updated",
        "presence.updated",
        "conversation.read",
        "conversation.updated",
        "conversation.removed",
    ]
    conversation_id: str
    payload: dict


class ClientEvent(BaseModel):
    v: Literal[1]
    type: Literal["typing.updated", "presence.updated"]
    conversation_id: str = Field(max_length=36)
    request_id: str = Field(max_length=64)
