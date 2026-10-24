"""Database-backed attachment queue; safe to run several workers."""

import asyncio, logging
from datetime import timedelta
from sqlalchemy import select, or_, and_, delete
from .db import SessionLocal
from .models import Attachment, Session, now
from .attachments import s3, validate
from .config import settings

log = logging.getLogger("relay.worker")


async def tick():
    async with SessionLocal() as db:
        rows = (
            await db.scalars(
                select(Attachment)
                .where(
                    or_(
                        Attachment.status.in_(["pending", "delete"]),
                        and_(
                            Attachment.message_id.is_(None),
                            Attachment.created_at < now() - timedelta(hours=24),
                        ),
                    )
                )
                .with_for_update(skip_locked=True)
                .limit(20)
            )
        ).all()
        for a in rows:
            if a.status == "pending" and (
                now() - a.created_at.replace(tzinfo=now().tzinfo)
            ) < timedelta(hours=24):
                try:
                    data = await asyncio.to_thread(
                        lambda: (
                            s3()
                            .get_object(Bucket=settings.s3_bucket, Key=a.storage_key)[
                                "Body"
                            ]
                            .read()
                        )
                    )
                    await asyncio.to_thread(validate, data, a.content_type)
                    a.status = "ready"
                except Exception:
                    a.status = "delete"
                    log.warning(
                        "attachment_validation_failed", extra={"attachment_id": a.id}
                    )
            else:
                await asyncio.to_thread(
                    s3().delete_object, Bucket=settings.s3_bucket, Key=a.storage_key
                )
                await db.delete(a)
        await db.execute(delete(Session).where(Session.expires_at < now()))
        await db.commit()


async def main():
    while True:
        try:
            await tick()
        except Exception:
            log.exception("worker_tick_failed")
        await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
