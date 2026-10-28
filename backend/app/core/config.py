import os
from pathlib import Path
from pydantic_settings import BaseSettings

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
_env_path = BACKEND_DIR / ".env"
_db_path = (BACKEND_DIR / "autonotes.db").as_posix()


class Settings(BaseSettings):
    PROJECT_NAME: str = "AutoNotes AI"
    DATABASE_URL: str = f"sqlite:///{_db_path}"

    # Storage directories (absolute paths inside backend directory)
    UPLOAD_DIR: str = str(BACKEND_DIR / "uploads")
    PODCAST_DIR: str = str(BACKEND_DIR / "podcasts")
    VECTOR_DIR: str = str(BACKEND_DIR / "vector_indices")
    EXPLAINER_DIR: str = str(BACKEND_DIR / "explainer_videos")

    # AI Configuration
    AI_PROVIDER: str = "gemini"  # "gemini" or "ollama"
    GEMINI_API_KEY: str = ""
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "llama3"
    OLLAMA_EMBED_MODEL: str = "nomic-embed-text"

    # Gemini model names (google-genai SDK)
    GEMINI_CHAT_MODEL: str = "gemini-flash-lite-latest"
    GEMINI_EMBED_MODEL: str = "gemini-embedding-001"

    # TTS Voice Config (Microsoft Edge TTS)
    HOST_A_VOICE: str = "en-US-GuyNeural"
    HOST_B_VOICE: str = "en-US-JennyNeural"
    HOST_A_NAME: str = "Alex"
    HOST_B_NAME: str = "Sarah"

    # Optional ElevenLabs
    ELEVENLABS_API_KEY: str = ""

    # Chunking
    CHUNK_SIZE: int = 500
    CHUNK_OVERLAP: int = 100

    model_config = {
        "env_file": [str(_env_path), ".env"],
        "extra": "ignore",
    }


settings = Settings()

# Ensure required directories exist
for dir_name in [settings.UPLOAD_DIR, settings.PODCAST_DIR, settings.VECTOR_DIR, settings.EXPLAINER_DIR]:
    Path(dir_name).mkdir(parents=True, exist_ok=True)
