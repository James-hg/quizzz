import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


def uuid_col() -> Column:
    return Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class User(Base):
    __tablename__ = "users"

    id = uuid_col()
    email = Column(String(255), unique=True, nullable=False)
    display_name = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    quizzes = relationship("Quiz", back_populates="owner")
    sessions = relationship("QuizSession", back_populates="user")


class Quiz(Base):
    __tablename__ = "quizzes"

    id = uuid_col()
    title = Column(String(255), nullable=False)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    owner = relationship("User", back_populates="quizzes")
    questions = relationship("Question", back_populates="quiz", cascade="all, delete")
    sessions = relationship("QuizSession", back_populates="quiz")


class Question(Base):
    __tablename__ = "questions"

    id = uuid_col()
    quiz_id = Column(UUID(as_uuid=True), ForeignKey("quizzes.id"), nullable=False)
    text = Column(Text, nullable=False)
    position = Column(Integer, nullable=False, default=0)

    quiz = relationship("Quiz", back_populates="questions")
    options = relationship("Option", back_populates="question", cascade="all, delete")


class Option(Base):
    __tablename__ = "options"

    id = uuid_col()
    question_id = Column(UUID(as_uuid=True), ForeignKey("questions.id"), nullable=False)
    text = Column(Text, nullable=False)
    is_correct = Column(Boolean, default=False, nullable=False)
    position = Column(Integer, nullable=False, default=0)

    question = relationship("Question", back_populates="options")

    __table_args__ = (
        UniqueConstraint("question_id", "position", name="uq_option_question_position"),
    )


class QuizSession(Base):
    __tablename__ = "quiz_sessions"

    id = uuid_col()
    quiz_id = Column(UUID(as_uuid=True), ForeignKey("quizzes.id"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    current_index = Column(Integer, default=0, nullable=False)
    is_paused = Column(Boolean, default=False, nullable=False)

    quiz = relationship("Quiz", back_populates="sessions")
    user = relationship("User", back_populates="sessions")
    responses = relationship("Response", back_populates="session", cascade="all, delete")


class Response(Base):
    __tablename__ = "responses"

    id = uuid_col()
    session_id = Column(UUID(as_uuid=True), ForeignKey("quiz_sessions.id"), nullable=False)
    question_id = Column(UUID(as_uuid=True), ForeignKey("questions.id"), nullable=False)
    selected_option_id = Column(UUID(as_uuid=True), ForeignKey("options.id"), nullable=False)
    is_correct = Column(Boolean, nullable=False)
    answered_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    session = relationship("QuizSession", back_populates="responses")
