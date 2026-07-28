"""
Explainer Video generation pipeline:
1. Extract PDF text
2. Detect domain using LLM
3. Select persona (doctor, scientist, astronomer, teacher, etc.)
4. Generate an accessible, jargon-free explainer script (JSON segments)
5. Synthesize narration audio with edge-tts (single narrator voice)
6. Return script JSON + audio path
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


# ──────────────────────────── Persona Definitions ─────────────────────────────

PERSONAS = [
    {
        "type": "doctor",
        "name": "Dr. Alex",
        "emoji": "👨‍⚕️",
        "voice": "en-US-GuyNeural",
        "keywords": ["medicine", "medical", "health", "anatomy", "disease", "patient", "clinical",
                     "treatment", "drug", "pharmacology", "surgery", "diagnosis", "symptom",
                     "therapy", "hospital", "cardiac", "neurology", "biology", "physiology"],
        "intro": "Hello! I'm Dr. Alex, a medical professional. Let me walk you through this in simple, clear terms.",
        "color": "#22c55e",
    },
    {
        "type": "astronomer",
        "name": "Prof. Nova",
        "emoji": "🧑‍🚀",
        "voice": "en-US-BrianNeural",
        "keywords": ["astronomy", "space", "planet", "star", "galaxy", "cosmos", "universe",
                     "telescope", "orbit", "celestial", "astrophysics", "solar", "lunar",
                     "nebula", "black hole", "gravity", "quantum", "physics", "radiation",
                     "wormhole", "entanglement", "relativity", "spacetime"],
        "intro": "Greetings! I'm Prof. Nova, an astronomer and physicist. Let me take you on a journey through this topic.",
        "color": "#6366f1",
    },
    {
        "type": "scientist",
        "name": "Dr. Zara",
        "emoji": "🧪",
        "voice": "en-US-JennyNeural",
        "keywords": ["chemistry", "chemical", "biology", "biochemistry", "laboratory", "experiment",
                     "molecule", "compound", "reaction", "cell", "protein", "enzyme", "gene",
                     "DNA", "RNA", "microbe", "bacteria", "virus", "ecology", "evolution"],
        "intro": "Hi there! I'm Dr. Zara, a research scientist. I'll explain this fascinating topic step by step.",
        "color": "#f59e0b",
    },
    {
        "type": "lawyer",
        "name": "Attorney Sam",
        "emoji": "⚖️",
        "voice": "en-US-ChristopherNeural",
        "keywords": ["law", "legal", "court", "justice", "contract", "rights", "constitution",
                     "legislation", "regulation", "statute", "policy", "governance", "criminal",
                     "civil", "attorney", "judge", "verdict", "plaintiff", "defendant"],
        "intro": "Hello! I'm Attorney Sam, a legal professional. I'll break down this topic into everyday language.",
        "color": "#64748b",
    },
    {
        "type": "coach",
        "name": "Coach Jordan",
        "emoji": "🏃",
        "voice": "en-US-EricNeural",
        "keywords": ["sport", "fitness", "athletic", "exercise", "training", "muscle", "nutrition",
                     "performance", "endurance", "strength", "coach", "team", "competition",
                     "health", "workout", "physiology", "biomechanics"],
        "intro": "Hey, team! I'm Coach Jordan. Let's power through this topic together — I'll keep it real and simple.",
        "color": "#ef4444",
    },
    {
        "type": "historian",
        "name": "Prof. Aria",
        "emoji": "📖",
        "voice": "en-US-AriaNeural",
        "keywords": ["history", "historical", "civilization", "culture", "society", "social",
                     "economics", "political", "geography", "philosophy", "art", "literature",
                     "archaeology", "anthropology", "war", "revolution", "empire"],
        "intro": "Hello! I'm Prof. Aria, a historian and social scientist. Let me put this topic in context for you.",
        "color": "#a855f7",
    },
    {
        "type": "engineer",
        "name": "Eng. Max",
        "emoji": "💻",
        "voice": "en-US-GuyNeural",
        "keywords": ["engineering", "software", "computer", "algorithm", "technology", "program",
                     "code", "system", "network", "hardware", "data", "machine learning",
                     "artificial intelligence", "robotics", "electronics", "circuit", "mechanical"],
        "intro": "Hey! I'm Max, an engineer. I'll explain the technical bits in plain language — no jargon, promise!",
        "color": "#0ea5e9",
    },
    {
        "type": "teacher",
        "name": "Teacher Sam",
        "emoji": "🎓",
        "voice": "en-US-JennyNeural",
        "keywords": [],  # Default fallback
        "intro": "Hello everyone! I'm Teacher Sam. I'm here to explain this topic in the simplest way possible — let's dive in!",
        "color": "#ec4899",
    },
]

DEFAULT_PERSONA = PERSONAS[-1]  # teacher is the fallback


# ──────────────────────────── Domain Detection ────────────────────────────────

DOMAIN_DETECT_SYSTEM = (
    "You are an expert at classifying text by academic or professional domain. "
    "Respond with ONLY a JSON object, nothing else."
)

DOMAIN_DETECT_PROMPT = """Analyze the following document excerpt and identify its primary domain.

DOCUMENT EXCERPT:
{text}

Return ONLY a JSON object with these fields:
{{
  "domain": "a short label like 'medicine', 'astronomy', 'chemistry', 'law', 'sports', 'history', 'engineering', 'education', etc.",
  "confidence": "high | medium | low",
  "keywords_found": ["list", "of", "up", "to", "5", "key", "domain", "terms", "found"]
}}

JSON:"""


def detect_domain(text: str) -> dict:
    """Use LLM to detect the document's domain. Returns {'domain': ..., 'confidence': ..., 'keywords_found': [...]}"""
    preview = text[:4000]
    prompt = DOMAIN_DETECT_PROMPT.format(text=preview)
    raw = llm_service.generate_text(prompt, DOMAIN_DETECT_SYSTEM)

    # Parse JSON
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return {"domain": "general", "confidence": "low", "keywords_found": []}


def select_persona(domain_result: dict) -> dict:
    """Match detected domain to a persona. Returns the persona dict."""
    domain = domain_result.get("domain", "").lower()
    keywords_found = [kw.lower() for kw in domain_result.get("keywords_found", [])]
    combined = domain + " " + " ".join(keywords_found)

    best_persona = DEFAULT_PERSONA
    best_score = 0

    for persona in PERSONAS[:-1]:  # exclude the default teacher
        score = sum(1 for kw in persona["keywords"] if kw in combined)
        if score > best_score:
            best_score = score
            best_persona = persona

    logger.info(f"Selected persona: {best_persona['name']} (domain={domain}, score={best_score})")
    return best_persona


# ──────────────────────────── Script Generation ───────────────────────────────

SCRIPT_SYSTEM = """You are an expert educator who explains complex topics in simple, vivid, accessible language.
Your explanations are suitable for anyone, including people who cannot see visual aids.
You use analogies, stories, and plain language. You never assume prior knowledge.
Respond ONLY with a valid JSON array, no markdown, no extra text."""

SCRIPT_PROMPT = """You are {persona_name}, a {persona_type}. Generate an educational explainer script based on this document.

PERSONA: {persona_name} ({persona_emoji})
INTRO LINE: "{intro}"

DOCUMENT CONTENT:
{content}

INSTRUCTIONS:
- Start with the persona's intro line (segment 1)
- Break the explanation into 8-14 natural segments/paragraphs
- Explain every technical term in plain language when you first use it. Example: "The mitochondria — think of it as the power plant of the cell — generates energy."
- Use vivid analogies, real-world comparisons, and storytelling to make abstract concepts concrete
- Explain things so clearly that a blind person hearing only the audio can fully understand
- Each segment should be 2-4 sentences, conversational and warm
- Include a wrap-up segment summarizing the key takeaways
- End with a friendly sign-off

Output ONLY a JSON array. Each item must have:
{{
  "segment": <number starting at 1>,
  "text": "<the narration text for this segment>",
  "visual_cue": "<one of: intro | explain | define | example | summary | signoff>",
  "keywords": ["<up to 3 key terms mentioned in this segment>"]
}}

JSON ARRAY:"""


def generate_explainer_script(text: str, persona: dict) -> list[dict]:
    """Generate a structured explainer script as a list of segment dicts."""
    content_preview = text[:7000]
    if len(text) > 7000:
        content_preview += "\n\n[... document continues ...]"

    prompt = SCRIPT_PROMPT.format(
        persona_name=persona["name"],
        persona_type=persona["type"],
        persona_emoji=persona["emoji"],
        intro=persona["intro"],
        content=content_preview,
    )

    raw = llm_service.generate_text(prompt, SCRIPT_SYSTEM)

    # Parse JSON array
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if match:
        try:
            segments = json.loads(match.group())
            if isinstance(segments, list) and len(segments) > 0:
                return segments
        except json.JSONDecodeError:
            pass

    # Fallback
    logger.warning("Could not parse explainer script JSON. Using fallback.")
    return [
        {"segment": 1, "text": persona["intro"], "visual_cue": "intro", "keywords": []},
        {"segment": 2, "text": "This document covers some important concepts. Let me walk you through the highlights.", "visual_cue": "explain", "keywords": []},
        {"segment": 3, "text": "I hope that gave you a good overview of the topic. Thanks for listening!", "visual_cue": "signoff", "keywords": []},
    ]


# ──────────────────────────── Audio Synthesis ─────────────────────────────────

async def _synthesize_segment(text: str, voice: str, output_path: str) -> None:
    """Synthesize a single segment to an MP3 using edge-tts."""
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(output_path)


async def _generate_audio_segments_async(segments: list[dict], voice: str, temp_dir: str) -> list[str]:
    """Generate individual MP3s for each segment sequentially. Returns only paths for non-empty segments."""
    paths = []
    for i, seg in enumerate(segments):
        text = seg.get("text", "").strip()
        if not text:
            paths.append(None)  # placeholder so index stays aligned with segments
            continue
        path = os.path.join(temp_dir, f"seg_{i:04d}.mp3")
        await _synthesize_segment(text, voice, path)
        paths.append(path)
        logger.info(f"  Synthesized segment {i + 1}/{len(segments)}")
    return paths


def _get_mp3_duration_seconds(path: str) -> float:
    """Return duration of an MP3 file in seconds using pydub, fall back to 0."""
    try:
        from pydub import AudioSegment as _AS
        return len(_AS.from_mp3(path)) / 1000.0
    except Exception:
        return 0.0


def _merge_audio_with_timing(
    segment_paths: list[str | None],
    segments: list[dict],
    output_path: str,
    pause_ms: int = 500,
) -> list[dict]:
    """
    Merge per-segment MP3s (with silence padding) and embed start_time (seconds)
    into each segment dict.  Returns the updated segments list.
    """
    PAUSE_SEC = pause_ms / 1000.0
    cursor = 0.0

    try:
        from pydub import AudioSegment

        combined = AudioSegment.empty()
        pause_clip = AudioSegment.silent(duration=pause_ms)

        for i, path in enumerate(segment_paths):
            if path is None:
                # Empty segment — keep cursor, no audio added
                segments[i]["start_time"] = round(cursor, 3)
                continue

            clip = AudioSegment.from_mp3(path)
            seg_duration = len(clip) / 1000.0

            segments[i]["start_time"] = round(cursor, 3)
            cursor += seg_duration + PAUSE_SEC

            combined += clip + pause_clip

        combined.export(output_path, format="mp3", bitrate="128k")
        logger.info(f"Merged {len(segment_paths)} segments with pydub (timing embedded).")

    except Exception as e:
        logger.warning(f"pydub merge/timing failed ({e}), falling back to raw concat + char-count timing.")
        # Fallback: concatenate raw bytes, estimate timing from char count
        total_chars = sum(len(seg.get("text", "")) for seg in segments) or 1
        raw_cursor = 0.0
        # We'll use a rough estimate of 14 chars/sec for the fallback
        CHARS_PER_SEC = 14.0
        with open(output_path, "wb") as out:
            for i, path in enumerate(segment_paths):
                if path is None:
                    segments[i]["start_time"] = round(raw_cursor, 3)
                    continue
                seg_chars = len(segments[i].get("text", ""))
                segments[i]["start_time"] = round(raw_cursor, 3)
                raw_cursor += seg_chars / CHARS_PER_SEC + PAUSE_SEC
                with open(path, "rb") as seg_file:
                    out.write(seg_file.read())

    return segments


# ──────────────────────────── Main Entry Point ────────────────────────────────

def generate_explainer(document_id: int, file_path: str) -> tuple[dict, str, str]:
    """
    Full explainer generation pipeline.
    Returns (persona_dict, script_json_string, output_audio_path).
    Each segment in the script will contain a `start_time` field (seconds)
    reflecting its exact position in the merged audio — enabling perfect
    voice-text sync on the frontend.
    """
    # Step 1: Extract text
    logger.info(f"Extracting text for explainer (doc {document_id})...")
    full_text, _ = extract_text_from_pdf(file_path)

    # Step 2: Detect domain + select persona
    logger.info("Detecting document domain...")
    domain_result = detect_domain(full_text)
    persona = select_persona(domain_result)
    logger.info(f"Domain: {domain_result.get('domain')} → Persona: {persona['name']}")

    # Step 3: Generate script
    logger.info("Generating explainer script...")
    segments = generate_explainer_script(full_text, persona)
    logger.info(f"Script has {len(segments)} segments.")

    # Step 4: Synthesize audio per segment
    logger.info(f"Synthesizing audio with voice {persona['voice']}...")
    output_filename = f"explainer_{document_id}_{uuid.uuid4().hex[:8]}.mp3"
    output_path = str(Path(settings.EXPLAINER_DIR) / output_filename)

    with tempfile.TemporaryDirectory() as temp_dir:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            seg_paths = loop.run_until_complete(
                _generate_audio_segments_async(segments, persona["voice"], temp_dir)
            )
        finally:
            loop.close()

        # Step 5: Merge audio + embed real start_time into each segment
        logger.info("Merging audio segments and embedding timing...")
        segments = _merge_audio_with_timing(seg_paths, segments, output_path)

    logger.info(f"Explainer audio generated: {output_path}")
    return persona, json.dumps(segments), output_path
