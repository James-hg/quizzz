import os
from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Local only: load .env if present (Vercel will ignore it)
load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

engine = None
SessionLocal = None

if DATABASE_URL:
    # Keep DATABASE_URL exactly as provided (including sslmode if present)
    engine = create_async_engine(DATABASE_URL, echo=False, future=True)
    SessionLocal = async_sessionmaker(
        engine, expire_on_commit=False, autoflush=False)


async def get_session() -> AsyncSession:
    if SessionLocal is None:
        raise RuntimeError("DATABASE_URL is not set (no DB session available)")
    async with SessionLocal() as session:
        yield session
