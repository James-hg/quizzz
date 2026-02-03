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

    class Config:
        orm_mode = True


class PlayStart(BaseModel):
    quiz_id: UUID
    user_id: Optional[UUID] = None


class PlayAnswer(BaseModel):
    selected_option_id: UUID
    question_id: UUID


class PlayResponse(BaseModel):
    id: UUID
    question_id: UUID
    selected_option_id: UUID
    is_correct: bool

    class Config:
        orm_mode = True


class PlaySession(BaseModel):
    id: UUID
    quiz_id: UUID
    completed: bool = Field(..., alias="is_completed")
    responses: List[PlayResponse]

    class Config:
        orm_mode = True
        allow_population_by_field_name = True

