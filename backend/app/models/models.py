from datetime import datetime
from sqlalchemy import String, Integer, DateTime, Text, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    original_name: Mapped[str] = mapped_column(String(512), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(
        String(64), default="uploading"
    )  # uploading | ingesting | ready | error
    error_message: Mapped[str] = mapped_column(Text, nullable=True)
    vector_index_path: Mapped[str] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), default=func.now()
    )

    chats: Mapped[list["ChatMessage"]] = relationship(
        "ChatMessage", back_populates="document", cascade="all, delete-orphan"
    )
    podcasts: Mapped[list["Podcast"]] = relationship(
        "Podcast", back_populates="document", cascade="all, delete-orphan"
    )
    explainers: Mapped[list["ExplainerVideo"]] = relationship(
        "ExplainerVideo", back_populates="document", cascade="all, delete-orphan"
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    document_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("documents.id"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # "user" | "assistant"
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sources: Mapped[str] = mapped_column(Text, nullable=True)  # JSON array of source chunks
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), default=func.now()
    )

    document: Mapped["Document"] = relationship("Document", back_populates="chats")


class Podcast(Base):
    __tablename__ = "podcasts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    document_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("documents.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(64), default="generating"
    )  # generating | ready | error
    script: Mapped[str] = mapped_column(Text, nullable=True)
    characters: Mapped[str] = mapped_column(Text, nullable=True)  # JSON: {host_a: {...}, host_b: {...}}
    audio_path: Mapped[str] = mapped_column(String(1024), nullable=True)
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), default=func.now()
    )

    document: Mapped["Document"] = relationship("Document", back_populates="podcasts")


class ExplainerVideo(Base):
    __tablename__ = "explainer_videos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    document_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("documents.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(64), default="generating"
    )  # generating | ready | error
    domain: Mapped[str] = mapped_column(String(128), nullable=True)  # detected domain e.g. "medicine"
    persona_name: Mapped[str] = mapped_column(String(128), nullable=True)  # e.g. "Dr. Alex"
    persona_type: Mapped[str] = mapped_column(String(64), nullable=True)   # e.g. "doctor"
    persona_emoji: Mapped[str] = mapped_column(String(16), nullable=True)  # e.g. "👨‍⚕️"
    script: Mapped[str] = mapped_column(Text, nullable=True)  # JSON array of segments
    audio_path: Mapped[str] = mapped_column(String(1024), nullable=True)
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), default=func.now()
    )

    document: Mapped["Document"] = relationship("Document", back_populates="explainers")
