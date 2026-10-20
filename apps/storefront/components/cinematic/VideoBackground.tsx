'use client';

import { useEffect, useRef, useState } from 'react';
import type { CinematicMedia } from '../../lib/media';

export function VideoBackground({ asset, className = '', priority = false }: { asset: CinematicMedia; className?: string; priority?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setEnabled(!preference.matches); if (preference.matches) { video.current?.pause(); setPlaying(false); } };
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const element = container.current;
    const player = video.current;
    if (!element || !player || !enabled || failed || !('IntersectionObserver' in window)) return;
    let visible = false;
    const sync = () => {
      if (visible && !document.hidden) void player.play().catch(() => setPlaying(false));
      else { player.pause(); setPlaying(false); }
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: .15 });
    observer.observe(element);
    document.addEventListener('visibilitychange', sync);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); player.pause(); };
  }, [enabled, failed, asset.video]);

  return <div ref={container} className={`absolute inset-0 overflow-hidden ${className}`}>
    {/* Authored SVGs remain visible if playback is unavailable or disabled. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={asset.poster} alt={asset.description} className="h-full w-full object-cover" loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : 'auto'} />
    {asset.video && enabled && !failed && <video ref={video} src={asset.video} poster={asset.poster} muted loop playsInline preload="none" aria-hidden="true" onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => { setFailed(true); setPlaying(false); }} className={`absolute inset-0 h-full w-full object-cover ${playing ? 'opacity-100' : 'opacity-0'}`} />}
  </div>;
}
