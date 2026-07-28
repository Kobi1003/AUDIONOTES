"""
PDF ingestion pipeline:
1. Extract text from PDF using pypdf
2. Split into overlapping chunks
3. Embed chunks using configured LLM provider
4. Build & persist FAISS vector index
"""
import logging
from pathlib import Path

import fitz  # PyMuPDF
from pypdf import PdfReader
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.models import Document
from app.services import llm as llm_service
from app.services.vector_store import VectorStore

logger = logging.getLogger(__name__)


# ─────────────────────────── Text Extraction ──────────────────────────────────

def extract_text_from_pdf(file_path: str, document_id: int = 0) -> tuple[str, int]:
    """Return (full_text, page_count). Extracts images and injects markdown links."""
    doc = fitz.open(file_path)
    pages = []
    
    images_dir = Path(settings.UPLOAD_DIR) / "images" / str(document_id)
    images_dir.mkdir(parents=True, exist_ok=True)
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        
        # Render the full page as a high-quality image snapshot
        pix = page.get_pixmap(dpi=150)
        img_filename = f"page_{page_num + 1}.png"
        img_path = images_dir / img_filename
        pix.save(img_path)
        pix = None  # Free memory
        
        img_url = f"/images/{document_id}/{img_filename}"
        img_markdown = f"![Page {page_num + 1}](http://localhost:8000{img_url})"
        
        page_text = page.get_text()
        
        # Always append the page image link to the text so the LLM knows it's available
        page_text += f"\n\n{img_markdown}"
            
        if page_text.strip():
            pages.append(page_text.strip())
            
    return "\n\n".join(pages), len(doc)


# ─────────────────────────── Chunking ─────────────────────────────────────────

def chunk_text(text: str, chunk_size: int = None, overlap: int = None) -> list[str]:
    """Simple sliding-window character chunker."""
    chunk_size = chunk_size or settings.CHUNK_SIZE
    overlap = overlap or settings.CHUNK_OVERLAP

    chunks = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = min(start + chunk_size, text_len)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == text_len:
            break
        start += chunk_size - overlap  # slide forward with overlap

    return chunks


# ─────────────────────────── Main Pipeline ────────────────────────────────────

def ingest_document(document_id: int, file_path: str, db: Session) -> None:
    """
    Full ingestion pipeline for a single document.
    Updates the Document record status throughout.
    """
    doc = db.get(Document, document_id)
    if not doc:
        logger.error(f"Document {document_id} not found in DB.")
        return

    try:
        # Step 1: Update status
        doc.status = "ingesting"
        db.commit()

        # Step 2: Extract text
        logger.info(f"Extracting text from: {file_path}")
        full_text, page_count = extract_text_from_pdf(file_path, document_id)

        if not full_text.strip():
            raise ValueError("PDF appears to be empty or image-based (no extractable text).")

        doc.page_count = page_count
        db.commit()

        # Step 3: Chunk
        logger.info("Chunking text...")
        chunks = chunk_text(full_text)
        logger.info(f"Created {len(chunks)} chunks.")

        # Step 4: Embed
        logger.info(f"Embedding {len(chunks)} chunks with provider={settings.AI_PROVIDER}...")
        # Batch embed in groups of 50 to avoid rate limits
        all_embeddings = []
        batch_size = 50
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i : i + batch_size]
            embeddings = llm_service.get_embeddings(batch)
            all_embeddings.extend(embeddings)
            logger.info(f"  Embedded batch {i // batch_size + 1}/{(len(chunks) - 1) // batch_size + 1}")

        # Validate all embeddings have the same dimension (prevents numpy inhomogeneous array errors)
        dims = set(len(e) for e in all_embeddings)
        if len(dims) > 1:
            logger.warning(
                f"Inconsistent embedding dimensions detected: {dims}. "
                "Re-embedding all chunks with local SentenceTransformers for consistency."
            )
            from app.services.llm import _st_embed
            all_embeddings = _st_embed(chunks)

        # Step 5: Build FAISS index
        logger.info("Building FAISS index...")
        store = VectorStore(document_id)
        store.build(all_embeddings, chunks)

        # Step 6: Update document record
        doc.chunk_count = len(chunks)
        doc.vector_index_path = store.get_index_path()
        doc.status = "ready"
        db.commit()

        logger.info(f"Document {document_id} ingestion complete.")

    except Exception as e:
        logger.exception(f"Ingestion failed for document {document_id}: {e}")
        doc.status = "error"
        doc.error_message = str(e)
        db.commit()
        raise
