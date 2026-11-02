// First-run flow for a simulated, unconfigured machine.
// `onDone` returns the setup choices that seed the new workspace role.
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { machine, profile } from "@/shared/data";
import { DitherProgress, Hint, Mono, Term } from "@/shared/shared";
import { DisclosureTrigger, Facts, Field, FieldError, OnboardingShell, PROGRESS_MARK, RadioRow, STEP_ITEMS, STEP_MS, StepTransition, Stepper, simulate, useFocusOnMount } from "./kit";

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

/** A new Source, as the wizard created it. */
export interface SourceSetup {
  role: "source";
  profileName: string;
  profileFile: string;
  /** "manual" installs no background service: atlas serves only while `canonfig source serve` runs. */
  service: "service" | "manual";
  port: number;
  /** Whether `source scan` proposed tools. Without it the new Source starts with an empty profile. */
  scan: boolean;
}

/** A follower that just joined: enrolled, revision downloaded, nothing applied yet. */
export interface FollowerSetup {
  role: "follower";
  name: string;
  profileId: string;
  tunnel: boolean;
  /** Whether the profile's default schedule was set. False leaves the machine without a schedule. */
  schedule: boolean;
}

export type Setup = SourceSetup | FollowerSetup;

const DEFAULT_PORT = 17342;

export function Onboarding({ onDone }: { onDone: (setup: Setup) => void }) {
  const [stage, setStage] = useState<Stage>("choose");
  // The wizard left with "Change my answer", or null on the first visit, which gets the full entrance.
  const [returnedFrom, setReturnedFrom] = useState<Role | null>(null);
  const back = (from: Role) => {
    setReturnedFrom(from);
    setStage("choose");
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
    <OnboardingShell hostname={machine.hostname} backdrop={<SetupBackdrop job={job} />}>
      {/* md:pb-44 clears the fixed demo switcher (215px wide and about 70px tall, 12px from
          the left and 80px above the bottom) at the end of the scroll, where the cards can
          reach under it. From xl the cards start right of it, so normal padding returns and a
          card that fits the window doesn't scroll. Below md the switcher lives in the header
          (kit.tsx), so only normal padding remains. */}
      <div className={cn("relative isolate flex min-h-full flex-col items-center overflow-hidden px-4 pt-8 pb-12 md:pb-44 xl:pb-12 [overflow-wrap:anywhere] sm:px-6 sm:pt-16", stage === "choose" ? "justify-center" : "justify-start sm:pt-[12vh]")}>
        {/* popLayout takes the leaving screen out of flow, so the next one lays out at once and
            the picked card's shell (CardShell) can grow straight into the wizard card's place.
            `custom` tells the leaving choice which card was picked. */}
        <AnimatePresence mode="popLayout" custom={stage}>
          {stage === "choose" && <Choose key="choose" returnedFrom={returnedFrom} onPick={setStage} />}
          {stage === "source" && <SourceWizard key="source" job={job} onRun={run} onBack={() => back("source")} onDone={onDone} />}
          {stage === "follower" && <FollowerWizard key="follower" job={job} onRun={run} onBack={() => back("follower")} onDone={onDone} />}
        </AnimatePresence>
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
function Choose({ returnedFrom, onPick }: { returnedFrom: Role | null; onPick: (role: Role) => void }) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const screen = CHOOSE_SCREEN[reduced ? "reduced" : returnedFrom ? "return" : "intro"];
  const item = reduced ? undefined : CHOOSE_ITEM;
  return (
    // Leaving, it sits above the wizard so the picked card's text clears over the growing shell; inert, so it can't be picked twice.
    <motion.div inert={!present} variants={screen} initial="hidden" animate="shown" exit="exit" className={cn("w-full max-w-[680px] pb-10 text-center", !present && "z-10")}>
      <motion.div variants={item}>
        <h1 ref={heading} tabIndex={-1} className="text-[28px] leading-tight font-semibold tracking-[-0.025em] outline-none">
          What should this machine do?
        </h1>
        <p className="mx-auto mt-3 max-w-[480px] leading-relaxed text-balance text-muted-foreground">
          Canonfig keeps your AI agent instructions, settings, skills and tools the same on every machine.
        </p>
      </motion.div>
      <div className="mt-9 grid grid-cols-1 gap-3 text-left sm:grid-cols-2">
        <Choice
          role="source"
          returning={returnedFrom === "source"}
          title="Make this the Source"
          description="For the machine where you edit your setup. Other machines copy from it, and only this one publishes changes."
          onPick={onPick}
        />
        <Choice
          role="follower"
          returning={returnedFrom === "follower"}
          title="Copy the setup from another machine"
          description="For a machine that should get its setup from your Source."
          onPick={onPick}
        />
      </div>
      <motion.p variants={item} className="mt-6 text-sm text-muted-foreground">
        Not sure? Make the computer you use most the Source.
      </motion.p>
    </motion.div>
  );
}

/**
 * One role card: just its title. What the role means shows in a tooltip while the card is
 * hovered or keyboard-focused, and stays linked to the button as its description for screen
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
              <span className="text-xl leading-snug font-medium tracking-[-0.01em] text-pretty">{title}</span>
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
      // Errors already on screen shake once, so a repeated Continue visibly registers.
      // Errors this press reveals drop in on their own (field-error-in); nothing to shake yet.
      if (!reduced) for (const error of event.currentTarget.querySelectorAll("[data-field-error]")) error.animate(SHAKE, { duration: 300, easing: SNAP_EASING });
      onBlocked?.();
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
      className={cn("w-full max-w-[600px]", !present && "z-10")}
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
        <ArrowLeft className="size-3.5" /> Change my answer
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
                  {children}
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
              <Button type="submit" variant="secondary" className="min-w-24">
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
function Finished({ title, children, next, action, onOpen }: { title: string; children: ReactNode; next: ReactNode; action: string; onOpen: () => void }) {
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
        <Button type="button" variant="default" onClick={onOpen}>
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
  job: Job | null;
  onRun: (ms: number, steps: number) => void;
  onBack: () => void;
  onDone: (setup: S) => void;
}

function SourceWizard({ job, onRun, onBack, onDone }: WizardProps<SourceSetup>) {
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [name, setName] = useState(profile.name);
  const [file, setFile] = useState(machine.profileFile);
  const [scan, setScan] = useState(true);
  const [service, setService] = useState<"service" | "manual">("service");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [advanced, setAdvanced] = useState(false);
  const progress = job?.progress ?? null;
  const done = !!job?.done;

  // Validated as typed, never rewritten: stripping characters would turn "1.5" into a different port.
  const portNumber = Number(port);
  const portValid = /^\d+$/.test(port) && portNumber >= 1 && portNumber <= 65535;
  const creates = [
    `Profile file at ${file}`,
    "Canonfig's own records at ~/.canonfig/state.sqlite",
    "A signing key, kept in your login keyring",
    ...(service === "service" ? [`Background service at https://127.0.0.1:${portNumber}`] : []),
    ...(scan ? ["2 proposed tools, found in ~/.claude.json and ~/.codex/config.toml"] : []),
  ];

  const nameError = tried && !name.trim() ? "Enter a profile name." : null;
  const fileError = tried && !file.trim() ? "Enter where to save the profile file." : null;
  const portError = tried && !portValid ? "Enter a whole number from 1 to 65535." : null;

  return (
    <Wizard
      role="source"
      title="Make atlas the Source"
      steps={["Your profile", "The service", "Create"]}
      step={step}
      onStep={(s) => {
        setTried(false);
        setStep(s);
      }}
      onBack={onBack}
      finalLabel="Make atlas the Source"
      busyLabel="Creating…"
      blocked={(step === 0 && (!name.trim() || !file.trim())) || (step === 1 && !portValid)}
      onBlocked={() => {
        setTried(true);
        // The port lives under Advanced; its error must be visible.
        if (step === 1) setAdvanced(true);
      }}
      busy={progress !== null && !done}
      onFinish={() => onRun(2600, creates.length)}
      done={
        done ? (
          <Finished
            title="atlas is now the Source"
            action={scan ? "Review proposed tools" : "Open Canonfig"}
            onOpen={() => onDone({ role: "source", profileName: name.trim(), profileFile: file.trim(), service, port: portNumber, scan })}
            next={
              scan ? (
                <>
                  Next: check the 2 tools Canonfig found, then publish your first <Term term="Profile Revision" />.
                </>
              ) : (
                <>
                  Next: add what your other machines need, then publish your first <Term term="Profile Revision" />.
                </>
              )
            }
          >
            Your <Term term="Machine Profile" /> is <Mono className="text-foreground">{file.trim()}</Mono> in this demo workspace. The demo doesn't create or read that file; edit the profile
            here.
          </Finished>
        ) : undefined
      }
    >
      {step === 0 && (
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            Your <Term term="Machine Profile" /> is one file that lists everything your other machines should have.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1.4fr]">
            <Field label="Profile name" htmlFor="ob-name" error={nameError}>
              <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} aria-describedby={nameError ? "ob-name-error" : undefined} />
            </Field>
            <Field label="Profile file" htmlFor="ob-file" hint="Canonfig keeps your comments when it edits this file." error={fileError}>
              <Input
                id="ob-file"
                value={file}
                onChange={(e) => setFile(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!!fileError}
                aria-describedby={fileError ? "ob-file-error" : undefined}
                className="font-mono text-[12px]"
              />
            </Field>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50">
            <Checkbox checked={scan} onCheckedChange={(c) => setScan(c === true)} className="mt-px" />
            <span>
              <span className="font-medium">Suggest tools from my AI agent settings</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Reads only ~/.claude.json and ~/.codex/config.toml, and suggests a tool for each program they start, such as an MCP server. Nothing is added until you review it.
              </span>
            </span>
          </label>
        </div>
      )}
      {step === 1 && (
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            Other machines connect to a small service on atlas. It only accepts connections from atlas itself, so they reach it over SSH, which each machine sets up when it joins.
          </p>
          <RadioGroup value={service} onValueChange={(v) => setService(v as "service" | "manual")} className="gap-2">
            <RadioRow value="service" title="Run it in the background" description="Starts when you log in and runs without a terminal open, so other machines can sync whenever you're logged in." />
            <RadioRow
              value="manual"
              title="Only when I start it"
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
              <Field label="Port" htmlFor="ob-port" error={portError}>
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
      {step === 2 && (
        <div>
          {progress === null ? (
            <>
              <p className="mb-3 leading-relaxed text-muted-foreground">Canonfig creates these on atlas:</p>
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
            Other machines get nothing until you publish a <Term term="Profile Revision" />.
          </p>
        </div>
      )}
    </Wizard>
  );
}

/* ------------------------------------------------------------------ */
/* Follower enroll                                                     */
/* ------------------------------------------------------------------ */

function FollowerWizard({ job, onRun, onBack, onDone }: WizardProps<FollowerSetup>) {
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteTried, setPasteTried] = useState(false);
  const [tunnel, setTunnel] = useState(true);
  const [sshHost, setSshHost] = useState("atlas.local");
  const [sshUser, setSshUser] = useState("marcos");
  const [hostKey, setHostKey] = useState("./source-host-key.pub");
  const [advanced, setAdvanced] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [name, setName] = useState("laptop");
  const [profileId, setProfileId] = useState(profile.id);
  const [useSchedule, setUseSchedule] = useState(true);
  const progress = job?.progress ?? null;
  const done = !!job?.done;

  const steps = [
    ...(tunnel ? ["Opening the SSH tunnel to atlas"] : []),
    "Checking atlas's certificate",
    "Registering this machine with atlas",
    "Downloading revision 7",
    ...(useSchedule ? ["Setting the daily 09:00 schedule"] : []),
  ];

  // Typing keeps only lowercase letters, digits and dashes (spaces become dashes); edge dashes are trimmed
  // here rather than per keystroke, so typing "my laptop" can pass through "my-". Everything below uses this.
  const machineName = name.replace(/^-+|-+$/g, "");

  // Validate late: these only show after a Continue that couldn't proceed.
  const errors = {
    invite: step === 0 && invite === null ? "Use the example file, or paste the invitation." : null,
    host: step === 1 && tunnel && !sshHost.trim() ? "Enter the SSH host for atlas." : null,
    user: step === 1 && tunnel && !sshUser.trim() ? "Enter your SSH user on atlas." : null,
    hostKey: step === 1 && tunnel && !hostKey.trim() ? "Enter the path to atlas's SSH host public key file." : null,
    trusted: step === 1 && tunnel && !trusted ? "Confirm the fingerprint matches atlas." : null,
    name: step === 2 && !machineName ? "Enter a name for this machine." : null,
  };
  const blocked = Object.values(errors).some(Boolean);
  const shown = (key: keyof typeof errors) => (tried ? errors[key] : null);

  // The demo doesn't decode invitations: it accepts the example's prefix and then shows example details,
  // and the copy around it says so rather than implying a real check.
  const pasteValid = pasted.trim().startsWith("canonfig-invite-v1:");
  const readPasted = () => {
    setPasteTried(true);
    if (pasteValid) setInvite("(pasted)");
  };

  return (
    <Wizard
      role="follower"
      title="Copy the setup from atlas"
      steps={["Invitation", "Connection", "This machine"]}
      step={step}
      onStep={(s) => {
        setTried(false);
        setStep(s);
      }}
      onBack={onBack}
      finalLabel="Join atlas"
      busyLabel="Joining…"
      blocked={blocked}
      onBlocked={() => {
        setTried(true);
        // The host key file lives under Advanced; its error must be visible.
        if (errors.hostKey) setAdvanced(true);
      }}
      busy={progress !== null && !done}
      onFinish={() => onRun(3000, steps.length)}
      done={
        done ? (
          <Finished
            title={`${machineName} now follows atlas`}
            action="Open Canonfig"
            onOpen={() => onDone({ role: "follower", name: machineName, profileId, tunnel, schedule: useSchedule })}
            next="Next: see what revision 7 would change here, before you apply it."
          >
            atlas can disconnect this machine on its own, without affecting the others. Canonfig hasn't changed any files here yet.
          </Finished>
        ) : undefined
      }
    >
      {step === 0 && (
        <div className="space-y-4">
          <p className="leading-relaxed text-muted-foreground">
            On atlas, create a single-use invitation file (<Mono>canonfig source invite</Mono> does the same), then copy it to this machine, for example with scp.
          </p>
          {invite === null ? (
            paste ? (
              <div className="space-y-2">
                <Field
                  label="Invitation contents"
                  htmlFor="ob-paste"
                  error={pasteTried && !pasteValid ? "That isn't the example invitation. In this demo, pasted invitations start with canonfig-invite-v1:" : null}
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
                    placeholder="canonfig-invite-v1:…"
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
                  <p className="mt-1 text-sm text-muted-foreground">Usually named canonfig-invite. This demo uses an example file.</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setInvite("~/Downloads/canonfig-invite")}>
                      Use the example file
                    </Button>
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
                <span className="font-medium">Example invitation from atlas</span>
                <Button type="button" variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => setInvite(null)}>
                  Use another
                </Button>
              </div>
              <Facts
                items={[
                  ["File", <Mono className="text-foreground">{invite === "(pasted)" ? "Pasted" : invite}</Mono>],
                  ["Endpoint", <Mono className="text-foreground">{machine.endpoint}</Mono>],
                  ["Expires", "In 52 minutes, or once used"],
                  [
                    <Term term="Follower Group">Groups</Term>,
                    <>
                      Can receive secrets <Mono>canonfig:secrets</Mono>
                    </>,
                  ],
                ]}
              />
            </div>
          )}
        </div>
      )}
      {step === 1 && (
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            The invitation's address, 127.0.0.1, means “this machine”. An SSH tunnel forwards that port on this machine to atlas, so the address reaches atlas from here.
          </p>
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50">
            <Switch checked={tunnel} onCheckedChange={setTunnel} />
            <span>
              <span className="font-medium">Connect through an SSH tunnel</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">Uses the SSH access you already have to atlas. Canonfig opens the tunnel before each sync.</span>
            </span>
          </label>
          {tunnel && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="SSH host" htmlFor="ob-host" error={shown("host")}>
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
                <Field label="SSH user" htmlFor="ob-user" error={shown("user")}>
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
                  atlas's SSH host key, from <Mono>{hostKey}</Mono>
                  <Hint label="checking the SSH host key">Compare it with the output of “ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub” on atlas. Change the file under Advanced.</Hint>
                </div>
                <Mono className="mt-1 block text-foreground">ED25519 SHA256:Jx7qL2c9…vR0wPq4sE</Mono>
                <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2.5 sm:min-h-10">
                  <Checkbox checked={trusted} onCheckedChange={(c) => setTrusted(c === true)} aria-invalid={!!shown("trusted")} />
                  This matches atlas
                </label>
              </div>
              {shown("trusted") && <FieldError>{shown("trusted")}</FieldError>}
              <Collapsible open={advanced} onOpenChange={setAdvanced}>
                <DisclosureTrigger>Advanced</DisclosureTrigger>
                <CollapsibleContent className="mt-3">
                  <Field
                    label="atlas's SSH host public key file"
                    htmlFor="ob-hostkey"
                    hint="A copy of /etc/ssh/ssh_host_ed25519_key.pub from atlas, for example made with scp."
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Name for this machine" htmlFor="ob-mname" hint="Shown on atlas." error={shown("name")}>
                  <Input
                    id="ob-mname"
                    value={name}
                    // Collapse dash runs too: typing spaces one at a time turns "a  b" into "a--b" otherwise.
                    onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-"))}
                    onBlur={() => setName(machineName)}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!shown("name")}
                    aria-describedby={shown("name") ? "ob-mname-error" : undefined}
                  />
                </Field>
                <Field label="Profile to follow" htmlFor="ob-profile">
                  <Select value={profileId} onValueChange={setProfileId}>
                    <SelectTrigger id="ob-profile" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="workstation">Workstation (10 resources)</SelectItem>
                      <SelectItem value="minimal">Minimal (3 resources)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50">
                <Checkbox checked={useSchedule} onCheckedChange={(c) => setUseSchedule(c === true)} className="mt-px" />
                <span className="font-medium">Sync daily at 09:00, the profile's default schedule</span>
              </label>
              <p className="text-sm text-muted-foreground">
                Joining downloads <Term term="Profile Revision">revision 7</Term>, the latest setup atlas published, but changes no files. Before the first sync, you'll see exactly what would change.
              </p>
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
