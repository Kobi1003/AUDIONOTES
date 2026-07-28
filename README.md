# AutoNotes AI 🎙️

**Upload PDFs → Chat with your documents → Generate AI Podcast episodes**

A full-stack application featuring RAG-based document chat and dual-host podcast generation using Microsoft Edge TTS (free, no API key required).

---

## Architecture

```
AUDIONOTES/
├── backend/          # FastAPI Python backend
│   ├── app/
│   │   ├── core/     # Config, DB setup
│   │   ├── models/   # SQLAlchemy ORM models
│   │   ├── services/ # Ingestion, LLM, Podcast, Vector Store
│   │   └── api/      # Endpoints + Pydantic schemas
│   ├── uploads/       # Stored PDFs
│   ├── vector_indices/ # FAISS indices per document
│   ├── podcasts/      # Generated MP3 files
│   ├── requirements.txt
│   └── .env
└── frontend/         # React + TypeScript Vite app
    └── src/
        ├── components/  # Sidebar, ChatSection, PodcastPlayer, Waveform
        ├── api.ts       # Typed API client
        └── App.tsx      # Main app
```

---

## Quick Start

### 1. Backend Setup

```powershell
cd backend

# Create virtual environment
python -m venv venv
.\venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure API key
# Edit .env and set GEMINI_API_KEY=your_key_here
# OR set AI_PROVIDER=ollama for local mode

# Run the server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 2. Frontend Setup

```powershell
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | `gemini` | `gemini` or `ollama` |
| `GEMINI_API_KEY` | *(required for gemini)* | Google Gemini API key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3` | Ollama chat model |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `HOST_A_VOICE` | `en-US-GuyNeural` | Male podcast host voice |
| `HOST_B_VOICE` | `en-US-JennyNeural` | Female podcast host voice |

---

## Features

- 📄 **PDF Upload** — Drag & drop or click to upload
- 🔍 **RAG Chat** — Ask questions, get cited answers from the document
- 🎙️ **AI Podcast** — Generate a dual-host conversation about your document
- 🔊 **Free TTS** — Uses Microsoft Edge Neural voices (no API key!)
- 🎵 **Custom Player** — Animated waveform, seek bar, speed control, MP3 download
- 🌙 **Dark Glassmorphic UI** — Stunning premium design

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/documents/upload` | Upload PDF |
| `GET` | `/api/documents` | List all documents |
| `DELETE` | `/api/documents/{id}` | Delete document |
| `POST` | `/api/documents/{id}/chat` | Ask a question (RAG) |
| `GET` | `/api/documents/{id}/chat/history` | Chat history |
| `POST` | `/api/documents/{id}/podcast` | Generate podcast |
| `GET` | `/api/podcasts/{id}/audio` | Stream MP3 |
| `GET` | `/health` | Health check |

Interactive docs: **http://localhost:8000/docs**

---

## Requirements

- Python 3.10+
- Node.js 18+
- FFmpeg *(optional — for higher quality audio stitching; falls back to raw MP3 concat)*
- Ollama *(only if using local AI mode)*
