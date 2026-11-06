import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite://"
import pytest
import httpx
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import StaticPool
from app import main, ai
from app.models import Base
from app.db import database
from app import events


class FakeRedis:
    def __init__(self):
        self.values = {}

    async def set(self, k, v, nx=False, ex=None):
        if nx and k in self.values:
            return False
        self.values[k] = v
        return True

    async def get(self, k):
        return self.values.get(k)

    async def exists(self, k):
        return k in self.values

    async def delete(self, k):
        self.values.pop(k, None)

    async def publish(self, *args):
        pass

    async def ping(self):
        return True

    async def eval(self, script, n, key, arg):
        if "INCR" in script:
            self.values[key] = int(self.values.get(key, 0)) + 1
            return self.values[key]
        if self.values.get(key) == arg:
            self.values.pop(key, None)
            return 1
        return 0


@pytest.fixture
async def env(monkeypatch):
    test_url = os.environ.get("TEST_DATABASE_URL", "sqlite+aiosqlite://")
    engine = create_async_engine(
        test_url, **({"poolclass": StaticPool} if test_url.startswith("sqlite") else {})
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as c:
        await c.run_sync(Base.metadata.drop_all)
        await c.run_sync(Base.metadata.create_all)

    async def db():
        async with factory() as s:
            yield s

    main.app.dependency_overrides[database] = db
    fake = FakeRedis()
    for mod in (main, ai, events):
        monkeypatch.setattr(mod, "r", fake)
    monkeypatch.setattr(ai, "SessionLocal", factory)
    monkeypatch.setattr(main, "SessionLocal", factory)
    yield factory, fake
    main.app.dependency_overrides.clear()
    await engine.dispose()


@pytest.fixture
async def clients(env):
    headers = {"origin": "http://localhost:3000"}
    async with (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app),
            base_url="http://test",
            headers=headers,
        ) as a,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app),
            base_url="http://test",
            headers=headers,
        ) as b,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app),
            base_url="http://test",
            headers=headers,
        ) as c,
    ):
        for client, name in ((a, "alice"), (b, "bobby"), (c, "carol")):
            response = await client.post(
                "/auth/register",
                json={
                    "username": name,
                    "password": "test-password-123",
                    "display_name": name.title(),
                },
            )
            assert response.status_code == 201, response.text
            client.headers["x-csrf-token"] = response.json()["csrf"]
            client.user = response.json()["user"]
        yield a, b, c
