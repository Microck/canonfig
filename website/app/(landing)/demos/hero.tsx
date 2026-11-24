'use client';

import { useEffect, useRef, useState } from 'react';
import { HARNESSES, HarnessLogo } from './harnesses';
import { FOLLOWERS, IconTile, type Machine } from './machine';
import { useOffscreen } from './offscreen';
import './hero.css';

const SOURCE: Machine = {
  name: 'atlas',
  platform: 'Linux',
  accent: 'var(--sa-dither-purple)',
  icon: 'desktop',
  harnesses: ['claude-code', 'openai-codex', 'opencode'],
};

const NAMES = new Map<string, string>(HARNESSES.map(({ name, logo }) => [logo, name]));

// One sync every 4.8s (hero.css): the first starts once the map has settled,
// then a pulse leaves atlas down each edge 140ms apart, and each follower's
// ring lights as its pulse lands. Path and ring share each delay.
const pulseDelay = (index: number) => `${2200 + index * 140}ms`;

/**
 * The hero picture, drawn like the GUI's machine map: atlas holds the one
 * setup in ~/.canonfig/ and every follower gets it, in whichever harnesses it
 * runs. Logos instead of file names, so it reads at a glance. On load the
 * edges draw and the followers settle; then a sync pulse runs down every edge
 * on a slow loop. Reduced motion shows the map still.
 */
export default function HeroDiagram() {
  const [figureRef, offscreen] = useOffscreen<HTMLElement>();
  return (
    <figure ref={figureRef} className="hm" data-offscreen={offscreen || undefined}>
      <figcaption className="sa-sr">
        atlas, the Source, holds the setup in ~/.canonfig/. laptop, studio, gaming-pc and build-box each get the same setup in the harnesses they run.
      </figcaption>
      <div className="hm-source">
        <Node machine={SOURCE} role="Source" folder />
      </div>
      <Edges />
      <span className="hm-trunk" aria-hidden="true" />
      <ul className="hm-followers" aria-label="Follower Machines">
        {FOLLOWERS.map((machine, index) => (
          <li key={machine.name} style={{ '--animation-delay': `${1000 + index * 110}ms` }}>
            <Node machine={machine} role="Up to date" pulseDelay={pulseDelay(index)} />
          </li>
        ))}
      </ul>
    </figure>
  );
}

/**
 * The edges from atlas to each follower, in real pixels: the pulse is a dash
 * slid along each path, and dashes only measure true on a drawing that is not
 * stretched. So the SVG takes its own size as its viewBox, and redraws when
 * that changes. Columns are exactly a quarter wide (hero.css), so each edge
 * ends at 12.5%, 37.5%, 62.5% or 87.5% of the width.
 */
function Edges() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() => setSize({ width: svg.clientWidth, height: svg.clientHeight }));
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  return (
    <svg ref={svgRef} className="hm-edges" viewBox={size ? `0 0 ${size.width} ${size.height}` : undefined} aria-hidden="true">
      {size
        ? FOLLOWERS.map((machine, index) => {
            const { width, height } = size;
            const x = width * (0.125 + 0.25 * index);
            const d = `M${width / 2} 0 C${width / 2} ${height * 0.55} ${x} ${height * 0.45} ${x} ${height}`;
            return (
              <g key={machine.name}>
                <path className="hm-edge" d={d} />
                <path className="hm-pulse" d={d} pathLength={100} style={{ '--animation-delay': pulseDelay(index) }} />
              </g>
            );
          })
        : null}
    </svg>
  );
}

function Node({ machine, role, folder = false, pulseDelay }: { machine: Machine; role: string; folder?: boolean; pulseDelay?: string }) {
  return (
    <div className="hm-node" data-source={folder || undefined}>
      {/* Lights as this follower's sync pulse lands. */}
      {pulseDelay ? <span className="hm-ring" aria-hidden="true" style={{ '--animation-delay': pulseDelay }} /> : null}
      <div className="hm-head">
        <svg className="hm-tile" viewBox="0 0 26 26" aria-hidden="true">
          <IconTile id={`hero-${machine.name}`} accent={machine.accent} icon={machine.icon} source={folder} />
        </svg>
        <span className="hm-name">
          <b>{machine.name}</b>
          <span>{machine.platform}</span>
        </span>
        {folder ? <code className="hm-folder">~/.canonfig/</code> : null}
      </div>
      <div className="hm-foot">
        <ul className="hm-logos" aria-label={`Harnesses on ${machine.name}`}>
          {machine.harnesses.map((logo) => (
            <li key={logo} title={NAMES.get(logo)}>
              <HarnessLogo logo={logo} className="hm-logo" />
              <span className="sa-sr">{NAMES.get(logo)}</span>
            </li>
          ))}
        </ul>
        <span className={folder ? 'hm-role' : 'hm-role hm-role-ok'}>
          {folder ? null : (
            <svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="6" fill="currentColor" />
              <path d="M4.4 7.2 6.2 9 9.6 5.3" fill="none" stroke="var(--sa-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {role}
        </span>
      </div>
    </div>
  );
}
