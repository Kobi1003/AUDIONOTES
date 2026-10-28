import { useState, useEffect, useRef, useCallback } from "react";
import type { Document, Explainer } from "../api";
import {
  sendBlindChatStream,
  createExplainer,
  listExplainers,
  getExplainer,
  getExplainerAudioUrl,
} from "../api";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface BlindCompanionProps {
  document: Document;
  onToast: (msg: string, type: "success" | "error" | "info") => void;
}

export function BlindCompanion({ document, onToast }: BlindCompanionProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [currentResponse, setCurrentResponse] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speechRate, setSpeechRate] = useState(1.0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceIdx, setSelectedVoiceIdx] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState<"idle" | "generating" | "ready">("idle");
  const [explainer, setExplainer] = useState<Explainer | null>(null);
  const [hasSR, setHasSR] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [showShortcuts, setShowShortcuts] = useState(false);

  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const micBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const loadVoices = () => {
      const v = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
      setVoices(v);
      if (v.length > 0) {
        const pref = v.findIndex(
          (v) => v.name.includes("Google") || v.name.includes("Neural") || v.name.includes("Natural")
        );
        setSelectedVoiceIdx(pref >= 0 ? pref : 0);
      }
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, []);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setHasSR(false); return; }
    setHasSR(true);
    const r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = "en-US";
    r.onresult = (e: any) => {
      const t = Array.from(e.results as SpeechRecognitionResultList)
        .map((res: any) => res[0].transcript)
        .join("");
      setTranscript(t);
      if (e.results[e.results.length - 1].isFinal) {
        setIsListening(false);
        sendQuestion(t);
      }
    };
    r.onerror = () => {
      setIsListening(false);
      onToast("Microphone error. Check browser permissions and try again.", "error");
    };
    r.onend = () => setIsListening(false);
    recognitionRef.current = r;
  }, []);

  useEffect(() => {
    listExplainers(document.id)
      .then((list) => {
        const ready = list.find((e) => e.status === "ready");
        if (ready) { setExplainer(ready); setSummaryStatus("ready"); }
      })
      .catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      window.speechSynthesis.cancel();
    };
  }, [document.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.code === "Space" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        micBtnRef.current?.click();
      }
      if (e.code === "Escape") { window.speechSynthesis.cancel(); setIsSpeaking(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentResponse]);

  const speak = useCallback(
    (text: string) => {
      if (!autoSpeak || !text) return;
      window.speechSynthesis.cancel();

      // Strip markdown and split into chunks to avoid Chromium 200-char cutoff
      const clean = text
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/#{1,6}\s+/g, "")
        .replace(/`{1,3}[^`]*`{1,3}/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        .trim();

      const rawParts = clean.split(/(?<=[.!?])\s+|\n+/);
      const chunks: string[] = [];
      for (const part of rawParts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (trimmed.length > 180) {
          const subParts = trimmed.split(/(?<=[,;:])\s+/);
          for (const sub of subParts) { if (sub.trim()) chunks.push(sub.trim()); }
        } else {
          chunks.push(trimmed);
        }
      }
      const finalChunks = chunks.length > 0 ? chunks : [clean];

      // Keepalive to prevent Chromium from stalling long speech
      const keepAlive = setInterval(() => {
        if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 10000);

      let idx = 0;
      const speakNext = () => {
        if (idx >= finalChunks.length) {
          clearInterval(keepAlive);
          setIsSpeaking(false);
          return;
        }
        const u = new SpeechSynthesisUtterance(finalChunks[idx++]);
        u.rate = speechRate;
        if (voices[selectedVoiceIdx]) u.voice = voices[selectedVoiceIdx];
        if (idx === 1) u.onstart = () => setIsSpeaking(true);
        u.onend = speakNext;
        u.onerror = (e) => {
          if (e.error !== "canceled" && e.error !== "interrupted") speakNext();
          else { clearInterval(keepAlive); setIsSpeaking(false); }
        };
        window.speechSynthesis.speak(u);
      };
      speakNext();
    },
    [autoSpeak, speechRate, voices, selectedVoiceIdx]
  );

  const stopSpeaking = () => { window.speechSynthesis.cancel(); setIsSpeaking(false); };

  const toggleMic = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else if (!isResponding) {
      window.speechSynthesis.cancel();
      setTranscript("");
      try { recognitionRef.current?.start(); setIsListening(true); }
      catch { onToast("Could not start microphone. Please try again.", "error"); }
    }
  };

  const sendQuestion = async (question: string) => {
    const q = question.trim();
    if (!q) return;
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: q }]);
    setTranscript("");
    setManualInput("");
    setIsResponding(true);
    setCurrentResponse("");
    try {
      let full = "";
      await sendBlindChatStream(document.id, q, (event: any) => {
        if (event.type === "chunk") { full += event.text; setCurrentResponse(full); }
        else if (event.type === "done") {
          setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", content: full }]);
          setCurrentResponse("");
          speak(full);
        }
      });
    } catch (err: any) {
      onToast(err.message || "Could not get a response. Please try again.", "error");
    } finally {
      setIsResponding(false);
    }
  };

  const handleGenerateSummary = async () => {
    setSummaryStatus("generating");
    try {
      const exp = await createExplainer(document.id);
      pollRef.current = setInterval(async () => {
        const updated = await getExplainer(exp.id).catch(() => null);
        if (!updated) return;
        if (updated.status === "ready") {
          clearInterval(pollRef.current!);
          setExplainer(updated);
          setSummaryStatus("ready");
          onToast("Audio summary is ready! Press play to listen.", "success");
        } else if (updated.status === "error") {
          clearInterval(pollRef.current!);
          setSummaryStatus("idle");
          onToast("Summary generation failed. Please try again.", "error");
        }
      }, 3000);
    } catch (err: any) {
      setSummaryStatus("idle");
      onToast(err.message || "Failed to start summary generation.", "error");
    }
  };

  return (
    <div className="bc-root" role="main" aria-label="Blind Companion accessibility agent">
      <header className="bc-header" role="banner">
        <div className="bc-header-icon" aria-hidden="true">?</div>
        <div className="bc-header-text">
          <h2 className="bc-title">Blind Companion Agent</h2>
          <p className="bc-subtitle" title={document.original_name}>
            Voice-first accessibility � {document.original_name}
          </p>
        </div>
        <button
          className="bc-shortcuts-toggle"
          onClick={() => setShowShortcuts((v) => !v)}
          aria-expanded={showShortcuts}
          aria-label="Show keyboard shortcuts"
          id="shortcuts-toggle-btn"
        >
          ?? Shortcuts
        </button>
      </header>

      {showShortcuts && (
        <div className="bc-shortcuts-panel" role="region" aria-label="Keyboard shortcuts">
          <div className="bc-shortcut"><kbd>Space</kbd> Start / stop microphone</div>
          <div className="bc-shortcut"><kbd>Esc</kbd> Stop speaking immediately</div>
          <div className="bc-shortcut"><kbd>Tab</kbd> Navigate between controls</div>
          <div className="bc-shortcut"><kbd>Enter</kbd> Activate focused button</div>
        </div>
      )}

      <section className="bc-input-section" aria-label="Voice input">
        {hasSR ? (
          <div className="bc-mic-wrapper">
            {isListening && (
              <>
                <div className="bc-ring bc-ring-1" aria-hidden="true" />
                <div className="bc-ring bc-ring-2" aria-hidden="true" />
                <div className="bc-ring bc-ring-3" aria-hidden="true" />
              </>
            )}
            <button
              ref={micBtnRef}
              id="mic-toggle-btn"
              className={`bc-mic-btn${isListening ? " bc-listening" : ""}${isResponding ? " bc-thinking" : ""}`}
              onClick={toggleMic}
              disabled={isResponding}
              aria-label={
                isListening
                  ? "Stop listening � press Space or Enter"
                  : isResponding
                  ? "Agent is thinking, please wait"
                  : "Start voice input � press Space or Enter"
              }
              aria-pressed={isListening}
            >
              <span className="bc-mic-emoji" aria-hidden="true">
                {isListening ? "?" : isResponding ? "?" : "??"}
              </span>
              <span className="bc-mic-text">
                {isListening ? "Listening�" : isResponding ? "Thinking�" : "Tap to Speak"}
              </span>
              <span className="bc-mic-hint" aria-hidden="true">Space</span>
            </button>
          </div>
        ) : (
          <div className="bc-no-sr" role="alert">
            ?? Voice recognition is not supported in your browser. Please use <strong>Chrome</strong> or <strong>Edge</strong>.
          </div>
        )}

        {(isListening || transcript) && (
          <div className="bc-transcript" role="status" aria-live="assertive">
            <span className="bc-transcript-label" aria-hidden="true">You said:</span>
            <p className="bc-transcript-text">{transcript || "�"}</p>
          </div>
        )}

        <form
          className="bc-manual-form"
          onSubmit={(e) => { e.preventDefault(); sendQuestion(manualInput); }}
          aria-label="Type your question"
        >
          <input
            id="manual-question-input"
            type="text"
            className="bc-manual-input"
            placeholder="Or type your question here�"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            disabled={isResponding}
            aria-label="Type a question about the document"
          />
          <button
            type="submit"
            className="bc-manual-send"
            disabled={isResponding || !manualInput.trim()}
            aria-label="Send typed question"
            id="manual-send-btn"
          >
            Ask ?
          </button>
        </form>
      </section>

      <section className="bc-messages" role="log" aria-label="Conversation" aria-live="polite">
        {messages.length === 0 && !currentResponse && !isListening && (
          <div className="bc-empty" role="note">
            <div className="bc-empty-icon" aria-hidden="true">??</div>
            <p className="bc-empty-title">Hello! I&apos;m your Blind Companion.</p>
            <p className="bc-empty-hint">
              Press <strong>Space</strong> or tap the microphone to ask anything about{" "}
              <strong>{document.original_name}</strong>. I&apos;ll read every answer aloud for you.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`bc-msg bc-msg-${msg.role}`}
            aria-label={msg.role === "user" ? "Your question" : "Agent answer"}
          >
            <div className="bc-msg-role" aria-hidden="true">
              {msg.role === "user" ? "?? You" : "?? Agent"}
            </div>
            <p className="bc-msg-content">{msg.content}</p>
            {msg.role === "assistant" && (
              <button
                className="bc-replay-btn"
                onClick={() => speak(msg.content)}
                aria-label="Read this answer aloud again"
              >
                ?? Read again
              </button>
            )}
          </div>
        ))}

        {currentResponse && (
          <div className="bc-msg bc-msg-assistant bc-msg-streaming" aria-live="polite" aria-label="Agent is responding">
            <div className="bc-msg-role" aria-hidden="true">?? Agent</div>
            <p className="bc-msg-content">
              {currentResponse}
              <span className="bc-cursor" aria-hidden="true">�</span>
            </p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </section>

      {isSpeaking && (
        <div className="bc-speaking" role="status" aria-live="polite">
          <div className="bc-speaking-waves" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </div>
          <span className="bc-speaking-text">Speaking�</span>
          <button className="bc-stop-btn" onClick={stopSpeaking} aria-label="Stop reading aloud" id="stop-speaking-btn">
            ? Stop
          </button>
        </div>
      )}

      <section className="bc-settings" role="region" aria-label="Voice settings">
        <h3 className="bc-section-title">?? Voice Settings</h3>
        <div className="bc-settings-grid">
          <div className="bc-setting">
            <label className="bc-setting-label" htmlFor="auto-speak-btn">Auto-read responses</label>
            <button
              id="auto-speak-btn"
              className={`bc-toggle${autoSpeak ? " bc-toggle-on" : " bc-toggle-off"}`}
              onClick={() => setAutoSpeak((v) => !v)}
              aria-pressed={autoSpeak}
              aria-label={`Auto-read is ${autoSpeak ? "on" : "off"}. Click to toggle.`}
            >
              {autoSpeak ? "ON" : "OFF"}
            </button>
          </div>

          <div className="bc-setting bc-setting-wide">
            <label className="bc-setting-label" htmlFor="speech-rate-slider">
              Speed: {speechRate.toFixed(1)}�
            </label>
            <input
              id="speech-rate-slider"
              type="range"
              className="bc-slider"
              min="0.6"
              max="1.8"
              step="0.1"
              value={speechRate}
              onChange={(e) => setSpeechRate(Number(e.target.value))}
              aria-label={`Speech rate: ${speechRate.toFixed(1)} times normal`}
              aria-valuemin={0.6}
              aria-valuemax={1.8}
              aria-valuenow={speechRate}
            />
            <div className="bc-slider-labels" aria-hidden="true"><span>Slow</span><span>Fast</span></div>
          </div>

          {voices.length > 0 && (
            <div className="bc-setting bc-setting-wide">
              <label className="bc-setting-label" htmlFor="voice-selector">Speaking voice</label>
              <select
                id="voice-selector"
                className="bc-select"
                value={selectedVoiceIdx}
                onChange={(e) => setSelectedVoiceIdx(Number(e.target.value))}
                aria-label="Select the voice for reading responses aloud"
              >
                {voices.map((v, i) => (
                  <option key={i} value={i}>{v.name} ({v.lang})</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </section>

      <section className="bc-summary" role="region" aria-label="Document audio summary">
        <h3 className="bc-section-title">?? Listen to Document Summary</h3>
        <p className="bc-summary-desc">
          Get a complete spoken overview of <strong>{document.original_name}</strong> narrated by an AI expert � no reading required.
        </p>

        {summaryStatus === "idle" && (
          <button
            id="generate-summary-btn"
            className="bc-summary-generate-btn"
            onClick={handleGenerateSummary}
            disabled={document.status !== "ready"}
            aria-label="Generate an audio summary of the document"
          >
            ??? Generate Audio Summary
          </button>
        )}

        {summaryStatus === "generating" && (
          <div className="bc-generating" role="status" aria-live="polite">
            <div className="bc-spinner" aria-hidden="true" />
            <p>Generating your audio summary� This takes about a minute.</p>
          </div>
        )}

        {summaryStatus === "ready" && explainer && (
          <div className="bc-audio-player" aria-label="Document audio summary player">
            <div className="bc-audio-meta">
              <span className="bc-audio-persona" aria-hidden="true">
                {explainer.persona_emoji} {explainer.persona_name}
              </span>
              <span className="bc-audio-ready">? Ready to play</span>
            </div>
            <audio
              ref={audioRef}
              src={getExplainerAudioUrl(explainer.id)}
              controls
              className="bc-audio"
              aria-label={`Audio summary narrated by ${explainer.persona_name}`}
            />
            <p className="bc-audio-tip">
              ?? Tip: Use your keyboard or screen reader to control playback.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
