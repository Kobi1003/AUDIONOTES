import { useEffect, useRef, useState } from 'react';

interface WaveformProps {
  isPlaying: boolean;
  barCount?: number;
}

export function Waveform({ isPlaying, barCount = 40 }: WaveformProps) {
  const [heights, setHeights] = useState<number[]>(() =>
    Array.from({ length: barCount }, () => Math.random() * 40 + 10)
  );
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      return;
    }

    const animate = () => {
      setHeights((prev) =>
        prev.map((h) => {
          const delta = (Math.random() - 0.5) * 12;
          return Math.max(8, Math.min(52, h + delta));
        })
      );
      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [isPlaying]);

  return (
    <div className="waveform-container" aria-hidden="true">
      {heights.map((h, i) => (
        <div
          key={i}
          className={`wave-bar${isPlaying ? ' active' : ''}`}
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  );
}
