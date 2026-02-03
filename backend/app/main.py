import io

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .docx_extract import docx_extract
from .db import engine, get_session
from .models import Base, Option, Question, Quiz, QuizSession, Response
from .schemas import PlayAnswer, PlaySession, PlayStart, QuizCreate, QuizSummary

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
async def create_quiz(payload: QuizCreate, session: AsyncSession = Depends(get_session)):
    quiz = Quiz(title=payload.title, owner_id=payload.owner_id)
    session.add(quiz)
    await session.flush()

    for q in payload.questions:
        question = Question(
            quiz_id=quiz.id,
            text=q.text,
            position=q.position,
        )
        session.add(question)
        await session.flush()
        for opt in q.options:
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


@app.get("/quizzes/{quiz_id}", response_model=QuizSummary)
async def get_quiz(quiz_id: str, session: AsyncSession = Depends(get_session)):
    quiz = await session.get(Quiz, quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")
    return quiz


# --- Play sessions ---
@app.post("/plays", response_model=PlaySession)
async def start_play(payload: PlayStart, session: AsyncSession = Depends(get_session)):
    quiz = await session.get(Quiz, payload.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")

    qs = QuizSession(quiz_id=payload.quiz_id, user_id=payload.user_id)
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
        raise HTTPException(status_code=400, detail="Invalid option for question")

    is_correct = bool(option.is_correct)
    resp = Response(
        session_id=qs.id,
        question_id=payload.question_id,
        selected_option_id=payload.selected_option_id,
        is_correct=is_correct,
    )
    session.add(resp)
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
        responses=responses,
    )
