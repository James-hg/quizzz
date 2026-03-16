import io
import os
import random
from datetime import datetime
from uuid import UUID

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import case, delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .auth import create_access_token, get_current_user, hash_password, verify_password
from .db import SessionLocal, engine, get_session as get_db_session
from .docx_extract import docx_extract
from .models import Base, Folder, Option, Question, Quiz, QuizSession, Response, User
from .schemas import (
    AuthSuccess,
    AuthUser,
    BootstrapPayload,
    FolderCreate,
    FolderOut,
    FolderUpdate,
    LoginRequest,
    PasswordChangeRequest,
    PlayAnswer,
    PlaySession,
    PlayStart,
    QuizCreate,
    QuizFull,
    QuizSummary,
    SettingsUpdateRequest,
    SignupRequest,
)

app = FastAPI()
BCRYPT_MAX_PASSWORD_BYTES = 72


default_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]

extra_origins = os.getenv("ALLOWED_ORIGINS") or os.getenv("FRONTEND_ORIGIN") or ""
parsed_extra = [o.strip() for o in extra_origins.split(",") if o.strip()]

allowed_origins = default_origins + parsed_extra

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def normalize_email(email: str) -> str:
    return email.strip().lower()


def normalize_name(name: str) -> str:
    return name.strip()


def validate_password_strength(password: str) -> str:
    normalized = password.strip()
    if len(normalized) < 8:
        raise HTTPException(
            status_code=400, detail="Password must be at least 8 characters"
        )

    password_bytes = len(normalized.encode("utf-8"))
    if password_bytes > BCRYPT_MAX_PASSWORD_BYTES:
        raise HTTPException(
            status_code=400,
            detail=(
                "Password is too long for bcrypt (max 72 UTF-8 bytes). "
                "Use a shorter password."
            ),
        )
    return normalized


def serialize_user(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "is_admin": bool(user.is_admin),
        "created_at": user.created_at,
    }


def serialize_folder(folder: Folder) -> dict:
    return {
        "id": folder.id,
        "owner_id": folder.owner_id,
        "parent_id": folder.parent_id,
        "name": folder.name,
        "color": folder.color,
        "created_at": folder.created_at,
        "updated_at": folder.updated_at,
    }


def serialize_quiz(quiz: Quiz) -> dict:
    ordered_questions = sorted(quiz.questions, key=lambda q: q.position)
    return {
        "id": quiz.id,
        "title": quiz.title,
        "subject": quiz.subject,
        "folder_id": quiz.folder_id,
        "questions": [
            {
                "id": q.id,
                "text": q.text,
                "position": q.position,
                "options": [
                    {
                        "id": o.id,
                        "text": o.text,
                        "is_correct": o.is_correct,
                        "position": o.position,
                    }
                    for o in sorted(q.options, key=lambda x: x.position)
                ],
            }
            for q in ordered_questions
        ],
    }


async def _validate_folder_owned(
    session: AsyncSession,
    user: User,
    folder_id: UUID | None,
) -> UUID | None:
    if folder_id is None:
        return None
    folder = await session.get(Folder, folder_id)
    if not folder or folder.owner_id != user.id:
        raise HTTPException(status_code=400, detail="Invalid folder_id")
    return folder_id


async def _check_folder_name_available(
    session: AsyncSession,
    owner_id: UUID,
    parent_id: UUID | None,
    name: str,
    exclude_id: UUID | None = None,
) -> None:
    stmt = select(Folder).where(Folder.owner_id == owner_id)
    if parent_id is None:
        stmt = stmt.where(Folder.parent_id.is_(None))
    else:
        stmt = stmt.where(Folder.parent_id == parent_id)
    stmt = stmt.where(func.lower(Folder.name) == name.lower())
    if exclude_id:
        stmt = stmt.where(Folder.id != exclude_id)

    existing = (await session.execute(stmt)).scalars().first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail="A folder with this name already exists in the selected parent",
        )


async def _creates_folder_cycle(
    session: AsyncSession,
    owner_id: UUID,
    folder_id: UUID,
    candidate_parent_id: UUID | None,
) -> bool:
    cursor = candidate_parent_id
    visited = set()
    while cursor:
        if cursor == folder_id:
            return True
        if cursor in visited:
            return True
        visited.add(cursor)
        parent = await session.get(Folder, cursor)
        if not parent or parent.owner_id != owner_id:
            return True
        cursor = parent.parent_id
    return False


async def _get_quiz_statuses(
    session: AsyncSession,
    user_id: UUID,
    quiz_ids: list[UUID],
) -> list[dict]:
    status_map: dict[UUID, dict] = {
        qid: {
            "quiz_id": qid,
            "active_session_id": None,
            "current_index": 0,
            "is_paused": False,
            "elapsed_seconds": 0,
            "last_completed_at": None,
            "last_score_correct": 0,
            "last_score_total": 0,
        }
        for qid in quiz_ids
    }

    if not quiz_ids:
        return []

    active_result = await session.execute(
        select(QuizSession)
        .where(QuizSession.user_id == user_id)
        .where(QuizSession.quiz_id.in_(quiz_ids))
        .where(QuizSession.completed_at.is_(None))
        .order_by(QuizSession.started_at.desc())
    )
    for qs in active_result.scalars().all():
        if status_map[qs.quiz_id]["active_session_id"] is None:
            status_map[qs.quiz_id]["active_session_id"] = qs.id
            status_map[qs.quiz_id]["current_index"] = qs.current_index
            status_map[qs.quiz_id]["is_paused"] = qs.is_paused
            status_map[qs.quiz_id]["elapsed_seconds"] = qs.elapsed_seconds

    completed_result = await session.execute(
        select(QuizSession)
        .where(QuizSession.user_id == user_id)
        .where(QuizSession.quiz_id.in_(quiz_ids))
        .where(QuizSession.completed_at.is_not(None))
        .order_by(QuizSession.completed_at.desc())
    )

    latest_by_quiz: dict[UUID, QuizSession] = {}
    for qs in completed_result.scalars().all():
        if qs.quiz_id not in latest_by_quiz:
            latest_by_quiz[qs.quiz_id] = qs

    latest_session_ids = [s.id for s in latest_by_quiz.values()]
    score_map: dict[UUID, tuple[int, int]] = {}
    if latest_session_ids:
        score_rows = await session.execute(
            select(
                Response.session_id,
                func.count(Response.id),
                func.sum(case((Response.is_correct.is_(True), 1), else_=0)),
            )
            .where(Response.session_id.in_(latest_session_ids))
            .group_by(Response.session_id)
        )
        for session_id, total, correct in score_rows.all():
            score_map[session_id] = (int(total or 0), int(correct or 0))

    for quiz_id, qs in latest_by_quiz.items():
        total, correct = score_map.get(qs.id, (0, 0))
        status_map[quiz_id]["last_completed_at"] = qs.completed_at
        status_map[quiz_id]["last_score_total"] = total
        status_map[quiz_id]["last_score_correct"] = correct

    return [status_map[qid] for qid in quiz_ids]


async def build_bootstrap_payload(session: AsyncSession, user: User) -> dict:
    folder_rows = await session.execute(
        select(Folder)
        .where(Folder.owner_id == user.id)
        .order_by(Folder.created_at.asc())
    )
    folders = folder_rows.scalars().all()

    quiz_rows = await session.execute(
        select(Quiz)
        .options(selectinload(Quiz.questions).selectinload(Question.options))
        .where(Quiz.owner_id == user.id)
        .order_by(Quiz.created_at.desc())
    )
    quizzes = quiz_rows.scalars().all()
    quiz_ids = [quiz.id for quiz in quizzes]
    statuses = await _get_quiz_statuses(session, user.id, quiz_ids)

    return {
        "user": serialize_user(user),
        "folders": [serialize_folder(folder) for folder in folders],
        "quizzes": [serialize_quiz(quiz) for quiz in quizzes],
        "statuses": statuses,
    }


async def run_startup_migrations() -> None:
    if engine is None:
        return

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        await conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()"
            )
        )

        await conn.execute(
            text("ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS subject VARCHAR(255)")
        )
        await conn.execute(
            text("ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS folder_id UUID")
        )

        await conn.execute(
            text(
                """
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'uq_folder_sibling_name'
                    ) THEN
                        ALTER TABLE folders
                        ADD CONSTRAINT uq_folder_sibling_name
                        UNIQUE (owner_id, parent_id, name);
                    END IF;
                END $$;
                """
            )
        )

        await conn.execute(
            text(
                """
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1
                        FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage kcu
                          ON tc.constraint_name = kcu.constraint_name
                        WHERE tc.table_name = 'quizzes'
                          AND tc.constraint_type = 'FOREIGN KEY'
                          AND kcu.column_name = 'folder_id'
                    ) THEN
                        ALTER TABLE quizzes
                        ADD CONSTRAINT fk_quizzes_folder_id
                        FOREIGN KEY (folder_id)
                        REFERENCES folders(id)
                        ON DELETE SET NULL;
                    END IF;
                END $$;
                """
            )
        )


async def seed_admin_user() -> None:
    admin_email = normalize_email(os.getenv("ADMIN_EMAIL", ""))
    admin_password = os.getenv("ADMIN_PASSWORD", "")
    admin_display_name = normalize_name(os.getenv("ADMIN_DISPLAY_NAME", "Admin"))

    if not admin_email or not admin_password or SessionLocal is None:
        return

    password_bytes = len(admin_password.encode("utf-8"))
    if password_bytes > BCRYPT_MAX_PASSWORD_BYTES:
        print(
            "Skipping admin seed: ADMIN_PASSWORD is longer than "
            f"{BCRYPT_MAX_PASSWORD_BYTES} UTF-8 bytes"
        )
        return

    async with SessionLocal() as session:
        existing = await session.execute(
            select(User).where(func.lower(User.email) == admin_email)
        )
        user = existing.scalars().first()
        password_hash = hash_password(admin_password)

        if user:
            user.password_hash = password_hash
            user.is_admin = True
            if not user.display_name:
                user.display_name = admin_display_name
        else:
            user = User(
                email=admin_email,
                password_hash=password_hash,
                display_name=admin_display_name,
                is_admin=True,
            )
            session.add(user)

        await session.commit()


async def _require_owned_quiz(
    session: AsyncSession,
    user_id: UUID,
    quiz_id: UUID,
    eager: bool = False,
) -> Quiz:
    stmt = select(Quiz).where(Quiz.id == quiz_id, Quiz.owner_id == user_id)
    if eager:
        stmt = stmt.options(selectinload(Quiz.questions).selectinload(Question.options))
    result = await session.execute(stmt)
    quiz = result.scalars().first()
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")
    return quiz


async def _require_owned_session(
    session: AsyncSession,
    user_id: UUID,
    session_id: UUID,
) -> QuizSession:
    qs = await session.get(QuizSession, session_id)
    if not qs or qs.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    return qs


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Quizzz FastAPI backend is up"}


@app.get("/health")
def health():
    return {"ok": True}


@app.on_event("startup")
async def on_startup():
    if not os.getenv("JWT_SECRET_KEY"):
        raise RuntimeError("JWT_SECRET_KEY is required")

    if engine is None:
        print("DATABASE_URL not set; skipping DB init")
        return

    try:
        await run_startup_migrations()
    except Exception as e:
        print(f"DB init failed; continuing without DB. Error: {e}")
        return

    try:
        await seed_admin_user()
    except Exception as e:
        print(f"Admin seed failed; continuing without admin seed. Error: {e}")
        return


@app.post("/auth/signup", response_model=AuthSuccess)
async def signup(payload: SignupRequest, session: AsyncSession = Depends(get_db_session)):
    email = normalize_email(payload.email)
    password = validate_password_strength(payload.password)
    display_name = normalize_name(payload.display_name or "")

    existing = await session.execute(select(User).where(func.lower(User.email) == email))
    if existing.scalars().first():
        raise HTTPException(status_code=409, detail="Email already exists")

    user = User(
        email=email,
        password_hash=hash_password(password),
        display_name=display_name or email.split("@")[0],
        is_admin=False,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)

    token = create_access_token(str(user.id), {"email": user.email})
    data = await build_bootstrap_payload(session, user)
    return {"access_token": token, "token_type": "bearer", "data": data}


@app.post("/auth/login", response_model=AuthSuccess)
async def login(payload: LoginRequest, session: AsyncSession = Depends(get_db_session)):
    email = normalize_email(payload.email)
    result = await session.execute(select(User).where(func.lower(User.email) == email))
    user = result.scalars().first()

    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = create_access_token(str(user.id), {"email": user.email})
    data = await build_bootstrap_payload(session, user)
    return {"access_token": token, "token_type": "bearer", "data": data}


@app.get("/auth/bootstrap", response_model=BootstrapPayload)
async def auth_bootstrap(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    return await build_bootstrap_payload(session, current_user)


@app.get("/users/me", response_model=AuthUser)
async def get_me(current_user: User = Depends(get_current_user)):
    return serialize_user(current_user)


@app.patch("/users/me", response_model=AuthUser)
async def update_me(
    payload: SettingsUpdateRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    if payload.display_name is not None:
        current_user.display_name = normalize_name(payload.display_name) or None

    if payload.email is not None:
        new_email = normalize_email(payload.email)
        exists = await session.execute(
            select(User).where(func.lower(User.email) == new_email, User.id != current_user.id)
        )
        if exists.scalars().first():
            raise HTTPException(status_code=409, detail="Email already exists")
        current_user.email = new_email

    await session.commit()
    await session.refresh(current_user)
    return serialize_user(current_user)


@app.patch("/users/me/password")
async def update_password(
    payload: PasswordChangeRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    new_password = validate_password_strength(payload.new_password)
    current_user.password_hash = hash_password(new_password)
    await session.commit()
    return {"status": "ok"}


@app.get("/folders", response_model=list[FolderOut])
async def list_folders(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    result = await session.execute(
        select(Folder)
        .where(Folder.owner_id == current_user.id)
        .order_by(Folder.created_at.asc())
    )
    return result.scalars().all()


@app.post("/folders", response_model=FolderOut)
async def create_folder(
    payload: FolderCreate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    name = normalize_name(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="Folder name is required")

    parent_id = payload.parent_id
    if parent_id:
        parent = await session.get(Folder, parent_id)
        if not parent or parent.owner_id != current_user.id:
            raise HTTPException(status_code=400, detail="Invalid parent folder")

    await _check_folder_name_available(session, current_user.id, parent_id, name)

    folder = Folder(
        owner_id=current_user.id,
        parent_id=parent_id,
        name=name,
        color=payload.color or "#38bdf8",
    )
    session.add(folder)
    await session.commit()
    await session.refresh(folder)
    return folder


@app.patch("/folders/{folder_id}", response_model=FolderOut)
async def update_folder(
    folder_id: UUID,
    payload: FolderUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    folder = await session.get(Folder, folder_id)
    if not folder or folder.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Folder not found")

    updates = payload.dict(exclude_unset=True)

    next_parent_id = folder.parent_id
    if "parent_id" in updates:
        next_parent_id = updates["parent_id"]
        if next_parent_id == folder.id:
            raise HTTPException(status_code=400, detail="Folder cannot be its own parent")
        if next_parent_id:
            parent = await session.get(Folder, next_parent_id)
            if not parent or parent.owner_id != current_user.id:
                raise HTTPException(status_code=400, detail="Invalid parent folder")
            if await _creates_folder_cycle(
                session,
                current_user.id,
                folder.id,
                next_parent_id,
            ):
                raise HTTPException(status_code=400, detail="Invalid parent folder")
        folder.parent_id = next_parent_id

    next_name = folder.name
    if "name" in updates:
        next_name = normalize_name(updates["name"] or "")
        if not next_name:
            raise HTTPException(status_code=400, detail="Folder name is required")

    await _check_folder_name_available(
        session,
        current_user.id,
        next_parent_id,
        next_name,
        exclude_id=folder.id,
    )
    folder.name = next_name

    if "color" in updates and updates["color"]:
        folder.color = updates["color"]

    await session.commit()
    await session.refresh(folder)
    return folder


@app.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    folder = await session.get(Folder, folder_id)
    if not folder or folder.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Folder not found")

    quizzes = await session.execute(
        select(Quiz).where(Quiz.owner_id == current_user.id, Quiz.folder_id == folder_id)
    )
    for quiz in quizzes.scalars().all():
        quiz.folder_id = None

    children = await session.execute(
        select(Folder).where(Folder.owner_id == current_user.id, Folder.parent_id == folder_id)
    )
    for child in children.scalars().all():
        child.parent_id = None

    await session.delete(folder)
    await session.commit()
    return {"status": "deleted", "folder_id": str(folder_id)}


@app.post("/upload")
async def upload_docx(
    file: UploadFile = File(...),
    _: User = Depends(get_current_user),
):
    if not file.filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="Only .docx files are supported.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        return docx_extract(io.BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse DOCX: {exc}") from exc


@app.post("/quizzes", response_model=QuizSummary)
async def create_quiz(
    payload: QuizCreate,
    shuffle_questions: bool = Query(False),
    shuffle_options: bool = Query(False),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    folder_id = await _validate_folder_owned(session, current_user, payload.folder_id)
    questions_in = list(payload.questions)
    if shuffle_questions:
        random.shuffle(questions_in)

    quiz = Quiz(
        title=payload.title,
        subject=payload.subject,
        owner_id=current_user.id,
        folder_id=folder_id,
    )
    session.add(quiz)
    await session.flush()

    for q in questions_in:
        question = Question(quiz_id=quiz.id, text=q.text, position=q.position)
        session.add(question)
        await session.flush()

        opts = list(q.options)
        if shuffle_options:
            random.shuffle(opts)
        for opt in opts:
            session.add(
                Option(
                    question_id=question.id,
                    text=opt.text,
                    is_correct=opt.is_correct,
                    position=opt.position,
                )
            )

    await session.commit()
    await session.refresh(quiz)
    return quiz


@app.put("/quizzes/{quiz_id}", response_model=QuizSummary)
async def update_quiz(
    quiz_id: UUID,
    payload: QuizCreate,
    shuffle_questions: bool = Query(False),
    shuffle_options: bool = Query(False),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    quiz = await _require_owned_quiz(session, current_user.id, quiz_id)
    folder_id = await _validate_folder_owned(session, current_user, payload.folder_id)

    sub_sessions = select(QuizSession.id).where(QuizSession.quiz_id == quiz_id)
    await session.execute(delete(Response).where(Response.session_id.in_(sub_sessions)))

    sub_questions = select(Question.id).where(Question.quiz_id == quiz_id)
    sub_options = select(Option.id).where(Option.question_id.in_(sub_questions))

    await session.execute(delete(Response).where(Response.question_id.in_(sub_questions)))
    await session.execute(
        delete(Response).where(Response.selected_option_id.in_(sub_options))
    )
    await session.execute(delete(QuizSession).where(QuizSession.quiz_id == quiz_id))
    await session.execute(delete(Option).where(Option.question_id.in_(sub_questions)))
    await session.execute(delete(Question).where(Question.quiz_id == quiz_id))

    quiz.title = payload.title
    quiz.subject = payload.subject
    quiz.folder_id = folder_id
    await session.flush()

    questions_in = list(payload.questions)
    if shuffle_questions:
        random.shuffle(questions_in)

    for q in questions_in:
        question = Question(quiz_id=quiz.id, text=q.text, position=q.position)
        session.add(question)
        await session.flush()

        opts = list(q.options)
        if shuffle_options:
            random.shuffle(opts)
        for opt in opts:
            session.add(
                Option(
                    question_id=question.id,
                    text=opt.text,
                    is_correct=opt.is_correct,
                    position=opt.position,
                )
            )

    await session.commit()
    await session.refresh(quiz)
    return quiz


@app.get("/quizzes", response_model=list[QuizSummary])
async def list_quizzes(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    result = await session.execute(
        select(Quiz)
        .where(Quiz.owner_id == current_user.id)
        .order_by(Quiz.created_at.desc())
    )
    return result.scalars().all()


@app.get("/quizzes/{quiz_id}", response_model=QuizFull)
async def get_quiz(
    quiz_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    quiz = await _require_owned_quiz(session, current_user.id, quiz_id, eager=True)
    return quiz


@app.delete("/quizzes/{quiz_id}")
async def delete_quiz(
    quiz_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    quiz = await _require_owned_quiz(session, current_user.id, quiz_id)

    sub_sessions = select(QuizSession.id).where(QuizSession.quiz_id == quiz_id)
    await session.execute(delete(Response).where(Response.session_id.in_(sub_sessions)))

    sub_questions = select(Question.id).where(Question.quiz_id == quiz_id)
    await session.execute(delete(Response).where(Response.question_id.in_(sub_questions)))

    await session.execute(delete(QuizSession).where(QuizSession.quiz_id == quiz_id))
    await session.execute(delete(Option).where(Option.question_id.in_(sub_questions)))
    await session.execute(delete(Question).where(Question.quiz_id == quiz_id))
    await session.delete(quiz)

    await session.commit()
    return {"status": "deleted", "quiz_id": str(quiz_id)}


@app.post("/plays", response_model=PlaySession)
async def start_play(
    payload: PlayStart,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    quiz = await _require_owned_quiz(session, current_user.id, payload.quiz_id)

    existing = await session.execute(
        select(QuizSession)
        .where(QuizSession.quiz_id == payload.quiz_id)
        .where(QuizSession.user_id == current_user.id)
        .where(QuizSession.completed_at.is_(None))
        .order_by(QuizSession.started_at.desc())
    )
    qs = existing.scalars().first()
    if qs:
        qs.is_paused = False
        qs.active_started_at = datetime.utcnow()
        await session.commit()
        await session.refresh(qs)
        return PlaySession(
            id=qs.id,
            quiz_id=qs.quiz_id,
            is_completed=qs.completed_at is not None,
            current_index=qs.current_index,
            is_paused=qs.is_paused,
            elapsed_seconds=qs.elapsed_seconds,
            responses=[],
        )

    now = datetime.utcnow()
    qs = QuizSession(
        quiz_id=quiz.id,
        user_id=current_user.id,
        current_index=0,
        is_paused=False,
        active_started_at=now,
        elapsed_seconds=0,
    )
    session.add(qs)
    await session.commit()
    await session.refresh(qs)
    return PlaySession(
        id=qs.id,
        quiz_id=qs.quiz_id,
        is_completed=qs.completed_at is not None,
        current_index=qs.current_index,
        is_paused=qs.is_paused,
        elapsed_seconds=qs.elapsed_seconds,
        responses=[],
    )


@app.post("/plays/{session_id}/answers", response_model=PlaySession)
async def submit_answer(
    session_id: UUID,
    payload: PlayAnswer,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    qs = await _require_owned_session(session, current_user.id, session_id)

    question = await session.get(Question, payload.question_id)
    option = await session.get(Option, payload.selected_option_id)
    if (
        not question
        or not option
        or question.quiz_id != qs.quiz_id
        or option.question_id != payload.question_id
    ):
        raise HTTPException(status_code=400, detail="Invalid option for question")

    is_correct = bool(option.is_correct)
    resp = Response(
        session_id=qs.id,
        question_id=payload.question_id,
        selected_option_id=payload.selected_option_id,
        is_correct=is_correct,
    )
    session.add(resp)
    qs.current_index = qs.current_index + 1
    qs.is_paused = False
    qs.active_started_at = qs.active_started_at or datetime.utcnow()
    await session.commit()
    await session.refresh(qs)

    result = await session.execute(select(Response).where(Response.session_id == qs.id))
    responses = [
        {
            "id": r.id,
            "question_id": r.question_id,
            "selected_option_id": r.selected_option_id,
            "is_correct": r.is_correct,
        }
        for r in result.scalars().all()
    ]

    return PlaySession(
        id=qs.id,
        quiz_id=qs.quiz_id,
        is_completed=qs.completed_at is not None,
        current_index=qs.current_index,
        is_paused=qs.is_paused,
        elapsed_seconds=qs.elapsed_seconds,
        responses=responses,
    )


@app.patch("/plays/{session_id}/progress")
async def update_progress(
    session_id: UUID,
    current_index: int = Query(..., ge=0),
    pause: bool = Query(True),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    qs = await _require_owned_session(session, current_user.id, session_id)
    qs.current_index = current_index
    now = datetime.utcnow()

    if pause:
        if qs.active_started_at:
            qs.elapsed_seconds += int((now - qs.active_started_at).total_seconds())
            qs.active_started_at = None
        qs.is_paused = True
    else:
        if qs.active_started_at is None:
            qs.active_started_at = now
        qs.is_paused = False

    await session.commit()
    return {
        "status": "paused" if pause else "saved",
        "session_id": str(session_id),
        "current_index": current_index,
        "elapsed_seconds": qs.elapsed_seconds,
    }


@app.patch("/plays/{session_id}/complete")
async def complete_session(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    qs = await _require_owned_session(session, current_user.id, session_id)
    now = datetime.utcnow()
    if qs.active_started_at:
        qs.elapsed_seconds += int((now - qs.active_started_at).total_seconds())
        qs.active_started_at = None
    qs.completed_at = now
    qs.is_paused = False
    await session.commit()
    return {"status": "completed", "session_id": str(session_id)}


@app.get("/plays/{session_id}", response_model=PlaySession)
async def get_play_session(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    qs = await _require_owned_session(session, current_user.id, session_id)
    result_resp = await session.execute(select(Response).where(Response.session_id == qs.id))
    responses = [
        {
            "id": r.id,
            "question_id": r.question_id,
            "selected_option_id": r.selected_option_id,
            "is_correct": r.is_correct,
        }
        for r in result_resp.scalars().all()
    ]
    return PlaySession(
        id=qs.id,
        quiz_id=qs.quiz_id,
        is_completed=qs.completed_at is not None,
        current_index=qs.current_index,
        is_paused=qs.is_paused,
        elapsed_seconds=qs.elapsed_seconds,
        responses=responses,
    )


@app.get("/quizzes/{quiz_id}/session", response_model=PlaySession)
async def get_active_session(
    quiz_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    await _require_owned_quiz(session, current_user.id, quiz_id)
    result = await session.execute(
        select(QuizSession)
        .where(QuizSession.quiz_id == quiz_id)
        .where(QuizSession.user_id == current_user.id)
        .where(QuizSession.completed_at.is_(None))
        .order_by(QuizSession.started_at.desc())
    )
    qs = result.scalars().first()
    if not qs:
        raise HTTPException(status_code=404, detail="No active session")

    result_resp = await session.execute(select(Response).where(Response.session_id == qs.id))
    responses = [
        {
            "id": r.id,
            "question_id": r.question_id,
            "selected_option_id": r.selected_option_id,
            "is_correct": r.is_correct,
        }
        for r in result_resp.scalars().all()
    ]

    return PlaySession(
        id=qs.id,
        quiz_id=qs.quiz_id,
        is_completed=qs.completed_at is not None,
        current_index=qs.current_index,
        is_paused=qs.is_paused,
        elapsed_seconds=qs.elapsed_seconds,
        responses=responses,
    )


@app.get("/quizzes/{quiz_id}/history")
async def get_history(
    quiz_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    await _require_owned_quiz(session, current_user.id, quiz_id)
    result = await session.execute(
        select(QuizSession)
        .where(QuizSession.quiz_id == quiz_id)
        .where(QuizSession.user_id == current_user.id)
        .where(QuizSession.completed_at.is_not(None))
        .order_by(QuizSession.completed_at.desc())
    )
    sessions = result.scalars().all()
    history = []
    for s in sessions:
        resp_result = await session.execute(
            select(Response).where(Response.session_id == s.id)
        )
        responses = resp_result.scalars().all()
        correct = sum(1 for r in responses if r.is_correct)
        total = len(responses)
        history.append(
            {
                "session_id": s.id,
                "completed_at": s.completed_at,
                "correct": correct,
                "total": total,
                "current_index": s.current_index,
            }
        )
    return history
