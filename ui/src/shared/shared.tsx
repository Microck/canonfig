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

const TONE_DITHER_DIM = {
  ok: "--dither-ok-dim",
  warn: "--dither-warn-dim",
  act: "--dither-act-dim",
  bad: "--dither-bad-dim",
  muted: "--dither-muted-dim",
  purple: "--dither-purple-dim",
} as const;

const TONE_DITHER_BRIGHT = {
  ok: "--dither-ok-bright",
  warn: "--dither-warn-bright",
  act: "--dither-act-bright",
  bad: "--dither-bad-bright",
  muted: "--dither-muted-bright",
  purple: "--dither-purple-bright",
} as const;

const TRACK_DOT_STYLE = fillStyle("dotted", { color: "--dither-track-dot", cell: 1.5 });

// Half the cells of a 4×4 Bayer tile at 1.5px cells: the grain of the shimmer.
const SHIMMER_STYLE = {
  "--shimmer-dots": ditherMask(0.5),
  "--shimmer-tile": "6px",
} as CSSProperties;

/**
 * Dithered progress over a dotted telemetry track. The fill layers a deep
 * midtone wake under the primary dither ramp and finishes with a crisp bright
 * leading edge. While `running` and unfinished, a dotted highlight sweeps
 * toward the edge (CSS mask-position only; held still under reduced motion).
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
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className={cn("relative h-1.5 overflow-hidden rounded-full bg-muted", className)} role="progressbar" aria-label={label} aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
      <div aria-hidden className="absolute inset-0" style={TRACK_DOT_STYLE} />
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${clamped}%` }}>
        <div className="absolute inset-0" style={fillStyle("gradient", { color: TONE_DITHER_DIM[tone], edge: "right", length: 32, from: 0.95, to: 0.45, cell: 1.5 })} />
        <div className="absolute inset-0" style={fillStyle("gradient", { color: TONE_DITHER[tone], edge: "right", length: 22, from: 1, to: 0.12, cell: 1.5 })} />
        {clamped > 0 && (
          <>
            <div aria-hidden className="absolute inset-0" style={fillStyle("gradient", { color: TONE_DITHER_BRIGHT[tone], edge: "right", length: 8, from: 0.9, to: 0, cell: 1.5 })} />
            <div aria-hidden className="absolute inset-y-0 right-0 w-[3px]" style={{ backgroundColor: `var(${TONE_DITHER_BRIGHT[tone]})` }} />
          </>
        )}
        {running && clamped < 100 && <div aria-hidden className="dither-shimmer absolute inset-0" style={SHIMMER_STYLE} />}
      </div>
    </div>
  );
}

// Per-state architectural motifs for StateBand. One unified shader serves every
// state via the `kind` uniform (0 ok, 1 warn, 2 act, 3 bad, 4 muted, 5 running),
// so switching states swaps uniforms, matrix, and palette without rebuilding the
// WebGL context. Each field is right-weighted so the headline on the left stays
// clear. Rates below are in field seconds, which `speed` scales into real time.
const STATE_BAND_FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  vec2 p = uv * vec2(aspect, 1.0);
  float rightWeight = smoothstep(0.18, 0.78, uv.x);

  // 0: ok (orbital iso-contours anchored on the right)
  if (kind < 0.5) {
    vec2 d = p - vec2(0.86 * aspect, 0.22);
    float r = length(d);
    float ang = atan(d.y, d.x);
    float warp = 0.08 * sin(ang * 3.0 + t * 0.35) + 0.04 * cos(r * 5.0 - t * 0.25);
    float rings = abs(fract((r + warp) * 3.1 - t * 0.08) - 0.5) * 2.0;
    float ridge = smoothstep(0.55, 0.98, rings);
    float core = exp(-r * 1.15);
    float strata = 0.32 * smoothstep(0.95, 0.05, uv.y + 0.12 * sin(p.x * 2.2 + t * 0.2));
    float crest = pow(max(ridge, 0.0), 3.0) * smoothstep(1.9, 0.15, r) * 0.72;
    return clamp((core * 0.65 + strata * 0.55 + crest) * (0.25 + 0.85 * rightWeight), 0.0, 1.0);
  }

  // 1: warn (two phase-shifted wave planes colliding along a diagonal fault seam)
  if (kind < 1.5) {
    float seam = (uv.x - 0.68) * 1.4 + (uv.y - 0.5) * 0.55 + 0.08 * sin(uv.y * 5.0 + t * 0.8);
    float side = seam > 0.0 ? 1.0 : -1.0;
    float wA = 0.5 + 0.5 * sin((p.x * 9.5 + p.y * 4.0) + t * 0.7);
    float wB = 0.5 + 0.5 * sin((p.x * 9.5 - p.y * 6.5) - t * 0.55 + 1.4);
    float interference = side > 0.0 ? (wA * 0.65 + wB * 0.35) : (wB * 0.75);
    float faultGlow = exp(-abs(seam) * 5.2) * (0.65 + 0.35 * sin(t * 2.4));
    float base = smoothstep(0.28, 0.82, uv.x) * (0.35 + 0.45 * interference);
    return clamp(base * 0.72 + faultGlow * 0.88 * smoothstep(0.2, 0.55, uv.x), 0.0, 1.0);
  }

  // 2: act (directional stepped beacon chevrons pointing right toward the action)
  if (kind < 2.5) {
    float cy = abs(uv.y - 0.5);
    float chevPhase = fract((p.x * 1.7 + cy * 1.35) - t * 0.55);
    float chev = smoothstep(0.18, 0.48, chevPhase) * smoothstep(0.92, 0.58, chevPhase);
    float tip = pow(max(smoothstep(0.42, 0.54, chevPhase) * smoothstep(0.68, 0.54, chevPhase), 0.0), 1.5);
    float lane = smoothstep(0.56, 0.06, cy);
    float rails = smoothstep(0.05, 0.0, abs(cy - 0.34)) * 0.4;
    return clamp((chev * 0.62 * lane + tip * 0.75 * lane + rails) * (0.2 + 0.9 * rightWeight), 0.0, 1.0);
  }

  // 3: bad (telemetry shear). Beat clock steps 5 times a field second (3 a second
  // at speed 0.6): at most 1.5 flashes/sec, inside WCAG 2.3.1's 3-flash limit.
  if (kind < 3.5) {
    float beat = floor(t * 5.0);
    float strip = floor(uv.y * 7.0);
    float shift = step(0.58, hash21(vec2(strip, beat))) * (hash21(vec2(beat, strip + 3.0)) - 0.5) * 0.32;
    float sx = uv.x + shift;
    float col = floor(sx * 18.0);
    float barH = 0.28 + 0.68 * hash21(vec2(col, floor(beat / 2.0) + 1.3));
    float inBar = smoothstep(barH + 0.06, barH - 0.04, uv.y);
    float gap = mix(1.0, 0.12, step(0.82, hash21(vec2(col + 7.0, beat))));
    float edgeHot = exp(-abs(uv.y - barH) * 14.0) * 0.95;
    float scan = mix(0.65, 1.0, step(0.45, fract(uv.y * res.y * 0.33)));
    return clamp((inBar * 0.58 * gap * scan + edgeHot * gap) * smoothstep(0.24, 0.72, sx), 0.0, 1.0);
  }

  // 4: muted (nearly still low-contrast strata)
  if (kind < 4.5) {
    vec2 d = p - vec2(0.88 * aspect, 0.18);
    float r = length(d);
    float rings = abs(fract(r * 2.4 - t * 0.04) - 0.5) * 2.0;
    float ridge = smoothstep(0.68, 0.98, rings) * smoothstep(1.8, 0.2, r) * 0.45;
    float strata = 0.35 * smoothstep(0.85, 0.0, uv.y + 0.08 * sin(p.x * 2.0 + t * 0.15));
    return clamp((strata + ridge) * (0.2 + 0.75 * rightWeight), 0.0, 1.0);
  }

  // 5: running (propagating revision wavefront with trailing packet streaks)
  float frontX = fract(t * 0.32) * 1.35 - 0.15;
  float dist = frontX - uv.x;
  float wake = dist >= 0.0 ? exp(-dist * 4.2) : exp(dist * 24.0);
  float lane = floor(uv.y * 8.0);
  float packetPhase = fract(uv.x * 2.5 - t * (0.9 + 0.4 * hash21(vec2(lane, 2.1))) + hash21(vec2(lane, 9.7)));
  float packet = smoothstep(0.72, 0.98, packetPhase) * smoothstep(0.45, 0.0, abs(fract(uv.y * 8.0) - 0.5));
  float grid = max(step(0.92, fract(p.x * 4.0)), step(0.92, fract(uv.y * 4.0))) * 0.18;
  float crest = exp(-abs(dist) * 28.0) * 0.95;
  return clamp((grid + wake * 0.58 + packet * 0.52 * (0.4 + wake) + crest) * (0.28 + 0.82 * smoothstep(0.12, 0.52, uv.x)), 0.0, 1.0);
}
`;

const BAND_PALETTE = {
  ok: ["--dither-paper", "--dither-ok-dim", "green", "--dither-ok-bright"],
  warn: ["--dither-paper", "--dither-warn-dim", "--warn", "--dither-warn-bright"],
  act: ["--dither-paper", "--dither-act-dim", "orange", "--dither-act-bright"],
  bad: ["--dither-paper", "--dither-bad-dim", "red", "--dither-bad-bright"],
  muted: ["--dither-paper", "--dither-muted-dim", "grey", "--dither-muted-bright"],
} as const;

/**
 * Each state's motion character, threshold matrix, and reduced-motion still frame.
 * `fps` never exceeds 20; muted barely moves, so 10 is enough.
 */
const BAND_MOTION = {
  // Calm orbital iso-contours.
  ok: { speed: 0.6, fps: 20, stillTime: 4, matrix: "bayer8", uniforms: { kind: 0 } },
  // Moire fault seam pulsing slowly.
  warn: { speed: 0.5, fps: 20, stillTime: 0.63, matrix: "bayer4", uniforms: { kind: 1 } },
  // Directional beacon chevrons marching right.
  act: { speed: 0.6, fps: 20, stillTime: 4, matrix: "bayer4", uniforms: { kind: 2 } },
  // Beat-stepped telemetry shear and vertical dropouts.
  bad: { speed: 0.6, fps: 20, stillTime: 3.08, matrix: "bayer4", uniforms: { kind: 3 } },
  // Nearly still quiet strata.
  muted: { speed: 0.15, fps: 10, stillTime: 4, matrix: "bayer8", uniforms: { kind: 4 } },
} as const;

// A publish or sync in progress, in any tone: a packet wavefront sweeping left to right.
const BAND_RUNNING = { speed: 1.4, fps: 20, stillTime: 2, matrix: "bayer8", uniforms: { kind: 5 } } as const;

/**
 * A dithered band behind a machine-state header. Each tone renders its own
 * ordered-dither motif while `idle` (see BAND_MOTION); `running` switches to a
 * propagating wavefront. Reduced motion shows one still frame per state.
 * One WebGL context. Decoration, so a loading skeleton draws nothing for it
 * (`skullet-ignore`) and shows the header's text.
 */
export function StateBand({ tone = "ok", mode = "idle", className }: { tone?: keyof typeof BAND_MOTION; mode?: "idle" | "running"; className?: string }) {
  const band = mode === "running" ? BAND_RUNNING : BAND_MOTION[tone];
  return (
    <div skullet-ignore="" className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden>
      <DitherShader
        field={STATE_BAND_FIELD}
        uniforms={band.uniforms}
        matrix={band.matrix}
        palette={BAND_PALETTE[tone]}
        speed={band.speed}
        fps={band.fps}
        stillTime={band.stillTime}
        cell={2}
        className="absolute inset-0 opacity-80"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-transparent" />
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
