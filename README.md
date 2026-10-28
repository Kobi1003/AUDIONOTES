# AudioNotes AI 🎙️

[![GitHub Repo](https://img.shields.io/badge/GitHub-Repository-blue?logo=github)](https://github.com/Kobi1003/AUDIONOTES)
[![Live Demo](https://img.shields.io/badge/Render-Live%20Demo-46E3B7?logo=render)](https://audionotes-ai.onrender.com)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **AI-Powered Document Intelligence & 100% Hands-Free Accessible Voice Companion**

AudioNotes AI transforms static documents (PDF, TXT, DOCX) into interactive, intelligent knowledge bases. Designed from the ground up for universal accessibility, it offers both a modern **Visual Interface** and an industry-leading, **Blind-Accessible Audio Mode** powered by conversational RAG, high-precision vector search, and AI-generated podcasts & explainer videos.

---

## 🌐 Live Links

- **GitHub Repository**: [https://github.com/Kobi1003/AUDIONOTES](https://github.com/Kobi1003/AUDIONOTES)
- **Live Deployment**: [https://audionotes-ai.onrender.com](https://audionotes-ai.onrender.com) *(or your deployed Render service URL)*

---

## 🌟 Key Highlights

### ♿ 1. Hands-Free Blind-Accessible Audio Mode
- **Zero-Sight Required**: Automatic spoken onboarding on first launch guiding the user on how to navigate using just the keyboard and voice.
- **Single `Enter` Wake-Up**: Press `Enter` anytime to instantly pause playback and activate the microphone to ask questions.
- **Double `Enter` Safe Exit**: Press `Enter` twice quickly to exit Audio Mode and return safely to the Home Accessibility Gate.
- **Continuous Processing Voice Feedback**: While any document is uploaded and prepared for RAG retrieval (chunking, embedding, vector store creation), a spoken status (`"File is being processed, please wait"`) announces continuously at short intervals so visually impaired users are never left in silence.
- **Hardened Web Speech Queue**: Built-in V8 garbage collection protection (`window.__speechActiveUtterance`) and local TTS voice prioritization to prevent mid-sentence audio cutoffs on Chromium and Windows Edge.

### 🔍 2. Precision RAG (Retrieval-Augmented Generation)
- **FAISS Vector Database**: High-speed local similarity search across all document chunks.
- **Hybrid Search**: Query single documents or run global semantic searches across your entire knowledge base simultaneously.
- **Source Verification**: Grounded AI responses with direct chunk excerpts and relevance scores.

### 🎙️ 3. AI Podcasts & Spoken Explainers
- **Multi-Persona Explainer Audio**: Generates conversational summaries narrated by AI personas with dynamic scene visualization.
- **Edge TTS & gTTS Fallbacks**: High-definition natural neural speech synthesis with automated local fallbacks.

### 💻 4. Glassmorphic Visual Interface
- Modern dark-mode dashboard with interactive document viewer, inline microphone speech-to-text, document management, and podcast player.

---

## ⌨️ Accessibility & Controls Reference

| Action | Control / Voice Command | Description |
|---|---|---|
| **Wake Microphone** | Press `Enter` or `Space` | Halts any active audio playback and turns on the microphone. |
| **Exit Audio Mode** | Press `Enter` **twice quickly** | Confirms exit with audio feedback and returns to Home Gate. |
| **Reset to Start** | Press `Escape` | Resets audio queue and returns to the initial Audio Mode home screen. |
| **Upload Document** | Say *"upload"* or *"add document"* | Opens the system file picker to select a document. |
| **Spoken Processing** | *Automated* | Speaks *"File is being processed, please wait"* every 4.5s until indexed. |
| **Select Note** | Say *"note 1"*, *"note 2"*, etc. | Opens the corresponding document from your library. |
| **Listen to Summary** | Say *"summary"* or *"overview"* | Generates and narrates a spoken audio summary. |
| **Stop Audio** | Say *"stop"* or *"quiet"* | Immediately silences the assistant. |
| **Hear Help** | Say *"help"* | Spoken contextual guide listing all available voice commands. |

---

## 🛠️ Architecture & Tech Stack

```
AUDIONOTES/
├── backend/                      # FastAPI Python Backend (Port 8000)
│   ├── app/
│   │   ├── api/                  # REST endpoints & Pydantic models
│   │   ├── core/                 # Database, FAISS & environment configuration
│   │   ├── models/               # SQLAlchemy ORM models
│   │   └── services/             # RAG, Ingestion, FAISS VectorStore, Podcast & Explainer
│   ├── uploads/                  # Uploaded document storage
│   ├── vector_indices/           # Persisted FAISS vector stores
│   └── requirements.txt
├── frontend/                     # React 18 + TypeScript + Vite SPA
│   ├── src/
│   │   ├── components/
│   │   │   ├── AccessibilityGate.tsx   # Entry gate selecting Audio vs Visual mode
│   │   │   ├── BlindModeApp.tsx        # Complete voice-driven accessible interface
│   │   │   ├── BlindCompanion.tsx      # In-document voice companion
│   │   │   ├── ChatSection.tsx         # Visual RAG chat interface
│   │   │   ├── ExplainerVideo.tsx      # Video/Audio explainer player
│   │   │   └── Sidebar.tsx             # Document library & upload
│   │   ├── api.ts                      # Fully typed API client
│   │   └── App.tsx                     # Main application entry
│   └── package.json
├── Dockerfile                    # Multi-stage Docker build (Node 20 + Python 3.11)
├── docker-compose.yml            # Containerized local orchestration
├── render.yaml                   # Infrastructure-as-code for Render deployment
└── README.md
```

- **Frontend**: React 18, TypeScript, Vite, Web Speech API (`webkitSpeechRecognition` & `speechSynthesis`), Lucide Icons.
- **Backend**: FastAPI, Uvicorn, SQLAlchemy, SQLite, FAISS, PyMuPDF (`fitz`), Edge-TTS, gTTS.
- **AI Models**: Google Gemini API (`gemini-flash-lite-latest` / `gemini-2.0-flash` & `gemini-embedding-001` / `text-embedding-004`).

---

## 🚀 Quick Start (Local Setup)

### Prerequisites
- Node.js 18+ & npm
- Python 3.10+
- Google Gemini API Key ([Get one here](https://aistudio.google.com/app/apikey))

### 1. Backend Setup

```bash
cd backend

# Create and activate virtual environment
python -m venv venv
# On Windows:
.\venv\Scripts\activate
# On Linux/macOS:
# source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Create .env file
cp .env.example .env # or create backend/.env
```

Add your Gemini API Key in `backend/.env`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
AI_PROVIDER=gemini
GEMINI_CHAT_MODEL=gemini-flash-lite-latest
GEMINI_EMBED_MODEL=gemini-embedding-001
```

Start the backend server:
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 2. Frontend Setup

In a new terminal:
```bash
cd frontend

# Install packages
npm install

# Start Vite dev server
npm run dev
```

Visit **`http://localhost:5173`** in Google Chrome or Microsoft Edge (recommended for Web Speech API support).

---

## 🐳 Docker Setup

Run the entire application in a single container with persistent volume mounts:

```bash
# Set your Gemini API Key
export GEMINI_API_KEY="your_api_key_here" # Linux/macOS
# $env:GEMINI_API_KEY="your_api_key_here" # Windows PowerShell

# Build and start via Docker Compose
docker-compose up --build -d
```

Access the app directly at **`http://localhost:8000`**.

---

## ☁️ Deploying to Render

This repository includes a production-ready **multi-stage Dockerfile** and **`render.yaml`** blueprint that compiles the frontend and serves it seamlessly from FastAPI as a single container on Render's free tier.

### Option A: Blueprint Deploy (Recommended)
1. Push your repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com/), click **New** > **Blueprint**.
3. Select your `AUDIONOTES` repository.
4. Render will detect `render.yaml`. Set your `GEMINI_API_KEY` when prompted.
5. Click **Apply**.

### Option B: Manual Web Service Deploy
1. Click **New** > **Web Service** in Render.
2. Select your repository: `https://github.com/Kobi1003/AUDIONOTES`.
3. Choose **Docker** as the Runtime.
4. Set the **Dockerfile Path** to `Dockerfile`.
5. Under **Environment Variables**, add:
   - `GEMINI_API_KEY`: *(Your Google Gemini API Key)*
   - `AI_PROVIDER`: `gemini`
   - `GEMINI_CHAT_MODEL`: `gemini-flash-lite-latest`
   - `GEMINI_EMBED_MODEL`: `gemini-embedding-001`
   - `PORT`: `8000`
6. Click **Deploy Web Service**.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | *(Required)* | Google Gemini API Key from Google AI Studio. |
| `AI_PROVIDER` | `gemini` | AI Provider (`gemini` or `ollama`). |
| `GEMINI_CHAT_MODEL` | `gemini-flash-lite-latest` | Model used for RAG Q&A and conversation. |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Embedding model for document indexing. |
| `PORT` | `8000` | Port on which FastAPI serves the API and static SPA. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Endpoint for Ollama if running local LLMs. |

---

## 📡 Core API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/documents/` | Upload document file (PDF, TXT, DOCX) and begin FAISS RAG indexing. |
| `GET` | `/api/documents/` | List all documents and their indexing statuses (`uploading`, `ingesting`, `ready`). |
| `GET` | `/api/documents/{id}` | Retrieve document metadata and processing status. |
| `POST` | `/api/chat/stream` | Stream RAG Q&A response for a specific document with sources. |
| `POST` | `/api/chat/global-stream` | Stream global RAG search across all documents in library. |
| `POST` | `/api/explainers/` | Generate AI spoken podcast / explainer audio. |
| `GET` | `/health` | Application health check. |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE). Free for open-source, non-profit, accessibility, and educational use.
