// Shared first-run flow. Demo choices seed the simulated workspace; live operations
// preserve the backend's plan digest, approval, invitation and enrollment evidence.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, cubicBezier, LayoutGroup, motion, useIsPresent, usePresenceData, useReducedMotion, type Variants } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Circle, FileArrowUp, RadioButton } from "@/components/icons";
import { cn, riseIn, SNAP, SNAP_EASING } from "@/lib/utils";
import { DitherShader, fillStyle } from "@/lib/dither";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEMO, type Harness, type HarnessId } from "@/shared/metadata";
import { DitherProgress, Hint, Mono, Term } from "@/shared/shared";
import { DisclosureTrigger, Facts, Field, FieldError, OnboardingShell, PROGRESS_MARK, RadioRow, STEP_ITEMS, STEP_MS, StepTransition, Stepper, simulate, useFocusOnMount } from "./kit";
import { ErrorNotice } from "@/live/session";
import { SetupEvidence, type EnrollmentController } from "./enrollment-controller";
import { TransitionError, useStateMachine } from "@/lib/state-machine";
import type { SetupImportOffer, SetupImportReview } from "../../../src/setup/setup.types";
import { ImportReview } from "./import-review";

// Rings drifting inward toward the centre: many machines converging on one.
// At speed 1 a ring takes about 20 seconds to move one ring inward.
// The setup job (SetupBackdrop) drives four uniforms, all 0 while nothing runs:
//   progress: the job's share done. The rings travel two rings inward over the whole job,
//     so they close in on the card in step with its progress bar, and stop when it stops.
//     Two whole rings, so the pattern after a job matches the one before.
//   energy: 1 while the job runs. The clear space around the card shrinks so the rings come
//     closer, and they gain green as progress grows.
//   ripple: 1 the moment a step completes, falling to 0. One lit ring runs out from the card,
//     fading as it goes, so each tick of the list shows in the room around it.
//   settled: 1 once the job succeeded. Rings turn fully green and wobble half as much.
const CONVERGE_FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  vec2 p = (uv - vec2(0.5, 0.48)) * vec2(res.x / res.y, 1.0);
  float r = length(p);
  float wobble = (fbm(p * 1.3 + vec2(t * 0.02, -t * 0.015)) - 0.5) * 0.16 * (1.0 - 0.5 * settled);
  float band = abs(fract((r + wobble) * 5.0 + t * 0.05 + progress * 2.0) - 0.5) * 2.0;
  float ring = smoothstep(0.78, 1.0, band);
  float halo = smoothstep(0.34 - 0.1 * energy, 0.95, r);
  float level = 0.7 + 0.2 * energy * progress + 0.3 * settled;
  float front = (0.3 + 0.9 * (1.0 - ripple) - r) / 0.05;
  float wave = 0.6 * ripple * ripple * exp(-front * front);
  return clamp(ring * halo * level + halo * 0.05 + wave, 0.0, 1.0);
}
`;

/** The simulated setup job: the wizard shows it as a progress bar and a list, the backdrop as motion. */
interface Job {
  /** 0 to 100. */
  progress: number;
  /** Items in the wizard's list; one completes every 100 / steps of progress (RunList). */
  steps: number;
  done: boolean;
}

type JobUniforms = { energy: number; progress: number; ripple: number; settled: number };
const JOB_IDLE: JobUniforms = { energy: 0, progress: 0, ripple: 0, settled: 0 };
// Reduced motion: one still frame per phase, held while progress ticks.
const JOB_STILL = {
  running: { energy: 1, progress: 0.6, ripple: 0, settled: 0 },
  done: { energy: 0, progress: 1, ripple: 0, settled: 1 },
} satisfies Record<string, JobUniforms>;
// Energy comes up in 400ms as the job starts; a step's ripple crosses the screen in 600ms,
// inside the ~600ms between steps; after success the rings settle over 900ms.
const ENERGY_MS = 400;
const RIPPLE_MS = 600;
const SETTLE_MS = 900;
const BACKDROP_FPS = 15;
const snap = cubicBezier(...SNAP);

/**
 * The dithered rings behind every screen of setup, choice and wizard alike. They drift calmly
 * until a job runs, then follow it (see CONVERGE_FIELD). The job's uniforms update at the
 * shader's own 15fps, only while something moves: the job, a ripple or the settle.
 * Reduced motion: one still frame per phase (idle, running, done).
 */
function SetupBackdrop({ job }: { job: Job | null }) {
  const reduced = useReducedMotion();
  const [live, setLive] = useState(JOB_IDLE);
  // When the job started, its latest step completed and it finished (performance.now() ms), and how many steps are done.
  const marks = useRef({ start: 0, step: 0, done: 0, completed: 0 });
  useEffect(() => {
    if (!job || reduced) return;
    const m = marks.current;
    const now = performance.now();
    m.start ||= now;
    const completed = Math.floor((job.progress / 100) * job.steps);
    if (completed > m.completed) {
      m.completed = completed;
      m.step = now;
    }
    if (job.done) m.done ||= now;
    let frame = 0;
    let drawn = -Infinity;
    const tick = (t: number) => {
      const settle = m.done ? Math.min(1, (t - m.done) / SETTLE_MS) : 0;
      const ripple = m.step ? Math.max(0, 1 - (t - m.step) / RIPPLE_MS) : 0;
      const moving = !job.done || settle < 1 || ripple > 0;
      // Throttled to the shader's frame rate, but the last frame always lands, so the rings rest exactly settled.
      if (t - drawn >= 1000 / BACKDROP_FPS || !moving) {
        drawn = t;
        setLive({
          energy: m.done ? 1 - snap(settle) : snap(Math.min(1, (t - m.start) / ENERGY_MS)),
          progress: job.progress / 100,
          ripple,
          settled: snap(settle),
        });
      }
      if (moving) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [job, reduced]);

  const uniforms = !job ? JOB_IDLE : reduced ? JOB_STILL[job.done ? "done" : "running"] : live;
  return (
    <>
      <DitherShader
        field={CONVERGE_FIELD}
        uniforms={uniforms}
        palette={["--dither-paper", "--dither-color-grey", "--dither-color-green"]}
        cell={3}
        fps={BACKDROP_FPS}
        // Livelier while the job runs, slower once it settled.
        speed={(1 + 2 * uniforms.energy) * (1 - 0.5 * uniforms.settled)}
        stillTime={6}
        className="absolute inset-0 opacity-60"
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_48%_52%_at_50%_48%,var(--background)_45%,transparent_100%)]" />
    </>
  );
}

type Role = "source" | "follower";
type Stage = "choose" | Role;

type OnboardingStage =
  | { kind: "choosing"; returnedFrom: Role | null }
  | { kind: "inspecting-source"; returnedFrom: Role | null }
  | { kind: Role };
type StageEvent = { kind: "choose"; role: Role; live: boolean } | { kind: "source-ready" } | { kind: "inspection-failed" } | { kind: "back"; from: Role };
function transitionStage(state: OnboardingStage, event: StageEvent): OnboardingStage {
  switch (event.kind) {
    case "choose":
      if (state.kind !== "choosing") break;
      return event.role === "source" && event.live ? { kind: "inspecting-source", returnedFrom: state.returnedFrom } : { kind: event.role };
    case "source-ready":
      if (state.kind === "inspecting-source") return { kind: "source" };
      break;
    case "inspection-failed":
      if (state.kind === "inspecting-source") return { kind: "choosing", returnedFrom: state.returnedFrom };
      break;
    case "back":
      if (state.kind === event.from) return { kind: "choosing", returnedFrom: event.from };
      break;
  }
  throw new TransitionError("Onboarding", state.kind, event.kind);
}

type TrustState = { kind: "unverified" } | { kind: "verified"; identity: string };
type TrustEvent = { kind: "verify"; identity: string } | { kind: "reset" };
function transitionTrust(_state: TrustState, event: TrustEvent): TrustState {
  return event.kind === "verify" ? { kind: "verified", identity: event.identity } : { kind: "unverified" };
}

/** A new Source, as the wizard created it. */
export interface SourceSetup {
  role: "source";
  profileName: string;
  /** The harnesses ~/.canonfig/canonfig.jsonc lists. */
  harnesses: HarnessId[];
  /** Ids (`<source>/<category>/<name>`) of the items imported once from those harnesses into ~/.canonfig/. */
  imported: string[];
  /** "manual" installs no background service: atlas serves only while `canonfig source serve` runs. */
  service: "service" | "manual";
  port: number;
  /** Whether `source scan` proposed tools from the folder. Without it the new Source starts with no tools. */
  scan: boolean;
}

/** A follower that just joined: enrolled, revision downloaded, nothing applied yet. */
export interface FollowerSetup {
  role: "follower";
  name: string;
  tunnel: boolean;
  /** Whether the profile's default schedule was set. False leaves the machine without a schedule. */
  schedule: boolean;
  /** Harnesses the Source lists that this machine excludes (local/local.jsonc `excludeHarnesses`). */
  excluded: HarnessId[];
}

export type Setup = SourceSetup | FollowerSetup;
export interface OnboardingData {
  hostname: string;
  endpoint: string;
  profileName: string;
  harnesses: Pick<Harness, "id" | "name" | "installed" | "listed" | "excluded">[];
  offers: readonly ImportOffer[];
  skipped: SetupImportReview["skipped"];
  collisions: SetupImportReview["collisions"];
  present: SetupImportReview["present"];
  followerInstalled: HarnessId[];
}

const DEFAULT_PORT = 17342;

export type ImportOffer = SetupImportOffer;


export function Onboarding({ onDone, data, live, onCancel }: { onDone: (setup: Setup) => void; data: OnboardingData; live?: EnrollmentController; onCancel?: () => void }) {
  const stageFlow = useStateMachine<OnboardingStage, StageEvent>(live?.session.role === "follower" ? { kind: "follower" } : { kind: "choosing", returnedFrom: null }, transitionStage);
  const stage: Stage = stageFlow.state.kind === "inspecting-source" || stageFlow.state.kind === "choosing" ? "choose" : stageFlow.state.kind;
  const back = (from: Role) => {
    if (onCancel) { onCancel(); return; }
    stageFlow.send({ kind: "back", from });
  };
  // Lives here, not in the wizard, because the backdrop follows it too. One job per visit:
  // the wizard can't be left while it runs (Back is disabled) or once it's done (hidden).
  const [job, setJob] = useState<Job | null>(null);
  const run = (ms: number, steps: number) => {
    setJob({ progress: 0, steps, done: false });
    simulate(
      ms,
      (progress) => setJob({ progress, steps, done: false }),
      () => setJob({ progress: 100, steps, done: true }),
    );
  };

  return (
    <OnboardingShell hostname={data.hostname} backdrop={<SetupBackdrop job={live ? live.applied ? { progress: 100, steps: 1, done: true } : null : job} />}>
      {/* In the demo, md:pb-40 clears the fixed demo panel (220px wide and about 122px tall, 12px
          from the left and from the bottom, App.tsx) at the end of the scroll, where the cards can
          reach under it. From xl the cards start right of it, so normal padding returns and a
          card that fits the window doesn't scroll. Below md the panel is a button in the header
          (kit.tsx), so only normal padding remains, as in production. Every screen is centred vertically, where the
          backdrop's rings meet; a step that changes height grows the card evenly up and down
          (the height tween keeps that smooth). A card taller than the window just scrolls. */}
      <div className={cn("relative isolate flex min-h-full flex-col items-center overflow-hidden px-4 pt-8 pb-12 xl:pb-16 [overflow-wrap:anywhere] justify-center sm:px-6 sm:pt-16", DEMO && "md:pb-40")}>
        {/* popLayout takes the leaving screen out of flow, so the next one lays out at once and
            the picked card's shell (CardShell) can grow straight into the wizard card's place.
            `custom` tells the leaving choice which card was picked. */}
        <AnimatePresence mode="popLayout" custom={stage}>
          {stage === "choose" && <Choose key="choose" busy={stageFlow.state.kind === "inspecting-source"} returnedFrom={"returnedFrom" in stageFlow.state ? stageFlow.state.returnedFrom : null} onPick={(role) => {
            stageFlow.send({ kind: "choose", role, live: !!live });
            if (live && role === "source") void live.planSetup(undefined, undefined, () => stageFlow.send({ kind: "source-ready" })).then(() => {
              if (stageFlow.current.current.kind === "inspecting-source") stageFlow.send({ kind: "inspection-failed" });
            });
          }} />}
          {stage === "source" && <SourceWizard key="source" data={data} live={live} job={job} onRun={run} onBack={() => back("source")} onDone={onDone} />}
          {stage === "follower" && <FollowerWizard key="follower" data={data} live={live} job={job} onRun={run} onBack={() => back("follower")} onDone={onDone} />}
        </AnimatePresence>
        {stage === "choose" && live?.state.loading && <p role="status">Inspecting this machine…</p>}
        {stage === "choose" && live?.state.error && <ErrorNotice error={live.state.error} title="This machine could not be checked" recovery="Follow the instructions above, then choose a role again to retry. If you need to restart the browser session, run canonfig ui in a terminal and open its new sign-in link." />}
      </div>
    </OnboardingShell>
  );
}

// The shared card's grow and shrink between choice and wizard. A spring with a little bounce
// (0.15), so the card lands with weight; about 500ms, the longest motion in setup, which is
// seen once.
const CARD_MORPH = { type: "spring", bounce: 0.15, duration: 0.5 } as const;

/**
 * A card's border and fill, as one shared element per role (layoutId): the picked choice
 * card's shell grows into the wizard card, and shrinks back on "Change my answer". It has no
 * children, so the morph's scale never stretches text; each side's content fades on its own
 * above it. `layoutDependency` differs between the two sides, so the shell only re-measures
 * across the hand-off, not on every keystroke in the wizard. The old shell hides at once
 * (no crossfade): both look the same, and a crossfade would thin the card mid-flight.
 * Reduced motion shares nothing: a zero-length layout transition still paints the old box
 * for a frame, so each screen simply fades with its own shell.
 */
function CardShell({ role, side, shared = true, className }: { role: Role; side: "choose" | "wizard"; shared?: boolean; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      layoutId={shared && !reduced ? `card-${role}` : undefined}
      layoutDependency={side}
      layoutCrossfade={false}
      transition={CARD_MORPH}
      // Inline radius, so motion corrects it while the shell scales.
      style={{ borderRadius: 12 }}
      className={cn("absolute inset-0 -z-10 border border-border bg-panel", className)}
    />
  );
}

// Reduced motion, for the choice and the wizard alike: the screen fades in and out.
const SCREEN_FADE = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.2, ease: SNAP } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: SNAP } },
} satisfies Variants;

// The choice screen's motion, by visit. Normal motion only; reduced motion fades the screen.
// First visit: the group arrives from 0.96 and a 4px blur in 450ms, and inside it the heading,
// both cards and the footnote rise in 60ms apart, the cards with a slight lift from 0.98.
// Coming back: the group is already there; everything but the returning card rises in 40ms
// apart once the shell has mostly landed, and that card's text fades in over its shell.
// Leaving: the heading and footnote lift away, the other card drops and fades in 200ms, and
// the picked card's text clears in 120ms while its shell carries on into the wizard.
const CHOOSE_SCREEN = {
  intro: {
    hidden: { opacity: 0, transform: "scale(0.96)", filter: "blur(4px)" },
    shown: {
      opacity: 1,
      transform: "scale(1)",
      filter: "blur(0px)",
      transition: { duration: 0.45, ease: SNAP, delayChildren: 0.08, staggerChildren: 0.06 },
      // No filter or transform left behind: they'd keep the whole group on its own layer.
      transitionEnd: { filter: "none", transform: "none" },
    },
    exit: {},
  },
  return: {
    hidden: {},
    shown: { transition: { delayChildren: 0.12, staggerChildren: 0.04 } },
    exit: {},
  },
  reduced: SCREEN_FADE,
} satisfies Record<string, Variants>;

const CHOOSE_ITEM: Variants = {
  hidden: { opacity: 0, transform: "translateY(10px)" },
  shown: { opacity: 1, transform: "translateY(0px)", transition: { duration: 0.4, ease: SNAP } },
  exit: { opacity: 0, transform: "translateY(-6px)", transition: { duration: 0.15, ease: SNAP } },
};

/** The choice card's own motion (normal motion only); `returning` is the card that takes the wizard card back. */
function choiceVariants(role: Role, returning: boolean): { card: Variants; content: Variants } {
  return {
    card: {
      // The returning card stays put: its shell is mid-morph, measured against this box. Its
      // start is spelled out: from an unset transform, motion fills the string with zeros (scale 0).
      hidden: returning ? { transform: "translateY(0px) scale(1)" } : { opacity: 0, transform: "translateY(16px) scale(0.98)" },
      shown: { opacity: 1, transform: "translateY(0px) scale(1)", transition: { duration: 0.45, ease: SNAP } },
      exit: (to: Stage) => (to === role ? {} : { opacity: 0, transform: "translateY(12px) scale(0.97)", transition: { duration: 0.2, ease: SNAP } }),
    },
    content: {
      hidden: returning ? { opacity: 0 } : {},
      shown: { opacity: 1, transition: { duration: 0.25, ease: SNAP, delay: returning ? 0.2 : 0 } },
      exit: (to: Stage) => (to === role ? { opacity: 0, transition: { duration: 0.12, ease: SNAP } } : {}),
    },
  };
}

// popLayout finds a leaving screen through its outermost motion element, so screens need no ref.
function Choose({ returnedFrom, onPick, busy }: { returnedFrom: Role | null; onPick: (role: Role) => void; busy: boolean }) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const screen = CHOOSE_SCREEN[reduced ? "reduced" : returnedFrom ? "return" : "intro"];
  const item = reduced ? undefined : CHOOSE_ITEM;
  return (
    // Leaving, it sits above the wizard so the picked card's text clears over the growing shell; inert, so it can't be picked twice.
    <motion.div inert={!present || busy} variants={screen} initial="hidden" animate="shown" exit="exit" className={cn("w-full max-w-[680px] pb-10 text-center", !present && "z-10")}>
      <motion.div variants={item}>
        <h1 ref={heading} tabIndex={-1} className="text-[28px] leading-tight font-semibold tracking-[-0.025em] outline-none">
          What should this machine do?
        </h1>
        <p className="mx-auto mt-3 max-w-[480px] leading-relaxed text-balance text-muted-foreground">
          Canonfig shares your AI coding tools' setup across machines. Choose a Source to edit it on, or a follower to copy it to.
        </p>
      </motion.div>
      <div className="mt-9 grid grid-cols-1 gap-3 text-left sm:grid-cols-2">
        <Choice
          role="source"
          returning={returnedFrom === "source"}
          title="Make this the Source"
          description="The Source is the machine where you edit the setup that other machines copy. Only the Source publishes changes."
          onPick={onPick}
        />
        <Choice
          role="follower"
          returning={returnedFrom === "follower"}
          title="Copy the setup from another machine"
          description="This machine becomes a follower and copies the setup your Source publishes."
          onPick={onPick}
        />
      </div>
      <motion.p variants={item} className="mt-6 text-sm text-muted-foreground">
        Setting up Canonfig for the first time? Start with the machine whose setup you want to share.
      </motion.p>
    </motion.div>
  );
}

/**
 * One role card: just its title. What the role means shows in a tooltip while the card is
 * hovered or keyboard-focused (on touch screens, which can't hover, as a line under the title), and stays linked to the button as its description for screen
 * readers. Hover brightens its border and fill and nudges its arrow, and a press sinks it to
 * 0.98 (choice-card in index.css). Only the picked card keeps its shared shell while the choice
 * leaves; the other drops its layoutId, so it never hands off a stale position later.
 */
function Choice({ role, returning, title, description, onPick }: { role: Role; returning: boolean; title: string; description: string; onPick: (role: Role) => void }) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  const leavingTo = usePresenceData() as Stage | undefined;
  const variants = reduced ? undefined : choiceVariants(role, returning);
  const descriptionId = useId();
  return (
    <motion.div variants={variants?.card} className="grid">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onPick(role)}
            aria-describedby={descriptionId}
            className="choice-card group relative isolate flex min-h-[112px] min-w-0 items-center rounded-xl p-5 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <CardShell role={role} side="choose" shared={present || leavingTo === role} className="choice-shell" />
            <motion.span variants={variants?.content} className="flex w-full items-center justify-between gap-3">
              <span className="flex flex-col gap-1.5">
                <span className="text-xl leading-snug font-medium tracking-[-0.01em] text-pretty">{title}</span>
                {/* Touch screens can't hover, so they see the description on the card; aria-hidden
                    because the button already reads it through aria-describedby. */}
                <span aria-hidden className="hidden text-sm leading-relaxed text-muted-foreground pointer-coarse:block">
                  {description}
                </span>
              </span>
              <ArrowRight aria-hidden className="choice-arrow size-4 shrink-0 text-faint" />
            </motion.span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72 text-sm leading-relaxed">
          {description}
        </TooltipContent>
      </Tooltip>
      <span id={descriptionId} hidden>
        {description}
      </span>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Wizard frame                                                        */
/* ------------------------------------------------------------------ */

/**
 * Smooths the height change when `key` changes (a wizard step, the finished screen):
 * the element runs from the height it last painted at to its new height, clipped while
 * it moves, then hands height back to layout. Other size changes stay instant: a
 * disclosure animates its own height, and an error line is small. Interruptible: a new
 * key mid-run starts from the height on screen. Instant under reduced motion.
 */
function useHeightTween<T extends HTMLElement>(key: unknown, duration: number) {
  const ref = useRef<T>(null);
  const reduced = useReducedMotion();
  // Border-box height at the last layout. The observer reports after layout, so in the
  // layout effect below it still holds the height before this commit (mid-run, the
  // tweened height), which is where the next run must start.
  const painted = useRef(0);
  const tween = useRef<Animation | null>(null);
  const shownKey = useRef(key);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      painted.current = entry.borderBoxSize[0].blockSize;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    const element = ref.current;
    if (!element || reduced) return;
    // Cancel first: while a run is active, the element measures at the tweened height.
    tween.current?.cancel();
    const from = painted.current;
    const to = element.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;
    tween.current = element.animate(
      [
        { height: `${from}px`, overflow: "clip" },
        { height: `${to}px`, overflow: "clip" },
      ],
      { duration, easing: SNAP_EASING },
    );
  }, [key, reduced, duration]);
  return ref;
}

// The wizard screen. Normal motion: nothing on the screen itself as it arrives (its card
// shell grows out of the picked choice, and its parts rise in, see Wizard); it fades out in
// 120ms when it leaves, while the choice card's shell takes the card back. Reduced motion
// fades it in and out.
const WIZARD_SCREEN = {
  normal: { hidden: {}, shown: {}, exit: SCREEN_FADE.exit },
  reduced: SCREEN_FADE,
} satisfies Record<string, Variants>;

/**
 * One form for every step, so Enter continues from any field. A step that is
 * not complete keeps Continue enabled: submitting it calls `onBlocked`, and the
 * step then shows its errors next to the fields that need attention.
 */
function Wizard({
  role,
  title,
  steps,
  step,
  onStep,
  onBack,
  finalLabel,
  busyLabel,
  onFinish,
  blocked = false,
  onBlocked,
  busy = false,
  done,
  wide = false,
  children,
}: {
  role: Role;
  title: string;
  steps: string[];
  step: number;
  onStep: (s: number) => void;
  onBack: () => void;
  finalLabel: string;
  busyLabel: string;
  onFinish: () => void;
  blocked?: boolean;
  onBlocked?: () => void;
  busy?: boolean;
  done?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  const present = useIsPresent();
  // One LayoutGroup per wizard, so its progress mark never glides in from another wizard's stepper.
  const group = useId();
  // Which way the last step change went: the steps slide with it.
  const [direction, setDirection] = useState<1 | -1>(1);
  // The step content and the whole card (when it turns into the finished screen) run to their
  // new height on the same curve as the content: STEP_MS with a step's slide, 450ms as the
  // card settles into the finished screen.
  const card = useHeightTween<HTMLFormElement>(!!done, 450);
  const body = useHeightTween<HTMLDivElement>(step, STEP_MS);
  const last = step === steps.length - 1;

  // Arrival from the choice: while the shell is still growing (CARD_MORPH), the wizard's parts
  // rise in top to bottom, 35ms apart from 200ms in, so they land as the card does: the
  // back link, the header with the stepper, the first step's items, the footer. The header
  // and footer carry their dividers, so no rule shows before its card.
  useLayoutEffect(() => {
    if (reduced) return;
    riseIn(card.current!.parentElement!.querySelectorAll(`[data-rise], ${STEP_ITEMS}`), { delay: 200, gap: 35, duration: 320, cap: 6 });
    // Arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Commit the new step synchronously, then focus its heading: the control just used may be
  // gone (Back on the second step, or Enter in a field), and focus would fall to <body>.
  const go = (next: number) => {
    flushSync(() => {
      setDirection(next > step ? 1 : -1);
      onStep(next);
    });
    stepHeading.current?.focus();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || done) return;
    if (blocked) {
      const form = event.currentTarget;
      // Errors already on screen shake once, so a repeated Continue visibly registers.
      // Errors this press reveals drop in on their own (field-error-in); nothing to shake yet.
      if (!reduced) for (const error of form.querySelectorAll("[data-field-error]")) error.animate(SHAKE, { duration: 300, easing: SNAP_EASING });
      // Render the errors now, then move focus to the first field that needs fixing, so keyboard and screen
      // reader users land on it and hear its error (aria-describedby) instead of staying on Continue.
      flushSync(() => onBlocked?.());
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    } else if (last) onFinish();
    else go(step + 1);
  };

  return (
    // Leaving, it sits above the choice so its content clears over the shrinking shell; inert meanwhile.
    <motion.div
      inert={!present}
      variants={WIZARD_SCREEN[reduced ? "reduced" : "normal"]}
      initial="hidden"
      animate="shown"
      exit="exit"
      className={cn("w-full", wide ? "max-w-4xl" : "max-w-[600px]", !present && "z-10")}
    >
      {/* Kept in layout (invisible, so not focusable) once done, so the card doesn't jump. */}
      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        disabled={busy}
        data-rise
        className={cn("mb-4 min-h-11 text-muted-foreground transition-[opacity,visibility] duration-150 ease-snap sm:min-h-10", done && "invisible opacity-0")}
      >
        <ArrowLeft className="size-3.5" /> Back to machine choice
      </Button>
      <form ref={card} noValidate onSubmit={submit} className="relative isolate rounded-xl">
        <CardShell role={role} side="wizard" />
        {done && (
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]">
            <div className="finish-sweep absolute inset-0 opacity-40" style={SWEEP_STYLE} />
          </div>
        )}
        <LayoutGroup id={group}>
          {!done && (
            <div data-rise className="border-b border-border px-4 pt-5 pb-4 sm:px-6">
              <h1 ref={heading} tabIndex={-1} className="text-[15px] font-medium outline-none">
                {title}
              </h1>
              <Stepper steps={steps} step={step} />
            </div>
          )}
          <div ref={body} className="px-4 py-6 sm:px-6">
            {done ?? (
              <>
                {/* Keyed, so each step's heading is a new element that screen readers announce on focus. */}
                <h2 key={step} ref={stepHeading} tabIndex={-1} className="sr-only">
                  {steps[step]}
                </h2>
                <StepTransition step={step} direction={direction}>
                  <fieldset disabled={busy} className="min-w-0">{children}</fieldset>
                </StepTransition>
              </>
            )}
          </div>
        </LayoutGroup>
        {!done && (
          <div data-rise className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-6">
            {step > 0 && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => go(step - 1)}>
                Back
              </Button>
            )}
            {last ? (
              <Button type="submit" variant="primary" disabled={busy}>
                {/* Both labels share one grid cell so the button keeps its width when it switches. */}
                <span className="grid">
                  <span className={cn("col-start-1 row-start-1", busy && "invisible")}>{finalLabel}</span>
                  <span className={cn("col-start-1 row-start-1", !busy && "invisible")}>{busyLabel}</span>
                </span>
              </Button>
            ) : (
              <Button type="submit" variant="secondary" className="min-w-24" disabled={busy}>
                Continue
              </Button>
            )}
          </div>
        )}
      </form>
    </motion.div>
  );
}

const SHAKE: Keyframe[] = [
  { transform: "translateX(0px)" },
  { transform: "translateX(-3px)" },
  { transform: "translateX(3px)" },
  { transform: "translateX(-2px)" },
  { transform: "translateX(0px)" },
];

// The finish sweep: DitherProgress's green ramp at the background's 3px cell, half density
// at its leading (right) edge so it reads as dots rather than a solid bar, thinning to
// nothing 240px behind it, so no floor of dots tints the rest of the card while it crosses.
const SWEEP_STYLE = fillStyle("gradient", { color: "green", edge: "right", length: 80, from: 0.5, to: 0, cell: 3 });

/**
 * The live checklist while a fake job runs. Icons are static: no spinner.
 * Screen readers hear a count, not a second copy of the current line.
 */
function RunList({ items, progress }: { items: string[]; progress: number }) {
  const at = (progress / 100) * items.length;
  const finished = Math.min(items.length, Math.floor(at));
  return (
    <>
      <ul className="mt-4 space-y-2">
        {items.map((label, i) => {
          const state = at >= i + 1 ? "done" : at > i ? "running" : "waiting";
          return (
            <li key={label} className="flex items-center gap-2.5">
              <span className="grid size-4 place-items-center">
                {state === "done" ? (
                  <Check className="size-3.5 text-ok" />
                ) : state === "running" ? (
                  <RadioButton bold className="size-3.5 text-foreground" />
                ) : (
                  <Circle className="size-3 text-faint" />
                )}
              </span>
              <span className={cn("transition-colors duration-150 ease-snap", state === "waiting" && "text-muted-foreground")}>{label}</span>
            </li>
          );
        })}
      </ul>
      <p role="status" className="sr-only">
        {finished === items.length ? "All done" : `${finished} of ${items.length} done`}
      </p>
    </>
  );
}

/**
 * The end of setup. Once, on arrival: the stepper's ring leaves the header and grows into
 * the success badge (the shared PROGRESS_MARK, on CARD_MORPH) while the card settles to its
 * new height; the check draws as the badge lands, the text rises in behind it 50ms apart,
 * and the Wizard's green sweep crosses the card. About 800ms in all, and none of it repeats.
 */
function Finished({ title, children, next, action, onOpen, busy = false }: { title: string; children: ReactNode; next: ReactNode; action: string; onOpen: () => void; busy?: boolean }) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const reduced = useReducedMotion();
  return (
    <div>
      <motion.span layoutId={reduced ? undefined : PROGRESS_MARK} aria-hidden transition={CARD_MORPH} className="grid size-8 place-items-center rounded-full bg-ok/15 text-ok">
        <Check className="check-draw size-4" style={{ animationDelay: "300ms" }} />
      </motion.span>
      <h2 ref={heading} tabIndex={-1} className="rise-in mt-4 text-[17px] font-medium tracking-[-0.01em] outline-none" style={{ animationDelay: "150ms" }}>
        {title}
      </h2>
      <div className="rise-in mt-2 leading-relaxed text-muted-foreground" style={{ animationDelay: "200ms" }}>
        {children}
      </div>
      <div className="rise-in mt-6 flex flex-col items-start justify-between gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:gap-6" style={{ animationDelay: "250ms" }}>
        <p className="text-muted-foreground">{next}</p>
        <Button type="button" variant="default" disabled={busy} onClick={onOpen}>
          {action}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Source init                                                         */
/* ------------------------------------------------------------------ */

/** A role's wizard. `job` is the setup job once it starts (Onboarding owns it); `onRun` starts it with the list's length. */
interface WizardProps<S extends Setup> {
  data: OnboardingData;
  live?: EnrollmentController;
  job: Job | null;
  onRun: (ms: number, steps: number) => void;
  onBack: () => void;
  onDone: (setup: S) => void;
}

// The Source wizard's steps, by index.
const SOURCE_STEPS = ["Profile", "AI tools", "Import", "Connection", "Create"];
const SOURCE_STEP = { profile: 0, harnesses: 1, import: 2, service: 3, create: 4 } as const;


/** A bordered row holding a checkbox and its label text. */
const CHECK_ROW = "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50 sm:min-h-10";

function SourceWizard({ job, onRun, onBack, onDone, data, live }: WizardProps<SourceSetup>) {
  const { harnesses } = data;
  const INSTALLED = harnesses.filter((h) => h.installed);
  const NOT_INSTALLED = harnesses.filter((h) => !h.installed);
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [name, setName] = useState(data.profileName);
  // Setup lists the installed harnesses until the person edits the list, as `setup plan` does without --harness.
  // Any harness can be listed, installed or not, as `--harness` allows.
  const [listed, setListed] = useState<HarnessId[]>(() => (live ? harnesses.filter((h) => h.listed) : INSTALLED).map((h) => h.id));
  // A target keeps its chosen offer id while its harness is unlisted, so re-listing the harness restores the choice.
  const [choices, setChoices] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [scan, setScan] = useState(true);
  const [service, setService] = useState<"service" | "manual">("service");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [advanced, setAdvanced] = useState(false);
  const progress = live ? null : job?.progress ?? null;
  const done = live ? live.applied : !!job?.done;

  const selected = harnesses.filter((h) => listed.includes(h.id)).map((h) => h.id);
  const offered = useMemo(() => data.offers.filter((offer) =>
    offer.harnesses.some((harness) => listed.includes(harness)) && !data.present.includes(offer.id)
    && !data.collisions.some((collision) => collision.kind === "folder" && collision.candidates.some((candidate) => candidate.id === offer.id)))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  [data.offers, data.present, data.collisions, listed]);
  const collisionTargets = useMemo(() => new Set(data.collisions.filter((collision) => collision.kind === "candidates").map((collision) => collision.target)), [data.collisions]);
  const imported = useMemo(() => {
    const offeredIds = new Set(offered.map((offer) => offer.id));
    const primary = new Map<string, ImportOffer>();
    const chosen = new Map<string, string>();
    // Plain identical items keep their canonical first id; collisions keep the person's chosen source.
    for (const offer of offered) if (!primary.has(offer.target)) primary.set(offer.target, offer);
    for (const offer of offered) {
      const choice = choices.get(offer.target);
      if ((collisionTargets.has(offer.target) ? choice === offer.id : choice !== undefined && offeredIds.has(choice)) && !chosen.has(offer.target)) {
        chosen.set(offer.target, collisionTargets.has(offer.target) ? offer.id : primary.get(offer.target)!.id);
      }
    }
    return [...chosen.values()];
  }, [offered, choices, collisionTargets]);

  // Validated as typed, never rewritten: stripping characters would turn "1.5" into a different port.
  const portNumber = Number(port);
  const portValid = /^\d+$/.test(port) && portNumber >= 1 && portNumber <= 65535;
  const creates = [
    `The shared setup folder, ~/.canonfig/, with canonfig.jsonc, AGENTS.md and skills/. Selected AI coding tools: ${selected.length}`,
    ...(imported.length > 0 ? [`Selected imports: ${imported.length}`] : []),
    "Canonfig's setup records at ~/.canonfig/state.sqlite",
    "Keys that identify the Source, kept in this machine's credential storage",
    ...(service === "service" ? [`A background service at https://127.0.0.1:${portNumber} for other machines to connect to`] : []),
    ...(scan ? ["Suggestions of tools the setup needs, for you to review"] : []),
  ];

  const nameError = tried && !name.trim() ? "Enter a profile name." : null;
  const portError = tried && !portValid ? "Enter a whole number from 1 to 65535." : null;

  return (
    <Wizard
      role="source"
      title={`Make ${data.hostname} the Source`}
      steps={live ? ["Profile", "AI tools", "Import", "Approve", "Create"] : SOURCE_STEPS}
      step={step}
      wide={step === SOURCE_STEP.import}
      onStep={(s) => {
        setTried(false);
        if (live && s === SOURCE_STEP.import && step === SOURCE_STEP.harnesses) void live.planSetup(selected, undefined, () => setStep(s));
        else if (live && s === SOURCE_STEP.service && step === SOURCE_STEP.import) void live.planSetup(selected, imported, () => setStep(s));
        else if (live && s === SOURCE_STEP.create && !live.approved) setTried(true);
        else setStep(s);
      }}
      onBack={onBack}
      finalLabel={live?.sourceState.kind === "needs-human-action" ? "Resume approved setup" : `Make ${data.hostname} the Source`}
      busyLabel="Creating…"
      blocked={live ? !live.approved && (step === SOURCE_STEP.service || step === SOURCE_STEP.create) : (step === SOURCE_STEP.profile && !name.trim()) || (step === SOURCE_STEP.service && !portValid)}
      onBlocked={() => {
        setTried(true);
        // The port lives under Advanced; its error must be visible.
        if (step === SOURCE_STEP.service) setAdvanced(true);
      }}
      busy={live ? live.state.loading : progress !== null && !done}
      onFinish={() => live ? void live.applySetup() : onRun(2600, creates.length)}
      done={
        done ? (
          <Finished
            title={`${data.hostname} is now the Source`}
            action={!live && scan ? "Review proposed tools" : "Open Canonfig"}
            onOpen={() => onDone({ role: "source", profileName: name.trim(), harnesses: selected, imported, service, port: portNumber, scan })}
            next={
              !live && scan ? (
                <>
                  Next: review suggested tools, then publish a <Term term="Profile Revision" />, a version of the setup other machines can copy.
                </>
              ) : (
                <>
                  Next: finish editing the setup, then publish a <Term term="Profile Revision" />, a version other machines can copy.
                </>
              )
            }
          >
            Your shared setup, called a <Term term="Machine Profile" />, lives in <Mono className="text-foreground">~/.canonfig/</Mono>
            {DEMO ? " in this demo workspace. This demo doesn't read or create that folder. Edit the example profile in Canonfig." : " on this machine. Open Profile to edit it, then Settings, Source service to let other machines connect."}
          </Finished>
        ) : undefined
      }
    >
      {live?.state.error && <ErrorNotice error={live.state.error} title="Setup could not continue" recovery="Follow the instructions above, then reload setup status before continuing. To review a new plan, go Back to machine choice and choose Source again." />}
      {(live?.sourceState.kind === "observation-lost" || live?.sourceState.kind === "failed") && <div className="space-y-2"><p>Setup could not finish or refresh its status. Reload setup status to check what has already completed before continuing.</p><Button type="button" variant="outline" onClick={live.reloadStatus}>Reload setup status</Button></div>}
      {live?.sourceState.kind === "needs-human-action" && <p role="status">Setup needs your help. Follow the instructions in the setup details below, then resume the approved setup.</p>}
      {step === SOURCE_STEP.profile && (
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            A <Term term="Machine Profile" /> is the setup you share with other machines. You edit it in the <Term term="Canonical Folder" />, <Mono className="text-foreground">~/.canonfig/</Mono> on {data.hostname}.
            It holds instructions, skills and settings for your AI coding tools. Other machines receive only the versions you publish.
          </p>
          {live ? <Facts items={[["Profile name", data.profileName], ["Naming", "The profile uses this machine's name. You can rename it later in Profile, Defaults."]]} /> : <Field label="Profile name" htmlFor="ob-name" hint="Choose a name for the shared setup. Canonfig saves it in ~/.canonfig/canonfig.jsonc." error={nameError} className="sm:max-w-80">
            <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} aria-describedby={nameError ? "ob-name-error" : undefined} />
          </Field>}
        </div>
      )}
      {step === SOURCE_STEP.harnesses && (
        <div className="space-y-5">
          <div className="space-y-1">
            <p className="font-medium">Which tools sync with <Mono className="text-foreground">~/.canonfig/</Mono>?</p>
            <p className="text-muted-foreground">Syncing replaces their instructions, skills and MCP servers. Unchecked tools are left alone.</p>
          </div>
          <ul aria-label="Installed AI coding tools" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {INSTALLED.map((h) => (
              <li key={h.id}>
                <label className={CHECK_ROW}>
                  <Checkbox
                    checked={listed.includes(h.id)}
                    onCheckedChange={(c) => setListed((ids) => (c === true ? [...ids, h.id] : ids.filter((id) => id !== h.id)))}
                    className="mt-px"
                  />
                  <span className="min-w-0 font-medium">{h.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <Collapsible>
            <DisclosureTrigger>Not installed here ({NOT_INSTALLED.length})</DisclosureTrigger>
            <CollapsibleContent className="mt-3">
              <ul aria-label="AI coding tools not installed" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {NOT_INSTALLED.map((h) => (
                  <li key={h.id}>
                    <label className={CHECK_ROW}>
                      <Checkbox
                        checked={listed.includes(h.id)}
                        onCheckedChange={(c) => setListed((ids) => (c === true ? [...ids, h.id] : ids.filter((id) => id !== h.id)))}
                        className="mt-px"
                      />
                      <span className="min-w-0 font-medium">{h.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
      {step === SOURCE_STEP.import && (
        <div className="space-y-5">
          <ImportReview data={data} listed={listed} choices={choices} onChoices={setChoices} />
          {!live && <label className={CHECK_ROW}>
            <Checkbox checked={scan} onCheckedChange={(c) => setScan(c === true)} className="mt-px" />
            <span>Suggest tools this setup needs so I can review them later</span>
          </label>}
        </div>
      )}
      {step === SOURCE_STEP.service && (live ? <><SetupEvidence controller={live} approval />{tried && !live.approved && <FieldError>Enter your name and approve this plan before continuing.</FieldError>}</> :
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            Other machines need a connection to {data.hostname} to copy its setup. Choose when the Source service runs. They connect through SSH, a secure connection you configure when each machine joins.
          </p>
          <RadioGroup value={service} onValueChange={(v) => setService(v as "service" | "manual")} className="gap-2">
            <RadioRow value="service" title="Run it in the background" description="Starts when you log in and runs without a terminal open, so other machines can sync whenever you're logged in." />
            <RadioRow
              value="manual"
              title="Start it manually"
              description={
                <>
                  Other machines can sync only while <Mono>canonfig source serve</Mono> runs in a terminal.
                </>
              }
            />
          </RadioGroup>
          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <DisclosureTrigger>Advanced</DisclosureTrigger>
            <CollapsibleContent className="mt-3 grid grid-cols-1 items-end gap-4 sm:grid-cols-[auto_1fr] sm:gap-6">
              <Field label="Source service port" htmlFor="ob-port" hint="Use a whole number from 1 to 65535. Keep the default unless another service uses it." error={portError}>
                <Input
                  id="ob-port"
                  inputMode="numeric"
                  autoComplete="off"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  aria-invalid={!!portError}
                  aria-describedby={portError ? "ob-port-error" : undefined}
                  className="w-28 font-mono text-[12px] tabular-nums"
                />
              </Field>
              {service === "service" && (
                <p className="pb-1.5 text-sm text-muted-foreground">
                  To keep the service running after you log out, run <Mono>loginctl enable-linger $USER</Mono>. Canonfig doesn't change this for you.
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
      {step === SOURCE_STEP.create && (
        <div>
          {live ? <SetupEvidence controller={live} /> : progress === null ? (
            <>
              <p className="mb-3 leading-relaxed text-muted-foreground">Review what Canonfig will create on {data.hostname}, then make it the Source.</p>
              <ul className="space-y-2">
                {creates.map((c) => (
                  <li key={c} className="flex items-center gap-2.5">
                    <Circle className="size-3 text-faint" />
                    {c}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <DitherProgress value={progress} running={!done} label="Creating the Source" />
              <RunList items={creates} progress={progress} />
            </>
          )}
          {/* Stays put while creating, so nothing on the card swaps places. */}
          <p className="mt-5 text-sm text-muted-foreground">
            Creating the Source does not change your AI coding tools' files. Sync applies the setup to tools; publishing a <Term term="Profile Revision" /> makes a version available to other machines.
          </p>
        </div>
      )}
    </Wizard>
  );
}


/* ------------------------------------------------------------------ */
/* Follower enroll                                                     */
/* ------------------------------------------------------------------ */

function FollowerWizard({ job, onRun, onBack, onDone, data, live }: WizardProps<FollowerSetup>) {
  const LISTED = data.harnesses.filter((h) => h.listed);
  const FOLLOWER_INSTALLED = data.followerInstalled;
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [demoInvite, setInvite] = useState<string | null>(null);
  const invite = live ? live.invitationLabel : demoInvite;
  const [paste, setPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteTried, setPasteTried] = useState(false);
  const [tunnel, setTunnel] = useState(true);
  const [sshHost, setSshHost] = useState(live ? "" : "atlas.local");
  const [sshUser, setSshUser] = useState(live ? "" : "maria");
  const [hostKey, setHostKey] = useState("./source-host-key.pub");
  const [advanced, setAdvanced] = useState(false);
  const [replace, setReplace] = useState(false);
  const [sshPort, setSshPort] = useState("22");
  const [localPort, setLocalPort] = useState("");
  const sshTrust = useStateMachine<TrustState, TrustEvent>({ kind: "unverified" }, transitionTrust);
  const sourceTrust = useStateMachine<TrustState, TrustEvent>({ kind: "unverified" }, transitionTrust);
  const sshIdentity = JSON.stringify([sshHost, sshUser, hostKey, sshPort, localPort]);
  const sourceIdentity = live ? JSON.stringify([live.envelope, live.inspection?.sourceFingerprint, live.inspection?.tlsFingerprint]) : data.endpoint;
  const trusted = sshTrust.state.kind === "verified" && sshTrust.state.identity === sshIdentity;
  const sourceTrusted = sourceTrust.state.kind === "verified" && sourceTrust.state.identity === sourceIdentity;
  const setTrusted = (checked: boolean) => sshTrust.send(checked ? { kind: "verify", identity: sshIdentity } : { kind: "reset" });
  const setSourceTrusted = (checked: boolean) => sourceTrust.send(checked ? { kind: "verify", identity: sourceIdentity } : { kind: "reset" });
  const [name, setName] = useState(live ? data.hostname : "laptop");
  // Harnesses the person excludes on this machine; Canonfig projects the rest of atlas's list that is installed here.
  const [excluded, setExcluded] = useState<HarnessId[]>([]);
  const selectedExclusions = live?.preferenceDraft?.excluded ?? [];
  const [demoSchedule, setUseSchedule] = useState(!live);
  const useSchedule = live ? live.preferenceDraft?.schedule ?? false : demoSchedule;
  const progress = live ? null : job?.progress ?? null;
  const done = live ? live.joined : !!job?.done;
  const sourceName = live ? "the Source" : "atlas";

  const steps = [
    ...(tunnel ? ["Opening the SSH tunnel to atlas"] : []),
    "Checking atlas's certificate",
    "Registering this machine with atlas",
    "Downloading revision 7",
    ...(useSchedule ? ["Setting the daily 09:00 schedule"] : []),
  ];

  // Typing keeps only lowercase letters, digits and dashes (spaces become dashes); edge dashes are trimmed
  // here rather than per keystroke, so typing "my laptop" can pass through "my-". Everything below uses this.
  const machineName = live ? name.trim() : name.replace(/^-+|-+$/g, "");

  // Validate late: these only show after a Continue that couldn't proceed.
  const errors = {
    invite: step === 0 && invite === null ? (live ? "Choose a file or paste the complete invitation." : "Use the example file, or paste the invitation.") : null,
    host: step === 1 && tunnel && !sshHost.trim() ? `Enter ${sourceName}'s hostname or IP address for SSH, such as atlas.local.` : null,
    user: step === 1 && tunnel && !sshUser.trim() ? `Enter the account name you use to sign in to ${sourceName} through SSH.` : null,
    hostKey: step === 1 && tunnel && !hostKey.trim() ? "Enter the path to the Source's SSH host public key file." : null,
    trusted: step === 1 && tunnel && !trusted ? "Compare the SSH host key with the Source's copy, then select the confirmation." : null,
    sourceTrusted: live && step === 1 && !sourceTrusted ? "Compare both fingerprints with the Source through a separate trusted connection, then select the confirmation." : null,
    replace: live?.session.role === "follower" && step === 2 && !replace ? "Confirm replacement of this machine's enrollment." : null,
    ports: live && step === 1 && tunnel && (![sshPort, localPort].every((port) => /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) ? "Use whole port numbers from 1 to 65535." : null,
    name: step === 2 && !machineName ? "Enter a name for this machine." : null,
  };
  const blocked = Object.values(errors).some(Boolean);
  const shown = (key: keyof typeof errors) => (tried ? errors[key] : null);

  // The demo doesn't decode invitations: it accepts the example's prefix and then shows example details,
  // and the copy around it says so rather than implying a real check.
  const pasteValid = live ? !!pasted.trim() : pasted.trim().startsWith("canonfig-invite-v1:");
  const readPasted = () => {
    setPasteTried(true);
    if (live) void live.inspectInvitation(pasted, (inspection) => { setSourceTrusted(false); setTrusted(false); setLocalPort(new URL(inspection.endpoint).port || "443"); });
    else if (pasteValid) setInvite("(pasted)");
  };

  return (
    <Wizard
      role="follower"
      title={`Copy the setup from ${sourceName}`}
      steps={["Invitation", "Connection", "This machine"]}
      step={step}
      onStep={(s) => {
        setTried(false);
        setStep(s);
      }}
      onBack={() => { live?.clearInvitation(); onBack(); }}
      finalLabel={`Join ${sourceName}`}
      busyLabel="Joining…"
      blocked={blocked}
      onBlocked={() => {
        setTried(true);
        // The host key file lives under Advanced; its error must be visible.
        if (errors.hostKey || errors.ports) setAdvanced(true);
      }}
      busy={live ? live.state.loading : progress !== null && !done}
      onFinish={() => live ? void live.join({ name: machineName, replace, tunnel, sshHost, sshUser, sshPort: Number(sshPort), hostKey, localPort: Number(localPort) }) : onRun(3000, steps.length)}
      done={
        done ? (
          <Finished
            title={`${machineName} now follows ${sourceName}`}
            action="Open Canonfig"
            busy={live?.state.loading}
            onOpen={() => onDone({ role: "follower", name: machineName, tunnel, schedule: useSchedule, excluded })}
            next={live ? "Next: open Sync to review what this setup would change before applying it." : "Next: open Sync to review what the published setup, revision 7, would change before applying it."}
          >
            This machine is now a follower and copies the setup the Source publishes. Joining didn't change your AI coding tools. The Source can revoke this machine's access without affecting other followers.
            {live && <div className="mt-4 space-y-4">
              {live.state.error && <ErrorNotice error={live.state.error} title="This machine joined, but its preferences could not be loaded or saved" recovery="Follow the instructions above. Reload this machine's preferences to check what was saved, then save any remaining changes. You do not need to join again." />}
              <Button type="button" variant="outline" disabled={live.state.loading} onClick={() => void live.loadHarnesses()}>Reload this machine's preferences</Button>
              {live.harnessReport && <>
                <p>Choose which AI coding tools use the Source's setup on this machine. Clear a tool to keep it outside Canonfig's control here.</p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {live.harnessReport.harnesses.map((h) => <li key={h.harness}><label className="flex min-h-11 items-center gap-3 px-3.5 py-2.5">
                    <Checkbox checked={!selectedExclusions.includes(h.harness)} disabled={live.state.loading} onCheckedChange={(checked) => {
                      live.editPreferences({ excluded: checked ? selectedExclusions.filter((id) => id !== h.harness) : [...selectedExclusions, h.harness], schedule: useSchedule });
                    }} />
                    <span className="min-w-0 flex-1">{h.name}</span><span className="text-sm text-muted-foreground">{!h.installed ? "Not installed here" : !h.listed ? "Not in the Source's profile" : "Installed here"}</span>
                  </label></li>)}
                </ul>
                <label className={CHECK_ROW}><Checkbox checked={useSchedule} disabled={live.state.loading} onCheckedChange={(checked) => live.editPreferences({ excluded: selectedExclusions, schedule: checked === true })} />Sync automatically on the profile's schedule</label>
                <p className="text-sm text-muted-foreground">Apply the profile in Sync before using its schedule. If saving the schedule fails, apply the profile, then try saving these preferences again.</p>
                <Button type="button" disabled={live.state.loading} onClick={() => void live.savePreferences(selectedExclusions, useSchedule)}>Save this machine's preferences</Button>
                {live.followerState.kind === "preferences-failed" && <p>Some preferences may already be saved. Select Save this machine's preferences to check what was saved and retry the remaining changes.</p>}
                {live.preferencesSaved && <p role="status">This machine's preferences saved.</p>}
              </>}
            </div>}
          </Finished>
        ) : undefined
      }
    >
      {live?.state.error && <ErrorNotice error={live.state.error} title="This machine could not join the Source" recovery="Follow the instructions above, then read the invitation or try joining again. If it was used or expired, create a new invitation on the Source. Never bypass an identity mismatch." />}
      {step === 0 && (
        <div className="space-y-4">
          <p className="leading-relaxed text-muted-foreground">
            An invitation gives this machine permission to copy the Source's setup. On {sourceName}, open Machines and create an invitation, or run <Mono>canonfig source invite</Mono> in a terminal. Copy the invitation file to this machine.
          </p>
          {invite === null ? (
            paste ? (
              <div className="space-y-2">
                <Field
                  label="Invitation contents"
                  htmlFor="ob-paste"
                  hint={live ? "Copy the entire invitation file, including its final EOF line." : "This demo accepts example contents starting with canonfig-invite-v1:."}
                  error={pasteTried && !pasteValid ? live ? "Paste the complete invitation contents, including the final EOF line." : "This demo accepts example invitations starting with canonfig-invite-v1:. Use the example file instead, or paste that prefix." : null}
                >
                  <Textarea
                    id="ob-paste"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        readPasted();
                      }
                    }}
                    placeholder={live ? "eyJ…\nEOF" : "canonfig-invite-v1:…"}
                    spellCheck={false}
                    aria-invalid={pasteTried && !pasteValid}
                    aria-describedby={pasteTried && !pasteValid ? "ob-paste-error" : undefined}
                    className="h-24 font-mono text-[12px]"
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={readPasted}>
                    Read invitation
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPaste(false)}>
                    Choose a file instead
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className={cn("flex flex-col items-center rounded-lg border border-dashed px-6 py-8 text-center", shown("invite") ? "border-bad/60" : "border-border-strong")}>
                  <FileArrowUp className="size-5 text-muted-foreground" />
                  <p className="mt-3 font-medium">Add the invitation file</p>
                  <p className="mt-1 text-sm text-muted-foreground">Choose the file copied from the Source.{DEMO && " This demo uses an example file."}</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {live ? <Input type="file" aria-label="Invitation file" onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (file) void live.inspectInvitation(await file.text(), (inspection) => { setSourceTrusted(false); setTrusted(false); setLocalPort(new URL(inspection.endpoint).port || "443"); }, file.name);
                    }} /> : <Button type="button" variant="outline" size="sm" onClick={() => setInvite("~/Downloads/canonfig-invite")}>
                      Use the example file
                    </Button>}
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPaste(true)}>
                      Paste contents
                    </Button>
                  </div>
                </div>
                {shown("invite") && <FieldError>{shown("invite")}</FieldError>}
              </>
            )
          ) : (
            <div className="rounded-lg border border-border bg-raised/40 px-4 py-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Check className="size-4 text-ok" />
                <span className="font-medium">{live ? "Invitation read" : "Example invitation from atlas"}</span>
                <Button type="button" variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => { setInvite(null); live?.clearInvitation(); setSourceTrusted(false); setTrusted(false); }}>
                  Choose another invitation
                </Button>
              </div>
              <Facts
                items={[
                  ["File", <Mono className="text-foreground">{invite === "(pasted)" ? "Pasted" : invite}</Mono>],
                  ["Source address", <Mono className="text-foreground">{live?.inspection?.endpoint ?? data.endpoint}</Mono>],
                  ["Expires", live?.inspection?.expiresAt ?? "In 52 minutes, or once used"],
                  [
                    <Term term="Follower Group">Groups</Term>,
                    live ? live.inspection?.groups.join(", ") || "Base profile only" : <>
                      Allowed to receive shared passwords and tokens through <Mono>canonfig:secrets</Mono>
                    </>,
                  ],
                ]}
              />
              <p className="mt-3 text-sm text-muted-foreground">Groups allow extra configuration beyond the shared setup. This invitation can be used once. Keep its contents private.</p>
            </div>
          )}
        </div>
      )}
      {step === 1 && (
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            {live ? "Check that you are connecting to the right Source before joining. Use an SSH tunnel, a secure connection between machines, if the Source address starts with 127.0.0.1 or localhost. Turn it off only if you already have a connection to that address." : "Connect securely to atlas before joining. The invitation uses 127.0.0.1, an address that normally points to this machine. An SSH tunnel forwards that connection to atlas instead."}
          </p>
          {live?.inspection && <>
            <p className="text-sm text-muted-foreground">These fingerprints identify the Source and its secure connection. Compare both with the values shown on the Source through a separate trusted connection, such as an existing SSH session. If either differs, stop and request a new invitation.</p>
            <Facts items={[["Source fingerprint", <Mono className="break-all">{live.inspection.sourceFingerprint}</Mono>], ["TLS fingerprint", <Mono className="break-all">{live.inspection.tlsFingerprint}</Mono>]]} />
            <label className={CHECK_ROW}><Checkbox checked={sourceTrusted} onCheckedChange={(checked) => setSourceTrusted(checked === true)} />I compared both fingerprints with the Source and they match.</label>
            {shown("sourceTrusted") && <FieldError>{shown("sourceTrusted")}</FieldError>}
          </>}
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50">
            <Switch checked={tunnel} onCheckedChange={setTunnel} />
            <span>
              <span className="font-medium">Connect through an SSH tunnel</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">Requires working SSH access to {sourceName}. Canonfig opens this secure connection before each sync.</span>
            </span>
          </label>
          {tunnel && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Source SSH address" htmlFor="ob-host" hint="The Source's hostname or IP address, such as atlas.local." error={shown("host")}>
                  <Input
                    id="ob-host"
                    value={sshHost}
                    // This matches atlas vouches for one exact identity, so editing host, user or key file withdraws it.
                    onChange={(e) => {
                      setSshHost(e.target.value);
                      setTrusted(false);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!shown("host")}
                    aria-describedby={shown("host") ? "ob-host-error" : undefined}
                  />
                </Field>
                <Field label="Source SSH username" htmlFor="ob-user" hint="The account you use to sign in to the Source through SSH." error={shown("user")}>
                  <Input
                    id="ob-user"
                    value={sshUser}
                    onChange={(e) => {
                      setSshUser(e.target.value);
                      setTrusted(false);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!shown("user")}
                    aria-describedby={shown("user") ? "ob-user-error" : undefined}
                  />
                </Field>
              </div>
              <div className={cn("rounded-lg border px-3.5 py-3", shown("trusted") ? "border-bad/60" : "border-border")}>
                <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  {sourceName}'s SSH host key, from <Mono>{hostKey}</Mono>
                  <Hint label="checking the SSH host key">The SSH host key identifies the Source. Compare this file with the Source's SSH host public key through a separate trusted connection. Change the file path under Advanced.</Hint>
                </div>
                {!live && <Mono className="mt-1 block text-foreground">ED25519 SHA256:Jx7qL2c9…vR0wPq4sE</Mono>}
                <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2.5 sm:min-h-10">
                  <Checkbox checked={trusted} onCheckedChange={(c) => setTrusted(c === true)} aria-invalid={!!shown("trusted")} aria-describedby={shown("trusted") ? "ob-trusted-error" : undefined} />
                  I checked this SSH host key against {sourceName} and it matches
                </label>
              </div>
              {shown("trusted") && <FieldError id="ob-trusted-error">{shown("trusted")}</FieldError>}
              <Collapsible open={advanced} onOpenChange={setAdvanced}>
                <DisclosureTrigger>Advanced</DisclosureTrigger>
                <CollapsibleContent className="mt-3">
                  <Field
                    label="Source SSH host public key file"
                    htmlFor="ob-hostkey"
                    hint="Copy /etc/ssh/ssh_host_ed25519_key.pub from the Source to this machine through a trusted connection. Enter the path to that copy. Never copy the private key."
                    error={shown("hostKey")}
                  >
                    <Input
                      id="ob-hostkey"
                      value={hostKey}
                      onChange={(e) => {
                        setHostKey(e.target.value);
                        setTrusted(false);
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!!shown("hostKey")}
                      aria-describedby={shown("hostKey") ? "ob-hostkey-error" : undefined}
                      className="font-mono text-[12px]"
                    />
                  </Field>
                  {live && <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="SSH port" htmlFor="ob-ssh-port"><Input id="ob-ssh-port" value={sshPort} onChange={(event) => setSshPort(event.target.value)} /></Field>
                    <Field label="Local tunnel port" htmlFor="ob-local-port"><Input id="ob-local-port" value={localPort} onChange={(event) => setLocalPort(event.target.value)} /></Field>
                    {shown("ports") && <FieldError>{shown("ports")}</FieldError>}
                  </div>}
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </div>
      )}
      {step === 2 && (
        <div className="space-y-5">
          {progress === null ? (
            <>
              <p className="text-muted-foreground">Name this follower so you can recognize it on the Source, then join to give it access to the shared setup.</p>
              <Field label="Name for this machine" htmlFor="ob-mname" hint={`Shown in Machines on ${sourceName}.`} error={shown("name")} className="sm:max-w-80">
                <Input
                  id="ob-mname"
                  value={name}
                  // Collapse dash runs too: typing spaces one at a time turns "a  b" into "a--b" otherwise.
                  onChange={(e) => setName(live ? e.target.value : e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-"))}
                  onBlur={() => setName(machineName)}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!!shown("name")}
                  aria-describedby={shown("name") ? "ob-mname-error" : undefined}
                />
              </Field>
              {!live && <section aria-labelledby="ob-harnesses" className="space-y-2">
                <h3 id="ob-harnesses" className="text-sm font-medium">
                  AI coding tools in atlas's profile
                </h3>
                <p className="text-sm text-muted-foreground">
                  The profile is the setup atlas shares. Choose which installed AI coding tools should use it here. Clear a tool to leave it out. Tools that aren't installed receive nothing.
                  {DEMO && " In this demo, what's installed here is an example."}
                </p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {LISTED.map((h) => {
                    const installed = FOLLOWER_INSTALLED.includes(h.id);
                    const isExcluded = excluded.includes(h.id);
                    return (
                      <li key={h.id}>
                        <label className={cn("flex min-h-11 items-center gap-3 px-3.5 py-2.5 sm:min-h-10", installed ? "cursor-pointer hover:bg-raised/50" : "cursor-not-allowed")}>
                          <Checkbox
                            checked={installed && !isExcluded}
                            disabled={!installed}
                            onCheckedChange={(c) => setExcluded((ids) => (c === true ? ids.filter((id) => id !== h.id) : [...ids, h.id]))}
                          />
                          <span className={cn("min-w-0 flex-1", !installed && "text-muted-foreground")}>{h.name}</span>
                          <span className={cn("shrink-0 text-sm", installed && !isExcluded ? "text-foreground" : "text-muted-foreground")}>
                            {!installed ? "Not installed here" : isExcluded ? "Excluded here" : "Will sync"}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-sm text-muted-foreground">
                  With the Backups setting on, the first sync saves replaced tool settings in a <Term term="Takeover Snapshot" /> at <Mono>~/.canonfig/.backups/</Mono>. With Backups off, replaced content is not saved.
                </p>
              </section>}
              {!live && <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50">
                <Checkbox checked={useSchedule} onCheckedChange={(c) => setUseSchedule(c === true)} className="mt-px" />
                <span className="font-medium">Sync daily at 09:00, the profile's default schedule</span>
              </label>}
              <p className="text-sm text-muted-foreground">
                {live ? "Joining registers this machine with the Source so it can copy the published setup. It does not apply the setup to your AI coding tools. Open Sync afterwards to review and apply the changes. You can choose tools and a sync schedule after joining." : <>Joining downloads <Term term="Profile Revision">revision 7</Term>, the version of the setup atlas published. It does not apply that setup to your AI coding tools. Open Sync afterwards to review and apply the changes.</>}
              </p>
              {live?.session.role === "follower" && <label className={CHECK_ROW}><Checkbox checked={replace} onCheckedChange={(checked) => setReplace(checked === true)} />Replace this machine's current connection to its Source with this invitation. It will follow the Source and groups in this invitation instead.</label>}
              {shown("replace") && <FieldError>{shown("replace")}</FieldError>}
            </>
          ) : (
            <>
              <DitherProgress value={progress} running={!done} label="Joining atlas" />
              <RunList items={steps} progress={progress} />
            </>
          )}
        </div>
      )}
    </Wizard>
  );
}
