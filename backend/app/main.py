import io
import random
from datetime import datetime

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from .docx_extract import docx_extract
from .db import engine, get_session
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "FastAPI backend is up"}


@app.on_event("startup")
async def on_startup():
    # create tables if they don't exist (simple bootstrap; switch to migrations later)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@app.post("/upload")
async def upload_docx(file: UploadFile = File(...)):
    """
    Accepts a .docx file upload, extracts quiz structure, and returns JSON.
    """
    if not file.filename.lower().endswith(".docx"):
        raise HTTPException(
            status_code=400, detail="Only .docx files are supported.")

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
    session: AsyncSession = Depends(get_session),
):
    questions_in = list(payload.questions)
    if shuffle_questions:
        random.shuffle(questions_in)

    quiz = Quiz(title=payload.title, owner_id=payload.owner_id)
    session.add(quiz)
    await session.flush()

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
async def list_quizzes(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Quiz))
    return result.scalars().all()


@app.get("/quizzes/{quiz_id}", response_model=QuizFull)
async def get_quiz(quiz_id: str, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(Quiz)
        .options(selectinload(Quiz.questions).selectinload(Question.options))
        .where(Quiz.id == quiz_id)
    )
    quiz = result.scalars().first()
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")
    return quiz


# --- Play sessions ---
@app.post("/plays", response_model=PlaySession)
async def start_play(payload: PlayStart, session: AsyncSession = Depends(get_session)):
    quiz = await session.get(Quiz, payload.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")

    # reuse active session if exists
    existing = await session.execute(
        select(QuizSession)
        .where(QuizSession.quiz_id == payload.quiz_id)
        .where(QuizSession.completed_at.is_(None))
        .order_by(QuizSession.started_at.desc())
    )
    qs = existing.scalars().first()
    if qs:
        await session.refresh(qs)
        return PlaySession(
            id=qs.id,
            quiz_id=qs.quiz_id,
            is_completed=qs.completed_at is not None,
            responses=[],
        )

    qs = QuizSession(quiz_id=payload.quiz_id, user_id=payload.user_id, current_index=0, is_paused=False)
    session.add(qs)
    await session.commit()
    await session.refresh(qs)
    return PlaySession(
        id=qs.id,
        quiz_id=qs.quiz_id,
        is_completed=qs.completed_at is not None,
        responses=[],
    )


@app.post("/plays/{session_id}/answers", response_model=PlaySession)
async def submit_answer(
    session_id: str,
    payload: PlayAnswer,
    session: AsyncSession = Depends(get_session),
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
    session.add(resp)
    qs.current_index = qs.current_index + 1
    qs.is_paused = False
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
    session: AsyncSession = Depends(get_session),
):
    qs = await session.get(QuizSession, session_id)
    if not qs:
        raise HTTPException(status_code=404, detail="Session not found")
    qs.current_index = current_index
    qs.is_paused = True
    await session.commit()
    return {"status": "paused", "session_id": session_id, "current_index": current_index}


@app.patch("/plays/{session_id}/complete")
async def complete_session(session_id: str, session: AsyncSession = Depends(get_session)):
    qs = await session.get(QuizSession, session_id)
    if not qs:
        raise HTTPException(status_code=404, detail="Session not found")
    qs.completed_at = datetime.utcnow()
    qs.is_paused = False
    await session.commit()
    return {"status": "completed", "session_id": session_id}


@app.get("/plays/{session_id}", response_model=PlaySession)
async def get_session(session_id: str, session: AsyncSession = Depends(get_session)):
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
        responses=responses,
    )


@app.get("/quizzes/{quiz_id}/session", response_model=PlaySession)
async def get_active_session(quiz_id: str, session: AsyncSession = Depends(get_session)):
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
        responses=responses,
    )


@app.get("/quizzes/{quiz_id}/history")
async def get_history(quiz_id: str, session: AsyncSession = Depends(get_session)):
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
        correct = sum(1 for r in responses if r.is_correct)
        total = len(responses)
        history.append(
            {
                "session_id": s.id,
                "completed_at": s.completed_at,
                "correct": correct,
                "total": total,
            }
        )
    return history
