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


ORPHAN_GRACE = timedelta(hours=1)
SWEEP_INTERVAL_SECONDS = 3600


def _bucket_objects(client):
    """Yield (key, last_modified) for every object in the private bucket."""
    token = None
    while True:
        kwargs = {"Bucket": settings.s3_bucket, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        page = client.list_objects_v2(**kwargs)
        for obj in page.get("Contents", []):
            yield obj["Key"], obj["LastModified"]
        if not page.get("IsTruncated"):
            return
        token = page.get("NextContinuationToken")


async def sweep_orphans(client=None) -> int:
    """Delete stored objects that no attachment row references.

    Covers uploads whose metadata transaction never committed and files of
    deleted conversations. A grace period protects uploads in flight.
    """
    client = client or s3()
    cutoff = now() - ORPHAN_GRACE
    objects = await asyncio.to_thread(lambda: list(_bucket_objects(client)))
    candidates = [key for key, modified in objects if modified.replace(tzinfo=modified.tzinfo or cutoff.tzinfo) < cutoff]
    removed = 0
    for start in range(0, len(candidates), 500):
        batch = candidates[start : start + 500]
        async with SessionLocal() as db:
            known = set(
                (await db.scalars(select(Attachment.storage_key).where(Attachment.storage_key.in_(batch)))).all()
            )
        for key in batch:
            if key not in known:
                await asyncio.to_thread(client.delete_object, Bucket=settings.s3_bucket, Key=key)
                removed += 1
    if removed:
        log.info("orphan_objects_removed", extra={"count": removed})
    return removed


async def main():
    last_sweep = 0.0
    loop = asyncio.get_running_loop()
    while True:
        try:
            await tick()
        except Exception:
            log.exception("worker_tick_failed")
        if loop.time() - last_sweep >= SWEEP_INTERVAL_SECONDS:
            last_sweep = loop.time()
            try:
                await sweep_orphans()
            except Exception:
                log.exception("orphan_sweep_failed")
        await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
