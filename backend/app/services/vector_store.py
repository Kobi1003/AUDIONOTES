"""
Vector store management using FAISS.
Handles saving and loading FAISS indices keyed by document ID.
"""
import os
import json
import logging
import numpy as np
from pathlib import Path
from typing import Optional

import faiss

from app.core.config import settings

logger = logging.getLogger(__name__)


class VectorStore:
    def __init__(self, document_id: int):
        self.document_id = document_id
        self.index_dir = Path(settings.VECTOR_DIR) / str(document_id)
        self.index_path = self.index_dir / "index.faiss"
        self.chunks_path = self.index_dir / "chunks.json"
        self.index: Optional[faiss.Index] = None
        self.chunks: list[str] = []

    def build(self, embeddings: list[list[float]], chunks: list[str]) -> None:
        """Build a new FAISS index from embeddings and save to disk."""
        self.index_dir.mkdir(parents=True, exist_ok=True)

        vectors = np.array(embeddings, dtype=np.float32)
        dimension = vectors.shape[1]

        self.index = faiss.IndexFlatIP(dimension)  # Inner product (cosine after normalizing)
        faiss.normalize_L2(vectors)
        self.index.add(vectors)
        self.chunks = chunks

        faiss.write_index(self.index, str(self.index_path))
        with open(self.chunks_path, "w", encoding="utf-8") as f:
            json.dump(chunks, f, ensure_ascii=False)

        logger.info(
            f"Built FAISS index with {len(chunks)} chunks for document {self.document_id}"
        )

    def load(self) -> bool:
        """Load FAISS index and chunks from disk."""
        if not self.index_path.exists() or not self.chunks_path.exists():
            return False
        try:
            self.index = faiss.read_index(str(self.index_path))
            with open(self.chunks_path, "r", encoding="utf-8") as f:
                self.chunks = json.load(f)
            return True
        except Exception as e:
            logger.error(f"Failed to load FAISS index for doc {self.document_id}: {e}")
            return False

    def search(self, query_embedding: list[float], top_k: int = 5) -> list[dict]:
        """Return top-k most similar chunks."""
        if self.index is None:
            if not self.load():
                return []

        vec = np.array([query_embedding], dtype=np.float32)
        if vec.shape[1] != self.index.d:
            logger.warning(
                f"Embedding dimension mismatch for doc {self.document_id}: query dim {vec.shape[1]} != index dim {self.index.d}"
            )
            if vec.shape[1] < self.index.d:
                vec = np.pad(vec, ((0, 0), (0, self.index.d - vec.shape[1])))
            else:
                vec = vec[:, :self.index.d]

        faiss.normalize_L2(vec)
        scores, indices = self.index.search(vec, top_k)

        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx == -1:
                continue
            results.append({"chunk": self.chunks[idx], "score": float(score)})
        return results

    def get_index_path(self) -> str:
        return str(self.index_dir)
