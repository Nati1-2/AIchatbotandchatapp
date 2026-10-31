from typing import Literal
from uuid import UUID
from pydantic import BaseModel, Field


class Credentials(BaseModel):
    username: str = Field(pattern=r"^[a-z0-9_]{3,32}$")
    password: str = Field(min_length=10, max_length=128)
    display_name: str = Field(default="", max_length=80)


class ProfileInput(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)
    show_presence: bool = True


class ConversationInput(BaseModel):
    kind: Literal["direct", "group", "ai"]
    title: str = Field(default="", max_length=80)
    user_ids: list[UUID] = Field(default_factory=list, max_length=100)


class SendInput(BaseModel):
    client_id: UUID
    body: str = Field(default="", max_length=8000)
    reply_id: UUID | None = None
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=5)


class EditInput(BaseModel):
    body: str = Field(min_length=1, max_length=8000)


class ReceiptInput(BaseModel):
    seq: int = Field(ge=0)
    read: bool = False


class PreferenceInput(BaseModel):
    pinned: bool
    muted: bool


class MemberInput(BaseModel):
    user_id: UUID
    role: Literal["admin", "member"] = "member"


class ReactionInput(BaseModel):
    emoji: Literal["👍", "❤️", "😂", "🎉", "👀", "🙏"]


class AIInput(BaseModel):
    client_id: UUID
    body: str = Field(min_length=1, max_length=8000)
    selected_ids: list[UUID] = Field(default_factory=list, max_length=30)
    selected_snapshots: dict[str, str] = Field(default_factory=dict, max_length=30)
    voice: bool = False  # the reply will be read aloud in voice mode


class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=1200)


class TranscriptionInput(BaseModel):
    audio: str = Field(min_length=1, max_length=8_000_000)
    mime_type: str = Field(pattern=r"^audio/[a-zA-Z0-9.+-]+(?:;.*)?$")
