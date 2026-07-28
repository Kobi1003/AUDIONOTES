import { useCallback, useEffect, useRef, useState } from "react";
import { getDocument, listDocuments, type Document } from "./api";
import { BlindModeApp } from "./components/BlindModeApp";
import { ChatSection } from "./components/ChatSection";
import { ExplainerVideo } from "./components/ExplainerVideo";
import { Sidebar } from "./components/Sidebar";

type Tab = "chat" | "explainer";

interface Toast {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

let toastId = 0;

// ─── Accessibility Gate ───────────────────────────────────────────────────────
// Shown on starting screen. Speaks a welcome message asking if user prefers Audio Mode or Interface Mode.
// Saves choice so preference is remembered, but can be switched anytime.

function AccessibilityGate({ onChoose }: { onChoose: (blind: boolean) => void }) {
  const [phase, setPhase] = useState<"idle" | "speaking" | "listening" | "done">("idle");
  const phaseRef = useRef<"idle" | "speaking" | "listening" | "done">("idle");
  const srRef = useRef<any>(null);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const stopAllSpeech = () => {
    if (activeUtteranceRef.current) {
      activeUtteranceRef.current.onend = null;
      activeUtteranceRef.current.onerror = null;
      activeUtteranceRef.current = null;
    }
    if (srRef.current) {
      try { srRef.current.abort(); } catch {}
      srRef.current = null;
    }
    window.speechSynthesis.cancel();
  };

  const pickVoice = () => {
    const vs = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    return vs.find((v) => v.name.includes("Google") || v.name.includes("Natural")) ?? vs[0] ?? null;
  };

  const startListening = () => {
    if (phaseRef.current === "done") return;
    setPhase("listening");
    phaseRef.current = "listening";
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e: any) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) {
        t += e.results[i][0].transcript + " ";
      }
      t = t.toLowerCase().trim();
      if (!t) return;

      if (
        t.includes("audio") ||
        t.includes("voice") ||
        t.includes("yes") ||
        t.includes("yeah") ||
        t.includes("yep") ||
        t.includes("first") ||
        t.includes("one") ||
        t.includes("1") ||
        t.includes("listen") ||
        t.includes("headphone") ||
        t.includes("sound")
      ) {
        stopAllSpeech();
        setPhase("done");
        phaseRef.current = "done";
        const u = new SpeechSynthesisUtterance("Audio Mode activated. Loading voice assistant.");
        u.voice = pickVoice();
        activeUtteranceRef.current = u;
        window.speechSynthesis.speak(u);
        setTimeout(() => {
          stopAllSpeech();
          onChoose(true);
        }, 1600);
      } else if (
        t.includes("interface") ||
        t.includes("visual") ||
        t.includes("summarize") ||
        t.includes("concept") ||
        t.includes("standard") ||
        t.includes("no") ||
        t.includes("second") ||
        t.includes("two") ||
        t.includes("2") ||
        t.includes("screen") ||
        t.includes("text")
      ) {
        stopAllSpeech();
        setPhase("done");
        phaseRef.current = "done";
        onChoose(false);
      }
    };
    r.onerror = () => {
      if (phaseRef.current === "listening") {
        setTimeout(startListening, 500);
      }
    };
    try { r.start(); } catch {}
    srRef.current = r;
  };

  const startWelcome = () => {
    if (phaseRef.current === "done") return;
    stopAllSpeech();
    setPhase("speaking");
    phaseRef.current = "speaking";

    const messages = [
      "Welcome to AudioNotes AI.",
      "Do you prefer Audio Mode or Interface Mode?",
      "Say Audio Mode, or press Audio Mode, for full voice control and agent Q and A.",
      "Say Interface Mode, or press Interface Mode, for visual summaries and AI tools.",
    ];

    const voice = pickVoice();
    let idx = 0;
    const next = () => {
      if (phaseRef.current !== "speaking") return;
      if (idx >= messages.length) { startListening(); return; }
      const u = new SpeechSynthesisUtterance(messages[idx++]);
      u.rate = 1.0;
      if (voice) u.voice = voice;
      activeUtteranceRef.current = u;
      u.onend = () => {
        if (activeUtteranceRef.current === u) {
          activeUtteranceRef.current = null;
          if (phaseRef.current === "speaking") {
            next();
          }
        }
      };
      window.speechSynthesis.speak(u);
    };

    setTimeout(next, 100);
  };

  const handleKeyOrClick = () => {
    if (phaseRef.current === "done") return;
    if (phaseRef.current === "speaking") {
      // Interrupt speaking assistant immediately and activate microphone
      stopAllSpeech();
      startListening();
    } else if (phaseRef.current === "idle") {
      startWelcome();
    } else if (phaseRef.current === "listening") {
      stopAllSpeech();
      startListening();
    }
  };

  // Listen for Enter / Space / gesture to interrupt assistant & start listening
  useEffect(() => {
    const load = () => pickVoice();
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);

    const timer = setTimeout(() => {
      if (phaseRef.current === "idle") {
        startWelcome();
      }
    }, 400);

    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") {
        e.preventDefault();
        handleKeyOrClick();
      }
    };

    const handleUserInteraction = () => {
      if (phaseRef.current === "idle") {
        startWelcome();
      }
    };

    window.addEventListener("keydown", handleGlobalKey);
    window.addEventListener("pointerdown", handleUserInteraction);

    return () => {
      clearTimeout(timer);
      stopAllSpeech();
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      window.removeEventListener("keydown", handleGlobalKey);
      window.removeEventListener("pointerdown", handleUserInteraction);
    };
  }, []);

  return (
    <div
      className="ag-root"
      tabIndex={0}
      aria-label="Starting screen. Choose Audio Mode or Interface Mode."
      onKeyDown={(e) => {
        if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") {
          e.preventDefault();
          handleKeyOrClick();
        }
      }}
    >
      <div className="ag-content" onClick={handleKeyOrClick}>
        <div className="ag-logo" aria-hidden="true">🎙️</div>
        <h1 className="ag-title">Welcome to AudioNotes AI</h1>

        <p className="ag-question" style={{ fontSize: "1.25rem", fontWeight: 600, color: "var(--accent-purple-light, #c084fc)", margin: "12px 0 6px" }}>
          Do you prefer Audio Mode or Interface Mode?
        </p>

        <p className="ag-subtitle" aria-live="polite">
          {phase === "idle" && "Press Enter or click anywhere to start voice options"}
          {phase === "speaking" && "🔊 Speaking options… (Press Enter to interrupt & speak)"}
          {phase === "listening" && "🎤 Listening — say 'Audio Mode' or 'Interface Mode'"}
          {phase === "done" && "Entering…"}
        </p>

        <div className="ag-buttons" onClick={(e) => e.stopPropagation()}>
          <button
            id="ag-voice-btn"
            className="ag-btn ag-btn-voice"
            tabIndex={0}
            aria-label="Audio Mode. Fully voice-controlled mode with Enter-key speech activation."
            onClick={() => {
              window.speechSynthesis.cancel();
              setPhase("done");
              onChoose(true);
            }}
          >
            <span className="ag-btn-icon" aria-hidden="true">🎧</span>
            <span className="ag-btn-label">Audio Mode</span>
            <span className="ag-btn-sub">Voice assistant & press Enter to ask questions</span>
          </button>

          <button
            id="ag-standard-btn"
            className="ag-btn ag-btn-standard"
            tabIndex={0}
            aria-label="Interface Mode. Visual document layout, AI chat, podcast, and video summaries."
            onClick={() => {
              window.speechSynthesis.cancel();
              onChoose(false);
            }}
          >
            <span className="ag-btn-icon" aria-hidden="true">💻</span>
            <span className="ag-btn-label">Interface Mode</span>
            <span className="ag-btn-sub">Visual documents, AI chat, podcast & video</span>
          </button>
        </div>

        <p className="ag-tip" aria-hidden="true">
          Speak your choice, select an option above, or press Enter. You can switch modes anytime.
        </p>
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

function App() {
  // Always start on initial choice screen (null) on fresh page load so voice lines play
  const [blindMode, setBlindMode] = useState<boolean | null>(null);

  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleChooseMode = (blind: boolean) => {
    localStorage.setItem("audionotesAccessibilityMode", blind ? "voice" : "standard");
    setBlindMode(blind);
  };

  const handleExitVoiceMode = () => {
    try { window.speechSynthesis.pause(); } catch {}
    try { window.speechSynthesis.cancel(); } catch {}
    document.querySelectorAll("audio, video").forEach((media) => {
      try {
        (media as HTMLMediaElement).pause();
        (media as HTMLMediaElement).currentTime = 0;
      } catch {}
    });
    localStorage.setItem("audionotesAccessibilityMode", "standard");
    setBlindMode(false);
    fetchDocs();
  };

  const fetchDocs = async () => {
    try { const docs = await listDocuments(); setDocuments(docs); }
    catch { /* ignore */ }
  };

  useEffect(() => { if (blindMode === false) fetchDocs(); }, [blindMode]);

  // Poll for status updates on non-ready documents (standard mode only)
  useEffect(() => {
    if (blindMode !== false) return;
    if (pollRef.current) clearInterval(pollRef.current);
    const pending = documents.filter((d) => d.status === "ingesting" || d.status === "uploading");
    if (pending.length === 0) return;
    pollRef.current = setInterval(async () => {
      const updates = await Promise.all(pending.map((d) => getDocument(d.id).catch(() => d)));
      setDocuments((prev) => { const map = new Map(updates.map((u) => [u.id, u])); return prev.map((d) => map.get(d.id) ?? d); });
      if (selectedDoc && pending.some((d) => d.id === selectedDoc.id)) {
        const updated = updates.find((u) => u.id === selectedDoc.id);
        if (updated) { setSelectedDoc(updated); if (updated.status === "ready") addToast(`"${updated.original_name}" is ready to chat!`, "success"); }
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [documents, selectedDoc, blindMode]);

  const addToast = useCallback((message: string, type: Toast["type"]) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  // ── Accessibility gate ─────────────────────────────────────────────────────
  if (blindMode === null) {
    return <AccessibilityGate onChoose={handleChooseMode} />;
  }

  // ── Voice mode ─────────────────────────────────────────────────────────────
  if (blindMode === true) {
    return <BlindModeApp onExitVoiceMode={handleExitVoiceMode} />;
  }

  // ── Standard mode ──────────────────────────────────────────────────────────
  return (
    <div className="app-layout">
      <Sidebar
        documents={documents}
        selectedDoc={selectedDoc}
        onSelectDoc={(doc) => { setSelectedDoc(doc); setActiveTab("chat"); }}
        onDocumentUploaded={(doc) => { setDocuments((prev) => [doc, ...prev]); setSelectedDoc(doc); }}
        onDocumentDeleted={(id) => { setDocuments((prev) => prev.filter((d) => d.id !== id)); if (selectedDoc?.id === id) setSelectedDoc(null); }}
        onToast={addToast}
      />

      <main className="main-content">
        {/* Switch to voice mode button */}
        <div className="switch-mode-bar">
          <button
            className="switch-mode-btn"
            id="switch-to-voice-btn"
            aria-label="Switch to Audio Mode"
            onClick={() => { localStorage.setItem("audionotesAccessibilityMode", "voice"); setBlindMode(true); }}
          >
            🎧 Switch to Audio Mode
          </button>
        </div>

        {selectedDoc ? (
          <>
            <div className="top-bar">
              <div className="top-bar-left">
                <h1 title={selectedDoc.original_name}>📑 {selectedDoc.original_name}</h1>
                <p>
                  {selectedDoc.page_count > 0 && `${selectedDoc.page_count} pages · `}
                  {selectedDoc.chunk_count > 0 && `${selectedDoc.chunk_count} chunks · `}
                  Status: <span style={{ color: statusColor(selectedDoc.status), fontWeight: 600 }}>{selectedDoc.status}</span>
                </p>
              </div>
              <nav className="tab-nav" aria-label="View tabs">
                {(["chat", "explainer"] as Tab[]).map((tab) => (
                  <button key={tab} className={`tab-btn${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)} id={`${tab}-tab-btn`}>
                    {tab === "chat" ? "💬 Chat" : "🎬 AI Video"}
                  </button>
                ))}
              </nav>
            </div>

            <div className="content-area">
              {activeTab === "chat" ? (
                <ChatSection document={selectedDoc} onToast={addToast} />
              ) : (
                <ExplainerVideo document={selectedDoc} onToast={addToast} />
              )}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">🎙️</div>
            <h2>Welcome to AudioNotes AI</h2>
            <p>Upload a PDF from the sidebar to unlock AI chat and AI video explanations.</p>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center", marginTop: "8px" }}>
              {["📄 PDF Upload", "🔍 RAG Chat", "🎬 AI Video", "🆓 Free TTS"].map((f) => (
                <span key={f} style={{ padding: "8px 16px", background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.2)", borderRadius: "20px", fontSize: "13px", color: "var(--accent-purple)" }}>{f}</span>
              ))}
            </div>
          </div>
        )}
      </main>

      <div className="toast-container" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span>{t.type === "success" ? "✅" : t.type === "error" ? "❌" : "ℹ️"}</span>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "ready": return "var(--status-ready)";
    case "ingesting": return "var(--status-ingesting)";
    case "uploading": return "var(--status-uploading)";
    case "error": return "var(--status-error)";
    default: return "var(--text-muted)";
  }
}

export default App;
