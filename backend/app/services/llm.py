"""
LLM service: unified interface for Gemini API (new google-genai SDK) and Ollama.
Provides text generation and embedding methods.
"""
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# ──────────────────────────── Gemini (new google-genai SDK) ────────────────────

def _get_genai_client():
    """Return a configured google-genai Client."""
    from google import genai
    return genai.Client(api_key=settings.GEMINI_API_KEY)


def _gemini_generate(prompt: str, system: Optional[str] = None) -> str:
    from google import genai
    from google.genai import types

    candidate_models = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-flash-latest"]
    last_error = None

    for model in candidate_models:
        try:
            client = _get_genai_client()
            config = types.GenerateContentConfig(
                system_instruction=system or "You are a helpful AI assistant.",
                temperature=0.7,
            )
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=config,
            )
            return response.text
        except Exception as e:
            last_error = e
            logger.warning(f"Gemini generation with {model} failed ({e}), trying next fallback model...")

    return f"AI Service Notice: Gemini request could not be completed. Details: {str(last_error)}"


def _gemini_generate_stream(prompt: str, system: Optional[str] = None):
    from google import genai
    from google.genai import types

    candidate_models = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-flash-latest"]
    last_error = None

    for model in candidate_models:
        try:
            client = _get_genai_client()
            config = types.GenerateContentConfig(
                system_instruction=system or "You are a helpful AI assistant.",
                temperature=0.7,
            )
            response = client.models.generate_content_stream(
                model=model,
                contents=prompt,
                config=config,
            )
            for chunk in response:
                if chunk.text:
                    yield chunk.text
            return  # Successfully finished streaming
        except Exception as e:
            last_error = e
            logger.warning(f"Gemini streaming with {model} failed ({e}), trying next fallback model...")

    err_msg = str(last_error)
    if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg:
        yield "\n\n⚠️ **API Quota Exceeded**: The Gemini API free tier rate limit has been reached across all models. Please wait 1 minute or update `GEMINI_API_KEY` in `.env`."
    elif "503" in err_msg or "UNAVAILABLE" in err_msg:
        yield "\n\n⚠️ **Service Temporarily Unavailable**: Gemini API server is currently busy. Please retry shortly."
    else:
        yield f"\n\n⚠️ **AI Service Error**: {err_msg}"


def _gemini_embed(texts: list[str]) -> list[list[float]]:
    import time

    try:
        from google import genai

        client = _get_genai_client()
        results = []
        for i, text in enumerate(texts):
            max_retries = 4
            for attempt in range(max_retries):
                try:
                    response = client.models.embed_content(
                        model=settings.GEMINI_EMBED_MODEL,
                        contents=text,
                    )
                    results.append(response.embeddings[0].values)
                    # Small delay between calls to avoid rate limits
                    if i < len(texts) - 1:
                        time.sleep(0.15)
                    break
                except Exception as retry_err:
                    err_str = str(retry_err).lower()
                    if "429" in err_str or "rate" in err_str or "quota" in err_str or "resource" in err_str:
                        wait = 2 ** attempt * 2  # 2, 4, 8, 16 seconds
                        logger.warning(f"Rate limited on embed call {i+1}/{len(texts)}, retrying in {wait}s (attempt {attempt+1}/{max_retries})...")
                        time.sleep(wait)
                    else:
                        raise  # Non-rate-limit error, propagate
            else:
                raise RuntimeError(f"Gemini embedding rate limit exceeded after {max_retries} retries for text {i+1}/{len(texts)}")
        return results
    except Exception as e:
        logger.warning(f"Gemini embedding failed ({e}), falling back to local SentenceTransformers.")
        return _st_embed(texts)


def _gemini_embed_query(text: str) -> list[float]:
    return _gemini_embed([text])[0]


# ──────────────────────────── Ollama ──────────────────────────────────────────

def _ollama_generate(prompt: str, system: Optional[str] = None) -> str:
    payload = {
        "model": settings.OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
    }
    if system:
        payload["system"] = system

    resp = httpx.post(
        f"{settings.OLLAMA_BASE_URL}/api/generate",
        json=payload,
        timeout=120.0,
    )
    resp.raise_for_status()
    return resp.json()["response"]


def _ollama_generate_stream(prompt: str, system: Optional[str] = None):
    payload = {
        "model": settings.OLLAMA_MODEL,
        "prompt": prompt,
        "stream": True,
    }
    if system:
        payload["system"] = system

    import json
    with httpx.stream("POST", f"{settings.OLLAMA_BASE_URL}/api/generate", json=payload, timeout=120.0) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines():
            if line:
                data = json.loads(line)
                yield data.get("response", "")


def _ollama_embed(texts: list[str]) -> list[list[float]]:
    embeddings = []
    for text in texts:
        resp = httpx.post(
            f"{settings.OLLAMA_BASE_URL}/api/embeddings",
            json={"model": settings.OLLAMA_EMBED_MODEL, "prompt": text},
            timeout=60.0,
        )
        resp.raise_for_status()
        embeddings.append(resp.json()["embedding"])
    return embeddings


def _ollama_embed_query(text: str) -> list[float]:
    return _ollama_embed([text])[0]


# ──────────────────────────── SentenceTransformers (local fallback) ────────────

_st_model = None


def _st_embed(texts: list[str]) -> list[list[float]]:
    global _st_model
    if _st_model is None:
        from sentence_transformers import SentenceTransformer
        _st_model = SentenceTransformer("all-MiniLM-L6-v2")
    vecs = _st_model.encode(texts, convert_to_numpy=True)
    return vecs.tolist()


def _st_embed_query(text: str) -> list[float]:
    return _st_embed([text])[0]


# ──────────────────────────── Public API ──────────────────────────────────────

def generate_text(prompt: str, system: Optional[str] = None) -> str:
    """Generate text using the configured AI provider."""
    if settings.AI_PROVIDER == "gemini":
        return _gemini_generate(prompt, system)
    elif settings.AI_PROVIDER == "ollama":
        return _ollama_generate(prompt, system)
    else:
        raise ValueError(f"Unknown AI_PROVIDER: {settings.AI_PROVIDER}")


def generate_text_stream(prompt: str, system: Optional[str] = None):
    """Generate text in a streaming fashion."""
    if settings.AI_PROVIDER == "gemini":
        yield from _gemini_generate_stream(prompt, system)
    elif settings.AI_PROVIDER == "ollama":
        yield from _ollama_generate_stream(prompt, system)
    else:
        raise ValueError(f"Unknown AI_PROVIDER: {settings.AI_PROVIDER}")


def get_embeddings(texts: list[str]) -> list[list[float]]:
    """Embed a list of texts using the configured provider."""
    if settings.AI_PROVIDER == "gemini":
        return _gemini_embed(texts)
    elif settings.AI_PROVIDER == "ollama":
        return _ollama_embed(texts)
    else:
        return _st_embed(texts)


def get_query_embedding(text: str) -> list[float]:
    """Embed a single query string."""
    if settings.AI_PROVIDER == "gemini":
        return _gemini_embed_query(text)
    elif settings.AI_PROVIDER == "ollama":
        return _ollama_embed_query(text)
    else:
        return _st_embed_query(text)


def rag_answer(question: str, context_chunks: list[str]) -> str:
    """Generate a RAG answer given retrieved context chunks."""
    context = "\n\n---\n\n".join(context_chunks)
    system = (
        "You are an expert research assistant. Provide highly detailed, comprehensive, "
        "and well-structured answers based ONLY on the provided context. Deeply analyze "
        "the provided context to fully address the user's specific question, elaborating "
        "on all relevant points. **IMPORTANT: You must highlight key terms and important concepts in bold.** "
        "If the context contains Markdown image links (e.g., ![Page 1](http://localhost:8000/images/...)), you MUST copy and paste the EXACT raw markdown link into your answer ONLY IF the user EXPLICITLY asks to see a picture, diagram, or page. Do NOT include image links in your response if the user just asks for a text explanation. "
        "If the context doesn't contain the answer, say so. "
        "Always cite relevant parts of the context in your answer."
    )
    prompt = f"""Context from document:
{context}

Question: {question}

Answer:"""
    return generate_text(prompt, system)


def blind_rag_answer_stream(question: str, context_chunks: list[str], history: Optional[list[dict]] = None):
    """Stream a RAG answer optimized for blind/visually impaired users.
    Plain spoken English — no markdown, no visual references, verbal structure cues.
    Designed to sound completely natural when read aloud by a TTS engine.
    """
    context = "\n\n---\n\n".join(context_chunks)
    history_str = ""
    if history:
        turns = []
        for msg in history[-8:]:
            role = "User" if msg.get("role") == "user" else "Assistant"
            turns.append(f"{role}: {msg.get('content', '')}")
        if turns:
            history_str = "Recent Conversation History:\n" + "\n".join(turns) + "\n\n"

    system = (
        "You are a warm, highly intelligent research companion speaking directly to a blind or visually impaired person. "
        "Your response will be read aloud immediately by a text-to-speech engine, so follow these rules strictly:\n\n"
        "1. Use plain spoken English ONLY. Absolutely NO markdown — no asterisks, no hashtags, no dashes for bullets, "
        "no backticks, no angle brackets. Write exactly as you would speak.\n"
        "2. NEVER use visual references like 'as shown in the diagram', 'see figure', 'in the table above', "
        "'highlighted in bold', or 'the image shows'. The person cannot see anything.\n"
        "3. Structure your answer with spoken verbal cues: 'First...', 'Next...', 'Also...', 'Finally...', "
        "and 'To summarize...' — so the listener can follow along easily.\n"
        "4. Define every technical term out loud the first time you use it.\n"
        "5. Use concrete real-world analogies and everyday comparisons to explain abstract ideas.\n"
        "6. Keep sentences SHORT and clear. Every sentence must be under 20 words. "
        "If a thought needs more words, split it into two sentences. Speak naturally and warmly.\n"
        "7. Evaluate the retrieved document context carefully. If the information to answer the question is found in the document context, provide a detailed, accurate response. "
        "CRITICAL RULE: If the question cannot be answered using the provided document context or if the context is missing, your response MUST be: "
        "'I cannot find an answer in the documents.' Do not fabricate information not present in the document.\n"
        "8. Provide a complete, thorough, and clear explanation of all parts of the question. End your answer with a brief spoken wrap-up of the key takeaway.\n"
        "9. Do NOT start your response with 'Certainly!', 'Sure!', 'Of course!' or similar filler phrases. "
        "Start directly and confidently with the answer.\n"
        "10. Always complete your full answer. Never cut off mid-explanation."
    )
    prompt = f"""{history_str}Context from the document:
{context}

Question: {question}

Answer (speak naturally, no markdown):"""
    yield from generate_text_stream(prompt, system)


def rag_answer_stream(question: str, context_chunks: list[str], history: Optional[list[dict]] = None):
    """Stream a RAG answer given retrieved context chunks and conversation history."""
    context = "\n\n---\n\n".join(context_chunks)
    history_str = ""
    if history:
        turns = []
        for msg in history[-8:]:
            role = "User" if msg.get("role") == "user" else "Assistant"
            turns.append(f"{role}: {msg.get('content', '')}")
        if turns:
            history_str = "Recent Conversation History:\n" + "\n".join(turns) + "\n\n"

    system = (
        "You are an expert research assistant. Provide highly detailed, comprehensive, "
        "and well-structured answers based on the provided document context and conversation history. Deeply analyze "
        "the provided context to fully address the user's specific question, elaborating "
        "on all relevant points. **IMPORTANT: You must highlight key terms and important concepts in bold.** "
        "If the context contains Markdown image links (e.g., ![Page 1](http://localhost:8000/images/...)), you MUST copy and paste the EXACT raw markdown link into your answer ONLY IF the user EXPLICITLY asks to see a picture, diagram, or page. Do NOT include image links in your response if the user just asks for a text explanation. "
        "Answer directly and authoritatively based on the retrieved facts. Do NOT include meta-disclaimers like "
        "'This question is not directly in your PDF'. Deliver clear, high-quality, actionable insights."
    )
    prompt = f"""{history_str}Context from document:
{context}

Question: {question}

Answer:"""
    yield from generate_text_stream(prompt, system)

