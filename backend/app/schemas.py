from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class OptionCreate(BaseModel):
    text: str
    is_correct: bool = False
    position: int


class QuestionCreate(BaseModel):
    text: str
    position: int
    options: List[OptionCreate]


class QuizCreate(BaseModel):
    title: str
    owner_id: Optional[UUID] = None
    questions: List[QuestionCreate]


class QuizSummary(BaseModel):
    id: UUID
    title: str
    subject: Optional[str] = None

    class Config:
        from_attributes = True


class PlayStart(BaseModel):
    quiz_id: UUID
    user_id: Optional[UUID] = None


class PlayAnswer(BaseModel):
    selected_option_id: UUID
    question_id: UUID
    session_id: UUID


class PlayResponse(BaseModel):
    id: UUID
    question_id: UUID
    selected_option_id: UUID
    is_correct: bool

    class Config:
        from_attributes = True


class PlaySession(BaseModel):
    id: UUID
    quiz_id: UUID
    completed: bool = Field(..., alias="is_completed")
    responses: List[PlayResponse]

    class Config:
        from_attributes = True
        allow_population_by_field_name = True


class OptionOut(BaseModel):
    id: UUID
    text: str
    is_correct: bool
    position: int

    class Config:
        from_attributes = True


class QuestionOut(BaseModel):
    id: UUID
    text: str
    position: int
    options: List[OptionOut]

    class Config:
        from_attributes = True


class QuizFull(BaseModel):
    id: UUID
    title: str
    subject: Optional[str] = None
    questions: List[QuestionOut]

    class Config:
        from_attributes = True
