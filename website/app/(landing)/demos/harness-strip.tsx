'use client';

import { HARNESSES, HarnessLogo } from './harnesses';
import { useOffscreen } from './offscreen';
import { revealDelay } from '../reveal';
import './harness-strip.css';

/**
 * The logo wall: one slow, endless row. Two identical tracks slide left by
 * their own width, so the second takes the first's place without a seam.
 * Hover holds it still, and so does scrolling it out of view; reduced motion
 * shows the logos still and wrapped.
 */
export function HarnessStrip() {
  const [stripRef, offscreen] = useOffscreen<HTMLDivElement>();
  return (
    <section className="sa-grid band" aria-labelledby="band-title" data-reveal>
      <p className="band-title rv" id="band-title" style={revealDelay(0)}>
        Works with {HARNESSES.length} harnesses
      </p>
      <div ref={stripRef} className="strip rv" style={revealDelay(80)} data-offscreen={offscreen || undefined}>
        <Track />
        <Track copy />
      </div>
    </section>
  );
}

function Track({ copy = false }: { copy?: boolean }) {
  return (
    <ul className="strip-track" aria-hidden={copy || undefined} aria-label={copy ? undefined : 'Supported harnesses'}>
      {HARNESSES.map(({ name, logo }) => (
        <li key={name}>
          <HarnessLogo logo={logo} className="strip-logo" />
          {name}
        </li>
      ))}
    </ul>
  );
}
