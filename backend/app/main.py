import io
import os
import random
from datetime import datetime
from uuid import UUID

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from .docx_extract import docx_extract
from .db import engine, get_session as get_db_session
from .models import Base, Option, Question, Quiz, QuizSession, Response
from .schemas import (
    PlayAnswer,
    PlaySession,
    PlayStart,
    QuizCreate,
    QuizSummary,
    QuizFull,
)

app = FastAPI(title="Quizzz API")

default_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
extra_origins = os.getenv("ALLOWED_ORIGINS") or os.getenv(
    "FRONTEND_ORIGIN") or ""
parsed_extra = [o.strip() for o in extra_origins.split(",") if o.strip()]
# fallback: allow Vercel preview/prod domains if none provided explicitly
origin_regex = None if parsed_extra else r"https://.*\\.vercel\\.app"
allowed_origins = default_origins + parsed_extra

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": " Quizzz FastAPI backend is up"}


@app.get("/health")
def health():
    return {"ok": True}


@app.on_event("startup")
async def on_startup():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        # No DB configured on Vercel yet — don't crash the app
        print("DATABASE_URL not set; skipping DB init")
        return

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception as e:
        # Don't crash the whole API on Vercel if DB is unreachable
        print(f"DB init failed; continuing without DB. Error: {e}")
        return


@app.post("/upload")
async def upload_docx(file: UploadFile = File(...)):
    """
    Accepts a .docx file upload, extracts quiz structure, and returns JSON.
    """
    # currently accepts only docx
    if not file.filename.lower().endswith(".docx"):
        raise HTTPException(
            status_code=400, detail="Only .docx files are supported.")

    # try loading file
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        # Use in-memory bytes; python-docx accepts file-like objects.
        return docx_extract(io.BytesIO(content))
    except Exception as exc:  # broad: parsing can fail for malformed docs
        raise HTTPException(
            status_code=400, detail=f"Failed to parse DOCX: {exc}") from exc


# --- Quiz persistence ---
@app.post("/quizzes", response_model=QuizSummary)
async def create_quiz(
    payload: QuizCreate,
    shuffle_questions: bool = Query(False),
    shuffle_options: bool = Query(False),
    session: AsyncSession = Depends(get_db_session),
):
    questions_in = list(payload.questions)  # store questions
    if shuffle_questions:
        random.shuffle(questions_in)  # randomize questions before play

    quiz = Quiz(title=payload.title, owner_id=payload.owner_id)
    session.add(quiz)  # store quiz to session
    await session.flush()

    for q in questions_in:
        question = Question(
            quiz_id=quiz.id,
            text=q.text,
            position=q.position,
        )
        # load question by question
        session.add(question)
        await session.flush()
        opts = list(q.options)
        if shuffle_options:
            random.shuffle(opts)  # randomize choices on load
        for opt in opts:
            # load choices to session
            session.add(
                Option(
                    question_id=question.id,
                    text=opt.text,
                    is_correct=opt.is_correct,
                    position=opt.position,
                )
            )

    await session.commit()
    await session.refresh(quiz)  # continue next question
    return quiz


@app.put("/quizzes/{quiz_id}", response_model=QuizSummary)
async def update_quiz(
    quiz_id: UUID,
    payload: QuizCreate,
    shuffle_questions: bool = Query(False),
    shuffle_options: bool = Query(False),
    session: AsyncSession = Depends(get_db_session),
):
    quiz = await session.get(Quiz, quiz_id)  # load quiz
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")

    # wipe existing responses/sessions/questions/options to rebuild cleanly
    sub_sessions = select(QuizSession.id).where(QuizSession.quiz_id == quiz_id)
    await session.execute(delete(Response).where(Response.session_id.in_(sub_sessions)))

    sub_questions = select(Question.id).where(Question.quiz_id == quiz_id)
    await session.execute(delete(Response).where(Response.question_id.in_(sub_questions)))
    await session.execute(delete(Response).where(Response.selected_option_id.in_(select(Option.id).where(Option.question_id.in_(sub_questions)))))

    await session.execute(delete(QuizSession).where(QuizSession.quiz_id == quiz_id))
    await session.execute(delete(Option).where(Option.question_id.in_(sub_questions)))
    await session.execute(delete(Question).where(Question.quiz_id == quiz_id))

    # update quiz title
    quiz.title = payload.title
    await session.flush()

    questions_in = list(payload.questions)
    if shuffle_questions:
        random.shuffle(questions_in)

    for q in questions_in:
        question = Question(
            quiz_id=quiz.id,
            text=q.text,
            position=q.position,
        )
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
async def list_quizzes(session: AsyncSession = Depends(get_db_session)):
    result = await session.execute(select(Quiz))  # get result for question
    return result.scalars().all()


@app.get("/quizzes/{quiz_id}", response_model=QuizFull)
async def get_quiz(quiz_id: UUID, session: AsyncSession = Depends(get_db_session)):
    result = await session.execute(
        select(Quiz)
        .options(selectinload(Quiz.questions).selectinload(Question.options))
        .where(Quiz.id == quiz_id)
    )
    quiz = result.scalars().first()
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")
    return quiz


@app.delete("/quizzes/{quiz_id}")
async def delete_quiz(quiz_id: UUID, session: AsyncSession = Depends(get_db_session)):
    quiz = await session.get(Quiz, quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")

    # 1) delete responses tied to this quiz (by session and by question)
    sub_sessions = select(QuizSession.id).where(QuizSession.quiz_id == quiz_id)
    await session.execute(delete(Response).where(Response.session_id.in_(sub_sessions)))

    sub_questions = select(Question.id).where(Question.quiz_id == quiz_id)
    await session.execute(delete(Response).where(Response.question_id.in_(sub_questions)))

    # 2) delete sessions
    await session.execute(delete(QuizSession).where(QuizSession.quiz_id == quiz_id))

    # 3) delete options, questions, then quiz (options/questions rely on cascade but delete explicitly to avoid FK issues)
    await session.execute(delete(Option).where(Option.question_id.in_(sub_questions)))
    await session.execute(delete(Question).where(Question.quiz_id == quiz_id))
    await session.delete(quiz)

    await session.commit()
    return {"status": "deleted", "quiz_id": str(quiz_id)}


# --- Play sessions ---
@app.post("/plays", response_model=PlaySession)
async def start_play(payload: PlayStart, session: AsyncSession = Depends(get_db_session)):
    quiz = await session.get(Quiz, payload.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")

    # resume sesison if one exist
    existing = await session.execute(
        select(QuizSession)
        .where(QuizSession.quiz_id == payload.quiz_id)
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
        quiz_id=payload.quiz_id,
        user_id=payload.user_id,
        current_index=0,
        is_paused=False,
        active_started_at=now,
        elapsed_seconds=0,
    )
    session.add(qs)  # load quiz to session
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
    session_id: str,
    payload: PlayAnswer,
    session: AsyncSession = Depends(get_db_session),
):
    qs = await session.get(QuizSession, session_id)
    if not qs:
        raise HTTPException(status_code=404, detail="Session not found")

    option = await session.get(Option, payload.selected_option_id)
    if not option or option.question_id != payload.question_id:
        raise HTTPException(
            status_code=400, detail="Invalid option for question")

    is_correct = bool(option.is_correct)
    resp = Response(
        session_id=qs.id,
        question_id=payload.question_id,
        selected_option_id=payload.selected_option_id,
        is_correct=is_correct,
    )
    session.add(resp)  # display correct answer
    qs.current_index = qs.current_index + 1
    qs.is_paused = False
    qs.active_started_at = qs.active_started_at or datetime.utcnow()
    await session.commit()
    await session.refresh(qs)

    # fetch all responses for return
    result = await session.execute(
        select(Response).where(Response.session_id == qs.id)
    )
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
        responses=responses,
    )


@app.patch("/plays/{session_id}/progress")
async def update_progress(
    session_id: str,
    current_index: int = Query(..., ge=0),
    pause: bool = Query(True),
    session: AsyncSession = Depends(get_db_session),
):
    qs = await session.get(QuizSession, session_id)
    if not qs:
        raise HTTPException(status_code=404, detail="Session not found")
    qs.current_index = current_index
    now = datetime.utcnow()
    if pause:
        if qs.active_started_at:
            qs.elapsed_seconds += int(
                (now - qs.active_started_at).total_seconds())
            qs.active_started_at = None
        qs.is_paused = True
    await session.commit()
    return {
        "status": "paused" if pause else "saved",
        "session_id": session_id,
        "current_index": current_index,
        "elapsed_seconds": qs.elapsed_seconds,
    }


@app.patch("/plays/{session_id}/complete")
async def complete_session(session_id: str, session: AsyncSession = Depends(get_db_session)):
    # once completed a quiz store metadata & exit session
    qs = await session.get(QuizSession, session_id)
    if not qs:
        raise HTTPException(status_code=404, detail="Session not found")
    now = datetime.utcnow()
    if qs.active_started_at:
        qs.elapsed_seconds += int((now - qs.active_started_at).total_seconds())
        qs.active_started_at = None
    qs.completed_at = now
    qs.is_paused = False
    await session.commit()
    return {"status": "completed", "session_id": session_id}


@app.get("/plays/{session_id}", response_model=PlaySession)
async def get_play_session(session_id: str, session: AsyncSession = Depends(get_db_session)):
    qs = await session.get(QuizSession, session_id)
    if not qs:
        raise HTTPException(status_code=404, detail="Session not found")
    result_resp = await session.execute(
        select(Response).where(Response.session_id == qs.id)
    )
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
async def get_active_session(quiz_id: UUID, session: AsyncSession = Depends(get_db_session)):
    result = await session.execute(
        select(QuizSession)
        .where(QuizSession.quiz_id == quiz_id)
        .where(QuizSession.completed_at.is_(None))
        .order_by(QuizSession.started_at.desc())
    )
    qs = result.scalars().first()
    if not qs:
        raise HTTPException(status_code=404, detail="No active session")

    result_resp = await session.execute(
        select(Response).where(Response.session_id == qs.id)
    )
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
async def get_history(quiz_id: UUID, session: AsyncSession = Depends(get_db_session)):
    # save quiz history to be resumed
    result = await session.execute(
        select(QuizSession)
        .where(QuizSession.quiz_id == quiz_id)
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
        # load correct answer
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
