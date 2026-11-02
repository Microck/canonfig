// Shared components for the simulated first-run flow.
import { useContext, useEffect, useId, useLayoutEffect, useRef, type ComponentType, type ReactNode } from "react";
import { AnimatePresence, motion, PresenceContext, useIsPresent, useReducedMotion, type Variants } from "motion/react";
import { CaretRight, Check, Question, WarningCircle } from "@/components/icons";
import { cn, riseIn, SNAP } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DEMO } from "@/shared/data";
import { GLOSSARY, Logo } from "@/shared/shared";

/**
 * Moves focus to the returned element when it mounts. The flow swaps whole
 * screens (choice, wizard, finished), so without this the control the person
 * just used disappears and keyboard focus falls back to <body>. A screen that
 * was leaving and comes back (AnimatePresence keeps it rather than mounting a
 * new one) takes focus again too.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const present = useIsPresent();
  useEffect(() => {
    if (present) ref.current?.focus();
  }, [present]);
  return ref;
}

/**
 * One step change's length: the pane's slide, the stepper ring's glide and the card's
 * height tween (Wizard) all run this long on --ease-snap, so they read as one movement.
 * The Stepper's connector fill below repeats it as the Tailwind class `duration-240`.
 */
export const STEP_MS = 240;
const STEP_MOVE = { duration: STEP_MS / 1000, ease: SNAP };

// Steps slide 20px in the direction of travel: Continue brings the next step in from the
// right, Back from the left. The pane itself only moves; its items fade in one after
// another as they rise (StepPane), so the step reads as built up rather than swapped.
// The leaving step fades and drifts 12px the other way in 120ms, clearing the stage
// before the new items arrive. 20px stays inside the card's padding at every width.
// Transform strings, not `x`: motion hands a plain transform to the compositor.
const STEP_SLIDE: Variants = {
  enter: (direction: number) => ({ transform: `translateX(${direction * 20}px)` }),
  center: { transform: "translateX(0px)", opacity: 1, transition: STEP_MOVE },
  exit: (direction: number) => ({ transform: `translateX(${direction * -12}px)`, opacity: 0, transition: { duration: 0.12, ease: SNAP } }),
};
// Reduced motion: no movement. The new step fades in; the old one leaves at once, so two steps never overlap.
const STEP_FADE: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { duration: 0.15, ease: SNAP } },
  exit: { opacity: 0, transition: { duration: 0 } },
};

/**
 * Swaps wizard steps with a direction-aware slide. The leaving step is popped out of
 * layout (absolute), so the container measures the new step at once and
 * `useHeightTween` on an ancestor can run to it. Rapid Continue/Back retargets: a step
 * that comes back while leaving turns around rather than mounting a second copy.
 */
export function StepTransition({ step, direction, children }: { step: number; direction: 1 | -1; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    // The pop-out is positioned against this box.
    <div className="relative">
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <StepPane key={step} direction={direction} reduced={!!reduced}>
          {children}
        </StepPane>
      </AnimatePresence>
    </div>
  );
}

/** A step's top-level items, the ones StepPane rises in: pane > the step's root > its children. */
export const STEP_ITEMS = "[data-step-pane] > * > *";

/**
 * One step's content. Inert while leaving, so its fields can't take a click or focus
 * during the exit. A step that arrives by Continue or Back rises its top-level items in,
 * 30ms apart, all done within 290ms, alongside the card's 240ms height tween on the same
 * curve. The wizard's first step is left alone: the wizard's entrance staggers it.
 * AnimatePresence's pop-out finds the pane itself (its outermost motion element).
 */
function StepPane({ direction, reduced, children }: { direction: 1 | -1; reduced: boolean; children: ReactNode }) {
  const present = useIsPresent();
  // AnimatePresence marks the children of its first render with initial: false.
  const first = useContext(PresenceContext)?.initial === false;
  const pane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (first || reduced) return;
    riseIn(pane.current!.querySelectorAll(":scope > * > *"), { gap: 30, duration: 200, distance: 6, cap: 3 });
    // Mount only: a step that turns around mid-exit is already built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <motion.div
      ref={pane}
      data-step-pane
      custom={direction}
      variants={reduced ? STEP_FADE : STEP_SLIDE}
      initial="enter"
      animate="center"
      exit="exit"
      inert={!present}
    >
      {children}
    </motion.div>
  );
}

/**
 * Top bar for a machine that isn't set up yet: brand, machine, glossary. `backdrop` fills
 * the frame behind <main>, outside the scrolling content, so its size follows the viewport
 * only: a step that grows, an opened disclosure or a scroll never resizes or moves it.
 */
export function OnboardingShell({ hostname, backdrop, children }: { hostname: string; backdrop: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-svh flex-col bg-canvas text-foreground">
      <Sheet>
        <header className="flex h-12 shrink-0 items-center justify-between px-4">
          {/* In the demo, max-md:mr-24 reserves the slot for the compact Demo button that App.tsx fixes into this header. */}
          <div className={cn("flex min-w-0 items-center gap-2.5", DEMO && "max-md:mr-24")}>
            <Logo />
            <span className="text-[13px] font-semibold tracking-[-0.01em]">canonfig</span>
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            <span className="truncate text-[13px] text-muted-foreground">{hostname}</span>
          </div>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Glossary" className="size-11 shrink-0 text-muted-foreground sm:size-10">
              <Question />
            </Button>
          </SheetTrigger>
        </header>
        <div className="relative isolate mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background">
          <div aria-hidden data-setup-backdrop className="absolute inset-0 -z-10">
            {backdrop}
          </div>
          <main className="h-full overflow-y-auto">{children}</main>
        </div>
        <SheetContent side="right" className="gap-0 border-border bg-panel p-0 data-[side=right]:w-[min(440px,100vw)] data-[side=right]:sm:max-w-[440px]">
          <div className="border-b border-border px-6 pt-5 pb-4">
            <SheetTitle className="text-[15px] font-medium">Glossary</SheetTitle>
            <SheetDescription className="sr-only">Definitions of Canonfig terms.</SheetDescription>
          </div>
          <dl className="min-h-0 flex-1 divide-y divide-border overflow-y-auto px-6 pb-24">
            {Object.entries(GLOSSARY).map(([term, { plain, meaning }]) => (
              <div key={term} className="py-3.5">
                <dt className="font-medium">{plain.charAt(0).toUpperCase() + plain.slice(1)}</dt>
                <dd className="mt-1 leading-relaxed text-muted-foreground">
                  {meaning} <span className="text-faint">Canonfig calls this {term}.</span>
                </dd>
              </div>
            ))}
          </dl>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function RadioRow({
  value,
  title,
  description,
  icon: Icon,
  children,
  className,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  // The radio and icon centre on the whole text block (title, description, children), so a
  // one-line row and a two-line row read the same way. The icon is 20px: at 16px it read
  // smaller than the medium-weight title beside it.
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50",
        "has-data-[state=checked]:border-border-strong has-data-[state=checked]:bg-raised",
        className,
      )}
    >
      <RadioGroupItem id={id} value={value} />
      {Icon && <Icon className="size-5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className="block leading-none font-medium">{title}</span>
        {description && <span className="mt-1.5 block text-sm text-muted-foreground">{description}</span>}
        {children}
      </span>
    </label>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Shown instead of the hint once the person has tried to continue. */
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 content-start gap-1.5 [&_input]:min-h-11 [&_[role=combobox]]:min-h-11 max-sm:[&_input]:text-base max-sm:[&_textarea]:text-base sm:[&_input]:min-h-10 sm:[&_[role=combobox]]:min-h-10", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? <FieldError id={htmlFor && `${htmlFor}-error`}>{error}</FieldError> : hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Inline error next to the control that caused it: colour, icon and text. It drops in
 * (field-error-in); `data-field-error` lets the wizard shake errors that are already
 * showing when Continue is pressed again.
 */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} data-field-error className="field-error-in flex items-start gap-1.5 text-sm text-bad">
      <WarningCircle className="mt-0.5 size-3.5 shrink-0" />
      {children}
    </p>
  );
}

/**
 * The current step's ring. One shared element (layoutId, in the Wizard's LayoutGroup) that
 * glides from marker to marker, and on finishing grows into the success badge (Finished).
 * Reduced motion doesn't share it, so the ring and the badge simply appear in place.
 */
export const PROGRESS_MARK = "progress-mark";

export function Stepper({ steps, step }: { steps: string[]; step: number }) {
  const reduced = useReducedMotion();
  return (
    <ol aria-label="Steps" className="mt-4 grid grid-cols-3 gap-2 text-sm sm:flex sm:flex-wrap sm:items-center">
      {steps.map((title, i) => (
        <li key={title} className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center" aria-current={i === step ? "step" : undefined}>
          {/* Markers and labels change colour at state speed; a newly completed step draws its check (check-draw).
              The ring travels to the new current step in STEP_MS, the same curve and time as the step's own slide.
              layoutDependency: it only re-measures when the step changes, not on every keystroke in the wizard. */}
          <span
            className={cn(
              "relative grid size-[18px] place-items-center rounded-full border text-[11px] font-medium tabular-nums transition-[color,background-color,border-color] duration-150 ease-snap",
              i < step && "border-transparent bg-ok/15 text-ok",
              i === step && "border-transparent text-foreground",
              i > step && "border-border text-faint",
            )}
          >
            {i === step && (
              <motion.span
                layoutId={reduced ? undefined : PROGRESS_MARK}
                layoutDependency={step}
                aria-hidden
                className="absolute -inset-px rounded-full border border-foreground/50"
                transition={STEP_MOVE}
              />
            )}
            {i < step ? (
              <>
                <Check aria-hidden className="check-draw size-3" />
                <span className="sr-only">Done:</span>
              </>
            ) : (
              i + 1
            )}
          </span>
          <span className={cn("transition-colors duration-150 ease-snap", i === step ? "text-foreground" : i < step ? "text-muted-foreground" : "text-faint")}>{title}</span>
          {/* The connector fills left to right once the step before it is done, as the ring leaves it. */}
          {i < steps.length - 1 && (
            <span aria-hidden className="relative mx-1 hidden h-px w-5 bg-border sm:block">
              <span className={cn("absolute inset-0 origin-left bg-ok/60 transition-transform duration-240 ease-snap", i < step ? "scale-x-100" : "scale-x-0")} />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Small key/value lines. */
export function Facts({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[120px_minmax(0,1fr)]", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="grid gap-1 sm:contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Run a fake job: ticks progress 0..100 then resolves. */
export function simulate(ms: number, onTick: (value: number) => void, onDone: () => void) {
  const started = performance.now();
  const id = window.setInterval(() => {
    const value = Math.min(100, ((performance.now() - started) / ms) * 100);
    onTick(value);
    if (value >= 100) {
      window.clearInterval(id);
      onDone();
    }
  }, 60);
  return () => window.clearInterval(id);
}

/** Quiet disclosure label, for "Advanced" fields. */
export function DisclosureTrigger({ children }: { children: ReactNode }) {
  return (
    <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-1 rounded-sm text-sm text-faint hover:text-muted-foreground sm:min-h-10">
      <CaretRight className="size-3.5 transition-transform duration-150 ease-snap group-data-[state=open]:rotate-90" />
      {children}
    </CollapsibleTrigger>
  );
}
