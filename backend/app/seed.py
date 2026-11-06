"""Explicit, idempotent development-only demo seed."""

import asyncio
from sqlalchemy import select
from .config import settings
from .db import SessionLocal
from .models import User, Conversation, Membership, Message, Preference
from .security import hasher


async def seed():
    if settings.environment != "development":
        raise RuntimeError("Seed is only allowed in development.")
    async with SessionLocal() as db:
        users = []
        for username, name in [("alex", "Alex Morgan"), ("jordan", "Jordan Lee")]:
            u = await db.scalar(select(User).where(User.username == username))
            if not u:
                u = User(
                    username=username,
                    display_name=name,
                    password_hash=hasher.hash("Relay-demo-2026!"),
                )
                db.add(u)
                await db.flush()
            users.append(u)
        key = ":".join(sorted(u.id for u in users))
        direct = await db.scalar(
            select(Conversation).where(Conversation.direct_key == key)
        )
        if not direct:
            direct = Conversation(kind="direct", title="", direct_key=key)
            db.add(direct)
            await db.flush()
            for u in users:
                db.add(
                    Membership(conversation_id=direct.id, user_id=u.id, role="member")
                )
            for sender, body in [
                (users[1], "Hey Alex! Welcome to Relay 👋"),
                (
                    users[1],
                    "A little space for our ideas, and the conversations that move them forward.",
                ),
                (users[0], "Already feels like home. Love how simple everything is."),
                (
                    users[1],
                    "Try sending a message from another browser. I’ll be right here.",
                ),
            ]:
                db.add(
                    Message(
                        conversation_id=direct.id,
                        sender_id=sender.id,
                        client_id=__import__("uuid").uuid4().__str__(),
                        body=body,
                    )
                )
            db.add(
                Preference(
                    conversation_id=direct.id,
                    user_id=users[0].id,
                    pinned=True,
                    muted=False,
                )
            )
        group = await db.scalar(
            select(Conversation).where(Conversation.direct_key == "seed:studio")
        )
        if not group:
            group = Conversation(
                kind="group", title="The studio", direct_key="seed:studio"
            )
            db.add(group)
            await db.flush()
            for i, u in enumerate(users):
                db.add(
                    Membership(
                        conversation_id=group.id,
                        user_id=u.id,
                        role="owner" if i == 0 else "member",
                    )
                )
            db.add(
                Message(
                    conversation_id=group.id,
                    sender_id=users[1].id,
                    client_id=__import__("uuid").uuid4().__str__(),
                    body="A home for the things we’re making together. Share a sketch, a thought, or your next big idea.",
                )
            )
        for u in users:
            if not await db.scalar(
                select(Conversation).where(Conversation.direct_key == "ai:" + u.id)
            ):
                c = Conversation(kind="ai", title="Relay AI", direct_key="ai:" + u.id)
                db.add(c)
                await db.flush()
                db.add(Membership(conversation_id=c.id, user_id=u.id, role="owner"))
        await db.commit()
    print("Development seed ready: alex / jordan · password: Relay-demo-2026!")


if __name__ == "__main__":
    asyncio.run(seed())
