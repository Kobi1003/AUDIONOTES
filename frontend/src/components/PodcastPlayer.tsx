import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPodcast,
  getPodcast,
  getPodcastAudioUrl,
  listPodcasts,
  type Document,
  type Podcast,
  type ScriptLine,
} from '../api';
import { Waveform } from './Waveform';

interface PodcastPlayerProps {
  document: Document;
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function PodcastPlayer({ document, onToast }: PodcastPlayerProps) {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [activePodcast, setActivePodcast] = useState<Podcast | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [scriptLines, setScriptLines] = useState<ScriptLine[]>([]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load existing podcasts
  useEffect(() => {
    setActivePodcast(null);
    setIsPlaying(false);
    setPodcasts([]);
    setScriptLines([]);

    listPodcasts(document.id)
      .then((list) => {
        setPodcasts(list);
        const ready = list.find((p) => p.status === 'ready');
        if (ready) loadPodcast(ready);

        // If there's a generating one, start polling
        const generating = list.find((p) => p.status === 'generating');
        if (generating) startPolling(generating.id);
      })
      .catch(() => {});
  }, [document.id]);

  // Sync playback rate
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  const loadPodcast = (podcast: Podcast) => {
    setActivePodcast(podcast);
    if (podcast.script) {
      try {
        setScriptLines(JSON.parse(podcast.script));
      } catch {
        setScriptLines([]);
      }
    }
    // Reset audio
    setCurrentTime(0);
    setIsPlaying(false);
  };

  const startPolling = useCallback((podcastId: number) => {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const updated = await getPodcast(podcastId);
        if (updated.status === 'ready') {
          clearInterval(pollRef.current!);
          setPodcasts((prev) =>
            prev.map((p) => (p.id === podcastId ? updated : p))
          );
          loadPodcast(updated);
          setIsGenerating(false);
          onToast('🎙️ Podcast ready! Click play to listen.', 'success');
        } else if (updated.status === 'error') {
          clearInterval(pollRef.current!);
          setIsGenerating(false);
          onToast(updated.error_message || 'Podcast generation failed.', 'error');
        }
      } catch {
        // ignore transient errors
      }
    }, 3000);
  }, [onToast]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const handleGenerate = async () => {
    if (document.status !== 'ready') {
      onToast('Document must be fully indexed before generating a podcast.', 'error');
      return;
    }
    setIsGenerating(true);
    try {
      const podcast = await createPodcast(document.id);
      setPodcasts((prev) => [podcast, ...prev]);
      startPolling(podcast.id);
      onToast('🎙️ Generating your podcast… This takes 1-2 minutes.', 'info');
    } catch (e: unknown) {
      setIsGenerating(false);
      onToast((e as Error).message || 'Failed to start podcast generation.', 'error');
    }
  };

  const togglePlay = () => {
    if (!audioRef.current || !activePodcast) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => onToast('Playback error.', 'error'));
    }
    setIsPlaying(!isPlaying);
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = ratio * duration;
  };

  const handleSkip = (seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, currentTime + seconds));
  };

  const progressPercent = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="podcast-section">
      {/* Generate Button */}
      {document.status === 'ready' && (
        <button
          className="generate-btn"
          onClick={handleGenerate}
          disabled={isGenerating || document.status !== 'ready'}
          id="generate-podcast-btn"
        >
          {isGenerating ? (
            <>
              <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
              Generating Podcast…
            </>
          ) : (
            <>🎙️ Generate AI Podcast Episode</>
          )}
        </button>
      )}

      {document.status !== 'ready' && (
        <div className="empty-state">
          <div className="empty-state-icon">⚙️</div>
          <h2>Document Not Ready</h2>
          <p>Please wait for the document to finish indexing before generating a podcast.</p>
        </div>
      )}

      {/* Generating State (no podcast yet) */}
      {isGenerating && !activePodcast && (
        <div className="glass-card generating-state">
          <div className="spinner" />
          <h3 style={{ fontFamily: 'Space Grotesk, sans-serif' }}>Creating Your Podcast</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', maxWidth: '300px', textAlign: 'center' }}>
            The AI is reading the document, crafting a dual-host script, and synthesizing voices. Usually takes 1–2 minutes.
          </p>
        </div>
      )}

      {/* Podcast Player */}
      {activePodcast && activePodcast.status === 'ready' && (
        <>
          <div className="podcast-player">
            {/* Host Avatars */}
            <div className="podcast-host-avatars">
              <div className={`host-avatar host-a${isPlaying ? ' active' : ''}`}>🎤</div>
              <div className={`host-avatar host-b${isPlaying ? ' active' : ''}`}>🎙️</div>
            </div>

            <div className="podcast-title">AI Podcast Episode</div>
            <div className="podcast-subtitle">
              {document.original_name} • Hosted by Alex &amp; Sarah
            </div>

            {/* Waveform */}
            <Waveform isPlaying={isPlaying} barCount={48} />

            {/* Progress Bar */}
            <div
              className="audio-progress-track"
              onClick={handleProgressClick}
              role="slider"
              aria-label="Audio progress"
              aria-valuenow={Math.floor(currentTime)}
              aria-valuemin={0}
              aria-valuemax={Math.floor(duration)}
            >
              <div
                className="audio-progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="audio-time-labels">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>

            {/* Controls */}
            <div className="playback-controls">
              <button className="ctrl-btn" onClick={() => handleSkip(-15)} title="Rewind 15s">⏮</button>
              <button className="ctrl-btn" onClick={() => handleSkip(-5)} title="Back 5s">◀◀</button>
              <button className="ctrl-btn play-btn" onClick={togglePlay} id="podcast-play-btn" title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button className="ctrl-btn" onClick={() => handleSkip(5)} title="Forward 5s">▶▶</button>
              <button className="ctrl-btn" onClick={() => handleSkip(15)} title="Forward 15s">⏭</button>
            </div>

            {/* Speed & Download */}
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '16px' }}>
              <select
                className="speed-selector"
                value={playbackRate}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
                aria-label="Playback speed"
              >
                {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                  <option key={r} value={r}>{r}×</option>
                ))}
              </select>

              <a
                href={getPodcastAudioUrl(activePodcast.id)}
                className="download-btn"
                download={`podcast_${document.original_name}.mp3`}
                target="_blank"
                rel="noreferrer"
              >
                ⬇ Download MP3
              </a>
            </div>

            {/* Hidden audio element */}
            <audio
              ref={audioRef}
              src={getPodcastAudioUrl(activePodcast.id)}
              onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
              onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
              onEnded={() => setIsPlaying(false)}
              onError={() => onToast('Audio playback error.', 'error')}
              preload="metadata"
            />
          </div>

          {/* Script Transcript */}
          {scriptLines.length > 0 && (
            <div className="script-transcript">
              <div className="script-transcript-title">📝 Podcast Script</div>
              {scriptLines.map((line, i) => (
                <div key={i} className={`script-line host-${line.host.toLowerCase()}`}>
                  <span className="script-host-badge">
                    {line.host === 'A' ? 'Alex' : 'Sarah'}
                  </span>
                  <span className="script-line-text">{line.text}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Previous Podcasts */}
      {podcasts.length > 1 && (
        <div style={{ marginTop: '8px' }}>
          <div className="doc-list-title" style={{ marginBottom: '10px' }}>Previous Episodes</div>
          {podcasts.slice(1).map((pod) => (
            <div
              key={pod.id}
              className={`doc-item${activePodcast?.id === pod.id ? ' active' : ''}`}
              onClick={() => pod.status === 'ready' && loadPodcast(pod)}
              style={{ cursor: pod.status === 'ready' ? 'pointer' : 'default' }}
            >
              <div className="doc-item-meta">
                <span className={`status-badge ${pod.status}`}>
                  <span className={`status-dot${pod.status === 'generating' ? ' pulse' : ''}`} />
                  {pod.status}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {new Date(pod.created_at).toLocaleDateString()}
                </span>
                {pod.duration_seconds > 0 && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {formatTime(pod.duration_seconds)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
