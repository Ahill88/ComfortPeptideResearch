'use client';

import { useEffect, useRef } from 'react';
import { animate } from 'motion';
import type { ReactNode } from 'react';

export function ScrollReveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!element || preference.matches || !('IntersectionObserver' in window)) return;
    let animation: ReturnType<typeof animate> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      animation = animate(element, { opacity: [0.55, 1], transform: ['translateY(18px)', 'translateY(0)'] }, { duration: .65, ease: [.22, 1, .36, 1] });
      observer.disconnect();
    }, { threshold: .12 });
    const stop = () => { if (preference.matches) { animation?.stop(); element.style.opacity = '1'; element.style.transform = 'none'; observer.disconnect(); } };
    observer.observe(element);
    preference.addEventListener('change', stop);
    return () => { observer.disconnect(); animation?.stop(); preference.removeEventListener('change', stop); };
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}
