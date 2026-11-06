import asyncio, io
from pathlib import PurePath
from uuid import uuid4
from urllib.parse import quote
import boto3
from PIL import Image, UnidentifiedImageError
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from .config import settings
from .db import database
from .models import Attachment, Conversation
from .security import current_user, member

router = APIRouter()
ALLOWED = {"image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain"}


def s3():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1",
    )


def validate(data, mime):
    if mime.startswith("image/"):
        try:
            with Image.open(io.BytesIO(data)) as img:
                if (
                    img.format not in {"PNG", "JPEG", "WEBP"}
                    or img.width * img.height > 25_000_000
                ):
                    raise ValueError()
                img.verify()
        except (
            UnidentifiedImageError,
            ValueError,
            OSError,
            Image.DecompressionBombError,
        ):
            raise HTTPException(422, "Invalid or oversized image.")
    elif mime == "application/pdf" and not data.startswith(b"%PDF-"):
        raise HTTPException(422, "Invalid PDF file.")
    elif mime == "text/plain":
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(422, "Text files must use UTF-8.")


@router.post("/conversations/{cid}/attachments", status_code=201)
async def upload(
    cid: str, file: UploadFile, user=Depends(current_user), db=Depends(database)
):
    await member(db, cid, user.id)
    if (await db.get(Conversation, cid)).kind == "ai":
        raise HTTPException(400, "AI file input is not supported. Paste text instead.")
    if file.content_type not in ALLOWED:
        raise HTTPException(415, "Use PNG, JPEG, WebP, PDF or UTF-8 text.")
    data = await file.read(settings.max_upload_bytes + 1)
    if not data or len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "Files must be between 1 byte and 10 MB.")
    await asyncio.to_thread(validate, data, file.content_type)
    aid = str(uuid4())
    key = f"uploads/{aid}"
    await asyncio.to_thread(
        s3().put_object,
        Bucket=settings.s3_bucket,
        Key=key,
        Body=data,
        ContentType=file.content_type,
    )
    a = Attachment(
        id=aid,
        conversation_id=cid,
        owner_id=user.id,
        storage_key=key,
        filename=PurePath(file.filename or "attachment").name[:255],
        content_type=file.content_type,
        size=len(data),
        status="pending",
    )
    db.add(a)
    await db.commit()
    return {"id": aid, "filename": a.filename, "status": a.status}


@router.get("/attachments/{aid}")
async def attachment_status(aid: str, user=Depends(current_user), db=Depends(database)):
    a = await db.get(Attachment, aid)
    if not a:
        raise HTTPException(404, "Attachment not found.")
    await member(db, a.conversation_id, user.id)
    if not a.message_id and a.owner_id != user.id:
        raise HTTPException(404, "Attachment not found.")
    return {"id": a.id, "filename": a.filename, "status": a.status}


@router.get("/attachments/{aid}/download")
async def download(aid: str, user=Depends(current_user), db=Depends(database)):
    a = await db.get(Attachment, aid)
    if not a or a.status != "ready":
        raise HTTPException(404, "Attachment not found.")
    await member(db, a.conversation_id, user.id)
    if not a.message_id and a.owner_id != user.id:
        raise HTTPException(404, "Attachment not found.")

    def fetch():
        return (
            s3().get_object(Bucket=settings.s3_bucket, Key=a.storage_key)["Body"].read()
        )

    data = await asyncio.to_thread(fetch)
    # Download disposition prevents active documents being executed in the API origin.
    return Response(
        data,
        media_type=a.content_type,
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''" + quote(a.filename),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@router.get("/conversations/{cid}/attachments")
async def shared(cid: str, user=Depends(current_user), db=Depends(database)):
    await member(db, cid, user.id)
    rows = (
        await db.scalars(
            select(Attachment)
            .where(
                Attachment.conversation_id == cid,
                Attachment.message_id.is_not(None),
                Attachment.status == "ready",
            )
            .order_by(Attachment.created_at.desc())
            .limit(100)
        )
    ).all()
    return [
        {
            "id": a.id,
            "filename": a.filename,
            "content_type": a.content_type,
            "size": a.size,
        }
        for a in rows
    ]
