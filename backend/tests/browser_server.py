"""Test-only external-service adapters. Never included in the production image."""

import os
import tempfile

test_directory = tempfile.TemporaryDirectory(prefix="relay-browser-")
os.environ.setdefault(
    "DATABASE_URL", "sqlite+aiosqlite:///" + test_directory.name + "/test.db"
)
os.environ.setdefault("AI_API_KEY", "test-only-no-network")
import asyncio, io, time
from contextlib import asynccontextmanager
from app import main, events, ai, attachments, worker
from app.models import Base
from app.db import engine
from app.seed import seed


class PubSub:
    def __init__(self, redis):
        self.redis = redis
        self.queue = asyncio.Queue()
        redis.listeners.add(self.queue)

    async def subscribe(self, *args):
        pass

    async def listen(self):
        while True:
            yield {"type": "message", "data": await self.queue.get()}

    async def aclose(self):
        self.redis.listeners.discard(self.queue)


class TestRedis:
    def __init__(self):
        self.values = {}
        self.expiry = {}
        self.listeners = set()

    async def get(self, key):
        if self.expiry.get(key, float("inf")) < time.monotonic():
            await self.delete(key)
        return self.values.get(key)

    async def set(self, key, value, nx=False, ex=None):
        if nx and await self.get(key) is not None:
            return False
        self.values[key] = value
        if ex:
            self.expiry[key] = time.monotonic() + ex
        return True

    async def exists(self, key):
        return await self.get(key) is not None

    async def delete(self, key):
        self.values.pop(key, None)
        self.expiry.pop(key, None)

    async def ping(self):
        return True

    async def publish(self, channel, data):
        for q in self.listeners:
            await q.put(data)

    def pubsub(self):
        return PubSub(self)

    async def eval(self, script, n, key, arg):
        if "INCR" in script:
            value = int(await self.get(key) or 0) + 1
            await self.set(key, value, ex=int(arg) if value == 1 else None)
            return value
        if await self.get(key) == arg:
            await self.delete(key)
            return 1
        return 0


class TestStorage:
    def __init__(self):
        self.objects = {}

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs["Body"]

    def get_object(self, **kwargs):
        return {"Body": io.BytesIO(self.objects[kwargs["Key"]])}

    def delete_object(self, **kwargs):
        self.objects.pop(kwargs["Key"], None)


class TestProvider:
    async def stream(self, messages):
        for word in [
            "This is a **mocked provider** response. ",
            "It is used only by automated tests.",
        ]:
            await asyncio.sleep(0.1)
            yield {"delta": word}
        yield {"usage": 16}


r = TestRedis()
storage = TestStorage()
for module in (main, events, ai):
    module.r = r
attachments.s3 = lambda: storage
worker.s3 = lambda: storage
ai.provider = TestProvider()


@asynccontextmanager
async def lifespan(app):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await seed()
    task = asyncio.create_task(worker.main())
    yield
    task.cancel()
    await engine.dispose()
    test_directory.cleanup()


main.app.router.lifespan_context = lifespan
app = main.app
