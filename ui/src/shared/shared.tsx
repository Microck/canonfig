// Shared display components used by the workspace and onboarding.
import { useState, type CSSProperties, type ReactNode } from "react";
import { Question } from "@/components/icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn, SNAP } from "@/lib/utils";
import { DitherShader, ditherMask, fillStyle } from "@/lib/dither";
import { BAYER_8 } from "@/lib/dither/matrices";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATE_META, type FollowerState } from "./metadata";

/**
 * Glossary terms from the Language section of AGENTS.md. `plain` is the everyday word the UI shows;
 * the Canonfig term stays one hover away. `meaning` is written for someone who
 * has never read the docs.
 */
export const GLOSSARY = {
  "Source Machine": {
    plain: "Source",
    meaning: "The one machine that owns your setup. You edit and publish here, and every other machine copies from it.",
  },
  "Follower Machine": {
    plain: "follower",
    meaning: "A machine that copies the Source's published setup. It can keep its own configuration in a local folder, within the Source's rules.",
  },
  "Machine Profile": {
    plain: "profile",
    meaning: "The setup you share with other machines. You edit its instructions, skills, settings and tool requirements in ~/.canonfig/ on the Source.",
  },
  "Canonical Folder": {
    plain: "Canonfig folder",
    meaning: "The ~/.canonfig folder on every machine. On the Source you write your setup there; on a follower it holds a copy of what the Source published, plus that machine's own items.",
  },
  "Target Harness": {
    plain: "harness",
    meaning: "An AI coding tool, such as Codex or Claude Code. Canonfig writes the shared setup into that tool's own configuration files.",
  },
  "Takeover Snapshot": {
    plain: "backup",
    meaning: "A copy of settings Canonfig is about to replace, kept in ~/.canonfig/.backups/ so you can restore them. Canonfig saves this copy only when the Backups setting is on.",
  },
  "Profile Revision": {
    plain: "revision",
    meaning: "A published, numbered version of your profile that never changes. Machines only get what you publish, never unpublished edits.",
  },
  "Profile Resource": {
    plain: "item",
    meaning: "One part of the shared setup, such as a skill, a connection to an external service through MCP, or a tool to install.",
  },
  "Local folder": {
    plain: "local folder",
    meaning: "~/.canonfig/local on one machine: items it adds for itself, within what the Source allows. Canonfig never replaces them and never sends them to the Source.",
  },
  "Local Overlay": {
    plain: "local replacement",
    meaning: "This machine's choice that its own item replaces the published one with the same name, here only. It lives in ~/.canonfig/local/local.jsonc and never goes to the Source.",
  },
  "Key Claim": {
    plain: "key you set yourself",
    meaning: "This machine's choice that one key of a harness's settings file is its own. Canonfig never writes, removes or checks that key there, and the other keys it writes in the file keep following the Source. It lives in ~/.canonfig/local/local.jsonc and never goes to the Source.",
  },
  "Append-local": {
    plain: "kept alongside",
    meaning: "Canonfig owns only its marked part of an instructions file, or only the skills it writes in a skills folder. Everything else the machine put there stays and is never reported as an edit.",
  },
  "Follower Drift": {
    plain: "local edit",
    meaning: "Someone changed a file Canonfig manages, on that machine. Canonfig keeps the change, reports it and stops updating what came from that file.",
  },
  "Human Action Required": {
    plain: "needs you",
    meaning: "A step only a person can do, like signing in to a tool. Syncing continues once it's done.",
  },
  Convergence: {
    plain: "up to date",
    meaning: "Everything a machine should have matches the profile and passes its check.",
  },
  "Follower Group": {
    plain: "group",
    meaning: "A named set of machines that get extra items on top of the base profile. A machine's groups come from its invitation.",
  },
  "Synchronization Schedule": {
    plain: "schedule",
    meaning: "When a machine checks for a new revision and applies it on its own.",
  },
  "Configuration Agent": {
    plain: "AI agent",
    meaning: "An optional AI agent that helps Canonfig resolve configuration tasks it cannot complete with fixed instructions. Its rules limit the folders, programs and sites it can use.",
  },
  "Synchronization Run": {
    plain: "sync",
    meaning: "One recorded attempt to bring a machine up to date.",
  },
} as const satisfies Record<string, { plain: string; meaning: string }>;

export type Term = keyof typeof GLOSSARY;

/** The tooltip's last line, so the docs and CLI vocabulary is always one hover away. */
function CalledThis({ term }: { term: string }) {
  return <span className="mt-2 block text-xs text-muted-foreground">Canonfig calls this {term}.</span>;
}

/**
 * A Canonfig concept in everyday words that explains itself on hover or focus and names the Canonfig
 * term. Shows the plain word unless `children` are given.
 *
 * Where it sits decides how it looks (ui/docs/design/overlays.md, Tooltip):
 * - Inside running text ("…gets its own identity, as a follower."), it is the word with a dotted
 *   underline. An icon in the middle of a sentence breaks the line it sits on.
 * - As a title or label (`label`), it is the plain text followed by a small (?) button, because an
 *   underlined heading reads as a link.
 * The word or the (?) is the tab stop, so the definition is reachable by keyboard; never put a Term
 * inside a button or link.
 */
export function Term({ children, term, label = false }: { children?: ReactNode; term: Term; label?: boolean }) {
  const { plain, meaning } = GLOSSARY[term];
  const title = plain.charAt(0).toUpperCase() + plain.slice(1);
  // Short blocks with space between them; one dense paragraph was hard to read.
  const content = (
    <TooltipContent className="max-w-72 text-sm leading-relaxed">
      <span className="block font-medium">{title}</span>
      <span className="mt-1 block">{meaning}</span>
      <CalledThis term={term} />
    </TooltipContent>
  );
  if (!label) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="rounded-[2px] underline decoration-faint decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {children ?? plain}
          </span>
        </TooltipTrigger>
        {content}
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <span>{children ?? plain}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`What is ${typeof children === "string" ? children : plain}?`}
            className="relative inline-flex size-4 shrink-0 items-center justify-center self-center rounded-sm text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-6"
          >
            <Question className="size-3" />
          </button>
        </TooltipTrigger>
        {content}
      </Tooltip>
    </span>
  );
}

/**
 * A small (?) that explains a control without cluttering its label. `label` names what it explains,
 * so screen readers hear "More about Host key" rather than a row of identical "More information" buttons.
 */
export function Hint({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`More about ${label}`} className={cn("relative -my-1 inline-flex h-6 w-10 shrink-0 items-center justify-center rounded-sm align-middle pointer-coarse:h-7 pointer-coarse:w-11 text-faint hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}>
          <Question className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-sm">{children}</TooltipContent>
    </Tooltip>
  );
}

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", act: "text-act", bad: "text-bad", muted: "text-faint" } as const;
const TONE_DITHER = { ok: "green", warn: "--warn", act: "orange", bad: "red", muted: "grey", purple: "purple" } as const;

/**
 * Every state a status marker shows. `bad` and `offline` share a colour, so shape
 * carries the difference (and keeps all six apart in greyscale / colour-blindness).
 * `off` covers not installed / not used / not applied.
 */
export type StatusKind = "ok" | "warn" | "act" | "bad" | "offline" | "off";

const STATUS_TEXT: Record<StatusKind, string> = { ok: "text-ok", warn: "text-warn", act: "text-act", bad: "text-bad", offline: "text-bad", off: "text-faint" };

/**
 * Linear-style status marker: fill amount reads as progress (ring, half, three-quarter,
 * check), × and a dashed ring mark the exceptions. 14px, centred by its flex parent.
 * Decorative: the adjacent label always carries the meaning.
 */
export function StatusMark({ kind, className }: { kind: StatusKind; className?: string }) {
  const ring = <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />;
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" data-status-mark={kind} className={cn("shrink-0", STATUS_TEXT[kind], className)}>
      {kind === "ok" && (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.4 7.2 6.2 9 9.6 5.3" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === "warn" && (
        <>
          {ring}
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
        </>
      )}
      {kind === "act" && (
        <>
          {ring}
          <path d="M7 7V3.5a3.5 3.5 0 1 1-3.5 3.5z" fill="currentColor" />
        </>
      )}
      {kind === "bad" && (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="m4.8 4.8 4.4 4.4m0-4.4-4.4 4.4" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
      {kind === "offline" && <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2" />}
      {kind === "off" && <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.9" />}
    </svg>
  );
}

/**
 * Status marker + label. The label always carries the meaning; colour and shape
 * only reinforce it. `self` uses the wording for the follower's own screens
 * ("You edited this" instead of "Edited on that machine").
 */
export function StateLabel({ state, compact, self }: { state: FollowerState | "excluded"; compact?: boolean; self?: boolean }) {
  const meta = STATE_META[state];
  const label = (self && meta.selfLabel) || meta.label;
  const hint = (self && meta.selfHint) || meta.hint;
  const kind: StatusKind = state === "offline" ? "offline" : meta.tone === "muted" ? "off" : meta.tone;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", TONE_TEXT[meta.tone])}>
          <StatusMark kind={kind} />
          {compact ? <span className="sr-only">{label}</span> : <span className="text-sm">{label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-sm">
        <span className="block font-medium">{label}</span>
        {hint}
        {meta.term && <CalledThis term={meta.term} />}
      </TooltipContent>
    </Tooltip>
  );
}

/** A dithered cell for the convergence matrix: texture density encodes state. */
export function StateCell({ state }: { state: FollowerState | "excluded" }) {
  const tone = STATE_META[state].tone;
  const variant = state === "converged" ? "solid" : state === "excluded" ? "dotted" : state === "never-synced" ? "dotted" : "hatched";
  return (
    <span className="relative block size-full overflow-hidden rounded-[3px]">
      <span
        className={cn("absolute inset-0", state === "converged" && "opacity-30")}
        style={fillStyle(variant, { color: TONE_DITHER[tone], cell: 2 })}
      />
    </span>
  );
}

// Half the cells of a 4×4 Bayer tile at 1.5px cells: the grain of the shimmer.
const SHIMMER_STYLE = {
  "--shimmer-dots": ditherMask(0.5),
  "--shimmer-tile": "6px",
} as CSSProperties;

/**
 * Dithered progress. The fill is a dither ramp, densest at its leading edge,
 * so progress reads as texture rather than a flat bar. While `running` and
 * unfinished, a dotted highlight sweeps toward the edge (CSS mask-position
 * only; held still under reduced motion).
 */
export function DitherProgress({
  value,
  tone = "ok",
  label,
  running = false,
  className,
}: {
  value: number;
  tone?: keyof typeof TONE_DITHER;
  /** The progressbar's accessible name: the operation, e.g. "Reading files". */
  label: string;
  running?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative h-1.5 overflow-hidden rounded-full bg-muted", className)} role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className="absolute inset-y-0 left-0" style={{ width: `${value}%` }}>
        <div className="absolute inset-0" style={fillStyle("gradient", { color: TONE_DITHER[tone], edge: "right", length: 18, to: 0.25, cell: 1.5 })} />
        {running && value < 100 && <div aria-hidden className="dither-shimmer absolute inset-0" style={SHIMMER_STYLE} />}
      </div>
    </div>
  );
}

// Soft contour bands rising from the bottom edge. One shader serves every state:
// each state sets one motion weight (see BAND_MOTION) and the other terms vanish,
// so a change of state only swaps uniforms and never rebuilds the WebGL context.
// Rates below are in field seconds, which `speed` scales into real time.
const HORIZON_FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  // bad: a failing feed. Its clock holds, then jumps, 6 times a field second
  // (3.6 a second at speed 0.6), and every glitch below changes only on these
  // beats. So no spot changes more than 3.6 times a second: under 2 flashes a
  // second, inside the 3 of WCAG 2.3.1.
  float beat = floor(t * 6.0);
  t = mix(t, beat / 6.0, glitch);
  // bad: tears come in bursts. Each run of 4 beats is torn or clean on a coin
  // toss, so the failures never settle into a rhythm. In a burst, coarse strips
  // of rows tear sideways by up to a fifth of the width; only some strips tear
  // on a beat, so the band never moves as one.
  float burst = step(0.5, hash21(vec2(floor(beat / 4.0), 0.37)));
  float strip = floor(uv.y * 5.0);
  float torn = glitch * burst * step(0.55, hash21(vec2(strip, beat)));
  uv.x += torn * 0.4 * (hash21(vec2(beat, strip + 9.0)) - 0.5);
  vec2 p = uv * vec2(aspect, 1.0);
  // Every state: two waves slide past each other on the horizon.
  float wave = 0.06 * sin(p.x * 3.0 + t * 0.35) + 0.04 * sin(p.x * 7.0 - t * 0.2);
  // bad: the horizon breaks into blocks at different heights, which jump to new
  // heights every third beat. Torn strips carry their blocks sideways. Each
  // height is the difference of two neighbouring random values, so the heights
  // cancel across the band: the horizon breaks, but the band's ink barely
  // changes when it jumps.
  float block = floor(p.x * 2.5);
  float shuffle = floor(beat / 3.0) + 0.5;
  wave += glitch * 0.2 * (hash21(vec2(block, shuffle)) - hash21(vec2(block + 1.0, shuffle)));
  // warn: the band rises, brightens and settles on one slow breath.
  float breathe = breath * sin(t * 2.5);
  // bad: a harder edge, so the broken horizon reads as steps, not a blur.
  float body = smoothstep(0.85 + 0.1 * breathe + 0.15 * sweep - 0.2 * glitch, 0.3 * glitch, uv.y + wave);
  // bad: signal dropouts. About 1 cell in 16 blanks out for a beat. A cell is
  // a quarter of the band's height wide and a sixth tall (1/130 of a wide
  // band), so no large area changes at once.
  vec2 cell = floor(vec2(p.x * 4.0, uv.y * 6.0));
  body *= 1.0 - glitch * step(0.94, hash21(cell + vec2(beat * 0.618, beat * 0.271)));
  float level = 0.9 + 0.12 * breathe;
  // Texture: a fine diagonal grain, swapped for chevrons marching right
  // (act: toward the action) or scanlines on the strips that tear (bad).
  float grain = 0.5 + 0.5 * sin(p.x * 18.0 + p.y * 9.0 + t * 0.15);
  float chevron = smoothstep(0.3, 0.7, 0.5 + 0.5 * sin((p.x + abs(uv.y - 0.4) * 0.8) * 8.0 - t * 3.0));
  float scanline = step(0.5, fract(uv.y * res.y * 0.25));
  grain = mix(grain, chevron, flow);
  grain = mix(grain, scanline, torn);
  // running: a lit front sweeps left to right, leaving a fading trail.
  float behind = fract(t * 0.25) * 2.0 - 0.25 - uv.x;
  float trail = behind > 0.0 ? exp(-behind * 5.0) : exp(behind * 30.0);
  level += sweep * (0.1 + 0.5 * trail);
  // The grain only shades the body; act and bad cut deeper so their texture reads
  // as motion, and act's level rises to make up for the ink its gaps remove.
  // Torn strips cut deeper, into scanlines, which drops their mean grain from
  // 0.8 to 0.7, so their level rises by 8/7: a tear moves ink into lines
  // instead of dimming a whole strip at once.
  float depth = 0.25 + 0.35 * flow + 0.15 * glitch + 0.2 * torn;
  level *= 1.0 + torn / 7.0;
  return clamp(body * (1.0 - depth + depth * grain) * (level + 0.15 * flow), 0.0, 1.0);
}
`;

const CALM = { breath: 0, flow: 0, glitch: 0, sweep: 0 } as const;

/**
 * Each state's motion character, all slow while idle. `stillTime` is the
 * frame reduced motion shows, chosen so the frozen frame still reads as that state.
 * `fps` never exceeds 20; muted barely moves, so 10 is enough.
 */
const BAND_MOTION = {
  // Calm drift: the plain horizon.
  ok: { speed: 0.6, fps: 20, stillTime: 4, uniforms: CALM },
  // A breath every 5s (2.5 rad per field second at speed 0.5).
  warn: { speed: 0.5, fps: 20, stillTime: 0.63, uniforms: { ...CALM, breath: 1 } },
  // Chevrons flowing right at about a fifth of the band's height a second.
  act: { speed: 0.6, fps: 20, stillTime: 4, uniforms: { ...CALM, flow: 1 } },
  // A failing feed: stuttered steps, a broken horizon, steady dropouts and tears
  // in bursts. The still frame is a beat mid-burst, with the lower strips torn.
  bad: { speed: 0.6, fps: 20, stillTime: 3.08, uniforms: { ...CALM, glitch: 1 } },
  // Nearly still.
  muted: { speed: 0.15, fps: 10, stillTime: 4, uniforms: CALM },
} as const;

// A publish or sync in progress, in any tone: a sweep every 2.5s (0.25 cycles
// per field second at speed 1.6). The front runs on to 175% so its trail has
// faded before it wraps. The still frame holds the front at 75%.
const BAND_RUNNING = { speed: 1.6, fps: 20, stillTime: 2, uniforms: { ...CALM, sweep: 1 } } as const;

/**
 * A dithered band behind a machine-state header. Each tone moves in its own
 * way while `idle` (see BAND_MOTION); `running` replaces that with a sweep.
 * Reduced motion shows one still frame per state. One WebGL context.
 * Decoration, so a loading skeleton draws nothing for it (`skullet-ignore`) and shows the header's text.
 */
export function StateBand({ tone = "ok", mode = "idle", className }: { tone?: keyof typeof BAND_MOTION; mode?: "idle" | "running"; className?: string }) {
  const band = mode === "running" ? BAND_RUNNING : BAND_MOTION[tone];
  return (
    <div skullet-ignore="" className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden>
      <DitherShader
        field={HORIZON_FIELD}
        uniforms={band.uniforms}
        palette={["--dither-paper", TONE_DITHER[tone]]}
        speed={band.speed}
        fps={band.fps}
        stillTime={band.stillTime}
        cell={2}
        className="absolute inset-0 opacity-70"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/10" />
    </div>
  );
}

export type DitherBlockMotif = "fade" | "route" | "strata" | "radar";

const TONE_DITHER_STOPS: Record<keyof typeof TONE_DITHER, readonly [string, string, string]> = {
  ok: ["var(--dither-ok-dim)", "var(--dither-color-green)", "var(--dither-ok-bright)"],
  warn: ["var(--dither-warn-dim)", "var(--warn)", "var(--dither-warn-bright)"],
  act: ["var(--dither-act-dim)", "var(--dither-color-orange)", "var(--dither-act-bright)"],
  bad: ["var(--dither-bad-dim)", "var(--dither-color-red)", "var(--dither-bad-bright)"],
  muted: ["var(--dither-muted-dim)", "var(--dither-color-grey)", "var(--dither-muted-bright)"],
  purple: ["var(--dither-purple-dim)", "var(--dither-color-purple)", "var(--dither-purple-bright)"],
};

interface BlockArt {
  readonly width: number;
  readonly height: number;
  readonly paths: readonly [string, string, string];
}

const blockArtCache = new Map<Exclude<DitherBlockMotif, "fade">, BlockArt>();

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const fract = (value: number) => value - Math.floor(value);
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const hash21 = (px: number, py: number) => {
  let x = fract(px * 123.34);
  let y = fract(py * 456.21);
  const d = x * (x + 45.32) + y * (y + 45.32);
  x += d;
  y += d;
  return fract(x * y);
};
const vnoise = (x: number, y: number) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return (top + (bot - top) * uy) * 2 - 1;
};
const fbm2 = (x: number, y: number) => {
  let sum = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  for (let i = 0; i < 4; i += 1) {
    sum += amp * vnoise(px, py);
    const nx = (0.8 * px - 0.6 * py) * 2.02 + 11.3;
    const ny = (0.6 * px + 0.8 * py) * 2.02 + 4.7;
    px = nx;
    py = ny;
    amp *= 0.5;
  }
  return clamp01(0.5 + (0.5 * sum) / 0.9375);
};

function motifTone(motif: Exclude<DitherBlockMotif, "fade">, u: number, v: number, aspect: number) {
  const px = u * aspect;
  if (motif === "route") {
    // Three waypoint nodes connected by a curving dashed trail over faint contours.
    const pts: readonly (readonly [number, number])[] = [
      [0.18 * aspect, 0.3],
      [0.52 * aspect, 0.68],
      [0.84 * aspect, 0.42],
    ];
    const curveY = 0.3 + 0.38 * Math.sin(u * Math.PI * 1.15) - 0.12 * Math.sin(u * Math.PI * 2.1);
    const distCurve = Math.abs(v - curveY);
    const dash = fract(u * 14 - 0.3) > 0.38 ? 1 : 0;
    const trail =
      smoothstep(0.085, 0.01, distCurve) *
      (0.45 + 0.55 * dash) *
      smoothstep(0.06, 0.16, u) *
      smoothstep(0.94, 0.84, u);
    let nodes = 0;
    for (const [nx, ny] of pts) {
      const d = Math.hypot(px - nx, v - ny);
      const halo = Math.exp(-d * 4.5) * 0.88;
      const ring = smoothstep(0.06, 0, Math.abs(d - 0.24)) * 0.52;
      nodes = Math.max(nodes, halo, ring);
    }
    const topo = Math.abs(fract(fbm2(px * 1.4, v * 1.4) * 2.2 + v * 0.8) - 0.5) * 2;
    const contour = smoothstep(0.76, 0.98, topo) * 0.32 * smoothstep(0.95, 0.1, v);
    return clamp01(Math.max(contour, trail * 0.78, nodes));
  }
  if (motif === "strata") {
    // Layered calm isometric ridge planes with crisp bright crests.
    const r1 = 0.62 + 0.12 * Math.sin(u * 5.2 + 0.6) + 0.05 * Math.cos(u * 11);
    const r2 = 0.4 + 0.1 * Math.sin(u * 6.8 + 2.4) + 0.04 * Math.sin(u * 13);
    const r3 = 0.18 + 0.07 * Math.cos(u * 8 + 1.1);
    let tone = 0;
    if (v < r1) tone = Math.max(tone, 0.28 * smoothstep(0, 0.35, r1 - v) + 0.35 * Math.exp(-Math.abs(v - r1) * 18));
    if (v < r2) tone = Math.max(tone, 0.52 * smoothstep(0, 0.25, r2 - v) + 0.45 * Math.exp(-Math.abs(v - r2) * 22));
    if (v < r3) tone = Math.max(tone, 0.78);
    const crest1 = Math.exp(-Math.abs(v - r1) * 26) * 0.55;
    const crest2 = Math.exp(-Math.abs(v - r2) * 30) * 0.88;
    const crest3 = Math.exp(-Math.abs(v - r3) * 32) * 0.96;
    return clamp01(Math.max(tone, crest1, crest2, crest3) * smoothstep(0.98, 0.72, v));
  }
  // radar: half-compass range arcs and cardinal ticks radiating from bottom center.
  const dx = (u - 0.5) * aspect;
  const r = Math.hypot(dx, v);
  const ang = Math.atan2(v, dx);
  const ringDist = Math.abs(fract(r * 2.8) - 0.5) * 2;
  const rings = smoothstep(0.76, 0.99, ringDist) * smoothstep(1.45, 0.12, r) * 0.78;
  const ticks = smoothstep(0.94, 0.995, Math.abs(Math.cos(ang * 6))) * smoothstep(1.25, 0.15, r) * 0.52;
  const beam = Math.exp(-Math.abs(ang - 1.15) * 5) * smoothstep(1.35, 0.05, r) * 0.88;
  const core = Math.exp(-r * 5.2) * 0.98;
  return clamp01(Math.max(rings, ticks, beam, core));
}

/**
 * Memoized 3-stop Bayer 8x8 SVG paths for a static DitherBlock motif.
 * Computed once per motif; zero WebGL contexts, zero repaints, SSR-safe.
 */
function blockMotifArt(motif: Exclude<DitherBlockMotif, "fade">): BlockArt {
  const cached = blockArtCache.get(motif);
  if (cached) return cached;
  const width = motif === "route" ? 140 : 180;
  const height = motif === "route" ? 40 : 48;
  const aspect = width / height;
  const layers = ["", "", ""];
  const { size, thresholds } = BAYER_8;

  for (let row = 0; row < height; row += 1) {
    const v = 1 - (row + 0.5) / height;
    const my = (height - 1 - row) % size;
    let activeStop = 0;
    let runStart = 0;
    const flush = (end: number) => {
      if (activeStop > 0 && end > runStart) {
        layers[activeStop - 1] += `M${runStart} ${row}h${end - runStart}v1h${runStart - end}z`;
      }
    };
    for (let col = 0; col <= width; col += 1) {
      let stop = 0;
      if (col < width) {
        const tone = motifTone(motif, (col + 0.5) / width, v, aspect);
        const threshold = thresholds[my * size + (col % size)] ?? 1;
        const scaled = tone * 3;
        let idx = Math.floor(scaled);
        if (scaled - idx >= threshold && idx < 3) idx += 1;
        stop = idx;
      }
      if (stop !== activeStop) {
        flush(col);
        activeStop = stop;
        runStart = col;
      }
    }
  }

  const art: BlockArt = { width, height, paths: [layers[0], layers[1], layers[2]] };
  blockArtCache.set(motif, art);
  return art;
}

/**
 * Static dither art for empty states and guidance cards, revealed once on mount (600ms).
 * `motif` picks a 3-stop Bayer 8x8 composition (`route`, `strata`, `radar`) or the plain
 * edge `fade`. Decoration, so a loading skeleton skips it.
 */
export function DitherBlock({
  tone = "muted",
  edge = "bottom",
  motif = "fade",
  className,
}: {
  tone?: keyof typeof TONE_DITHER;
  edge?: "top" | "bottom" | "left" | "right";
  motif?: DitherBlockMotif;
  className?: string;
}) {
  if (motif === "fade") {
    return (
      <div skullet-ignore="" aria-hidden data-edge={edge} className={cn("dither-reveal pointer-events-none relative", className)}>
        <div className="absolute inset-0" style={fillStyle("gradient", { color: TONE_DITHER[tone], edge, length: 20, to: 0.04, cell: 2 })} />
      </div>
    );
  }
  const art = blockMotifArt(motif);
  const [dim, mid, bright] = TONE_DITHER_STOPS[tone];
  return (
    <div skullet-ignore="" aria-hidden data-edge={edge} data-motif={motif} className={cn("dither-reveal pointer-events-none relative overflow-hidden", className)}>
      <svg
        className="absolute inset-0 size-full"
        viewBox={`0 0 ${art.width} ${art.height}`}
        preserveAspectRatio={motif === "route" ? "xMidYMid slice" : "xMidYMax slice"}
        shapeRendering="crispEdges"
      >
        <path d={art.paths[0]} style={{ fill: dim }} />
        <path d={art.paths[1]} style={{ fill: mid }} />
        <path d={art.paths[2]} style={{ fill: bright }} />
      </svg>
    </div>
  );
}

/**
 * A number whose changed digits slide in (150ms) after an action: up when it
 * grows, down when it shrinks. Instant under reduced motion. Screen readers
 * get the whole value once.
 */
export function AnimatedNumber({ value, className, format = String }: { value: number; className?: string; format?: (n: number) => string }) {
  const reduced = useReducedMotion();
  const [previous, setPrevious] = useState(value);
  const [direction, setDirection] = useState(1);
  if (value !== previous) {
    setDirection(value > previous ? 1 : -1);
    setPrevious(value);
  }
  const text = format(value);
  if (reduced) return <span className={cn("font-mono tabular-nums", className)}>{text}</span>;
  const chars = [...text];
  return (
    <span className={cn("relative inline-flex font-mono tabular-nums", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex overflow-hidden">
        {chars.map((char, i) => (
          // Keyed from the right, so units stay in place when the number gains a digit.
          <span key={chars.length - i} className="relative inline-block">
            <AnimatePresence initial={false} mode="popLayout" custom={direction}>
              <motion.span
                key={char}
                className="inline-block"
                custom={direction}
                variants={DIGIT}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.15, ease: SNAP }}
              >
                {char}
              </motion.span>
            </AnimatePresence>
          </span>
        ))}
      </span>
    </span>
  );
}

// Transform strings, not the `y` shorthand: motion hands a plain transform to the compositor (WAAPI),
// while `y` is composed on the main thread every frame.
const DIGIT = {
  enter: (direction: number) => ({ transform: `translateY(${direction > 0 ? "100%" : "-100%"})`, opacity: 0 }),
  center: { transform: "translateY(0%)", opacity: 1 },
  exit: (direction: number) => ({ transform: `translateY(${direction > 0 ? "-100%" : "100%"})`, opacity: 0 }),
};

/** The 300px pixel-art chest, downscaled smoothly: `pixelated` only helps when scaling up. */
export function Logo({ className }: { className?: string }) {
  return <img src={`${import.meta.env?.BASE_URL ?? "/"}favicon.png`} alt="" width={20} height={20} decoding="async" className={cn("size-5", className)} />;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs text-muted-foreground", className)}>{children}</span>;
}

/**
 * CLI messages mark commands and paths with backticks ("run `rustup default stable`"). Show those spans as
 * code instead of literal backticks. Odd split indexes are the quoted parts; an unpaired backtick stays text.
 */
export function CliText({ children }: { children: string }) {
  const parts = children.split("`");
  if (parts.length % 2 === 0) return children;
  return parts.map((part, index) => index % 2 === 1
    ? <code key={index} className="inline-block max-w-full rounded-[4px] bg-raised px-1 py-px align-baseline font-mono text-[0.9em] text-foreground [overflow-wrap:anywhere]">{part}</code>
    : part);
}
