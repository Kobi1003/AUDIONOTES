"""
Podcast generation pipeline:
1. Summarize document text using LLM
2. Generate a dual-host conversational podcast script
3. Synthesize each line with edge-tts (alternating voices)
4. Concatenate audio segments into a single MP3
"""
import asyncio
import json
import logging
import os
import re
import tempfile
import uuid
from pathlib import Path

import edge_tts

from app.core.config import settings
from app.services import llm as llm_service
from app.services.ingestion import extract_text_from_pdf

logger = logging.getLogger(__name__)

SCRIPT_SYSTEM = """You are a professional podcast script writer. 
You generate engaging, educational, and entertaining podcast scripts featuring two hosts."""

SCRIPT_PROMPT_TEMPLATE = """Create a podcast episode script based on the following document content.

HOSTS:
- {host_a} (Host A, uses tag [A]): Male voice, enthusiastic and asks great questions
- {host_b} (Host B, uses tag [B]): Female voice, knowledgeable and provides detailed explanations

DOCUMENT CONTENT:
{content}

INSTRUCTIONS:
- Write a 10-15 exchange conversation (20-30 lines total)
- Start with an intro where both hosts introduce the episode topic
- Cover the key points, insights, and interesting findings from the document
- Use a conversational, engaging tone — not academic or robotic
- End with a brief summary and sign-off
- Output ONLY a JSON array, nothing else. Each item: {{"host": "A" or "B", "text": "spoken line"}}

JSON ARRAY:"""


def _build_script_prompt(document_text: str) -> str:
    # Use first 8000 chars to keep within token limits
    content_preview = document_text[:8000]
    if len(document_text) > 8000:
        content_preview += "\n\n[... document continues ...]"

    return SCRIPT_PROMPT_TEMPLATE.format(
        host_a=settings.HOST_A_NAME,
        host_b=settings.HOST_B_NAME,
        content=content_preview,
    )


def _parse_script(raw_output: str) -> list[dict]:
    """Parse JSON array from LLM output, with fallback regex extraction."""
    # Try to find JSON array in the output
    match = re.search(r"\[.*\]", raw_output, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    # Fallback: try to parse the entire output
    try:
        return json.loads(raw_output.strip())
    except json.JSONDecodeError:
        logger.warning("Could not parse script JSON, using fallback.")
        # Create a minimal fallback script
        return [
            {"host": "A", "text": "Welcome to AutoNotes AI podcast. Today we're discussing an interesting document."},
            {"host": "B", "text": "That's right! Let me share what I found most compelling about this content."},
            {"host": "A", "text": "Thanks for listening! Until next time."},
            {"host": "B", "text": "See you next episode!"},
        ]


async def _synthesize_line(text: str, voice: str, output_path: str) -> None:
    """Synthesize a single line of text to an MP3 file using edge-tts with gTTS fallback."""
    try:
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(output_path)
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            return
    except Exception as e:
        logger.warning(f"edge-tts failed ({e}), falling back to gTTS...")

    try:
        from gtts import gTTS
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: gTTS(text=text, lang="en").save(output_path))
    except Exception as e2:
        logger.error(f"gTTS fallback also failed ({e2})")
        # Write minimal valid silent frame so generation completes
        with open(output_path, "wb") as f:
            f.write(b"\xff\xfb\x90\x04" + b"\x00" * 414)


async def _generate_audio_segments(
    script_lines: list[dict], temp_dir: str
) -> list[str]:
    """Generate individual MP3 files for each script line (sequential to avoid rate limits)."""
    segment_paths = []

    for i, line in enumerate(script_lines):
        voice = settings.HOST_A_VOICE if line["host"] == "A" else settings.HOST_B_VOICE
        path = os.path.join(temp_dir, f"segment_{i:04d}.mp3")
        text = line["text"].strip()
        if not text:
            continue
        await _synthesize_line(text, voice, path)
        segment_paths.append(path)
        logger.info(f"  Synthesized line {i + 1}/{len(script_lines)}")

    return segment_paths


def _concatenate_mp3_bytes(segment_paths: list[str], output_path: str) -> None:
    """
    Concatenate MP3 files by raw byte concatenation.
    This is a fallback when FFmpeg/pydub is not available.
    Raw MP3 concatenation works because MP3 frames are self-contained.
    """
    with open(output_path, "wb") as out_file:
        for path in segment_paths:
            with open(path, "rb") as seg:
                out_file.write(seg.read())


def _merge_audio_segments(segment_paths: list[str], output_path: str) -> None:
    """Merge audio segments using pydub, falling back to raw byte concat."""
    try:
        from pydub import AudioSegment

        combined = AudioSegment.empty()
        silence = AudioSegment.silent(duration=400)  # 400ms pause between lines

        for path in segment_paths:
            segment = AudioSegment.from_mp3(path)
            combined += segment + silence

        combined.export(output_path, format="mp3", bitrate="128k")
        logger.info(f"Merged {len(segment_paths)} segments with pydub.")

    except Exception as e:
        logger.warning(f"pydub merge failed ({e}), falling back to raw byte concat.")
        _concatenate_mp3_bytes(segment_paths, output_path)


def generate_podcast(document_id: int, file_path: str) -> tuple[str, str]:
    """
    Main podcast generation entry point.
    Returns (script_json_string, output_audio_path).
    """
    # Step 1: Extract document text
    logger.info(f"Extracting text for podcast generation (doc {document_id})...")
    full_text, _ = extract_text_from_pdf(file_path)

    # Step 2: Generate podcast script
    logger.info("Generating podcast script with LLM...")
    prompt = _build_script_prompt(full_text)
    raw_script = llm_service.generate_text(prompt, SCRIPT_SYSTEM)
    script_lines = _parse_script(raw_script)
    logger.info(f"Script has {len(script_lines)} lines.")

    # Step 3: Synthesize audio
    logger.info("Synthesizing audio with edge-tts...")
    output_filename = f"podcast_{document_id}_{uuid.uuid4().hex[:8]}.mp3"
    output_path = str(Path(settings.PODCAST_DIR) / output_filename)

    with tempfile.TemporaryDirectory() as temp_dir:
        # Use a fresh event loop — safe when called from a background thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            segment_paths = loop.run_until_complete(
                _generate_audio_segments(script_lines, temp_dir)
            )
        finally:
            loop.close()

        # Step 4: Merge segments
        logger.info("Merging audio segments...")
        _merge_audio_segments(segment_paths, output_path)

    logger.info(f"Podcast generated: {output_path}")
    return json.dumps(script_lines), output_path
