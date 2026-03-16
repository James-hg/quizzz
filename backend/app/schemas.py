from datetime import datetime
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


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
    subject: Optional[str] = None
    folder_id: Optional[UUID] = None
    questions: List[QuestionCreate]


class QuizSummary(BaseModel):
    id: UUID
    title: str
    subject: Optional[str] = None
    folder_id: Optional[UUID] = None

    class Config:
        from_attributes = True


class PlayStart(BaseModel):
    quiz_id: UUID


class PlayAnswer(BaseModel):
    selected_option_id: UUID
    question_id: UUID


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
    current_index: int | None = None
    is_paused: bool | None = None
    elapsed_seconds: int | None = 0
    responses: List[PlayResponse]

    class Config:
        from_attributes = True


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
    folder_id: Optional[UUID] = None
    questions: List[QuestionOut]

    class Config:
        from_attributes = True


class SignupRequest(BaseModel):
    email: EmailStr
    password: str
    display_name: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthUser(BaseModel):
    id: UUID
    email: str
    display_name: Optional[str] = None
    is_admin: bool = False
    created_at: datetime


class FolderCreate(BaseModel):
    name: str
    color: Optional[str] = "#38bdf8"
    parent_id: Optional[UUID] = None


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[UUID] = None


class FolderOut(BaseModel):
    id: UUID
    owner_id: UUID
    parent_id: Optional[UUID] = None
    name: str
    color: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class QuizStatusSummary(BaseModel):
    quiz_id: UUID
    active_session_id: Optional[UUID] = None
    current_index: int = 0
    is_paused: bool = False
    elapsed_seconds: int = 0
    last_completed_at: Optional[datetime] = None
    last_score_correct: int = 0
    last_score_total: int = 0


class BootstrapPayload(BaseModel):
    user: AuthUser
    folders: List[FolderOut]
    quizzes: List[QuizFull]
    statuses: List[QuizStatusSummary]


class AuthSuccess(BaseModel):
    access_token: str
    token_type: str = "bearer"
    data: BootstrapPayload


class SettingsUpdateRequest(BaseModel):
    display_name: Optional[str] = None
    email: Optional[EmailStr] = None


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str
