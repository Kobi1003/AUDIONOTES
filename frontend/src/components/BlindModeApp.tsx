// BlindModeApp.tsx — Complete voice-first application for visually impaired users.
// The app speaks everything, accepts only voice commands, and requires zero mouse interaction.
// Every screen announces itself. Documents are selected by voice. RAG is driven by voice.

import { useEffect, useRef, useState } from "react";
import type { Document, Explainer } from "../api";
import {
  listDocuments,
  uploadDocument,
  getDocument,
  sendBlindChatStream,
  sendGlobalSearchStream,
  createExplainer,
  listExplainers,
  getExplainer,
  getExplainerAudioUrl,
} from "../api";

// ─── Speech Sentence Splitter ────────────────────────────────────────────────
// Strips markdown and splits into short safe chunks for Chromium TTS.
function splitSpeechText(text: string): string[] {
  if (!text) return [];

  // 1. Strip markdown
  let clean = text
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/\*(.*?)\*/gs, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+>]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!clean) return [];

  // 2. Split on sentence boundaries
  // Use a simple approach that always works: split on ". " "! " "? "
  const sentences: string[] = [];
  // Add sentinel so last sentence is always captured
  const withSentinel = clean.endsWith(".") || clean.endsWith("!") || clean.endsWith("?")
    ? clean
    : clean + ".";

  let buf = "";
  for (let i = 0; i < withSentinel.length; i++) {
    const ch = withSentinel[i];
    buf += ch;
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= withSentinel.length || withSentinel[i + 1] === " " || withSentinel[i + 1] === "\n")) {
      const s = buf.trim();
      if (s.length > 0) sentences.push(s);
      buf = "";
    }
  }
  if (buf.trim()) sentences.push(buf.trim());

  // 3. Hard-split any chunk still >150 chars on comma/semicolon/colon
  const result: string[] = [];
  for (const s of sentences) {
    if (s.length <= 150) {
      result.push(s);
    } else {
      // Split on comma/semicolon/colon
      const sub = s.split(/(?<=[,;:])\s+/);
      let acc = "";
      for (const part of sub) {
        if ((acc + " " + part).trim().length > 150 && acc.length > 0) {
          result.push(acc.trim());
          acc = part;
        } else {
          acc = acc ? acc + " " + part : part;
        }
      }
      if (acc.trim()) result.push(acc.trim());
    }
  }

  return result.filter(s => s.length > 0);
}

// ─── Speech Queue ────────────────────────────────────────────────────────────
// Fully hardened queue for Chromium Web Speech API.
// Key fixes vs naive approach:
//  - onStart fires ONCE per enqueue batch, not per chunk
//  - keepalive at 5s (Chromium cuts at ~14s, this leaves huge margin)
//  - watchdog: if speechSynthesis stalls (not speaking but queue has items), force-drain
//  - onerror for "canceled"/"interrupted" only stops if this was deliberate (stop() called)
class SpeechQueue {
  private _queue: string[] = [];
  private _busy = false;
  private _started = false;   // true once the current batch has fired onStart
  private _voice: SpeechSynthesisVoice | null = null;
  private _rate = 0.95;
  private _pitch = 1.0;
  private _activeUtterance: SpeechSynthesisUtterance | null = null;
  private _keepAliveTimer: any = null;
  private _watchdogTimer: any = null;
  private _stopped = false;   // set true by stop(), prevents watchdog from restarting
  onEmpty?: () => void;
  onStart?: () => void;

  setVoice(v: SpeechSynthesisVoice | null) { this._voice = v; }

  enqueue(texts: string | string[], interrupt = true) {
    const rawArr = Array.isArray(texts) ? texts : [texts];
    const arr = rawArr.flatMap((t) => splitSpeechText(t)).filter((t) => t.trim().length > 0);
    if (arr.length === 0) return;
    if (interrupt) {
      this.stop();
    }
    this._stopped = false;
    this._queue.push(...arr);
    if (!this._busy) this._drain();
  }

  stop() {
    this._stopped = true;
    this._started = false;
    this._clearTimers();
    if (this._activeUtterance) {
      this._activeUtterance.onend = null;
      this._activeUtterance.onerror = null;
      this._activeUtterance = null;
    }
    try { window.speechSynthesis.cancel(); } catch {}
    this._queue = [];
    this._busy = false;
  }

  get isBusy() { return this._busy; }

  private _clearTimers() {
    if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
    if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
  }

  private _startKeepAlive() {
    this._clearTimers();
    // Keepalive every 5s — well within Chromium's ~14s stall threshold
    this._keepAliveTimer = setInterval(() => {
      if (this._stopped) return;
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      } else if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        setTimeout(() => { try { window.speechSynthesis.resume(); } catch {} }, 50);
      }
    }, 5000);

    // Watchdog: if we think we're busy but speechSynthesis has gone quiet, re-drain
    this._armWatchdog();
  }

  private _armWatchdog() {
    if (this._watchdogTimer) clearTimeout(this._watchdogTimer);
    // Give 8s for a chunk to start/finish; if it hasn't, force drain
    this._watchdogTimer = setTimeout(() => {
      if (this._stopped || !this._busy) return;
      if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
        // Speech engine dropped the ball — force continue
        if (this._activeUtterance) {
          this._activeUtterance.onend = null;
          this._activeUtterance.onerror = null;
          this._activeUtterance = null;
        }
        this._drain();
      } else {
        this._armWatchdog(); // still speaking, re-arm
      }
    }, 8000);
  }

  private _drain() {
    if (this._stopped) return;
    if (this._queue.length === 0) {
      this._busy = false;
      this._started = false;
      this._activeUtterance = null;
      this._clearTimers();
      this.onEmpty?.();
      return;
    }

    this._busy = true;
    // Fire onStart only once per batch (first chunk of the batch)
    if (!this._started) {
      this._started = true;
      this.onStart?.();
    }
    this._startKeepAlive();

    const text = this._queue.shift()!;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this._rate;
    u.pitch = this._pitch;
    if (this._voice) u.voice = this._voice;
    this._activeUtterance = u;

    u.onend = () => {
      if (this._stopped) return;
      if (this._activeUtterance === u) {
        this._activeUtterance = null;
        this._drain();
      }
    };

    u.onerror = (e) => {
      if (this._activeUtterance !== u) return;
      this._activeUtterance = null;
      if (this._stopped) {
        // Deliberate cancel — clean up
        this._busy = false;
        this._started = false;
        this._clearTimers();
        return;
      }
      // For ANY other error (network, synthesis-failed, audio-busy, etc.) — skip and continue
      console.warn("[SpeechQueue] utterance error:", e.error, "| text:", text.slice(0, 60));
      this._drain();
    };

    // Ensure speech engine is not paused before speaking
    try {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      window.speechSynthesis.speak(u);
    } catch (err) {
      console.warn("[SpeechQueue] speak() threw:", err);
      this._drain(); // try next chunk
    }
  }
}

// ─── Number parsing ──────────────────────────────────────────────────────────
const NUM_WORDS: Record<string, number> = {
  one: 1, first: 1, two: 2, second: 2, three: 3, third: 3,
  four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6,
  seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10,
};

function parseNoteNum(text: string): number | null {
  const m = text.match(/\b(\d+)\b/);
  if (m) return parseInt(m[1]);
  for (const [w, n] of Object.entries(NUM_WORDS)) {
    if (text.includes(w)) return n;
  }
  return null;
}

// ─── Sound Effects (Web Audio API) ───────────────────────────────────────────
function playSoundEffect(type: "listen_start" | "processing" | "answer_ready") {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    if (type === "listen_start") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } else if (type === "processing") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(523.25, ctx.currentTime);
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } else if (type === "answer_ready") {
      [523.25, 659.25, 783.99].forEach((freq) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(0.05, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      });
    }
  } catch {
    // Ignore audio context errors
  }
}

// ─── Ambient Search Music (Web Audio API) ──────────────────────────────────
let searchMusicCtx: AudioContext | null = null;
let searchMusicGain: GainNode | null = null;
let searchMusicOsc1: OscillatorNode | null = null;
let searchMusicOsc2: OscillatorNode | null = null;

function startSearchBackgroundMusic() {
  stopSearchBackgroundMusic();
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    searchMusicCtx = new AudioCtx();
    searchMusicGain = searchMusicCtx.createGain();

    searchMusicOsc1 = searchMusicCtx.createOscillator();
    searchMusicOsc2 = searchMusicCtx.createOscillator();
    searchMusicOsc1.type = "sine";
    searchMusicOsc2.type = "sine";
    searchMusicOsc1.frequency.setValueAtTime(220, searchMusicCtx.currentTime);
    searchMusicOsc2.frequency.setValueAtTime(330, searchMusicCtx.currentTime);

    searchMusicGain.gain.setValueAtTime(0.001, searchMusicCtx.currentTime);
    searchMusicGain.gain.exponentialRampToValueAtTime(0.015, searchMusicCtx.currentTime + 0.5);

    searchMusicOsc1.connect(searchMusicGain);
    searchMusicOsc2.connect(searchMusicGain);
    searchMusicGain.connect(searchMusicCtx.destination);

    searchMusicOsc1.start();
    searchMusicOsc2.start();
  } catch {}
}

function stopSearchBackgroundMusic() {
  try {
    if (searchMusicGain && searchMusicCtx) {
      searchMusicGain.gain.linearRampToValueAtTime(0.0001, searchMusicCtx.currentTime + 0.3);
      setTimeout(() => {
        try { searchMusicOsc1?.stop(); } catch {}
        try { searchMusicOsc2?.stop(); } catch {}
        try { searchMusicCtx?.close(); } catch {}
        searchMusicCtx = null;
        searchMusicGain = null;
        searchMusicOsc1 = null;
        searchMusicOsc2 = null;
      }, 350);
    }
  } catch {}
}

// ─── Component ───────────────────────────────────────────────────────────────
type Screen = "home" | "note" | "answering" | "summary";

export interface BlindModeAppProps {
  onExitVoiceMode: () => void;
}

export function BlindModeApp({ onExitVoiceMode }: BlindModeAppProps) {
  // UI state — only for rendering
  const [screen, setScreen] = useState<Screen>("home");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [statusText, setStatusText] = useState("Loading your notes…");
  const [cmdHints, setCmdHints] = useState<string[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [explainer, setExplainer] = useState<Explainer | null>(null);
  const [summaryState, setSummaryState] = useState<"idle" | "generating" | "ready">("idle");
  const [textInputQuery, setTextInputQuery] = useState("");

  const handleTextInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInputQuery.trim()) return;
    const q = textInputQuery.trim();
    setTextInputQuery("");
    stopAllAudio();
    processCommandRef.current(q);
  };

  // Refs — for SR callbacks and action functions (avoid stale closures)
  const screenRef = useRef<Screen>("home");
  const docsRef = useRef<Document[]>([]);
  const selDocRef = useRef<Document | null>(null);
  const explainerRef = useRef<Explainer | null>(null);
  const summaryStateRef = useRef<"idle" | "generating" | "ready">("idle");
  const lastAnnouncedRef = useRef<string[]>([]);
  const questionModeRef = useRef(false);
  const isListeningRef = useRef(false);
  const isExitingRef = useRef(false);
  const lastEnterTimeRef = useRef<number>(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sq = useRef(new SpeechQueue());
  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // All action functions stored in refs so SR callbacks always have current versions
  const announceHomeRef = useRef<(docs: Document[]) => void>(() => {});
  const announceNoteRef = useRef<(doc: Document) => void>(() => {});
  const handleQuestionRef = useRef<(q: string) => Promise<void>>(async () => {});
  const handleSummaryRef = useRef<() => Promise<void>>(async () => {});
  const processCommandRef = useRef<(text: string) => void>(() => {});
  const startSRRef = useRef<() => void>(() => {});
  const stopSRRef = useRef<() => void>(() => {});

  // Master function to immediately halt all audio playback, speech, and background music
  const stopAllAudio = () => {
    if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

    sq.current.stop();

    try { window.speechSynthesis.pause(); } catch {}
    try { window.speechSynthesis.cancel(); } catch {}

    stopSearchBackgroundMusic();

    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      } catch {}
    }
  };

  const handleExitVoiceMode = () => {
    isExitingRef.current = true;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.abort();
      } catch {}
    }
    stopAllAudio();
    try { window.speechSynthesis.pause(); } catch {}
    try { window.speechSynthesis.cancel(); } catch {}
    document.querySelectorAll("audio, video").forEach((media) => {
      try {
        (media as HTMLMediaElement).pause();
        (media as HTMLMediaElement).currentTime = 0;
      } catch {}
    });
    onExitVoiceMode();
  };

  // Ensure summary audio is halted whenever screen is changed away from summary
  useEffect(() => {
    if (screen !== "summary" && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [screen]);

  // ── Sync state → refs ──────────────────────────────────────────────────────
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { docsRef.current = documents; }, [documents]);
  useEffect(() => { selDocRef.current = selectedDoc; }, [selectedDoc]);
  useEffect(() => { explainerRef.current = explainer; }, [explainer]);
  useEffect(() => { summaryStateRef.current = summaryState; }, [summaryState]);

  // ── Define action functions ────────────────────────────────────────────────
  useEffect(() => {
    // Announce home screen
    announceHomeRef.current = (docs: Document[]) => {
      const texts: string[] = [
        "Audio Mode activated.",
        "Press the Enter key anytime to stop audio playback and activate your microphone to ask any questions to the agent.",
        "Press the Enter key twice quickly at any time to exit Audio Mode.",
        "Home screen.",
      ];
      if (docs.length === 0) {
        texts.push("You have no notes yet in your library.");
        texts.push("You can ask any question directly to the AI agent, or say 'upload' to add a document.");
        texts.push("Say 'help' for all available commands.");
        setStatusText("Audio Mode active. Press Enter to ask a question, or press Enter twice to exit.");
        setCmdHints(["upload", "help"]);
      } else {
        texts.push(`You have ${docs.length} document${docs.length !== 1 ? "s" : ""} in your library.`);
        docs.forEach((d, i) => {
          texts.push(`Note ${i + 1}: ${d.original_name.replace(/\.(pdf|txt|docx)$/i, "")}.`);
        });
        texts.push("You can speak any question directly, or say 'note 1', 'upload', or 'help'.");
        setStatusText(`Audio Mode active (${docs.length} note${docs.length !== 1 ? "s" : ""}). Press Enter to ask a question, or press Enter twice to exit.`);
        setCmdHints([...docs.map((_, i) => `note ${i + 1}`), "upload", "help"]);
      }
      lastAnnouncedRef.current = texts;
      sq.current.enqueue(texts);
    };

    // Announce note screen
    announceNoteRef.current = (doc: Document) => {
      const name = doc.original_name.replace(/\.pdf$/i, "");
      const texts = [
        `Note: ${name}.`,
        "Say 'ask a question' to chat with this note.",
        "Say 'summary' to hear a spoken overview.",
        "Say 'back' to return to your notes list.",
        "Say 'help' for all commands.",
      ];
      lastAnnouncedRef.current = texts;
      setStatusText(`"${name}" is open.`);
      setCmdHints(["ask a question", "summary", "back"]);
      sq.current.enqueue(texts);
    };

    // Handle a question (blind-chat RAG)
    handleQuestionRef.current = async (question: string) => {
      const doc = selDocRef.current;
      if (!doc) return;
      stopAllAudio();
      setScreen("answering");
      screenRef.current = "answering";
      setStatusText(`❓ Spoken Question: "${question}"`);
      setStreamText("");
      setCmdHints(["stop", "repeat", "ask again", "back"]);
      playSoundEffect("processing");
      startSearchBackgroundMusic();

      try {
        let full = "";
        await sendBlindChatStream(doc.id, question, (event: any) => {
          if (event.type === "chunk") {
            full += event.text;
            setStreamText(full);
          } else if (event.type === "done") {
            setStreamText(full);
            stopSearchBackgroundMusic();
            playSoundEffect("answer_ready");
            const sentences = splitSpeechText(full);
            const outro = ["When you are ready, please press the Enter key to continue our conversation."];
            lastAnnouncedRef.current = [...sentences, ...outro];
            sq.current.enqueue([...sentences, ...outro]);
          }
        });
      } catch {
        stopSearchBackgroundMusic();
        const err = ["I cannot find an answer in the documents.", "Please press the Enter key to continue our conversation."];
        lastAnnouncedRef.current = err;
        sq.current.enqueue(err);
      }
    };

    // Handle summary generation / playback
    handleSummaryRef.current = async () => {
      const doc = selDocRef.current;
      if (!doc) return;
      if (explainerRef.current?.status === "ready") {
        stopAllAudio();
        setScreen("summary");
        screenRef.current = "summary";
        const t = [
          `Playing the audio summary, narrated by ${explainerRef.current.persona_name}.`,
          "Say 'back' at any time to return.",
        ];
        lastAnnouncedRef.current = t;
        sq.current.enqueue(t);
        setTimeout(() => audioRef.current?.play().catch(() => {}), 2500);
        return;
      }
      if (summaryStateRef.current === "generating") {
        sq.current.enqueue(["The summary is still being generated. Please wait."]);
        return;
      }
      setSummaryState("generating");
      summaryStateRef.current = "generating";
      const gen = ["Generating a spoken summary. This takes about one minute. I will let you know when it is ready."];
      lastAnnouncedRef.current = gen;
      sq.current.enqueue(gen);
      try {
        const exp = await createExplainer(doc.id);
        pollRef.current = setInterval(async () => {
          const upd = await getExplainer(exp.id).catch(() => null);
          if (!upd) return;
          if (upd.status === "ready") {
            clearInterval(pollRef.current!);
            setExplainer(upd); explainerRef.current = upd;
            setSummaryState("ready"); summaryStateRef.current = "ready";
            stopAllAudio();
            setScreen("summary"); screenRef.current = "summary";
            const t = [`Summary ready. Narrated by ${upd.persona_name}. Playing now.`];
            lastAnnouncedRef.current = t;
            sq.current.enqueue(t);
            setTimeout(() => audioRef.current?.play().catch(() => {}), 2000);
          } else if (upd.status === "error") {
            clearInterval(pollRef.current!);
            setSummaryState("idle"); summaryStateRef.current = "idle";
            sq.current.enqueue(["The summary could not be generated. Please try again."]);
          }
        }, 3000);
      } catch {
        setSummaryState("idle"); summaryStateRef.current = "idle";
        sq.current.enqueue(["Failed to generate summary. Please try again."]);
      }
    };

    // Main command processor — called by SR callback
    processCommandRef.current = (text: string) => {
      const s = text.toLowerCase().trim();

      // ── Global commands ──────────────────────────────────────────────────
      if (s.includes("help")) {
        const helpMap: Record<Screen, string[]> = {
          home: [
            "Help — home screen.",
            "Ask any question directly to search your notes or AI knowledge.",
            "Say 'my notes' to hear the list of your notes.",
            "Say 'note 1', 'note 2', and so on, to open a note.",
            "Say 'upload' to upload a new PDF document.",
            "Say 'repeat' to hear the last announcement again.",
            "Press Enter anytime to start speaking your question.",
            "Press Enter twice quickly to exit Audio Mode.",
            "Say 'exit voice mode' to switch to standard interface.",
          ],
          note: [
            "Help — note screen.",
            "Ask any question directly to chat with the open note.",
            "Say 'summary' to hear a spoken overview of the document.",
            "Say 'back' to return to your notes list.",
            "Press Enter anytime to speak your question.",
            "Press Enter twice quickly to exit Audio Mode.",
            "Say 'repeat' to hear the last announcement again.",
          ],
          answering: [
            "Help — answer screen.",
            "Ask another question directly anytime.",
            "Press Enter anytime to interrupt or ask a new question.",
            "Press Enter twice quickly to exit Audio Mode.",
            "Say 'stop' to stop the answer.",
            "Say 'repeat' to hear the answer again.",
            "Say 'back' to return to the note.",
          ],
          summary: [
            "Help — summary screen.",
            "The audio summary is playing.",
            "Press Enter twice quickly to exit Audio Mode.",
            "Say 'back' to return to the note.",
          ],
        };
        const h = helpMap[screenRef.current] ?? helpMap.home;
        lastAnnouncedRef.current = h;
        sq.current.enqueue(h);
        return;
      }

      if (s.includes("repeat") || s.includes("say again") || s.includes("say that again")) {
        sq.current.enqueue(lastAnnouncedRef.current);
        return;
      }

      if (s.includes("exit voice") || s.includes("exit audio") || s.includes("exit mode") || s.includes("standard mode") || s.includes("switch mode")) {
        stopAllAudio();
        sq.current.enqueue(["Exiting audio mode. Returning to home screen. Goodbye."]);
        setTimeout(handleExitVoiceMode, 1800);
        return;
      }

      // ── Home screen ──────────────────────────────────────────────────────
      if (screenRef.current === "home") {
        if (s.includes("my notes") || s.includes("list notes") || s.includes("all notes") || s === "notes" || s.includes("show notes")) {
          stopAllAudio();
          announceHomeRef.current(docsRef.current);
          return;
        }
        if (s.includes("upload") || s.includes("add document") || s.includes("new document") || s.includes("add note")) {
          const t = ["Opening file picker. Please choose your document file."];
          lastAnnouncedRef.current = t;
          sq.current.enqueue(t);
          setTimeout(() => fileInputRef.current?.click(), 1200);
          return;
        }

        const num = parseNoteNum(s);
        if (num !== null && num >= 1 && num <= docsRef.current.length) {
          const doc = docsRef.current[num - 1];
          if (doc.status !== "ready") {
            sq.current.enqueue([`Note ${num} is still being processed. Please wait and try again.`]);
          } else {
            stopAllAudio();
            setSelectedDoc(doc); selDocRef.current = doc;
            setScreen("note"); screenRef.current = "note";
            setSummaryState("idle"); summaryStateRef.current = "idle";
            setExplainer(null); explainerRef.current = null;
            listExplainers(doc.id).then((list) => {
              const ready = list.find((e) => e.status === "ready");
              if (ready) { setExplainer(ready); explainerRef.current = ready; setSummaryState("ready"); summaryStateRef.current = "ready"; }
            }).catch(() => {});
            announceNoteRef.current(doc);
          }
          return;
        }
        if (s.startsWith("open ") || s.startsWith("play ")) {
          const query = s.replace(/^(open|play)\s+/, "").trim();
          const match = docsRef.current.find((d) =>
            d.original_name.toLowerCase().includes(query) ||
            query.includes(d.original_name.toLowerCase().replace(/\.pdf$/i, ""))
          );
          if (match) {
            if (match.status !== "ready") {
              sq.current.enqueue(["That note is still being processed. Please wait."]);
            } else {
              stopAllAudio();
              setSelectedDoc(match); selDocRef.current = match;
              setScreen("note"); screenRef.current = "note";
              announceNoteRef.current(match);
            }
            return;
          }
        }

        // Global search / Q&A for ANY spoken question on Home screen
        if (text.trim().length >= 3) {
          performGlobalSearch(text);
          return;
        }
      }

      // Helper for global search
      function performGlobalSearch(queryText: string) {
        const rawClean = queryText.replace(/^(search|find|tell me about|summarize|gist of|give me a gist of|open|play)\s+/i, "").trim();
        const cleanQuery = rawClean.length >= 2 ? rawClean : queryText;
        stopAllAudio();
        setScreen("answering");
        screenRef.current = "answering";
        setStatusText(`❓ Spoken Question: "${cleanQuery}"`);
        setStreamText("");
        setCmdHints(["stop", "repeat", "back"]);

        playSoundEffect("processing");
        startSearchBackgroundMusic();

        const announce = [`Searching for ${cleanQuery}. Preparing answer.`];
        lastAnnouncedRef.current = announce;
        sq.current.enqueue(announce);

        const isSummaryMode = queryText.toLowerCase().includes("gist") || queryText.toLowerCase().includes("summary") || queryText.toLowerCase().includes("overview");

        let full = "";
        sendGlobalSearchStream(cleanQuery, isSummaryMode ? "summary" : "question", (event: any) => {
          if (event.type === "matched_docs") {
            const matchedCount = event.count;
            if (matchedCount > 0) {
              const intro = event.is_specific_match
                ? [`Found ${matchedCount} matching ${cleanQuery} document${matchedCount !== 1 ? "s" : ""}.`]
                : [`Searching across all ${matchedCount} documents in your library.`];
              sq.current.enqueue(intro, false);
            }
          } else if (event.type === "chunk") {
            full += event.text;
            setStreamText(full);
          } else if (event.type === "done") {
            setStreamText(full);
            stopSearchBackgroundMusic();
            playSoundEffect("answer_ready");
            const sentences = splitSpeechText(full);
            const outro = ["When you are ready, please press the Enter key to continue our conversation."];
            lastAnnouncedRef.current = [...sentences, ...outro];
            sq.current.enqueue([...sentences, ...outro]);
          }
        }).catch(() => {
          stopSearchBackgroundMusic();
          const err = ["I cannot find an answer in the documents.", "Please press the Enter key to continue our conversation."];
          lastAnnouncedRef.current = err;
          sq.current.enqueue(err);
        });
      }

      // ── Note screen ──────────────────────────────────────────────────────
      if (screenRef.current === "note") {
        if (s.includes("summary") || s.includes("overview") || s.includes("explain") || s.includes("listen to")) {
          handleSummaryRef.current();
          return;
        }
        if (s.includes("back") || s.includes("go back") || s.includes("home") || s.includes("return")) {
          stopAllAudio();
          setScreen("home"); screenRef.current = "home";
          setSelectedDoc(null); selDocRef.current = null;
          announceHomeRef.current(docsRef.current);
          return;
        }
        // If note is open, automatically answer any spoken question directly
        if (selDocRef.current) {
          handleQuestionRef.current(text);
          return;
        } else if (text.trim().length >= 3) {
          performGlobalSearch(text);
          return;
        }
      }

      // ── Answering screen ─────────────────────────────────────────────────
      if (screenRef.current === "answering") {
        if (s.includes("stop") || s.includes("quiet") || s.includes("enough")) {
          stopAllAudio();
          const t = ["Stopped. Speak your next question anytime, or press Enter to speak."];
          lastAnnouncedRef.current = t;
          sq.current.enqueue(t);
          return;
        }
        if (s.includes("back") || s.includes("go back")) {
          stopAllAudio();
          setScreen("home"); screenRef.current = "home";
          setSelectedDoc(null); selDocRef.current = null;
          announceHomeRef.current(docsRef.current);
          return;
        }
        // Allow unlimited continuous follow-up questions directly on answering screen
        if (selDocRef.current) {
          handleQuestionRef.current(text);
          return;
        } else if (text.trim().length >= 3) {
          performGlobalSearch(text);
          return;
        }
      }

      // ── Summary screen ───────────────────────────────────────────────────
      if (screenRef.current === "summary") {
        if (s.includes("back") || s.includes("stop") || s.includes("go back")) {
          stopAllAudio();
          setScreen("note"); screenRef.current = "note";
          if (selDocRef.current) announceNoteRef.current(selDocRef.current);
          return;
        }
      }

      // Default fallback for any remaining text (treat as general query)
      if (text.trim().length >= 3) {
        performGlobalSearch(text);
      }
    };
  }, [onExitVoiceMode]);

  // ── Speech Recognition setup ───────────────────────────────────────────────
  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.maxAlternatives = 1;

    let silenceTimer: any = null;
    let accumulatedText = "";

    const submitSpeech = () => {
      const fullTranscript = accumulatedText.toLowerCase().trim();
      accumulatedText = "";
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }

      try { r.stop(); } catch {}
      isListeningRef.current = false;
      setIsListening(false);

      if (!fullTranscript) return;

      if (questionModeRef.current) {
        questionModeRef.current = false;
        handleQuestionRef.current(fullTranscript);
      } else {
        processCommandRef.current(fullTranscript);
      }
    };

    r.onresult = (e: any) => {
      let fullTranscript = "";
      for (let i = 0; i < e.results.length; ++i) {
        fullTranscript += e.results[i][0].transcript + " ";
      }
      const cleanText = fullTranscript.trim();

      if (cleanText) {
        accumulatedText = cleanText;
        setStatusText(`🎤 Hearing: "${cleanText}"…`);
        if (silenceTimer) clearTimeout(silenceTimer);
        // 1.8s silence threshold for reliable full-sentence detection
        silenceTimer = setTimeout(() => {
          submitSpeech();
        }, 1800);
      }
    };

    r.onend = () => {
      if (isExitingRef.current) return;
      if (silenceTimer) {
        try { r.start(); } catch {}
      } else if (accumulatedText.trim()) {
        submitSpeech();
      } else {
        isListeningRef.current = false;
        setIsListening(false);
        // Do NOT auto-restart mic here — wait for user to press Enter.
        // startSRRef.current() is only called from handleWakeUp (Enter key).
      }
    };

    r.onerror = (_e: any) => {
      if (isExitingRef.current) return;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      isListeningRef.current = false;
      setIsListening(false);
      // Do NOT auto-restart mic — user presses Enter to continue.
    };
    recognitionRef.current = r;

    startSRRef.current = () => {
      if (isExitingRef.current || isListeningRef.current || sq.current.isBusy) return;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (silenceTimer) clearTimeout(silenceTimer);
      accumulatedText = "";
      try {
        r.start();
        isListeningRef.current = true;
        setIsListening(true);
        setStatusText("🎤 Listening — speak your question to the agent now...");
        playSoundEffect("listen_start");
      } catch {}
    };
    stopSRRef.current = () => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (silenceTimer) clearTimeout(silenceTimer);
      accumulatedText = "";
      try { r.abort(); } catch {}
      isListeningRef.current = false;
      setIsListening(false);
    };

    sq.current.onStart = () => {
      setIsSpeaking(true);
      stopSearchBackgroundMusic();
      stopSRRef.current();
    };
    sq.current.onEmpty = () => {
      setIsSpeaking(false);
      // Do NOT auto-restart mic — user must press Enter to continue.
      // This prevents premature mic activation before the user is ready to speak.
      setStatusText("✅ Answer complete — press Enter to ask your next question, or press Enter twice to exit.");
    };
  }, []);

  // ── Manual Wake-Up Action (Enter Key / Space / Orb click) ───────────────────
  const handleWakeUp = () => {
    isExitingRef.current = false;
    // 1. Immediately halt all active speech synthesis, queue, ambient music, and audio elements
    sq.current.stop();
    try { window.speechSynthesis.pause(); } catch {}
    try { window.speechSynthesis.cancel(); } catch {}
    stopSearchBackgroundMusic();
    setIsSpeaking(false);

    if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
    }
    isListeningRef.current = false;
    setIsListening(false);

    // 2. Allow 150ms for speech synthesis audio to flush completely before starting mic
    setTimeout(() => {
      if (isExitingRef.current) return;
      startSRRef.current();
    }, 150);
  };

  // ── Double-Enter Exit Action ───────────────────────────────────────────────
  const handleEnterPress = () => {
    const now = Date.now();
    const timeSinceLastEnter = now - lastEnterTimeRef.current;
    lastEnterTimeRef.current = now;

    if (timeSinceLastEnter > 0 && timeSinceLastEnter < 2000) {
      // 2nd Enter press within 2 seconds — exit audio mode
      lastEnterTimeRef.current = 0;
      isExitingRef.current = true;
      if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onend = null;
          recognitionRef.current.onerror = null;
          recognitionRef.current.onresult = null;
          recognitionRef.current.abort();
        } catch {}
      }
      stopAllAudio();
      setIsListening(false);
      isListeningRef.current = false;
      setIsSpeaking(true);
      setStatusText("🚪 Exiting Audio Mode...");

      try { window.speechSynthesis.cancel(); } catch {}
      const exitMsg = new SpeechSynthesisUtterance("You pressed Enter twice. Returning to home screen now. Goodbye.");
      exitMsg.rate = 1.0;
      let hasExited = false;
      const doExit = () => {
        if (hasExited) return;
        hasExited = true;
        handleExitVoiceMode();
      };

      exitMsg.onend = doExit;
      exitMsg.onerror = doExit;

      // Fallback timeout in case speech synthesis stalls
      setTimeout(doExit, 3500);

      try {
        window.speechSynthesis.speak(exitMsg);
      } catch {
        doExit();
      }
    } else {
      // 1st Enter press — wake up mic to ask question
      handleWakeUp();
    }
  };

  // ── Voice loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    const load = () => {
      const vs = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
      const pref = vs.find((v) => 
        v.name.includes("Natural") || 
        v.name.includes("Online (Natural)") || 
        v.name.includes("Google US English") || 
        v.name.includes("Neural") || 
        v.name.includes("Google")
      );
      sq.current.setVoice(pref ?? vs[0] ?? null);
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // ── Initial document load ──────────────────────────────────────────────────
  useEffect(() => {
    listDocuments()
      .then((docs) => {
        setDocuments(docs);
        docsRef.current = docs;
        setScreen("home");
        screenRef.current = "home";
        announceHomeRef.current(docs);
      })
      .catch(() => {
        sq.current.enqueue(["Could not connect to the server. Please check that the app is running and refresh the page."]);
      });

    return () => {
      stopAllAudio();
      if (pollRef.current) clearInterval(pollRef.current);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    };
  }, []);

  // Reset process to the very start of Audio Mode (Triggered on Escape key)
  const handleResetToStart = () => {
    isExitingRef.current = false;
    stopAllAudio();
    setIsSpeaking(false);
    setIsListening(false);
    isListeningRef.current = false;
    questionModeRef.current = false;

    setScreen("home");
    screenRef.current = "home";
    setSelectedDoc(null);
    selDocRef.current = null;
    setExplainer(null);
    explainerRef.current = null;
    setSummaryState("idle");
    summaryStateRef.current = "idle";
    setStreamText("");

    setTimeout(() => {
      if (isExitingRef.current) return;
      announceHomeRef.current(docsRef.current);
    }, 150);
  };

  // ── Keyboard shortcuts (Enter / Space / Escape) ───────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.code === "Escape") {
        e.preventDefault();
        handleResetToStart();
      } else if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        handleEnterPress();
      } else if (e.code === "Space" && tag !== "BUTTON") {
        e.preventDefault();
        handleWakeUp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── File upload ────────────────────────────────────────────────────────────
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const t = [`Uploading ${file.name.replace(/\.pdf$/i, "")}. Please wait.`];
    lastAnnouncedRef.current = t;
    sq.current.enqueue(t);
    try {
      const doc = await uploadDocument(file);
      const newDocs = [doc, ...docsRef.current];
      setDocuments(newDocs);
      docsRef.current = newDocs;
      const succ = [
        `${file.name.replace(/\.pdf$/i, "")} uploaded successfully.`,
        "It is being processed. I will let you know when it is ready.",
        "It is now note 1 in your list.",
      ];
      lastAnnouncedRef.current = succ;
      sq.current.enqueue(succ);
      const pid = setInterval(async () => {
        const upd = await getDocument(doc.id).catch(() => null);
        if (!upd) return;
        if (upd.status === "ready") {
          clearInterval(pid);
          setDocuments((prev) => prev.map((d) => (d.id === upd.id ? upd : d)));
          const rdy = [`${upd.original_name.replace(/\.pdf$/i, "")} is ready. Say 'note 1' to open it.`];
          lastAnnouncedRef.current = rdy;
          sq.current.enqueue(rdy);
        } else if (upd.status === "error") {
          clearInterval(pid);
          sq.current.enqueue([`There was a problem processing ${file.name}. Please try uploading again.`]);
        }
      }, 3000);
    } catch (err: any) {
      sq.current.enqueue([`Upload failed. ${err.message ?? "Please try again."}`]);
    }
  };

  // ─────────────────────────────── Render ───────────────────────────────────
  return (
    <div className="bma-root" role="application" aria-label="AudioNotes Voice Mode">
      <input ref={fileInputRef} type="file" accept=".pdf,.txt,.docx" style={{ display: "none" }} onChange={handleFileSelected} id="bma-file-input" tabIndex={-1} aria-label="Select file to upload" />

      {/* Hidden audio for summary */}
      {explainer && screen !== "summary" && (
        <audio ref={audioRef} src={getExplainerAudioUrl(explainer.id)} aria-label="Document audio summary" onEnded={() => { sq.current.enqueue(["The summary has finished. Say 'back' to return to your note."]); }} />
      )}

      {/* Header */}
      <header className="bma-header" role="banner">
        <span className="bma-logo" aria-hidden="true">♿</span>
        <div className="bma-header-info">
          <div className="bma-app-name">AudioNotes AI — Voice Mode</div>
          <div className="bma-screen-label" aria-live="polite">
            {screen === "home" && "Home — All Notes"}
            {screen === "note" && `Note: ${selectedDoc?.original_name.replace(/\.pdf$/i, "")}`}
            {screen === "answering" && "Answering…"}
            {screen === "summary" && "Playing Audio Summary"}
          </div>
        </div>
        <button id="bma-exit-btn" className="bma-exit-btn" onClick={handleExitVoiceMode} aria-label="Exit audio mode, return to home screen" tabIndex={0}>
          Exit to Home Screen
        </button>
      </header>

      {/* Status orb */}
      <div
        className="bma-orb-area"
        onClick={handleEnterPress}
        tabIndex={0}
        role="button"
        aria-label="Press Enter key to speak, or press Enter twice quickly to exit Audio Mode"
        title="Click or press Enter to speak (Press Enter twice quickly to exit Audio Mode)"
        style={{ cursor: "pointer" }}
      >
        <div className={`bma-orb${isListening ? " bma-orb-listen" : ""}${isSpeaking ? " bma-orb-speak" : ""}`} aria-hidden="true">
          {isListening ? (
            <><div className="bma-ring bma-r1"/><div className="bma-ring bma-r2"/><div className="bma-ring bma-r3"/>
              <span className="bma-orb-icon">🎤</span></>
          ) : isSpeaking ? (
            <div className="bma-waves">
              {[0,1,2,3,4,5,6].map((i) => (<div key={i} className="bma-wbar" style={{ animationDelay: `${i * 0.09}s` }}/>))}
            </div>
          ) : <span className="bma-orb-icon">💬</span>}
        </div>
        <div className="bma-orb-label" aria-live="polite" aria-atomic="true">
          {isListening ? "Listening — speak now (Press Enter twice to exit)" : isSpeaking ? "Speaking — press Enter to speak (Enter twice to exit)" : "Press Enter to speak (Press Enter twice to exit)"}
        </div>
      </div>

      {/* Main status text */}
      <div className="bma-status" role="status" aria-live="polite" aria-atomic="true">{statusText}</div>

      {/* Manual text query fallback form */}
      <form onSubmit={handleTextInputSubmit} style={{ display: "flex", gap: "8px", width: "90%", maxWidth: "600px", margin: "0.75rem auto 1.5rem" }}>
        <input
          type="text"
          value={textInputQuery}
          onChange={(e) => setTextInputQuery(e.target.value)}
          placeholder="Or type any question or command & press Enter…"
          aria-label="Type any question or command for the agent"
          style={{
            flex: 1,
            padding: "0.75rem 1.25rem",
            borderRadius: "2rem",
            border: "1px solid rgba(139, 92, 246, 0.4)",
            background: "rgba(15, 23, 42, 0.8)",
            color: "#ffffff",
            fontSize: "0.95rem",
            outline: "none",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "0.75rem 1.5rem",
            borderRadius: "2rem",
            border: "none",
            background: "linear-gradient(135deg, #8b5cf6, #6366f1)",
            color: "#ffffff",
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 4px 12px rgba(139, 92, 246, 0.3)",
          }}
        >
          Ask
        </button>
      </form>

      {/* Home — document list */}
      {screen === "home" && (
        <div className="bma-doc-list" role="list" aria-label="Your notes">
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "1.5rem" }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                background: "linear-gradient(135deg, #10b981, #059669)",
                color: "#ffffff",
                border: "none",
                borderRadius: "0.5rem",
                padding: "0.75rem 1.5rem",
                fontSize: "1rem",
                fontWeight: "600",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)",
                transition: "transform 0.2s, background 0.2s"
              }}
              onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.03)")}
              onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
            >
              📁 Choose & Upload File
            </button>
          </div>
          {documents.length === 0 ? (
            <div className="bma-no-docs" role="listitem">
              <div className="bma-no-docs-icon" aria-hidden="true">📂</div>
              <p>No notes yet.</p>
              <p>Click the button above or say <strong>"upload"</strong> to add a document (PDF, TXT, DOCX).</p>
            </div>
          ) : (
            documents.map((doc, i) => (
              <div key={doc.id} className={`bma-doc-item${doc.status !== "ready" ? " bma-processing" : ""}`} role="listitem" aria-label={`Note ${i + 1}: ${doc.original_name}, ${doc.status}`}>
                <div className="bma-doc-num" aria-hidden="true">{i + 1}</div>
                <div className="bma-doc-body">
                  <div className="bma-doc-name">{doc.original_name.replace(/\.pdf$/i, "")}</div>
                  <div className="bma-doc-status" style={{ color: doc.status === "ready" ? "var(--status-ready)" : "var(--status-ingesting)" }}>
                    {doc.status === "ready" ? "✓ Ready" : `${doc.status}…`}
                  </div>
                </div>
                <div className="bma-doc-say" aria-hidden="true">Say "note {i + 1}"</div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Note detail */}
      {screen === "note" && selectedDoc && (
        <div className="bma-note-detail" aria-label={`Note open: ${selectedDoc.original_name}`}>
          <div className="bma-note-icon" aria-hidden="true">📑</div>
          <div className="bma-note-name">{selectedDoc.original_name.replace(/\.pdf$/i, "")}</div>
          <div className="bma-note-meta">
            {selectedDoc.page_count > 0 && `${selectedDoc.page_count} pages`}
            {selectedDoc.chunk_count > 0 && ` · ${selectedDoc.chunk_count} sections`}
          </div>
          {summaryState === "generating" && (
            <div className="bma-gen-row" role="status" aria-live="polite">
              <div className="bma-spinner" aria-hidden="true"/>
              <span>Generating audio summary…</span>
            </div>
          )}
        </div>
      )}

      {/* Streaming answer */}
      {screen === "answering" && (
        <div className="bma-answer-area" aria-live="off">
          <div className="bma-answer-label">Answer:</div>
          <p className="bma-answer-text">{streamText || "Searching…"}{streamText && <span className="bma-cursor" aria-hidden="true">▌</span>}</p>
        </div>
      )}

      {/* Audio summary player */}
      {screen === "summary" && explainer && (
        <div className="bma-summary-player" aria-label="Summary audio player">
          <div className="bma-sum-meta">
            <span aria-hidden="true">{explainer.persona_emoji}</span>
            <span>Narrated by {explainer.persona_name}</span>
            <span className="bma-sum-ready">✅ Playing</span>
          </div>
          <audio ref={audioRef} src={getExplainerAudioUrl(explainer.id)} controls className="bma-audio"
            aria-label={`Audio summary narrated by ${explainer.persona_name}`}
            onEnded={() => { sq.current.enqueue(["Summary finished. Say 'back' to return to your note."]); }}
          />
          <p className="bma-sum-tip">Say "back" to return · Your screen reader can also control playback</p>
        </div>
      )}

      {/* Command hints */}
      <div className="bma-hints" role="complementary" aria-label="Available voice commands">
        <div className="bma-hints-title" aria-hidden="true">Say a command:</div>
        <div className="bma-hints-chips">
          {cmdHints.map((c) => (<span key={c} className="bma-chip">"{c}"</span>))}
          <span className="bma-chip">"help"</span>
          <span className="bma-chip">"repeat"</span>
        </div>
      </div>

      {/* Keyboard footer */}
      <div className="bma-kbd-footer" aria-label="Keyboard shortcuts">
        <kbd>Esc</kbd> Exit Audio Mode &nbsp;·&nbsp; <kbd>Enter</kbd> Stop audio & activate microphone &nbsp;·&nbsp; <kbd>Space</kbd> Re-announce
      </div>
    </div>
  );
}
