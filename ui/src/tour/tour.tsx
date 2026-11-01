// Spotlight walkthrough used for the guided tour and for single-step page tips.
// The tour dims and blurs the whole app, cuts a rounded window around one element
// at a time, and explains it in a small card beside it. A tip is just the card.
//
// Targets are found by `data-tour="<id>"`, so screens only need an attribute,
// not a ref. A step with several ids spotlights the box around all of them.
// Steps whose targets aren't on screen are skipped in the direction of travel
// (e.g. Publish when there is nothing to publish). The dim layer is purely
// visual (pointer-events: none); a transparent blocker underneath the card
// swallows clicks, so the highlighted control can't fire while it's explained.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, X } from "@/components/icons";
import { cn } from "@/lib/utils";
import { fillStyle, usePrefersReducedMotion } from "@/lib/dither";
import { Button } from "@/components/ui/button";

export interface TourStep {
  /** `data-tour` ids to spotlight. Omit (and `selector`) for a centered card with nothing cut out. */
  target?: string[];
  /** CSS selector to spotlight instead of ids, for chrome that has no `data-tour` id (the mobile top bar). */
  selector?: string;
  title: string;
  body: ReactNode;
  /** Runs before the step measures its target, e.g. to switch to the right page. */
  before?: () => void;
  /** Last step only: the primary button does this (then closes), so the tour ends in doing, not reading. */
  action?: { label: string; run: () => void };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 6;
const RADIUS = 8;
const CARD_W = 320;
const GAP = 14;
/**
 * Card buttons draw at 28px but keep a 40px hit box (44px on touch) through an invisible
 * ::after, so the card stays compact. Its inset includes the button's 1px border;
 * the card's 16px padding holds the extra 6-8px outside that border, and
 * the buttons sit far enough apart that their boxes don't meet. They also skip the press
 * scale: the card is read, not tapped through quickly.
 */
const HIT = "relative after:absolute after:-inset-[7px] pointer-coarse:after:-inset-[9px] active:scale-100! transition-none";

/**
 * Motion. Opening fades the overlay and grows the card from 0.96 (CSS keyframes in index.css,
 * `tour-in` / `tour-card-in`). Moving between steps glides the spotlight and the card together
 * so the eye follows the target instead of hunting for it. Both use --ease-snap, the app's one
 * motion curve; MOVE_MS sits in the 200–300ms overlay band. Reduced motion jumps instead of
 * gliding and keeps only the fades. There is no exit animation: closing restores focus on unmount,
 * and delaying unmount would delay that focus.
 */
const MOVE_MS = 260;

/**
 * How long a step waits for its target before it counts as absent and is skipped. A page that
 * `before` just opened can still be loading: a lazy screen renders nothing until its code resolves,
 * and React 19 holds a Suspense reveal for up to 300ms. Absent targets (Publish with nothing to
 * publish) pay this delay once, with the card hidden.
 */
const FIND_MS = 800;

/** cubic-bezier(0.175, 0.885, 0.32, 1.1), i.e. --ease-snap, solved for x so JS tweens match CSS. */
function easeSnap(t: number) {
  const [x1, y1, x2, y2] = [0.175, 0.885, 0.32, 1.1];
  const bez = (p1: number, p2: number, s: number) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
  let s = t;
  for (let i = 0; i < 8; i++) {
    const dx = bez(x1, x2, s) - t;
    const d = 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
    if (Math.abs(dx) < 1e-4 || d === 0) break;
    s -= dx / d;
  }
  return bez(y1, y2, Math.min(1, Math.max(0, s)));
}

/** The spotlight's DOM nodes; the glide writes their geometry directly, never through React state. */
interface SpotlightNodes {
  panels: (HTMLDivElement | null)[];
  dim: HTMLDivElement | null;
  rim: HTMLDivElement | null;
  ring: HTMLDivElement | null;
}

/**
 * Writes one spotlight rect into the blur panels, the dim cutout, the rim and the ring. With no
 * rect (a centred card) the first panel blurs the whole viewport; the others and the rim aren't rendered.
 */
function paintSpotlight(n: SpotlightNodes, r: Rect | null, vw: number, vh: number) {
  const place = (el: HTMLElement | null, left: number, top: number, width: number, height: number) => {
    if (el) Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  };
  if (n.dim) n.dim.style.clipPath = holePath(r, vw, vh);
  if (!r) return place(n.panels[0], 0, 0, vw, vh);
  place(n.panels[0], 0, 0, vw, Math.max(0, r.y));
  place(n.panels[1], 0, r.y + r.h, vw, Math.max(0, vh - r.y - r.h));
  place(n.panels[2], 0, r.y, Math.max(0, r.x), r.h);
  place(n.panels[3], r.x + r.w, r.y, Math.max(0, vw - r.x - r.w), r.h);
  place(n.rim, r.x - 3, r.y - 3, r.w + 6, r.h + 6);
  place(n.ring, r.x, r.y, r.w, r.h);
}

/**
 * Glides the spotlight from where it was to `target`. One tween drives the blur panels, the dim
 * cutout and the rim, so they can't drift apart. Snaps when there is nothing to glide from (first
 * step, or to/from a centred card), or under reduced motion. Each frame goes straight to the DOM
 * through the returned nodes: a per-frame setState would re-render the whole tour ~16 times a glide.
 * Those nodes must not get a React `style` for these properties, or a re-render would reset them.
 */
function useGlidingSpotlight(target: Rect | null, reduce: boolean, vw: number, vh: number) {
  const nodes = useRef<SpotlightNodes>({ panels: [], dim: null, rim: null, ring: null });
  // Last painted rect, so a step change mid-glide starts from where the spotlight actually is.
  const shown = useRef<Rect | null>(null);
  const viewport = useRef({ vw, vh });
  useLayoutEffect(() => {
    viewport.current = { vw, vh };
    paintSpotlight(nodes.current, shown.current, vw, vh);
  }, [vw, vh]);
  useLayoutEffect(() => {
    const draw = (r: Rect | null) => {
      shown.current = r;
      paintSpotlight(nodes.current, r, viewport.current.vw, viewport.current.vh);
    };
    const from = shown.current;
    if (reduce || !from || !target) return draw(target);
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = easeSnap(Math.min(1, (now - start) / MOVE_MS));
      const lerp = (a: number, b: number) => a + (b - a) * k;
      draw({ x: lerp(from.x, target.x), y: lerp(from.y, target.y), w: lerp(from.w, target.w), h: lerp(from.h, target.h) });
      if (now - start < MOVE_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduce]);
  return nodes;
}

/** The CSS selectors a step spotlights; undefined for a centred card. */
function selectorsOf(step: TourStep) {
  return step.selector ? [step.selector] : step.target?.map((id) => `[data-tour="${id}"]`);
}

function measure(selectors: string[]): Rect | null {
  const boxes = selectors
    .flatMap((sel) => [...document.querySelectorAll<HTMLElement>(sel)])
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.right));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  return { x: left - PAD, y: top - PAD, w: right - left + PAD * 2, h: bottom - top + PAD * 2 };
}

/** Full-screen rectangle with a rounded hole; evenodd makes the hole transparent. */
function holePath(r: Rect | null, vw: number, vh: number) {
  const outer = `M0 0H${vw}V${vh}H0Z`;
  if (!r) return `path(evenodd, "${outer}")`;
  const k = Math.min(RADIUS, r.w / 2, r.h / 2);
  const { x, y, w, h } = r;
  const hole = `M${x + k} ${y}H${x + w - k}A${k} ${k} 0 0 1 ${x + w} ${y + k}V${y + h - k}A${k} ${k} 0 0 1 ${x + w - k} ${y + h}H${x + k}A${k} ${k} 0 0 1 ${x} ${y + h - k}V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`;
  return `path(evenodd, "${outer} ${hole}")`;
}

/** Card beside the spotlight: right if it fits, else below, above, left, then inside it; clamped to the viewport. */
function placeCard(r: Rect | null, cardH: number, vw: number, vh: number) {
  if (!r) return { left: (vw - CARD_W) / 2, top: Math.max(24, (vh - cardH) / 2) };
  const clampY = (y: number) => Math.min(Math.max(12, y), vh - cardH - 12);
  const clampX = (x: number) => Math.min(Math.max(12, x), vw - CARD_W - 12);
  if (r.x + r.w + GAP + CARD_W <= vw - 12) return { left: r.x + r.w + GAP, top: clampY(r.y) };
  if (r.y + r.h + GAP + cardH <= vh - 12) return { left: clampX(r.x), top: r.y + r.h + GAP };
  if (r.y - GAP - cardH >= 12) return { left: clampX(r.x), top: r.y - GAP - cardH };
  if (r.x - GAP - CARD_W >= 12) return { left: r.x - GAP - CARD_W, top: clampY(r.y) };
  // The target fills the screen (a whole page body): sit inside its bottom-left corner,
  // where list pages usually have empty space.
  return { left: clampX(r.x + 16), top: clampY(r.y + r.h - cardH - 16) };
}

/**
 * What a page tip must leave clear. `hard`: regions marked `data-tip-avoid`, an open DetailPanel (what
 * the person is reading) and the page header's actions; the tip never covers them. `soft`: the controls
 * in the page (list rows, notice actions, tabs), covered only when no spot clears them too. Measured with
 * the target, so a resize re-measures them.
 */
interface Avoid {
  hard: Rect[];
  soft: Rect[];
}

function measureAvoid(): Avoid {
  const rects = (els: Element[]) =>
    els
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0)
      .map((b) => ({ x: b.left, y: b.top, w: b.width, h: b.height }));
  const controls = [...document.querySelectorAll('main :is(a[href], button, input, select, textarea, [tabindex="0"])')];
  return {
    hard: rects([...document.querySelectorAll("[data-tip-avoid]")]),
    soft: rects(controls.filter((el) => !el.closest("[data-tip-avoid]"))),
  };
}

/**
 * A tip's card, like a popover from its trigger: below it, hanging left from its right edge, else slid
 * sideways past a hard region or dropped below whatever is in the way, else above the trigger.
 * Candidates nearest the trigger win; a spot clear of the page's controls beats one that only clears
 * the hard regions. Null when no spot on screen clears the hard regions: a tip is not modal, so it
 * must never sit on what someone is reading.
 */
function placeTip(r: Rect, cardH: number, vw: number, vh: number, { hard, soft }: Avoid) {
  const clampX = (x: number) => Math.min(Math.max(12, x), vw - CARD_W - 12);
  const below = r.y + r.h + GAP;
  const ideal = clampX(r.x + r.w - CARD_W);
  // Sliding sideways only helps past the block-shaped hard regions; list rows span the column, so
  // controls only push the card down.
  const xs = [ideal, clampX(r.x), ...hard.flatMap((a) => [clampX(a.x - 12 - CARD_W), clampX(a.x + a.w + 12)])].sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
  const fit = (avoid: Rect[]) => {
    const tops = [below, ...avoid.map((a) => a.y + a.h + GAP).filter((y) => y > below).sort((a, b) => a - b), r.y - GAP - cardH];
    for (const top of tops) {
      if (top < 12 || top + cardH > vh - 12) continue;
      const left = xs.find((x) => !avoid.some((a) => x < a.x + a.w && a.x < x + CARD_W && top < a.y + a.h && a.y < top + cardH));
      if (left !== undefined) return { left, top };
    }
    return null;
  };
  return fit([...hard, ...soft]) ?? fit(hard);
}

/**
 * `modal` (the tour) blocks the app, blurs and dims it, and rims the target. Non-modal
 * (page tips) draws only the card beside its target, like a popover: any click outside
 * the card or Esc dismisses it and the click still lands, so a tip never stands between
 * someone and the task they opened the page for. It never covers a `data-tip-avoid` region either
 * (see placeTip); when nothing on screen is free, `onNoRoom` lets an unrequested tip step back
 * unseen, and without it (opened from "?") the card takes the usual spot beside its target.
 */
export function Tour({
  steps,
  onClose,
  modal = true,
  onFocusFallback,
  onNoRoom,
}: {
  steps: TourStep[];
  onClose: (finished: boolean) => void;
  modal?: boolean;
  onFocusFallback?: () => void;
  onNoRoom?: () => void;
}) {
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [avoid, setAvoid] = useState<Avoid>({ hard: [], soft: [] });
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [cardH, setCardH] = useState(180);
  const reduce = usePrefersReducedMotion();
  // The card stays hidden until the first step is measured, so it never flies in from the
  // centre; `ready` turns gliding on one frame later, after that first placement has painted.
  const [measured, setMeasured] = useState(false);
  const [ready, setReady] = useState(false);
  // True while a step's target hasn't appeared yet (see FIND_MS); the card hides rather than show
  // the new step's text beside the previous step's spotlight.
  const [searching, setSearching] = useState(false);
  const spot = useGlidingSpotlight(rect, reduce, viewport.w, viewport.h);
  const dir = useRef<1 | -1>(1);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(document.activeElement);
  const step = steps[index];
  const last = index === steps.length - 1;

  // Runs the step's `before` (e.g. switch page) and moves to it. If its target
  // then isn't on screen, the measuring effect keeps going the same way.
  const go = useCallback(
    (to: number, direction: 1 | -1) => {
      if (to < 0) return;
      if (to >= steps.length) return onClose(true);
      dir.current = direction;
      steps[to].before?.();
      setIndex(to);
    },
    [steps, onClose],
  );

  useEffect(() => {
    steps[0].before?.();
    // Only the first step's setup; later steps run theirs in `go`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the current step started looking for its target. A ref, not effect-local, because the
  // effect below reruns whenever `go` changes identity (the host re-renders with a new onClose),
  // and a restart must not move the deadline or a step could search forever.
  const searchFrom = useRef({ index: -1, at: 0 });

  // Measure after `before` has rendered. Card, cutout and blur change together;
  // moving a full-screen blur adds paint work without helping explain the step.
  useLayoutEffect(() => {
    let raf = 0;
    let frames = 0;
    if (searchFrom.current.index !== index) searchFrom.current = { index, at: performance.now() };
    const start = searchFrom.current.at;
    const attempt = () => {
      // Two frames, so the page `before` switched to has rendered.
      if (++frames < 2) return void (raf = requestAnimationFrame(attempt));
      const selectors = selectorsOf(step);
      // A chapter can point at a section below the fold of a scrolling page. Scroll the first target
      // into view instantly, so the measurement below sees where it ends up; "nearest" leaves a
      // target that is already visible where it is.
      if (selectors) document.querySelector(selectors.join(", "))?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const target = selectors ? measure(selectors) : null;
      if (selectors && !target) {
        if (performance.now() - start < FIND_MS) {
          setSearching(true);
          raf = requestAnimationFrame(attempt);
          return;
        }
        setSearching(false);
        return go(index + dir.current, dir.current);
      }
      setSearching(false);
      setRect(target);
      setAvoid(measureAvoid());
      setMeasured(true);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [index, step, go]);

  // Glide only after the first placement has painted; otherwise the card would slide in from 0,0.
  useEffect(() => {
    if (!measured) return;
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, [measured]);

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      const selectors = selectorsOf(step);
      const target = selectors ? measure(selectors) : null;
      setRect(target);
      setAvoid(measureAvoid());
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [step]);

  const tipPos = !modal && rect ? placeTip(rect, cardH, viewport.w, viewport.h, avoid) : undefined;
  const noRoom = tipPos === null && onNoRoom !== undefined;
  const visible = measured && !searching && !noRoom;
  useEffect(() => {
    if (noRoom) onNoRoom?.();
  }, [noRoom, onNoRoom]);
  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
    // A tip doesn't take focus from the page; the tour does, since it blocks everything else.
    // A hidden card can't hold focus, so this also runs when the card first shows.
    if (modal && visible) nextRef.current?.focus();
  }, [index, modal, visible]);

  // Tips: a click anywhere outside the card, or Esc, dismisses; the click still reaches its target.
  useEffect(() => {
    if (modal) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) onClose(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [modal, onClose]);

  // Wait for removal before restoring focus. StrictMode's effect replay leaves the
  // card connected; tips and a last action that already moved focus need no restoration.
  useEffect(() => {
    if (!modal) return;
    const card = cardRef.current;
    const opener = returnFocus.current;
    return () => {
      queueMicrotask(() => {
        if (card?.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body && !card?.contains(active)) return;
        // The body is not an opener: a tour started after a dialog closed may find nothing focused.
        if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected && opener.getClientRects().length) {
          opener.focus({ preventScroll: true });
          if (document.activeElement === opener) return;
        }
        onFocusFallback?.();
      });
    };
  }, [modal, onFocusFallback]);

  const next = () => {
    if (!last) return go(index + 1, 1);
    onClose(true);
    step.action?.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose(false);
    else if (e.key === "ArrowRight") next();
    else if (e.key === "ArrowLeft") go(index - 1, -1);
    else if (e.key === "Tab" && modal) {
      // Keep focus inside the card while the rest of the app is blocked. A tip
      // leaves the page usable, so Tab moves on to the page as usual.
      const buttons = cardRef.current?.querySelectorAll<HTMLElement>("button");
      if (!buttons?.length) return;
      const first = buttons[0];
      const end = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const pos = tipPos ?? placeCard(rect, cardH, viewport.w, viewport.h);
  const glide = ready && !reduce;

  return (
    <div className={cn("fixed inset-0 z-[90]", !modal && "pointer-events-none", modal && "tour-in")} onKeyDown={onKeyDown}>
      {/* Swallows clicks so nothing behind the tour changes while it's explained. */}
      {modal && <div className="absolute inset-0" aria-hidden onClick={() => nextRef.current?.focus()} />}

      {/* Keep blur in rectangular panels outside the target. Animating a cutout
          on a backdrop-filter layer can leave Chromium painting the old hole.
          Panels, dim, rim and ring get their geometry from useGlidingSpotlight, not `style`. */}
      {modal && (rect ? [0, 1, 2, 3] : [0]).map((i) => (
        <div key={i} ref={(el) => void (spot.current.panels[i] = el)} aria-hidden className="pointer-events-none absolute backdrop-blur-[3px]" />
      ))}
      {modal && <div ref={(el) => void (spot.current.dim = el)} aria-hidden className="pointer-events-none absolute inset-0 bg-black/55" />}

      {modal && rect && (
        <>
          {/* Dithered rim around the window: a 3px band kept by a mask, filled with dither dots (CSS, no WebGL). */}
          <div
            ref={(el) => void (spot.current.rim = el)}
            aria-hidden
            className="pointer-events-none absolute rounded-[10px] p-[3px]"
            style={{
              mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
              maskComposite: "exclude",
              WebkitMaskComposite: "xor",
            }}
          >
            <div className="absolute inset-0" style={fillStyle("dotted", { color: "#c4b5fd", cell: 1.5 })} />
          </div>
          <div
            ref={(el) => void (spot.current.ring = el)}
            aria-hidden
            className="pointer-events-none absolute rounded-[8px] ring-1 ring-ring/70"
          />
        </>
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal={modal}
        aria-labelledby={titleId}
        className={cn(
          "pointer-events-auto absolute left-0 top-0 rounded-2xl border border-border-strong bg-popover p-4 text-popover-foreground shadow-[0_16px_48px_rgba(0,0,0,0.55)]",
          !visible && "invisible",
        )}
        style={{
          transform: `translate(${pos.left}px, ${pos.top}px)`,
          width: CARD_W,
          transition: glide ? `transform ${MOVE_MS}ms var(--ease-snap)` : undefined,
        }}
      >
        {/* Inner layer owns the entrance scale so it doesn't fight the positioning transform. */}
        <div className={cn(measured && "tour-card-in")}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
          {steps.length > 1 && (
            <div className="col-start-1 row-start-1 flex items-center gap-2">
              <ol className="flex gap-1" aria-label={`Step ${index + 1} of ${steps.length}`}>
                {steps.map((_, i) => (
                  <li key={i} className={cn("h-1 w-3 rounded-full transition-colors duration-150", i === index ? "bg-foreground" : i < index ? "bg-muted-foreground/60" : "bg-border-strong")} />
                ))}
              </ol>
              <span className="text-xs text-faint" aria-hidden>
                {index + 1} of {steps.length}
              </span>
            </div>
          )}
          <Button variant="ghost" size="icon-sm" className={cn("col-start-2 row-start-1 text-faint", HIT)} aria-label={steps.length > 1 ? "Close tour" : "Close tip"} onClick={() => onClose(false)}>
            <X />
          </Button>
          <h2 key={index} id={titleId} className={cn("tour-step-in text-lg leading-snug font-semibold text-foreground", steps.length > 1 ? "col-span-2 mt-3" : "col-start-1 row-start-1")}>
            {step.title}
          </h2>
        </div>
        <div key={index} className="tour-step-in mt-1.5 text-base leading-relaxed text-pretty text-muted-foreground">
          {step.body}
        </div>
        <div className="mt-4 flex items-center gap-2">
          {steps.length > 1 &&
            (index === 0 ? (
              <Button variant="ghost" size="sm" className={cn("text-muted-foreground", HIT)} onClick={() => onClose(false)}>
                Skip tour
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className={HIT} onClick={() => go(index - 1, -1)}>
                <ArrowLeft />
                Back
              </Button>
            ))}
          <Button ref={nextRef} size="sm" className={cn("ml-auto", HIT)} onClick={next}>
            {last ? (step.action?.label ?? (steps.length > 1 ? "Done" : "Got it")) : "Next"}
            {(!last || step.action) && <ArrowRight />}
          </Button>
        </div>
        </div>
      </div>
    </div>
  );
}
