"""
Pydantic schemas for request/response validation.
"""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel


# ─────────────────────────── Documents ────────────────────────────────────────

class DocumentOut(BaseModel):
    id: int
    original_name: str
    file_size: int
    page_count: int
    chunk_count: int
    status: str
    error_message: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ─────────────────────────── Chat ─────────────────────────────────────────────

class ChatRequest(BaseModel):
    question: str


class SourceChunk(BaseModel):
    chunk: str
    score: float


class ChatResponse(BaseModel):
    answer: str
    sources: list[SourceChunk]
    message_id: int


# ─────────────────────────── Podcasts ─────────────────────────────────────────

class PodcastOut(BaseModel):
    id: int
    document_id: int
    status: str
    script: Optional[str] = None
    characters: Optional[str] = None  # JSON string with host_a and host_b character info
    duration_seconds: int
    error_message: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ─────────────────────────── Explainer Videos ────────────────────────────────

class ExplainerOut(BaseModel):
    id: int
    document_id: int
    status: str
    domain: Optional[str] = None
    persona_name: Optional[str] = None
    persona_type: Optional[str] = None
    persona_emoji: Optional[str] = None
    script: Optional[str] = None
    duration_seconds: int
    error_message: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ─────────────────────────── General ─────────────────────────────────────────

class StatusResponse(BaseModel):
    status: str
    message: str
