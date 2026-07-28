# AudioNotes AI 🎙️

> **AI-Powered Document Intelligence & Hands-Free Accessible Voice Companion**

AudioNotes AI is a full-stack application that transforms static PDFs into interactive, intelligent knowledge bases. It features an advanced **RAG (Retrieval-Augmented Generation)** chat engine, **AI Video explanations**, and a dedicated **Blind-Accessible Audio Mode** for 100% voice-driven document exploration.

---

## 🌟 Key Features

- ♿ **Blind-Accessible Audio Mode**: Complete hands-free, voice-guided experience designed for blind and visually impaired users. Speaks setup guidance on startup and listens for voice commands.
- ⌨️ **Instant Enter-Key Control**: Pressing the `Enter` key immediately halts speech synthesis and opens the microphone for hands-free voice Q&A.
- 📄 **PDF Ingestion & FAISS Vector Store**: Extracts text, page snapshots, and embeds document chunks using FAISS similarity search for high-precision retrieval.
- 🔍 **Global & Document RAG Chat**: Ask questions across a single note or search your entire document library. Answers are synthesized directly from retrieved vector chunks.
- 🎙️ **Microphone Voice Input**: Speak your questions directly using Web Speech API in both Visual Interface Mode and Audio Mode.
- 🎬 **AI Video Explainer**: Generates structured, domain-tailored video explanations with AI narrator personas.
- 🌙 **Glassmorphic Dark UI**: Modern responsive design built with React, TypeScript, and Vanilla CSS.

---

## 🛠️ Architecture & Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Web Speech API (SpeechRecognition & SpeechSynthesis).
- **Backend**: FastAPI (Python 3.10+), PyMuPDF (fitz), FAISS Vector Database, SQLAlchemy, PyPDF.
- **AI Models**: Google Gemini API (`gemini-2.0-flash` & `text-embedding-004`) / Ollama local fallback.

```
AUDIONOTES/
├── backend/                  # FastAPI Python backend
│   ├── app/
│   │   ├── api/              # Endpoints & Pydantic schemas
│   │   ├── core/             # Database & environment config
│   │   ├── models/           # SQLAlchemy DB models
│   │   └── services/         # Ingestion, FAISS VectorStore, LLM RAG, Explainer
│   ├── uploads/              # Uploaded PDF files
│   ├── vector_indices/       # FAISS indices per document
│   └── requirements.txt
└── frontend/                 # React + TypeScript Vite app
    └── src/
        ├── components/       # BlindModeApp, ChatSection, ExplainerVideo, Sidebar
        ├── api.ts            # Typed API client
        └── App.tsx           # App root & Accessibility Gate
```

---

## 🚀 Quick Start

### 1. Backend Setup

```powershell
cd backend

# Create virtual environment
python -m venv venv
.\venv\Scripts\activate      # On Windows
# source venv/bin/activate  # On Linux/macOS

# Install dependencies
pip install -r requirements.txt

# Configure your Gemini API Key in .env
# GEMINI_API_KEY=your_gemini_api_key_here

# Start backend server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 2. Frontend Setup

```powershell
cd frontend

# Install dependencies
npm install

# Start Vite dev server
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## ⚙️ Configuration (`backend/.env`)

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | `gemini` | `gemini` or `ollama` |
| `GEMINI_API_KEY` | *(required)* | Google Gemini API Key |
| `GEMINI_CHAT_MODEL` | `gemini-2.0-flash` | Gemini model for RAG chat |
| `GEMINI_EMBED_MODEL` | `text-embedding-004` | Gemini model for vector embeddings |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL (if local provider) |

---

## 📜 License

MIT License. Free for open-source use and educational projects.
