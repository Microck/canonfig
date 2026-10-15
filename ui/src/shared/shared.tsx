// Shared display components used by the workspace and onboarding.
import { useState, type CSSProperties, type ReactNode } from "react";
import { Question } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { DitherShader, ditherMask, fillStyle } from "@/lib/dither";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATE_META, type FollowerState } from "./data";

/**
 * Glossary terms from GLOSSARY.md. `plain` is the everyday word the UI shows;
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
    meaning: "A machine that copies your setup from the Source and keeps the settings you mark as its own.",
  },
  "Machine Profile": {
    plain: "profile",
    meaning: "The list of everything your machines should have: files, settings, skills and tools.",
  },
  "Profile Revision": {
    plain: "revision",
    meaning: "A published, numbered version of your profile that never changes. Machines only get what you publish, never unpublished edits.",
  },
  "Profile Resource": {
    plain: "item",
    meaning: "One thing in the profile, like a file, a few settings or a tool to install.",
  },
  "Local Overlay": {
    plain: "local setting",
    meaning: "A setting one machine keeps as its own. Canonfig doesn't overwrite it and never sends its value to the Source.",
  },
  "Follower Drift": {
    plain: "local edit",
    meaning: "Someone changed a file Canonfig manages, on that machine. Canonfig leaves the change alone instead of overwriting it.",
  },
  "Human Action Required": {
    plain: "needs you",
    meaning: "A step only a person can do, like signing in to a tool. Syncing continues once it's done.",
  },
  Convergence: {
    plain: "up to date",
    meaning: "Everything a machine should have matches the profile and passes its check.",
  },
  "Apply Policy": {
    plain: "update rule",
    meaning: "What Canonfig does when the machine's copy is different from yours.",
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
    meaning: "An optional AI agent Canonfig can ask when no recipe covers a job. Its rules limit the folders, programs and sites it can use.",
  },
  "Synchronization Run": {
    plain: "sync",
    meaning: "One recorded attempt to bring a machine up to date.",
  },
} as const satisfies Record<string, { plain: string; meaning: string }>;

export type Term = keyof typeof GLOSSARY;

/** The tooltip's last line, so the docs and CLI vocabulary is always one hover away. */
function CalledThis({ term }: { term: string }) {
  return <span className="mt-1 block text-muted-foreground">Canonfig calls this {term}.</span>;
}

/**
 * A Canonfig concept in everyday words, with a dotted underline. Shows the
 * plain word unless `children` are given; hovering or focusing it explains it
 * and names the Canonfig term. It is a tab stop because the definition is
 * otherwise pointer-only; never put a Term inside a button or link.
 */
export function Term({ children, term }: { children?: ReactNode; term: Term }) {
  const { plain, meaning } = GLOSSARY[term];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="cursor-help rounded-[2px] underline decoration-faint decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {children ?? plain}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-sm">
        <span className="font-medium">{plain.charAt(0).toUpperCase() + plain.slice(1)}.</span> {meaning}
        <CalledThis term={term} />
      </TooltipContent>
    </Tooltip>
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
        <button type="button" aria-label={`More about ${label}`} className={cn("relative inline-flex rounded-sm text-faint after:absolute after:-inset-1.5 hover:text-muted-foreground", className)}>
          <Question className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-sm">{children}</TooltipContent>
    </Tooltip>
  );
}

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", act: "text-act", bad: "text-bad", muted: "text-faint" } as const;
const TONE_BG = { ok: "bg-ok", warn: "bg-warn", act: "bg-act", bad: "bg-bad", muted: "bg-faint" } as const;
const TONE_DITHER = { ok: "green", warn: "#f1c332", act: "orange", bad: "red", muted: "grey" } as const;

/**
 * Status dot + label. The label always carries the meaning; colour only
 * reinforces it. `self` uses the wording for the follower's own screens
 * ("You edited this" instead of "Edited on that machine").
 */
export function StateLabel({ state, compact, self }: { state: FollowerState | "excluded"; compact?: boolean; self?: boolean }) {
  const meta = STATE_META[state];
  const label = (self && meta.selfLabel) || meta.label;
  const hint = (self && meta.selfHint) || meta.hint;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", TONE_TEXT[meta.tone])}>
          <span aria-hidden className={cn("size-1.5 rounded-full", TONE_BG[meta.tone])} />
          {compact ? <span className="sr-only">{label}</span> : <span className="text-sm">{label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-sm">
        <span className="font-medium">{label}.</span> {hint}
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

// Soft contour bands rising from the bottom edge, drifting only while running.
// `energy` (0 idle, 1 running) lifts and brightens the bands without a new shader.
const HORIZON_FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  vec2 p = uv * vec2(res.x / res.y, 1.0);
  float wave = 0.06 * sin(p.x * 3.0 + t * 0.35) + 0.04 * sin(p.x * 7.0 - t * 0.2);
  float body = smoothstep(0.85 + 0.15 * energy, 0.0, uv.y + wave);
  float grain = 0.5 + 0.5 * sin(p.x * 18.0 + p.y * 9.0 + t * 0.15);
  return clamp(body * (0.75 + 0.25 * grain) * (0.9 + 0.3 * energy), 0.0, 1.0);
}
`;

const BAND = {
  idle: { speed: 0.6, uniforms: { energy: 0 } },
  running: { speed: 2.4, uniforms: { energy: 1 } },
} as const;

/**
 * A dithered band behind a machine-state header. `idle` moves gently;
 * `running` (a publish or sync in progress) speeds up and brightens the same shader.
 * Reduced motion shows one still frame. One WebGL context.
 */
export function StateBand({ tone = "ok", mode = "idle", className }: { tone?: keyof typeof TONE_DITHER; mode?: "idle" | "running"; className?: string }) {
  const band = BAND[mode];
  return (
    <div className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden>
      <DitherShader
        field={HORIZON_FIELD}
        uniforms={band.uniforms}
        palette={["--dither-paper", TONE_DITHER[tone]]}
        speed={band.speed}
        fps={20}
        stillTime={4}
        cell={2}
        className="absolute inset-0 opacity-70"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/10" />
    </div>
  );
}

/** Empty-state art: a dotted block that fades in from one edge, revealed once on mount (600ms). */
export function DitherBlock({ tone = "muted", edge = "bottom", className }: { tone?: keyof typeof TONE_DITHER; edge?: "top" | "bottom" | "left" | "right"; className?: string }) {
  return (
    <div aria-hidden data-edge={edge} className={cn("dither-reveal pointer-events-none relative", className)}>
      <div className="absolute inset-0" style={fillStyle("gradient", { color: TONE_DITHER[tone], edge, length: 20, to: 0.04, cell: 2 })} />
    </div>
  );
}

const SNAP = [0.175, 0.885, 0.32, 1.1] as const;

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

const DIGIT = {
  enter: (direction: number) => ({ y: direction > 0 ? "100%" : "-100%", opacity: 0 }),
  center: { y: "0%", opacity: 1 },
  exit: (direction: number) => ({ y: direction > 0 ? "-100%" : "100%", opacity: 0 }),
};

/** The 300px pixel-art chest, downscaled smoothly: `pixelated` only helps when scaling up. */
export function Logo({ className }: { className?: string }) {
  return <img src="/logo.png" alt="" width={20} height={20} decoding="async" className={cn("size-5", className)} />;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11.5px] text-muted-foreground", className)}>{children}</span>;
}

/** The primary action of a screen: gold, used once per view (ADR 0001 theme). */
export const goldButton =
  "bg-gold text-gold-foreground hover:bg-gold-hover font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] disabled:bg-muted disabled:shadow-none";
