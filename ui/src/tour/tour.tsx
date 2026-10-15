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
import { ArrowLeft, ArrowRight, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { fillStyle } from "@/lib/dither";
import { Button } from "@/components/ui/button";

export interface TourStep {
  /** `data-tour` ids to spotlight. Omit for a centered card with nothing cut out. */
  target?: string[];
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

function measure(ids: string[]): Rect | null {
  const boxes = ids
    .flatMap((id) => [...document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`)])
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
 * `modal` (the tour) blocks the app, blurs and dims it, and rims the target. Non-modal
 * (page tips) draws only the card beside its target, like a popover: any click outside
 * the card or Esc dismisses it and the click still lands, so a tip never stands between
 * someone and the task they opened the page for.
 */
export function Tour({ steps, onClose, modal = true }: { steps: TourStep[]; onClose: (finished: boolean) => void; modal?: boolean }) {
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [cardH, setCardH] = useState(180);
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

  // Measure after `before` has rendered. Card, cutout and blur change together;
  // moving a full-screen blur adds paint work without helping explain the step.
  useLayoutEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const target = step.target ? measure(step.target) : null;
        if (step.target && !target) return go(index + dir.current, dir.current);
        setRect(target);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [index, step, go]);

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      const target = step.target ? measure(step.target) : null;
      setRect(target);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [step]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
    // A tip doesn't take focus from the page; the tour does, since it blocks everything else.
    if (modal) nextRef.current?.focus();
  }, [index, modal]);

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

  // Give focus back to wherever it was when the tour opened (tips never took it).
  useEffect(() => () => void (modal && (returnFocus.current as HTMLElement | null)?.focus?.()), [modal]);

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

  const pos = placeCard(rect, cardH, viewport.w, viewport.h);

  return (
    <div className={cn("fixed inset-0 z-[90]", !modal && "pointer-events-none")} onKeyDown={onKeyDown}>
      {/* Swallows clicks so nothing behind the tour changes while it's explained. */}
      {modal && <div className="absolute inset-0" aria-hidden onClick={() => nextRef.current?.focus()} />}

      {/* Keep blur in rectangular panels outside the target. Animating a cutout
          on a backdrop-filter layer can leave Chromium painting the old hole. */}
      {modal && (rect ? [
        { left: 0, top: 0, width: viewport.w, height: Math.max(0, rect.y) },
        { left: 0, top: rect.y + rect.h, width: viewport.w, height: Math.max(0, viewport.h - rect.y - rect.h) },
        { left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h },
        { left: rect.x + rect.w, top: rect.y, width: Math.max(0, viewport.w - rect.x - rect.w), height: rect.h },
      ] : [{ left: 0, top: 0, width: viewport.w, height: viewport.h }]).map((panel, i) => (
        <div key={i} aria-hidden className="pointer-events-none absolute backdrop-blur-[3px]" style={panel} />
      ))}
      {modal && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-black/55"
          style={{ clipPath: holePath(rect, viewport.w, viewport.h) }}
        />
      )}

      {modal && rect && (
        <>
          {/* Dithered rim around the window: a 3px band kept by a mask, filled with dither dots (CSS, no WebGL). */}
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-[10px] p-[3px]"
            style={{
              left: rect.x - 3,
              top: rect.y - 3,
              width: rect.w + 6,
              height: rect.h + 6,
              mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
              maskComposite: "exclude",
              WebkitMaskComposite: "xor",
            }}
          >
            <div className="absolute inset-0" style={fillStyle("dotted", { color: "#c4b5fd", cell: 1.5 })} />
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-[8px] ring-1 ring-ring/70"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          />
        </>
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal={modal}
        aria-labelledby={titleId}
        className="pointer-events-auto absolute left-0 top-0 rounded-2xl border border-border-strong bg-popover p-4 text-popover-foreground shadow-[0_16px_48px_rgba(0,0,0,0.55)]"
        style={{ transform: `translate(${pos.left}px, ${pos.top}px)`, width: CARD_W }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
          {steps.length > 1 && (
            <div className="col-start-1 row-start-1 flex items-center gap-2">
              <ol className="flex gap-1" aria-label={`Step ${index + 1} of ${steps.length}`}>
                {steps.map((_, i) => (
                  <li key={i} className={cn("h-1 w-3 rounded-full", i === index ? "bg-foreground" : i < index ? "bg-muted-foreground/60" : "bg-border-strong")} />
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
          <h2 id={titleId} className={cn("text-[15px] leading-snug font-semibold text-foreground", steps.length > 1 ? "col-span-2 mt-3" : "col-start-1 row-start-1")}>
            {step.title}
          </h2>
        </div>
        <div className="mt-1.5 text-base leading-relaxed text-pretty text-muted-foreground">
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
  );
}
