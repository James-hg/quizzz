import os
from dotenv import load_dotenv
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

engine = None
SessionLocal = None

if DATABASE_URL:
    url = make_url(DATABASE_URL)

    q = dict(url.query)
    sslmode = q.pop("sslmode", None)

    connect_args = {}
    if sslmode in {"require", "verify-ca", "verify-full"}:
        connect_args["ssl"] = True

    url = url.set(query=q)

    engine = create_async_engine(
        url,
        echo=False,
        future=True,
        connect_args=connect_args,
    )
    SessionLocal = async_sessionmaker(
        engine, expire_on_commit=False, autoflush=False)


async def get_session() -> AsyncSession:
    if SessionLocal is None:
        raise RuntimeError("DATABASE_URL is not set (no DB session available)")
    async with SessionLocal() as session:
        yield session
