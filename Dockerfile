# ==============================================================
# Multi-stage Dockerfile for AudioNotes AI
# Combines React (Vite) frontend & FastAPI backend in one container
# ==============================================================

# ── Stage 1: Build Frontend ──
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# ── Stage 2: Production Python Backend ──
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies (ffmpeg for audio synthesis, curl for healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r ./backend/requirements.txt

# Copy backend code
COPY backend/ ./backend/

# Copy built frontend assets from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Ensure required persistent storage directories exist
RUN mkdir -p /app/backend/uploads /app/backend/podcasts /app/backend/vector_indices /app/backend/explainer_videos

# Environment variables
ENV PYTHONUNBUFFERED=1 \
    PORT=8000

# Expose default port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# Start FastAPI application
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --app-dir backend"]

