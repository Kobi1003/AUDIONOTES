"""
FastAPI route handlers.
"""
import json
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.schemas import (
    ChatRequest,
    ChatResponse,
    DocumentOut,
    ExplainerOut,
    PodcastOut,
    SourceChunk,
    StatusResponse,
)
from app.core.config import settings
from app.core.database import get_db
from app.models.models import ChatMessage, Document, ExplainerVideo, Podcast
from app.services import llm as llm_service
from app.services.explainer import generate_explainer
from app.services.ingestion import ingest_document
from app.services.podcast import generate_podcast
from app.services.vector_store import VectorStore

logger = logging.getLogger(__name__)
router = APIRouter()

# Thread pool for blocking background tasks
_executor = ThreadPoolExecutor(max_workers=4)


# ─────────────────────────── Documents ────────────────────────────────────────

@router.post("/documents/upload", response_model=DocumentOut, status_code=201)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload a PDF and kick off background ingestion."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    # Save file to disk
    safe_name = f"{uuid.uuid4().hex}_{file.filename}"
    file_path = str(Path(settings.UPLOAD_DIR) / safe_name)

    contents = await file.read()
    with open(file_path, "wb") as f:
        f.write(contents)

    # Create DB record
    doc = Document(
        filename=safe_name,
        original_name=file.filename,
        file_path=file_path,
        file_size=len(contents),
        status="uploading",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    # Start ingestion in background
    background_tasks.add_task(_run_ingestion, doc.id, file_path)

    return doc


def _run_ingestion(document_id: int, file_path: str):
    """Run ingestion in a background thread with its own DB session."""
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        ingest_document(document_id, file_path, db)
    finally:
        db.close()


@router.get("/documents", response_model=list[DocumentOut])
def list_documents(db: Session = Depends(get_db)):
    """List all uploaded documents."""
    return db.query(Document).order_by(Document.created_at.desc()).all()


@router.get("/documents/{document_id}", response_model=DocumentOut)
def get_document(document_id: int, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@router.delete("/documents/{document_id}", response_model=StatusResponse)
def delete_document(document_id: int, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    import shutil

    # Collect all file paths to clean up
    paths_to_remove = [doc.file_path, doc.vector_index_path]

    # Images directory for this document
    images_dir = os.path.join(settings.UPLOAD_DIR, "images", str(document_id))
    paths_to_remove.append(images_dir)

    # Collect podcast and explainer audio file paths
    for podcast in doc.podcasts:
        if podcast.audio_path:
            paths_to_remove.append(podcast.audio_path)
    for explainer in doc.explainers:
        if explainer.audio_path:
            paths_to_remove.append(explainer.audio_path)

    # Remove files
    for path in paths_to_remove:
        if path and os.path.exists(path):
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path)
                else:
                    os.remove(path)
            except Exception as e:
                logger.warning(f"Failed to remove {path}: {e}")

    db.delete(doc)
    db.commit()
    logger.info(f"Document {document_id} deleted successfully.")
    return StatusResponse(status="ok", message="Document deleted.")


# ─────────────────────────── Chat / RAG ────────────────────────────────────────

# ─────────────────────────── Chat / RAG ────────────────────────────────────────

@router.post("/documents/{document_id}/chat")
def chat_with_document(
    document_id: int,
    request: ChatRequest,
    db: Session = Depends(get_db),
):
    """RAG: answer a question about the document (streaming)."""
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document is not ready for chat (status: {doc.status})",
        )

    # Fetch prior chat history
    existing_messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.document_id == document_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    history_list = [{"role": m.role, "content": m.content} for m in existing_messages]

    # Contextualize vector search query with prior turn if available
    search_query = request.question
    if history_list:
        last_user_msgs = [m["content"] for m in history_list if m["role"] == "user"]
        if last_user_msgs:
            search_query = f"{last_user_msgs[-1]} | {request.question}"

    # Retrieve relevant chunks
    store = VectorStore(document_id)
    query_embedding = llm_service.get_query_embedding(search_query)
    results = store.search(query_embedding, top_k=15)

    if not results:
        raise HTTPException(status_code=500, detail="No chunks found in vector store.")

    context_chunks = [r["chunk"] for r in results]
    sources_data = [{"chunk": r["chunk"][:300], "score": r["score"]} for r in results]
    sources_json = json.dumps(sources_data)

    # Persist user message
    user_msg = ChatMessage(
        document_id=document_id, role="user", content=request.question
    )
    db.add(user_msg)
    db.commit()

    def generate_response():
        full_answer = ""
        # 1. Send sources first
        yield json.dumps({"type": "sources", "sources": sources_data}) + "\n"

        # 2. Stream answer chunks
        for chunk in llm_service.rag_answer_stream(request.question, context_chunks, history=history_list):
            full_answer += chunk
            yield json.dumps({"type": "chunk", "text": chunk}) + "\n"
        
        # 3. Save assistant message to DB using a new session since we are in a generator
        from app.core.database import SessionLocal
        local_db = SessionLocal()
        try:
            assistant_msg = ChatMessage(
                document_id=document_id,
                role="assistant",
                content=full_answer,
                sources=sources_json,
            )
            local_db.add(assistant_msg)
            local_db.commit()
            local_db.refresh(assistant_msg)
            yield json.dumps({"type": "done", "message_id": assistant_msg.id}) + "\n"
        finally:
            local_db.close()

    return StreamingResponse(generate_response(), media_type="application/x-ndjson")


@router.get("/documents/{document_id}/chat/history")
def get_chat_history(document_id: int, db: Session = Depends(get_db)):
    """Get chat history for a document."""
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.document_id == document_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    return [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "sources": json.loads(m.sources) if m.sources else [],
            "created_at": m.created_at,
        }
        for m in messages
    ]


# ─────────────────────────── Blind Companion / Accessibility Chat ─────────────

@router.post("/documents/{document_id}/blind-chat")
def blind_chat_with_document(
    document_id: int,
    request: ChatRequest,
    db: Session = Depends(get_db),
):
    """Accessibility-tuned RAG chat for visually impaired / blind users.
    Returns plain spoken-English answers — no markdown, no visual references.
    Designed to be read aloud immediately by browser TTS.
    Persists messages for multi-turn history.
    """
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document is not ready for chat (status: {doc.status})",
        )

    # Fetch prior chat history
    existing_messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.document_id == document_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    history_list = [{"role": m.role, "content": m.content} for m in existing_messages]

    search_query = request.question
    if history_list:
        last_user_msgs = [m["content"] for m in history_list if m["role"] == "user"]
        if last_user_msgs:
            search_query = f"{last_user_msgs[-1]} | {request.question}"

    store = VectorStore(document_id)
    query_embedding = llm_service.get_query_embedding(search_query)
    results = store.search(query_embedding, top_k=15)

    if not results:
        raise HTTPException(status_code=500, detail="No chunks found in vector store.")

    context_chunks = [r["chunk"] for r in results]
    
    # Save user message
    user_msg = ChatMessage(document_id=document_id, role="user", content=request.question)
    db.add(user_msg)
    db.commit()

    def generate_response():
        full = ""
        for chunk in llm_service.blind_rag_answer_stream(request.question, context_chunks, history=history_list):
            full += chunk
            yield json.dumps({"type": "chunk", "text": chunk}) + "\n"
        
        # Save assistant response
        from app.core.database import SessionLocal
        local_db = SessionLocal()
        try:
            assistant_msg = ChatMessage(
                document_id=document_id,
                role="assistant",
                content=full,
            )
            local_db.add(assistant_msg)
            local_db.commit()
        finally:
            local_db.close()

        yield json.dumps({"type": "done", "text": full}) + "\n"

    return StreamingResponse(generate_response(), media_type="application/x-ndjson")



class GlobalQueryRequest(BaseModel):
    query: str
    mode: Optional[str] = "question"  # "question" or "summary"


@router.post("/global-search")
def global_search(
    request: GlobalQueryRequest,
    db: Session = Depends(get_db),
):
    """Voice & Blind accessible global search over ALL documents or filtered domain/category.
    Aggregates matching documents, performs RAG across matched chunks or falls back to general LLM.
    """
    query_str = request.query.strip().lower()
    docs = db.query(Document).filter(Document.status == "ready").all()
    
    if not docs:
        def empty_gen():
            msg = "You currently have no documents in your library. I will answer using general knowledge."
            yield json.dumps({"type": "matched_docs", "count": 0, "names": []}) + "\n"
            for chunk in llm_service.blind_rag_answer_stream(request.query, []):
                yield json.dumps({"type": "chunk", "text": chunk}) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        return StreamingResponse(empty_gen(), media_type="application/x-ndjson")

    # Match documents by title/keyword (e.g. "biology", "physics")
    matched_docs = [
        d for d in docs
        if any(term in d.original_name.lower() for term in query_str.split()) or query_str in d.original_name.lower()
    ]
    
    # If no specific title matches, search across ALL ready documents
    target_docs = matched_docs if matched_docs else docs

    # Gather top chunks across all ready documents and sort by FAISS similarity score
    candidate_results = []
    query_embedding = llm_service.get_query_embedding(request.query)
    for d in docs:
        store = VectorStore(d.id)
        if store.load():
            results = store.search(query_embedding, top_k=10)
            for r in results:
                candidate_results.append({
                    "score": r["score"],
                    "chunk": f"[{d.original_name}]: {r['chunk']}"
                })

    # Sort all retrieved chunks across all documents by similarity score descending
    candidate_results.sort(key=lambda x: x["score"], reverse=True)
    all_chunks = [c["chunk"] for c in candidate_results[:25]]

    matched_names = [d.original_name for d in docs]

    def stream_answer():
        yield json.dumps({"type": "matched_docs", "count": len(docs), "names": matched_names, "is_specific_match": True}) + "\n"
        
        prompt = request.query
        if request.mode == "summary":
            prompt = f"Provide a complete, structured, easy-to-understand spoken summary of all information regarding: {request.query}"

        for chunk in llm_service.blind_rag_answer_stream(prompt, all_chunks):
            yield json.dumps({"type": "chunk", "text": chunk}) + "\n"
        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(stream_answer(), media_type="application/x-ndjson")


# ─────────────────────────── Podcasts ─────────────────────────────────────────

@router.post("/documents/{document_id}/podcast", response_model=PodcastOut, status_code=201)
def create_podcast(
    document_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Trigger podcast generation for a document."""
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document is not ready (status: {doc.status})",
        )

    podcast = Podcast(document_id=document_id, status="generating")
    db.add(podcast)
    db.commit()
    db.refresh(podcast)

    background_tasks.add_task(_run_podcast_generation, podcast.id, document_id, doc.file_path)

    return podcast


def _run_podcast_generation(podcast_id: int, document_id: int, file_path: str):
    """Run podcast generation in background with its own DB session."""
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        podcast = db.get(Podcast, podcast_id)
        if not podcast:
            return

        script_json, audio_path = generate_podcast(document_id, file_path)

        podcast.script = script_json
        podcast.audio_path = audio_path
        podcast.status = "ready"
        podcast.duration_seconds = _get_mp3_duration(audio_path)
        db.commit()

    except Exception as e:
        logger.exception(f"Podcast generation failed for podcast {podcast_id}: {e}")
        db = SessionLocal()
        podcast = db.get(Podcast, podcast_id)
        if podcast:
            podcast.status = "error"
            podcast.error_message = str(e)
            db.commit()
    finally:
        db.close()


def _get_mp3_duration(audio_path: str) -> int:
    """Accurate MP3 duration in seconds."""
    if not audio_path or not os.path.exists(audio_path):
        return 0
    try:
        from mutagen.mp3 import MP3
        return int(round(MP3(audio_path).info.length))
    except Exception:
        pass
    try:
        from pydub import AudioSegment
        audio = AudioSegment.from_mp3(audio_path)
        return int(len(audio) / 1000)
    except Exception:
        pass
    try:
        return int(os.path.getsize(audio_path) / (128 * 1024 / 8))
    except Exception:
        return 0


@router.get("/documents/{document_id}/podcasts", response_model=list[PodcastOut])
def list_podcasts(document_id: int, db: Session = Depends(get_db)):
    return (
        db.query(Podcast)
        .filter(Podcast.document_id == document_id)
        .order_by(Podcast.created_at.desc())
        .all()
    )


@router.get("/podcasts/{podcast_id}", response_model=PodcastOut)
def get_podcast(podcast_id: int, db: Session = Depends(get_db)):
    podcast = db.get(Podcast, podcast_id)
    if not podcast:
        raise HTTPException(status_code=404, detail="Podcast not found")
    return podcast


@router.get("/podcasts/{podcast_id}/audio")
def stream_podcast_audio(podcast_id: int, db: Session = Depends(get_db)):
    """Stream/download the generated podcast MP3."""
    podcast = db.get(Podcast, podcast_id)
    if not podcast:
        raise HTTPException(status_code=404, detail="Podcast not found")
    if podcast.status != "ready":
        raise HTTPException(status_code=400, detail=f"Podcast not ready (status: {podcast.status})")
    if not podcast.audio_path or not os.path.exists(podcast.audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    return FileResponse(
        path=podcast.audio_path,
        media_type="audio/mpeg",
        filename=f"podcast_{podcast_id}.mp3",
    )


# ─────────────────────────── Explainer Videos ─────────────────────────────────

@router.post("/documents/{document_id}/explainer", response_model=ExplainerOut, status_code=201)
def create_explainer(
    document_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Trigger AI explainer video generation for a document."""
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document is not ready (status: {doc.status})",
        )

    explainer = ExplainerVideo(document_id=document_id, status="generating")
    db.add(explainer)
    db.commit()
    db.refresh(explainer)

    background_tasks.add_task(_run_explainer_generation, explainer.id, document_id, doc.file_path)
    return explainer


def _run_explainer_generation(explainer_id: int, document_id: int, file_path: str):
    """Run explainer generation in a background thread with its own DB session."""
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        explainer = db.get(ExplainerVideo, explainer_id)
        if not explainer:
            return

        persona, script_json, audio_path = generate_explainer(document_id, file_path)

        explainer.domain = persona.get("type", "general")
        explainer.persona_name = persona.get("name", "Teacher Sam")
        explainer.persona_type = persona.get("type", "teacher")
        explainer.persona_emoji = persona.get("emoji", "🎓")
        explainer.script = script_json
        explainer.audio_path = audio_path
        explainer.status = "ready"
        explainer.duration_seconds = _get_mp3_duration(audio_path)
        db.commit()
        logger.info(f"Explainer {explainer_id} generation complete.")

    except Exception as e:
        logger.exception(f"Explainer generation failed for {explainer_id}: {e}")
        from app.core.database import SessionLocal as SL
        db2 = SL()
        try:
            exp = db2.get(ExplainerVideo, explainer_id)
            if exp:
                exp.status = "error"
                exp.error_message = str(e)
                db2.commit()
        finally:
            db2.close()
    finally:
        db.close()


@router.get("/documents/{document_id}/explainers", response_model=list[ExplainerOut])
def list_explainers(document_id: int, db: Session = Depends(get_db)):
    """List all explainer videos for a document."""
    return (
        db.query(ExplainerVideo)
        .filter(ExplainerVideo.document_id == document_id)
        .order_by(ExplainerVideo.created_at.desc())
        .all()
    )


@router.get("/explainers/{explainer_id}", response_model=ExplainerOut)
def get_explainer(explainer_id: int, db: Session = Depends(get_db)):
    """Get a single explainer video by ID."""
    explainer = db.get(ExplainerVideo, explainer_id)
    if not explainer:
        raise HTTPException(status_code=404, detail="Explainer not found")
    return explainer


@router.get("/explainers/{explainer_id}/audio")
def stream_explainer_audio(explainer_id: int, db: Session = Depends(get_db)):
    """Stream the generated explainer narration MP3."""
    explainer = db.get(ExplainerVideo, explainer_id)
    if not explainer:
        raise HTTPException(status_code=404, detail="Explainer not found")
    if explainer.status != "ready":
        raise HTTPException(status_code=400, detail=f"Explainer not ready (status: {explainer.status})")
    if not explainer.audio_path or not os.path.exists(explainer.audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    return FileResponse(
        path=explainer.audio_path,
        media_type="audio/mpeg",
        filename=f"explainer_{explainer_id}.mp3",
    )
