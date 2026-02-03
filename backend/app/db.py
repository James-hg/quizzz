import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Load environment variables from .env if present
load_dotenv()

# Default to local Postgres; override with DATABASE_URL env var.
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/quizzz",
)

# Async engine/session factory
engine = create_async_engine(DATABASE_URL, echo=False, future=True)
SessionLocal = async_sessionmaker(
    engine, expire_on_commit=False, autoflush=False)


@asynccontextmanager
async def get_session():
    session: AsyncSession = SessionLocal()
    try:
        yield session
    finally:
        await session.close()
