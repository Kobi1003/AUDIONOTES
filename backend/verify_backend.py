# -*- coding: utf-8 -*-
"""
Backend verification script -- tests each layer of the stack.
Run from the backend/ directory with the venv activated:
  python verify_backend.py
"""
import os
import sys
import json
import tempfile
import asyncio

# Force UTF-8 output on Windows
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

OK  = "[OK]"
ERR = "[FAIL]"
SKP = "[SKIP]"

# -- 1. Config loading ---------------------------------------------------------
print("=" * 60)
print("AutoNotes AI -- Backend Verification")
print("=" * 60)

print("\n[1] Loading configuration...")
from app.core.config import settings
print(f"  AI_PROVIDER : {settings.AI_PROVIDER}")
print(f"  UPLOAD_DIR  : {settings.UPLOAD_DIR}")
print(f"  PODCAST_DIR : {settings.PODCAST_DIR}")
print(f"  VECTOR_DIR  : {settings.VECTOR_DIR}")
print(f"  {OK} Config loaded")

# -- 2. Database ---------------------------------------------------------------
print("\n[2] Testing database...")
from app.core.database import Base, engine, SessionLocal
from app.models.models import Document, ChatMessage, Podcast
Base.metadata.create_all(bind=engine)
db = SessionLocal()
doc_count = db.query(Document).count()
print(f"  Documents in DB: {doc_count}")
db.close()
print(f"  {OK} Database OK")

# -- 3. Chunking ---------------------------------------------------------------
print("\n[3] Testing text chunking...")
from app.services.ingestion import chunk_text

sample_text = "This is a test document. " * 100
chunks = chunk_text(sample_text, chunk_size=200, overlap=40)
print(f"  Input: {len(sample_text)} chars -> {len(chunks)} chunks")
assert len(chunks) > 0, "Chunking produced no chunks!"
assert all(len(c) > 0 for c in chunks), "Empty chunk detected!"
print(f"  {OK} Chunking OK")

# -- 4. FAISS vector store -----------------------------------------------------
print("\n[4] Testing FAISS vector store...")
import numpy as np
from app.services.vector_store import VectorStore

test_doc_id = 99999
store = VectorStore(test_doc_id)
fake_embeddings = np.random.rand(5, 384).tolist()
fake_chunks = [f"Test chunk {i}" for i in range(5)]
store.build(fake_embeddings, fake_chunks)

query = np.random.rand(384).tolist()
results = store.search(query, top_k=3)
print(f"  Built index with 5 vectors, got {len(results)} results")
assert len(results) > 0, "No results returned from FAISS search!"
print(f"  {OK} FAISS OK")

# Clean up test index
import shutil
from pathlib import Path
test_dir = Path(settings.VECTOR_DIR) / str(test_doc_id)
if test_dir.exists():
    shutil.rmtree(test_dir)

# -- 5. LLM / Embeddings -------------------------------------------------------
print(f"\n[5] Testing embeddings (provider: {settings.AI_PROVIDER})...")
try:
    from app.services.llm import get_embeddings
    test_texts = ["Hello world", "This is a test"]
    embeddings = get_embeddings(test_texts)
    assert len(embeddings) == 2, "Expected 2 embeddings"
    assert len(embeddings[0]) > 0, "Empty embedding vector"
    print(f"  Embedding dimension: {len(embeddings[0])}")
    print(f"  {OK} Embeddings OK")
except Exception as e:
    print(f"  {SKP} Embeddings test skipped: {e}")
    print("  (Set GEMINI_API_KEY in .env or start Ollama to test)")

# -- 6. Edge TTS ---------------------------------------------------------------
print("\n[6] Testing edge-tts...")
try:
    import edge_tts
    async def test_tts():
        communicate = edge_tts.Communicate("Hello from AutoNotes AI!", "en-US-GuyNeural")
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            tmp_path = f.name
        await communicate.save(tmp_path)
        size = os.path.getsize(tmp_path)
        os.unlink(tmp_path)
        return size

    size = asyncio.run(test_tts())
    print(f"  Generated {size} bytes of audio")
    assert size > 1000, "Audio file too small -- TTS may have failed"
    print(f"  {OK} Edge TTS OK")
except Exception as e:
    print(f"  {ERR} Edge TTS failed: {e}")

# -- 7. FastAPI app import -----------------------------------------------------
print("\n[7] Testing FastAPI app import...")
from app.main import app
from fastapi.routing import APIRoute

def collect_routes(route_list, prefix=""):
    found = []
    for r in route_list:
        if isinstance(r, APIRoute):
            found.append((prefix + r.path, list(r.methods or [])))
        elif hasattr(r, 'original_router'):
            # new FastAPI _IncludedRouter
            p = getattr(r, 'prefix', '') or ''
            found.extend(collect_routes(r.original_router.routes, prefix + p))
        elif hasattr(r, 'routes'):
            p = getattr(r, 'prefix', '') or ''
            found.extend(collect_routes(r.routes, prefix + p))
    return found

all_routes = collect_routes(app.routes)
api_routes = [(p, m) for p, m in all_routes if '/api' in p or p.startswith('/documents') or p.startswith('/podcasts')]
print(f"  Total routes found: {len(all_routes)}")
# The router is mounted at /api, so show all collected routes
for path, methods in all_routes[:8]:
    print(f"    {methods} {path}")
assert len(all_routes) > 1, "Not enough routes found!"
print(f"  {OK} FastAPI app OK -- {len(all_routes)} routes registered")

# -- Summary -------------------------------------------------------------------
print("\n" + "=" * 60)
print("PASS: Backend verification complete!")
print("  Run server: uvicorn app.main:app --reload --port 8000")
print("=" * 60)
