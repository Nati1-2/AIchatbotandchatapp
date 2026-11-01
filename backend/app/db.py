import logging
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from .config import settings

log = logging.getLogger("relay")

# Determine engine based on config or fallback to SQLite
db_url = settings.database_url

# If database_url is the default localhost:5432 and we're not running locally, use SQLite
if "localhost:5432" in db_url or "127.0.0.1:5432" in db_url:
    log.info("No remote PostgreSQL configured. Using local persistent SQLite database.")
    db_url = "sqlite+aiosqlite:///relay.db"

engine = create_async_engine(db_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def database():
    async with SessionLocal() as db:
        yield db
