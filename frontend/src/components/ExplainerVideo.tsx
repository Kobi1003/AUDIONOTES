import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createExplainer,
  getExplainer,
  getExplainerAudioUrl,
  listExplainers,
  type Document,
  type Explainer,
  type ExplainerSegment,
} from '../api';

// ─── Persona visual config ───────────────────────────────────────────────────

const PERSONA_COLORS: Record<string, { primary: string; glow: string; bg: string }> = {
  doctor:     { primary: '#22c55e', glow: '#22c55e44', bg: '#052e16' },
  astronomer: { primary: '#818cf8', glow: '#818cf844', bg: '#0f0a1e' },
  scientist:  { primary: '#f59e0b', glow: '#f59e0b44', bg: '#1c1004' },
  lawyer:     { primary: '#94a3b8', glow: '#94a3b844', bg: '#0f172a' },
  coach:      { primary: '#f87171', glow: '#f8717144', bg: '#1c0505' },
  historian:  { primary: '#c084fc', glow: '#c084fc44', bg: '#150a24' },
  engineer:   { primary: '#38bdf8', glow: '#38bdf844', bg: '#041020' },
  teacher:    { primary: '#f472b6', glow: '#f472b644', bg: '#1c0516' },
};

const VISUAL_CUE_LABELS: Record<string, string> = {
  intro:   '👋 Introduction',
  explain: '💡 Explanation',
  define:  '📖 Definition',
  example: '🔍 Example',
  summary: '📋 Summary',
  signoff: '🎉 Wrap-Up',
};

// ─── Animated Avatar Canvas ──────────────────────────────────────────────────

interface AvatarProps {
  personaType: string;
  personaEmoji: string;
  personaName: string;
  isPlaying: boolean;
  currentCue: string;
  primaryColor: string;
}

function AnimatedAvatar({ personaType, personaEmoji: _personaEmoji, personaName, isPlaying, currentCue, primaryColor }: AvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const animRef = useRef<number>(0);
  const timeRef = useRef(0);
  // Canvas logical size - wide enough so face is never clipped
  const CW = 340;
  const CH = 420;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = CW;
    const H = CH;

    const draw = (ts: number) => {
      const dt = (ts - timeRef.current) / 1000;
      timeRef.current = ts;
      frameRef.current += dt;
      const t = frameRef.current;

      ctx.clearRect(0, 0, W, H);

      // Background glow
      const grad = ctx.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.45, 160);
      grad.addColorStop(0, primaryColor + '33');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      // Body sway when playing
      const sway = isPlaying ? Math.sin(t * 1.8) * 4 : 0;
      const bodyY = H * 0.52 + Math.sin(t * 0.9) * 2;

      ctx.save();
      // Only apply the sway offset here — all drawing coords already use W/2
      // so we must NOT also translate by W/2 (that would double the offset and
      // push the head to the right edge of the canvas, cutting the face in half).
      ctx.translate(sway * 0.3, 0);

      // ── Head ──
      ctx.beginPath();
      ctx.arc(W / 2, H * 0.28, 48, 0, Math.PI * 2);
      ctx.fillStyle = '#fde68a';
      ctx.fill();
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 3;
      ctx.stroke();

      // ── Eyes ──
      const blinkH = isPlaying && Math.sin(t * 7) > 0.96 ? 0 : 8;
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.ellipse(W / 2 - 16, H * 0.265, 5, blinkH / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(W / 2 + 16, H * 0.265, 5, blinkH / 2, 0, 0, Math.PI * 2);
      ctx.fill();

      // ── Eyebrows (expressive) ──
      const browLift = currentCue === 'define' ? -4 : currentCue === 'example' ? -2 : 0;
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(W / 2 - 22, H * 0.245 + browLift);
      ctx.lineTo(W / 2 - 9, H * 0.24 + browLift);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(W / 2 + 9, H * 0.24 + browLift);
      ctx.lineTo(W / 2 + 22, H * 0.245 + browLift);
      ctx.stroke();

      // ── Mouth (lip sync animation) ──
      const mouthOpen = isPlaying ? Math.abs(Math.sin(t * 6.5)) * 10 : 2;
      ctx.fillStyle = '#be123c';
      ctx.beginPath();
      ctx.ellipse(W / 2, H * 0.305, 12, mouthOpen / 2 + 1, 0, 0, Math.PI * 2);
      ctx.fill();
      if (mouthOpen > 4) {
        ctx.fillStyle = '#1e293b';
        ctx.beginPath();
        ctx.ellipse(W / 2, H * 0.308, 7, (mouthOpen - 3) / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Neck ──
      ctx.fillStyle = '#fde68a';
      ctx.fillRect(W / 2 - 10, H * 0.325, 20, 22);

      // ── Body / Outfit by persona ──
      const bodyColor = personaType === 'doctor'    ? '#ffffff' :
                        personaType === 'astronomer' ? '#1e3a5f' :
                        personaType === 'scientist'  ? '#ecfdf5' :
                        personaType === 'lawyer'     ? '#1e293b' :
                        personaType === 'coach'      ? '#dc2626' :
                        personaType === 'historian'  ? '#4c1d95' :
                        personaType === 'engineer'   ? '#0f172a' :
                                                       '#7c3aed';
      ctx.fillStyle = bodyColor;
      ctx.beginPath();
      ctx.roundRect(W / 2 - 45, bodyY - 10, 90, 100, [12, 12, 4, 4]);
      ctx.fill();
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      // ── Persona-specific badge / prop ──
      ctx.font = 'bold 22px serif';
      ctx.textAlign = 'center';
      if (personaType === 'doctor') {
        // Stethoscope
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(W / 2 + 10, bodyY + 20, 10, 0, Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(W / 2, bodyY + 30);
        ctx.lineTo(W / 2, bodyY + 50);
        ctx.stroke();
        ctx.fillStyle = '#cbd5e1';
        ctx.beginPath();
        ctx.arc(W / 2, bodyY + 50, 5, 0, Math.PI * 2);
        ctx.fill();
      } else if (personaType === 'astronomer') {
        // Stars
        ctx.fillStyle = '#fbbf24';
        for (let s = 0; s < 3; s++) {
          const sx = W / 2 - 25 + s * 25;
          const sy = bodyY + 20 + Math.sin(t * 2 + s) * 3;
          ctx.font = '14px serif';
          ctx.fillText('★', sx, sy);
        }
      } else if (personaType === 'scientist') {
        // Flask
        ctx.fillStyle = '#6ee7b7';
        ctx.beginPath();
        ctx.ellipse(W / 2 + 25, bodyY + 35, 8, 12, Math.PI / 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#059669';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (personaType === 'lawyer') {
        // Tie
        ctx.fillStyle = '#dc2626';
        ctx.beginPath();
        ctx.moveTo(W / 2 - 5, bodyY);
        ctx.lineTo(W / 2 + 5, bodyY);
        ctx.lineTo(W / 2 + 8, bodyY + 50);
        ctx.lineTo(W / 2, bodyY + 60);
        ctx.lineTo(W / 2 - 8, bodyY + 50);
        ctx.closePath();
        ctx.fill();
      } else if (personaType === 'coach') {
        // Whistle
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(W / 2 + 28, bodyY + 15, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#92400e';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (personaType === 'engineer') {
        // Laptop hint
        ctx.fillStyle = '#0ea5e9';
        ctx.fillRect(W / 2 - 20, bodyY + 40, 40, 26);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(W / 2 - 16, bodyY + 44, 32, 18);
      }

      // ── Gesturing arm (when playing) ──
      if (isPlaying) {
        const armAngle = Math.sin(t * 2) * 0.3 - 0.4;
        ctx.strokeStyle = '#fde68a';
        ctx.lineWidth = 10;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(W / 2 + 40, bodyY + 20);
        ctx.lineTo(W / 2 + 40 + Math.cos(armAngle) * 40, bodyY + 20 + Math.sin(armAngle) * 40);
        ctx.stroke();
        // Hand pointer finger
        ctx.strokeStyle = '#fde68a';
        ctx.lineWidth = 5;
        ctx.beginPath();
        const handX = W / 2 + 40 + Math.cos(armAngle) * 40;
        const handY = bodyY + 20 + Math.sin(armAngle) * 40;
        ctx.moveTo(handX, handY);
        ctx.lineTo(handX + Math.cos(armAngle - 0.3) * 15, handY + Math.sin(armAngle - 0.3) * 15);
        ctx.stroke();
      }

      ctx.restore();

      // ── Name badge ──
      ctx.fillStyle = primaryColor + 'cc';
      ctx.beginPath();
      ctx.roundRect(W / 2 - 65, H - 42, 130, 30, 8);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(personaName, W / 2, H - 22);

      // ── Ambient particles (when playing) ──
      if (isPlaying) {
        for (let p = 0; p < 5; p++) {
          const px = W / 2 + Math.sin(t * 1.5 + p * 1.3) * 90;
          const py = H * 0.35 + Math.cos(t * 1.2 + p * 0.9) * 60;
          const alpha = (Math.sin(t * 2 + p) + 1) / 2;
          ctx.fillStyle = primaryColor + Math.floor(alpha * 80).toString(16).padStart(2, '0');
          ctx.beginPath();
          ctx.arc(px, py, 3 + alpha * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [isPlaying, currentCue, primaryColor, personaType, personaName]);

  return (
    <canvas
      ref={canvasRef}
      width={CW}
      height={CH}
      style={{ display: 'block', margin: '0 auto', maxWidth: '100%' }}
      aria-label={`Animated avatar of ${personaName}`}
    />
  );
}

// ─── Chalkboard / Keyword Panel ───────────────────────────────────────────────

interface ChalkboardProps {
  segment: ExplainerSegment | null;
  primaryColor: string;
}

function Chalkboard({ segment, primaryColor }: ChalkboardProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
    const t = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(t);
  }, [segment?.segment]);

  if (!segment) return null;

  return (
    <div
      className="explainer-chalkboard"
      style={{
        borderColor: primaryColor + '66',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(10px)',
      }}
    >
      <div className="chalkboard-cue-label" style={{ color: primaryColor }}>
        {VISUAL_CUE_LABELS[segment.visual_cue] || '💡 Explanation'}
      </div>
      {segment.keywords.length > 0 && (
        <div className="chalkboard-keywords">
          {segment.keywords.map((kw, i) => (
            <span key={i} className="chalkboard-keyword" style={{ borderColor: primaryColor, color: primaryColor }}>
              {kw}
            </span>
          ))}
        </div>
      )}
      <div className="chalkboard-segment-num" style={{ color: primaryColor + '88' }}>
        Segment {segment.segment}
      </div>
    </div>
  );
}

// ─── Main ExplainerVideo Component ───────────────────────────────────────────

interface ExplainerVideoProps {
  document: Document;
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

export function ExplainerVideo({ document: doc, onToast }: ExplainerVideoProps) {
  const [_explainers, setExplainers] = useState<Explainer[]>([]);
  const [active, setActive] = useState<Explainer | null>(null);
  const [segments, setSegments] = useState<ExplainerSegment[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentSegmentIdx, setCurrentSegmentIdx] = useState(0);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [blindMode, setBlindMode] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Fetch existing explainers on mount / doc change
  useEffect(() => {
    loadExplainers();
  }, [doc.id]);

  const loadExplainers = async () => {
    try {
      const list = await listExplainers(doc.id);
      setExplainers(list);
      if (list.length > 0 && list[0].status === 'ready') {
        loadExplainer(list[0]);
      } else if (list.length > 0 && list[0].status === 'generating') {
        setIsGenerating(true);
        startPolling(list[0].id);
      }
    } catch {
      // ignore
    }
  };

  const loadExplainer = (exp: Explainer) => {
    setActive(exp);
    if (exp.script) {
      try {
        setSegments(JSON.parse(exp.script));
      } catch {
        setSegments([]);
      }
    }
  };

  const startPolling = (explainerId: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const updated = await getExplainer(explainerId);
        if (updated.status === 'ready') {
          clearInterval(pollRef.current!);
          setIsGenerating(false);
          setExplainers([updated]);
          loadExplainer(updated);
          onToast('🎬 Explainer video is ready!', 'success');
        } else if (updated.status === 'error') {
          clearInterval(pollRef.current!);
          setIsGenerating(false);
          onToast('❌ Explainer generation failed.', 'error');
        }
      } catch {
        // ignore
      }
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const exp = await createExplainer(doc.id);
      setExplainers([exp]);
      onToast('🎬 Generating your AI explainer video... this may take a minute.', 'info');
      startPolling(exp.id);
    } catch (err: any) {
      setIsGenerating(false);
      onToast(err.message || 'Failed to start generation', 'error');
    }
  };

  // ── Audio sync ──
  // New explainers have exact `start_time` embedded per segment by the backend.
  // Older explainers fall back to character-length-proportional estimation.
  const segmentStartTimes = useCallback((): number[] => {
    if (segments.length === 0 || duration === 0) return [];

    // Backend embeds real start_time on every segment — use it for perfect sync
    if (segments.every(s => typeof s.start_time === 'number')) {
      return segments.map(s => s.start_time as number);
    }

    // Fallback: estimate from char counts + 500 ms pauses between segments
    const PAUSE_SEC = 0.5;
    const totalPause = PAUSE_SEC * (segments.length - 1);
    const speechDuration = Math.max(0, duration - totalPause);
    const totalChars = segments.reduce((s, seg) => s + (seg.text?.length ?? 0), 0) || 1;
    const starts: number[] = [];
    let cursor = 0;
    for (let i = 0; i < segments.length; i++) {
      starts.push(cursor);
      const segSpeechDur = (segments[i].text?.length ?? 0) / totalChars * speechDuration;
      cursor += segSpeechDur + (i < segments.length - 1 ? PAUSE_SEC : 0);
    }
    return starts;
  }, [segments, duration]);

  const updateCurrentSegment = useCallback((time: number) => {
    if (segments.length === 0 || duration === 0) return;
    const starts = segmentStartTimes();
    // Walk backwards: last segment whose start_time <= current time (50 ms tolerance)
    let idx = 0;
    for (let i = starts.length - 1; i >= 0; i--) {
      if (time >= starts[i] - 0.05) { idx = i; break; }
    }
    setCurrentSegmentIdx(idx);

    // Auto-scroll transcript
    if (transcriptRef.current) {
      const item = transcriptRef.current.querySelector(`[data-seg="${idx}"]`) as HTMLElement;
      if (item) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [segments, duration, segmentStartTimes]);


  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !active) return;

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      updateCurrentSegment(audio.currentTime);
    };
    const onLoadedMeta = () => setDuration(audio.duration || active.duration_seconds);
    const onEnded = () => { setIsPlaying(false); setCurrentSegmentIdx(0); };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMeta);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMeta);
      audio.removeEventListener('ended', onEnded);
    };
  }, [active, updateCurrentSegment]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) { audio.pause(); setIsPlaying(false); }
    else { audio.play(); setIsPlaying(true); }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = parseFloat(e.target.value);
    audio.currentTime = t;
    setCurrentTime(t);
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  };

  const handleRate = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // ── Derived persona visuals ──
  const personaType = active?.persona_type || 'teacher';
  const colors = PERSONA_COLORS[personaType] || PERSONA_COLORS.teacher;
  const currentSeg = segments[currentSegmentIdx] || null;

  // ── Empty / Generating state ──
  if (!active && !isGenerating) {
    return (
      <div className="explainer-empty">
        <div className="explainer-empty-icon">🎬</div>
        <h2>AI Explainer Video</h2>
        <p>
          Generate a fully narrated, animated explainer video of your document.
          An AI persona — matched to your document's field — will explain everything
          in simple terms, including jargon, so <strong>anyone</strong> can understand.
        </p>
        <div className="explainer-features">
          {['🔬 Domain-aware persona', '🗣️ Jargon explained', '♿ Blind-friendly narration', '🎭 Animated character'].map(f => (
            <span key={f} className="explainer-feature-badge">{f}</span>
          ))}
        </div>
        <button
          id="generate-explainer-btn"
          className="explainer-generate-btn"
          onClick={handleGenerate}
          disabled={doc.status !== 'ready'}
        >
          ✨ Generate AI Explainer Video
        </button>
        {doc.status !== 'ready' && (
          <p className="explainer-not-ready">Document must finish processing first.</p>
        )}
      </div>
    );
  }

  if (isGenerating && !active) {
    return (
      <div className="explainer-empty">
        <div className="explainer-generating-spinner" />
        <h2>Generating Your Explainer Video</h2>
        <p>The AI is reading your document, detecting the subject area, selecting a persona, and writing a full narrated script. This usually takes 1–3 minutes.</p>
        <div className="explainer-gen-steps">
          {['📖 Reading PDF', '🔬 Detecting domain', '🎭 Selecting persona', '✍️ Writing script', '🎙️ Synthesizing voice'].map((s, i) => (
            <div key={i} className="explainer-gen-step">
              <span className="explainer-gen-step-dot" />
              {s}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`explainer-player ${blindMode ? 'blind-mode' : ''}`} style={{ '--persona-color': colors.primary, '--persona-glow': colors.glow, '--persona-bg': colors.bg } as React.CSSProperties}>

      {/* Hidden audio element */}
      {active && (
        <audio
          ref={audioRef}
          src={getExplainerAudioUrl(active.id)}
          preload="metadata"
          aria-label={`Explainer narration by ${active.persona_name}`}
        />
      )}

      {/* ── Persona header ── */}
      <div className="explainer-header">
        <div className="explainer-persona-badge">
          <span className="explainer-persona-emoji">{active?.persona_emoji || '🎓'}</span>
          <div>
            <div className="explainer-persona-name">{active?.persona_name}</div>
            <div className="explainer-persona-domain">
              {active?.domain ? active.domain.charAt(0).toUpperCase() + active.domain.slice(1) + ' Expert' : 'Expert'}
            </div>
          </div>
        </div>
        <div className="explainer-header-actions">
          <button
            id="blind-mode-toggle"
            className={`explainer-icon-btn ${blindMode ? 'active' : ''}`}
            onClick={() => setBlindMode(b => !b)}
            title={blindMode ? 'Show animation' : 'Blind-friendly mode (audio only)'}
            aria-pressed={blindMode}
          >
            {blindMode ? '👁️' : '🎭'}
          </button>
          <button
            id="transcript-toggle"
            className={`explainer-icon-btn ${showTranscript ? 'active' : ''}`}
            onClick={() => setShowTranscript(s => !s)}
            title="Toggle transcript"
          >
            📝
          </button>
          <button
            id="regenerate-explainer-btn"
            className="explainer-icon-btn"
            onClick={handleGenerate}
            disabled={isGenerating}
            title="Generate new explainer"
          >
            🔄
          </button>
        </div>
      </div>

      {/* ── Main stage ── */}
      <div className="explainer-stage">
        {/* Avatar */}
        {!blindMode && (
          <div className="explainer-avatar-area">
            <div className="explainer-avatar-glow" style={{ background: `radial-gradient(circle, ${colors.glow} 0%, transparent 70%)` }} />
            <AnimatedAvatar
              personaType={personaType}
              personaEmoji={active?.persona_emoji || '🎓'}
              personaName={active?.persona_name || 'Teacher Sam'}
              isPlaying={isPlaying}
              currentCue={currentSeg?.visual_cue || 'explain'}
              primaryColor={colors.primary}
            />
            <Chalkboard segment={currentSeg} primaryColor={colors.primary} />
          </div>
        )}

        {/* Current segment callout */}
        <div className={`explainer-callout ${blindMode ? 'explainer-callout-wide' : ''}`} aria-live="polite" aria-atomic="true">
          <div className="explainer-callout-cue" style={{ color: colors.primary }}>
            {currentSeg ? VISUAL_CUE_LABELS[currentSeg.visual_cue] : '🎬 Ready to play'}
          </div>
          <div className="explainer-callout-text">
            {currentSeg?.text || 'Press play to start the explanation.'}
          </div>
          {currentSeg && currentSeg.keywords.length > 0 && (
            <div className="explainer-callout-keywords">
              {currentSeg.keywords.map((kw, i) => (
                <span key={i} className="callout-kw" style={{ background: colors.primary + '22', color: colors.primary }}>
                  🔑 {kw}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Player controls ── */}
      <div className="explainer-controls">
        {/* Seek bar */}
        <div className="explainer-seek-row">
          <span className="explainer-time">{formatTime(currentTime)}</span>
          <input
            id="explainer-seek-bar"
            type="range"
            className="explainer-seek"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            style={{ '--fill': colors.primary } as React.CSSProperties}
            aria-label="Seek through explainer"
          />
          <span className="explainer-time">{formatTime(duration)}</span>
        </div>

        {/* Buttons row */}
        <div className="explainer-btn-row">
          {/* Rewind 10s */}
          <button
            id="explainer-rewind-btn"
            className="explainer-ctrl-btn secondary"
            onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, currentTime - 10); }}
            aria-label="Rewind 10 seconds"
          >⏪</button>

          {/* Play / Pause */}
          <button
            id="explainer-play-btn"
            className="explainer-play-btn"
            onClick={togglePlay}
            style={{ background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}aa)` }}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>

          {/* Skip 10s */}
          <button
            id="explainer-skip-btn"
            className="explainer-ctrl-btn secondary"
            onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.min(duration, currentTime + 10); }}
            aria-label="Skip 10 seconds"
          >⏩</button>

          {/* Volume */}
          <div className="explainer-volume">
            <span>🔊</span>
            <input
              id="explainer-volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={handleVolume}
              className="explainer-vol-slider"
              aria-label="Volume"
            />
          </div>

          {/* Speed */}
          <div className="explainer-speed">
            {[0.75, 1, 1.25, 1.5].map(rate => (
              <button
                key={rate}
                id={`speed-${rate.toString().replace('.', '_')}`}
                className={`explainer-speed-btn ${playbackRate === rate ? 'active' : ''}`}
                onClick={() => handleRate(rate)}
                style={playbackRate === rate ? { color: colors.primary, borderColor: colors.primary } : {}}
              >
                {rate}×
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Segment progress dots ── */}
      {!blindMode && segments.length > 0 && (
        <div className="explainer-progress-dots" role="progressbar" aria-valuenow={currentSegmentIdx + 1} aria-valuemax={segments.length}>
          {segments.map((seg, i) => (
            <button
              key={i}
              id={`seg-dot-${i}`}
              className={`explainer-dot ${i === currentSegmentIdx ? 'active' : i < currentSegmentIdx ? 'done' : ''}`}
              title={seg.visual_cue}
              style={i <= currentSegmentIdx ? { background: colors.primary } : {}}
              onClick={() => {
                if (audioRef.current && duration > 0) {
                  const starts = segmentStartTimes();
                  audioRef.current.currentTime = starts[i] ?? 0;
                }
              }}
              aria-label={`Go to segment ${i + 1}: ${VISUAL_CUE_LABELS[seg.visual_cue]}`}
            />
          ))}
        </div>
      )}

      {/* ── Full Transcript ── */}
      {showTranscript && segments.length > 0 && (
        <div className="explainer-transcript" ref={transcriptRef} aria-label="Full transcript">
          <h3 className="transcript-heading" style={{ color: colors.primary }}>📝 Full Transcript</h3>
          {segments.map((seg, i) => (
            <div
              key={i}
              data-seg={i}
              className={`transcript-seg ${i === currentSegmentIdx ? 'active' : ''}`}
              style={i === currentSegmentIdx ? { borderLeftColor: colors.primary, background: colors.glow } : {}}
              onClick={() => {
                if (audioRef.current && duration > 0) {
                  const starts = segmentStartTimes();
                  audioRef.current.currentTime = starts[i] ?? 0;
                  if (!isPlaying) { audioRef.current.play(); setIsPlaying(true); }
                }
              }}
            >
              <div className="transcript-seg-cue" style={{ color: colors.primary }}>
                {VISUAL_CUE_LABELS[seg.visual_cue]}
              </div>
              <div className="transcript-seg-text">{seg.text}</div>
              {seg.keywords.length > 0 && (
                <div className="transcript-seg-kws">
                  {seg.keywords.map((kw, ki) => (
                    <span key={ki} className="transcript-kw" style={{ color: colors.primary }}>#{kw}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
