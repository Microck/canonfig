'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Whether an element is out of the viewport, for pausing the page's loops
 * (the hero's sync pulse, the logo strip, the card films, the publish scene)
 * while nobody can see them. Starts as on screen, so server markup and the
 * first paint animate normally.
 */
export function useOffscreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [offscreen, setOffscreen] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setOffscreen(entry ? !entry.isIntersecting : false));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, offscreen] as const;
}

/**
 * A `<div>` that carries `data-offscreen` while it is out of view, so CSS can
 * pause the loops inside it. Lets server-rendered pictures stay server
 * components.
 */
export function Offscreen({ className, children }: { className?: string; children: ReactNode }) {
  const [ref, offscreen] = useOffscreen<HTMLDivElement>();
  return (
    <div ref={ref} className={className} data-offscreen={offscreen || undefined}>
      {children}
    </div>
  );
}

/**
 * Reveals each `[data-reveal]` section once, the first time 12% of the window
 * has scrolled past its top edge, by setting `data-revealed` (page.css runs
 * the rise). It then stops watching that section, so nothing replays. One
 * observer for the whole page; renders nothing.
 */
export function RevealOnScroll() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute('data-revealed', '');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    for (const section of document.querySelectorAll('[data-reveal]')) observer.observe(section);
    return () => observer.disconnect();
  }, []);
  return null;
}
