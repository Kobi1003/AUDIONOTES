"""
FastAPI application entry point.
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.endpoints import router
from app.core.config import settings
from app.core.database import Base, engine, init_db

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# Initialize database schema and migrations
init_db()

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="RAG-powered document understanding, chat, and podcast generation API.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS – allow all origins in production, dev servers in local
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import os
from fastapi.responses import FileResponse

os.makedirs(os.path.join(settings.UPLOAD_DIR, "images"), exist_ok=True)
app.mount("/images", StaticFiles(directory=os.path.join(settings.UPLOAD_DIR, "images")), name="images")

app.include_router(router, prefix="/api")


@app.get("/health")
def health_check():
    return {"status": "ok", "service": settings.PROJECT_NAME}


# Serve built React frontend SPA if dist folder exists
FRONTEND_DIST_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "frontend", "dist"),
    os.path.join(os.getcwd(), "frontend", "dist"),
    "/app/frontend/dist",
]
FRONTEND_DIST = next((p for p in FRONTEND_DIST_CANDIDATES if os.path.isdir(p)), None)

if FRONTEND_DIST:
    assets_dir = os.path.join(FRONTEND_DIST, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith("api") or full_path.startswith("images") or full_path == "health":
            return {"error": "Not found"}
        target = os.path.join(FRONTEND_DIST, full_path)
        if full_path and os.path.isfile(target):
            return FileResponse(target)
        return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))
