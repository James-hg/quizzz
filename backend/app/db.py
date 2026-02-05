import os

from dotenv import load_dotenv
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Load environment variables. Prefer .quizzz.env (repo root) then fallback to .env.
load_dotenv(".quizzz.env")
load_dotenv()

# Default to local Postgres; override with DATABASE_URL env var.
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/quizzz",
)

# Normalize URL for asyncpg: drop sslmode (psycopg-style) and set ssl=True instead.
url_obj = make_url(DATABASE_URL)
connect_args: dict[str, object] = {}
query = dict(url_obj.query)
if "sslmode" in query:
    query.pop("sslmode", None)
    connect_args["ssl"] = True
url_obj = url_obj.set(query=query)

# Async engine/session factory
engine = create_async_engine(url_obj, echo=False, future=True,
                             connect_args=connect_args)
SessionLocal = async_sessionmaker(
    engine, expire_on_commit=False, autoflush=False)


async def get_session() -> AsyncSession:
    async with SessionLocal() as session:
        yield session
