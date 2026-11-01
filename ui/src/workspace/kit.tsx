// Workspace layout components: page headers, dense rows, and detail panels.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion, usePresence, useReducedMotion, type Transition } from "motion/react";
import { Check, Copy, FileText, Folder, Key, Question, SlidersHorizontal, Sparkle, WarningCircle, Wrench, X, type IconComponent } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatedNumber, DitherBlock, Hint, StateBand } from "@/shared/shared";
import { PLAIN, profile, type ResourceKind } from "@/shared/data";
import { useSharedState, useWorkspace } from "./store";
import { PAGE_TIPS } from "./page-tips";
import { followLink, holdNavigation } from "./routes";

export const KIND_ICON: Record<ResourceKind, IconComponent> = {
  file: FileText,
  directory: Folder,
  config: SlidersHorizontal,
  skill: Sparkle,
  tool: Wrench,
  credential: Key,
};

/** The motion spec's one curve (index.css `--ease-snap`). */
const SNAP = [0.175, 0.885, 0.32, 1.1] as const;

/** 150ms state change, or nothing at all under reduced motion. */
function useStateTransition(): Transition {
  return useReducedMotion() ? { duration: 0 } : { duration: 0.15, ease: SNAP };
}

/** Wraps a list whose rows come and go; rows already there on mount don't animate. */
export function RowPresence({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

/**
 * A list row that grows in and collapses out (150ms height + opacity). Give it the row's key.
 * Inside an `<ol>`/`<ul>` pass `as="li"` so the animated element is the list item itself.
 */
export function AnimatedRow({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "li" }) {
  const transition = useStateTransition();
  const Row = as === "li" ? motion.li : motion.div;
  return (
    <Row
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={transition}
      // Clip only the height being animated. `hidden` would also cut rows wider than the list and trap sticky cells.
      className={cn("overflow-y-clip", className)}
    >
      {children}
    </Row>
  );
}

/** Plain name for a group: the reserved secrets group reads as what it does. */
export function groupLabel(name: string) {
  return name === "canonfig:secrets" ? PLAIN.secretsGroup : name;
}

/** Follower Groups. Profile → Groups owns the list; every picker and count reads it here, so a new group shows up everywhere. */
export interface Group {
  name: string;
  description?: string;
}

export function useGroups() {
  return useSharedState<Group[]>("groups", profile.groups);
}

/** Copies `text` and resolves true only once the browser confirms the write; a denied or missing clipboard says so. */
export async function copy(text: string, what = "Copied"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast.error("Couldn't copy. Select the text and copy it by hand.");
    return false;
  }
  toast(what, { description: text.length > 64 ? `${text.slice(0, 64)}…` : text });
  return true;
}

/** Swaps a copy icon for a check for 1.5s after a click. */
function useCopied() {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const flash = () => {
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1500);
  };
  return [done, flash] as const;
}

/**
 * Renders `backtick` spans in mock data as inline code instead of raw backticks.
 * The chip (fill, hairline, side margin) keeps the command visibly apart from the
 * prose around it; Manrope's narrow word space alone made "Run gh auth login on" read as one run.
 * Each chip is a button that copies its text in one click, with the same toast as the
 * copy icons; hover brightens its border and the app tooltip says "Copy", with the normal
 * cursor every other button uses. Never render this inside
 * another button or link: a nested button is invalid and would steal the row's click.
 */
export function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 ? (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Copy ${part}`}
                onClick={() => void copy(part, "Command copied")}
                className="mx-0.5 rounded-[4px] border border-border bg-secondary/70 px-1 py-px font-mono text-xs whitespace-nowrap text-foreground transition-colors duration-150 outline-none [box-decoration-break:clone] hover:border-border-strong hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                {part}
              </button>
            </TooltipTrigger>
            <TooltipContent>Copy</TooltipContent>
          </Tooltip>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * The 44px bar at the top of the content panel: page title on the left, view actions on the right.
 * Pages with a first-visit tip get a quiet "?" that shows it again; the tip card opens under it.
 * Sizes are explicit px so the bar matches Linear's measured 44px header whatever the rem scale.
 * The 18px left inset lines the title up with the toolbar pills and list text below it.
 * One rule for every screen: the h1 (last crumb, 15px/600 so it reads above 13px section labels)
 * always starts at the inset, so the title never shifts between routes; parent crumbs follow it
 * as a quiet "in Settings" label on desktop only.
 */
export function PageHeader({ crumbs, actions }: { crumbs: ReactNode[]; actions?: ReactNode }) {
  const ws = useWorkspace();
  const hasTip = PAGE_TIPS[ws.role][ws.view] !== undefined;
  const title = crumbs[crumbs.length - 1];
  const parents = crumbs.slice(0, -1);
  return (
    // Below md: title row, then one right-aligned actions row that wraps instead of clipping, primary
    // (last child) at the right edge. Desktop stays a single 44px row.
    <header className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1.5 pr-[10px] pl-[18px] md:h-[44px] md:flex-nowrap md:py-0">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 title={typeof title === "string" ? title : undefined} className="truncate text-[15px] leading-5 font-semibold text-foreground">
          {title}
        </h1>
        {parents.length > 0 && (
          <span className="hidden shrink-0 text-sm text-muted-foreground md:inline">
            in{" "}
            {parents.map((p, i) => (
              <span key={i}>
                {i > 0 && " / "}
                {p}
              </span>
            ))}
          </span>
        )}
      </div>
      {/* The "?" stays on the title row at every width; only real actions take the mobile second row. */}
      {hasTip && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" data-tour="page-help" className="text-faint" aria-label="How this page works" onClick={() => ws.openTip(ws.view)}>
              <Question />
            </Button>
          </TooltipTrigger>
          <TooltipContent>How this page works</TooltipContent>
        </Tooltip>
      )}
      {/* empty:hidden: an action like PublishButton may render nothing, which must not leave a blank row. */}
      {actions && <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1.5 empty:hidden max-md:basis-full">{actions}</div>}
    </header>
  );
}

/** The gold publish action, shown only while the profile has unpublished changes. */
export function PublishButton() {
  const ws = useWorkspace();
  if (ws.pending.length === 0) return null;
  return (
    <Button size="sm" data-tour="publish" variant="primary" onClick={() => ws.setPublishOpen(true)}>
      Publish revision <AnimatedNumber value={ws.nextSequence} />
    </Button>
  );
}

/**
 * A secondary bar under the header: view tabs on the left, quiet context on the right.
 * No rule under it: the header carries the one separator and the list starts right below.
 */
export function Toolbar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-[44px] shrink-0 items-center gap-[4px] px-[8px]">
      {children}
      <div className="ml-auto flex min-w-0 items-center gap-2 pr-[2px]">{right}</div>
    </div>
  );
}

/** A view pill: 28px, fully round. Inactive pills keep a hairline so they still read as buttons. */
export function ToolbarTab({ active, href, children, count }: { active: boolean; href: string; children: ReactNode; count?: number }) {
  const ws = useWorkspace();
  return (
    <a
      href={href}
      onClick={(event) => followLink(event, ws.navigate)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-[28px] items-center gap-1.5 rounded-full border-[0.5px] px-[10px] text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        active ? "border-transparent bg-raised text-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      {count !== undefined && <AnimatedNumber value={count} className="text-faint tabular-nums" />}
    </a>
  );
}

export function SectionLabel({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-[28px] items-center gap-2", className)}>
      <h2 className="text-base font-medium text-muted-foreground">{children}</h2>
      {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
    </div>
  );
}

/*
 * List geometry, shared by ListHead, ListRow and GroupRow so their columns line up on every page:
 * an 8px margin keeps each rounded fill clear of the panel edge, and 10px padding puts the text
 * 18px in, under the header crumb and the toolbar pill labels. Full-width blocks above a list (intros,
 * notices, the Sync band) use `px-[18px]` so their text starts on that same line. Rows use a width instead of
 * `w-full` because a <button> doesn't stretch to fill its parent, and `w-full` plus a margin overflows.
 */
const LIST_INSET = "mx-[8px] w-[calc(100%-16px)] px-[10px]";

/**
 * A row's hover, selected and focus fill: a 36px band 4px inside the 44px row, like Linear's issue rows,
 * so neighbouring fills keep an 8px gap without a rule between them. It is a ::before behind the
 * content; the row's `isolate` keeps that negative z-index inside the row rather than under the panel.
 * Cells that paint their own background (machines.tsx PINNED) reuse it to draw the same band.
 */
export const ROW_FILL = "before:absolute before:inset-x-0 before:inset-y-[4px] before:-z-10 before:rounded-lg";

/**
 * Column header for a dense list. `cols` is a CSS grid template shared with its rows.
 * `minWidth` keeps the columns from squeezing below it: a narrower page scrolls the list sideways instead.
 * `data-tour` lets a tour chapter spotlight a list: give the head and its rows the same id.
 */
export function ListHead({ cols, minWidth, children, "data-tour": tour }: { cols: string; minWidth?: number; children: ReactNode; "data-tour"?: string }) {
  return (
    <div
      data-tour={tour}
      className={cn("sticky top-0 z-10 grid h-[28px] items-center gap-3 border-b border-border bg-panel text-xs font-medium text-faint", LIST_INSET)}
      style={{ gridTemplateColumns: cols, minWidth }}
    >
      {children}
    </div>
  );
}

export function ListRow({
  cols,
  minWidth,
  selected,
  onClick,
  children,
  className,
  "data-tour": tour,
}: {
  cols: string;
  minWidth?: number;
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  "data-tour"?: string;
}) {
  const style = { gridTemplateColumns: cols, minWidth };
  // No rule between rows: the rounded hover and selected fills separate them, as in Linear's lists.
  const base = cn(
    "relative isolate grid h-[44px] items-center gap-3 text-left text-base",
    LIST_INSET,
    ROW_FILL,
    selected ? "before:bg-raised" : onClick && "hover:before:bg-raised/50",
    className,
  );
  if (!onClick) return <div data-tour={tour} className={base} style={style}>{children}</div>;
  return (
    <button
      data-tour={tour}
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className={cn(base, "outline-none focus-visible:before:bg-raised focus-visible:before:shadow-[inset_2px_0_0_var(--ring),inset_0_0_0_1px_var(--ring)]")}
      style={style}
    >
      {children}
    </button>
  );
}

/**
 * Group header inside a list, e.g. resources of one kind: a faint rounded band, no rule.
 * Its (?) shows on hover or keyboard focus with a fine pointer, so a list of groups doesn't repeat
 * the same mark down the page; touch screens, which can't hover, always show it.
 */
/** `minWidth` should match the list's rows so the band spans the sideways-scrolled list. */
export function GroupRow({ icon: Icon, label, count, hint, minWidth }: { icon?: IconComponent; label: string; count?: number; hint?: ReactNode; minWidth?: number }) {
  return (
    <div className={cn("group/band flex h-[36px] items-center gap-2 rounded-lg bg-raised/50 text-base", LIST_INSET)} style={{ minWidth }}>
      {Icon && <Icon className="size-[14px] text-muted-foreground" />}
      <span className="font-medium text-foreground">{label}</span>
      {count !== undefined && <AnimatedNumber value={count} className="text-faint tabular-nums" />}
      {hint && (
        <Hint label={label} className="pointer-fine:opacity-0 group-hover/band:opacity-100 focus-visible:opacity-100">
          {hint}
        </Hint>
      )}
    </div>
  );
}

/** Detail panel width bounds and keyboard resize step, in pixels. */
const PANEL_MIN = 320;
const PANEL_MAX = 560;
const PANEL_STEP = 16;
/** True between a DetailPanel unmounting and the end of that commit; see DetailPanel's open effect. */
let panelJustClosed = false;

// DetailPanel motion. The panel grows out of the row that opened it: scale from 0.96 with the origin
// on the panel's left edge (or the mobile overlay's centre line) at that row's height, so it visibly
// comes from the row. A row switch only fades the content in, since the frame is already there, and
// closing is quicker than opening. Only transform and opacity move, on the repo's one curve; nothing
// moves under reduced motion. It runs through WAAPI from layout effects, so the first frame is already
// the start pose (no flash) and no React state changes per frame.
const SNAP_CSS = "cubic-bezier(0.175, 0.885, 0.32, 1.1)";

// Where the last press landed. Safari doesn't focus a clicked button, so focus alone can't say which
// row opened the panel; a keyboard open still prefers the focused row (see openPanel).
let pointerY: number | null = null;
document.addEventListener("pointerdown", (e) => (pointerY = e.clientY), true);

/** Scales a fresh panel in from its opener: the focused element outside it, else the last press, else its centre. */
function openPanel(panel: HTMLElement): Animation[] {
  const rect = panel.getBoundingClientRect();
  const opener = document.activeElement;
  let openerY = pointerY;
  if (opener instanceof HTMLElement && opener !== document.body && !panel.contains(opener)) {
    const r = opener.getBoundingClientRect();
    openerY = r.top + r.height / 2;
  }
  const overlay = window.matchMedia("(max-width: 767.98px)").matches;
  panel.style.transformOrigin = `${overlay ? "50%" : "0"} ${(openerY ?? rect.top + rect.height / 2) - rect.top}px`;
  return [panel.animate({ opacity: [0, 1], transform: ["scale(0.96)", "none"] }, { duration: 220, easing: SNAP_CSS })];
}

/** Another row replaced the panel's contents: fade its header, body and footer in. */
function swapPanel(panel: HTMLElement): Animation[] {
  return [...panel.querySelectorAll<HTMLElement>(":scope > [data-panel-part]")].map((part) =>
    part.animate({ opacity: [0, 1] }, { duration: 120, easing: SNAP_CSS, fill: "backwards" }),
  );
}

/**
 * The right-side panel that opens on row click. It scales in from the clicked row, fades its content on a
 * row switch and closes faster than it opens (see the motion notes above). Body's AnimatePresence
 * keeps it mounted while it closes. The left edge resizes it between 320 and 560px,
 * by dragging or with the arrow keys once focused; Escape closes it unless a text field outside it has focus.
 * Closing it with focus inside returns focus to whatever opened it, usually the list row.
 * It opens at 380px, or 440px from a 1600px viewport so key paths and group tags fit. Under 768px
 * there is no room beside the list, so it covers the content area and the resize edge is hidden.
 */
export function DetailPanel({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const separator = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [isPresent, safeToRemove] = usePresence();
  // Open, or swap when another row's panel unmounted in this same commit (pages key the panel by row,
  // so a row change remounts it). React runs every layout cleanup of a commit before its new layout
  // effects, so the outgoing panel can leave a note the incoming one reads. The decision is kept in a ref
  // because StrictMode replays this effect on the same element, after its own cleanup wrote the note.
  const swapped = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    swapped.current ??= panelJustClosed;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const anims = reduce ? [] : (swapped.current ? swapPanel : openPanel)(panel.current!);
    return () => {
      for (const a of anims) a.cancel();
      panelJustClosed = true;
      queueMicrotask(() => (panelJustClosed = false));
    };
  }, []);
  // Close: fade and shrink slightly, then let Body's AnimatePresence unmount the panel. Reopening during
  // the exit brings the panel back present, and the cleanup snaps it back to rest.
  useLayoutEffect(() => {
    if (isPresent) return;
    const anims = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? []
      : [panel.current!.animate({ opacity: [1, 0], transform: ["none", "scale(0.98)"] }, { duration: 120, easing: SNAP_CSS, fill: "forwards" })];
    // `finished` rejects when the cleanup cancels a reopened panel's exit; that panel stays.
    Promise.all(anims.map((a) => a.finished)).then(() => safeToRemove?.(), () => {});
    return () => {
      for (const a of anims) a.cancel();
    };
  }, [isPresent, safeToRemove]);
  // Below md the panel is a full-screen overlay, so it acts as a modal: every sibling of the panel and
  // of each of its ancestors up to <body> goes inert, which keeps Tab, clicks and screen readers
  // inside the panel. Dialogs and toasts portalled to <body> later are new nodes and stay live.
  // At md+ the panel sits beside the list and stays non-modal. Declared before the focus-restore
  // effect so its cleanup runs first: an inert opener can't take focus back.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767.98px)");
    let released: HTMLElement[] = [];
    const release = () => {
      for (const node of released) node.inert = false;
      released = [];
    };
    const apply = () => {
      release();
      if (!mq.matches) return;
      for (let node = panel.current; node && node !== document.body; node = node.parentElement) {
        for (const sib of node.parentElement?.children ?? []) {
          if (sib === node || !(sib instanceof HTMLElement) || sib.inert) continue;
          sib.inert = true;
          released.push(sib);
        }
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      release();
    };
  }, []);
  // Remember the opener on mount and hand focus back on unmount, so Close and Escape don't drop
  // keyboard users at the top of the document. Only when focus was inside the panel: a panel that
  // never held focus (e.g. /follower/sync's default selection at mount, or StrictMode's replay)
  // must not steal it, or the first Tab skips the skip link. Skipped too when focus moved to
  // another row that swaps this panel for the next one. Removing the focused Close button drops
  // focus to <body> without a blur, so `focusInside` still reads true there. Without a live
  // opener focus goes to the selected row, else the page heading.
  // Below md the panel covers the page, so opening it moves focus to its Close button.
  const focusInside = useRef(false);
  useEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    const el = panel.current;
    if (window.matchMedia("(max-width: 767.98px)").matches) el?.querySelector<HTMLElement>("[data-panel-close]")?.focus();
    return () => {
      const now = document.activeElement;
      const lost = !!el?.contains(now) || ((!now || now === document.body) && focusInside.current);
      if (!lost) return;
      if (opener?.isConnected) return opener.focus();
      const fallback = document.querySelector<HTMLElement>('main [aria-current="true"]') ?? document.querySelector<HTMLElement>("main h1");
      if (fallback && !fallback.matches("button, a, [tabindex]")) fallback.tabIndex = -1;
      fallback?.focus();
    };
  }, []);
  // Escape closes the panel wherever focus is (the row that opened it, the bare page, the panel),
  // except in a text field outside the panel, where Escape belongs to the field. Below md the panel
  // is a full-screen overlay, so it closes from anywhere. Handlers that consume Escape (dialogs,
  // menus, tooltips) prevent default first.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const active = document.activeElement;
      const overlay = window.matchMedia("(max-width: 767.98px)").matches;
      const field = active instanceof HTMLElement && active.matches("input, textarea, select, [contenteditable]") && !panel.current?.contains(active);
      if (overlay || !field) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Written straight to the elements so resizing doesn't re-render the panel's contents.
  const resize = (w: number) => {
    const width = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)));
    if (panel.current) panel.current.style.width = `${width}px`;
    separator.current?.setAttribute("aria-valuenow", String(width));
  };
  // aria-valuenow is never rendered from JSX: React would only write it on mount, and the width lives in the DOM.
  // Read the real width before paint; resize() keeps the two in step afterwards.
  useLayoutEffect(() => {
    if (panel.current) separator.current?.setAttribute("aria-valuenow", String(panel.current.offsetWidth));
  }, []);
  // pointerup, pointercancel (the browser took the gesture, e.g. for touch scrolling) and lostpointercapture
  // all end a drag; the width keeps whatever the drag last set.
  const endDrag = () => {
    drag.current = null;
  };
  return (
    <aside
      ref={panel}
      className="relative flex w-[380px] shrink-0 flex-col border-l border-border bg-panel min-[1600px]:w-[440px] max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full! max-md:border-l-0"
      aria-label="Details"
      onFocus={() => (focusInside.current = true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) focusInside.current = false;
      }}
      // Inert content behind leaves only browser chrome past the panel's ends, so wrap Tab inside it.
      onKeyDown={(e) => {
        if (e.key !== "Tab" || !window.matchMedia("(max-width: 767.98px)").matches) return;
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
          (n) => !n.matches(":disabled") && n.getClientRects().length > 0,
        );
        const edge = e.shiftKey ? items[0] : items.at(-1);
        if (!edge || document.activeElement !== edge) return;
        e.preventDefault();
        (e.shiftKey ? items.at(-1) : items[0])?.focus();
      }}
    >
      {/* The panel sits on the right, so moving its left edge left (ArrowLeft) widens it. */}
      <div
        ref={separator}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize details"
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1 after:w-px hover:after:bg-ring/60 focus-visible:after:w-0.5 focus-visible:after:bg-ring max-md:hidden"
        onKeyDown={(e) => {
          const w = panel.current?.offsetWidth ?? 380;
          const next = e.key === "ArrowLeft" ? w + PANEL_STEP : e.key === "ArrowRight" ? w - PANEL_STEP : e.key === "Home" ? PANEL_MIN : e.key === "End" ? PANEL_MAX : null;
          if (next === null) return;
          e.preventDefault();
          resize(next);
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: panel.current?.offsetWidth ?? 380 };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) resize(drag.current.w + drag.current.x - e.clientX);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div data-panel-part className="flex h-[44px] shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <h2 className="min-w-0 truncate text-base font-medium">{title}</h2>
        {subtitle && <div className="shrink-0 truncate text-sm text-muted-foreground">{subtitle}</div>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button data-panel-close variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" onClick={onClose} aria-label="Close details">
              <X />
            </Button>
          </TooltipTrigger>
          {/* Radix consumes (and prevents) Escape while this tooltip is open, so the document listener above skips it; keep the advertised shortcut working here. */}
          <TooltipContent onEscapeKeyDown={onClose}>
            Close <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      <div data-panel-part className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
      {footer && (
        <div data-panel-part className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">
          {footer}
        </div>
      )}
    </aside>
  );
}

/**
 * Asks before in-app navigation discards an unsaved draft. While `dirty`, every in-app link, row, sidebar
 * entry, palette command and Demo switcher change goes through the guard in routes.ts and opens `dialog`
 * instead; Discard changes completes the navigation, Keep editing stays. Browser Back/Forward and reloads
 * are not intercepted. Every form with a saveable draft uses this, so they all ask the same way.
 *
 * Render `dialog` inside the form. `label` finishes "Your edits to … aren't saved". Exits that settle the
 * draft themselves (save, remove, Cancel on a new record) navigate inside `leaveWithoutAsking`.
 */
export function useLeaveGuard(dirty: boolean, label: string) {
  const [leaveRequest, setLeaveRequest] = useState<(() => void) | null>(null);
  // navigate() consults the guard synchronously, so this flag covers exactly the settling exit's own
  // navigation. The guard itself stays registered, so a draft still dirty afterwards keeps asking.
  const bypass = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    return holdNavigation((proceed) => {
      if (bypass.current) return false;
      setLeaveRequest(() => proceed);
      return true;
    });
  }, [dirty]);
  const leaveWithoutAsking = (leave: () => void) => {
    bypass.current = true;
    try {
      leave();
    } finally {
      bypass.current = false;
    }
  };
  const dialog = (
    <Dialog open={leaveRequest !== null} onOpenChange={(o) => !o && setLeaveRequest(null)}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription className="text-base text-pretty">Your edits to {label} aren't saved. Leaving now discards them.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setLeaveRequest(null)}>
            Keep editing
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const proceed = leaveRequest;
              setLeaveRequest(null);
              proceed?.();
            }}
          >
            Discard changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { dialog, leaveWithoutAsking };
}

/**
 * A label above a control, with an optional note or an inline error underneath.
 * A `hint` needs a plain-text label: it names the (?) button for screen readers.
 */
export function Field({
  label,
  htmlFor,
  hint,
  description,
  error,
  children,
  className,
}: ({ label: string; hint?: ReactNode } | { label: ReactNode; hint?: never }) & {
  htmlFor?: string;
  description?: ReactNode;
  /** Shown in place of the description; the caller sets aria-invalid on the control. */
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const noteId = htmlFor ? `${htmlFor}-note` : undefined;
  return (
    <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-1.5", className)}>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={htmlFor} className="text-sm font-medium text-muted-foreground">
          {label}
        </Label>
        {hint && typeof label === "string" && <Hint label={label}>{hint}</Hint>}
      </div>
      {children}
      {error ? (
        <p id={noteId} role="alert" className="flex items-center gap-1.5 text-sm text-bad">
          <WarningCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : (
        description && (
          <p id={noteId} className="text-sm text-pretty text-faint">
            {description}
          </p>
        )
      )}
    </div>
  );
}

/** A quiet CLI equivalent with a copy button. */
// `wrap` breaks long commands across lines (e.g. inside dialogs) instead of truncating them to one line.
// Matching margins reserve the copy target's 40px (44px coarse) hit area without enlarging its icon.
export function Cli({ children, className, wrap = false }: { children: string; className?: string; wrap?: boolean }) {
  const [done, flash] = useCopied();
  return (
    <div className={cn("group flex min-w-0 gap-2 font-mono text-xs text-faint", wrap ? "items-start" : "items-center", className)}>
      <span aria-hidden className="select-none">
        $
      </span>
      <span className={cn("text-muted-foreground", wrap ? "min-w-0 break-all" : "truncate")} title={children}>
        {children}
      </span>
      <button
        type="button"
        aria-label="Copy the CLI equivalent"
        title="Copy the CLI equivalent"
        onClick={async () => {
          if (await copy(children, "Command copied")) flash();
        }}
        className="relative m-3 shrink-0 rounded p-0.5 text-faint outline-none before:absolute before:-inset-3 pointer-coarse:m-3.5 pointer-coarse:before:-inset-3.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {done ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

/** A block of copyable command text, for steps a person runs elsewhere. */
export function CommandBox({ children }: { children: string }) {
  const [done, flash] = useCopied();
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-canvas/60 py-1 pr-1 pl-2.5 font-mono text-sm text-foreground">
      <span className="min-w-0 flex-1 truncate" title={children}>
        {children}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="rounded-[3px]"
        aria-label="Copy"
        onClick={async () => {
          if (await copy(children, "Copied")) flash();
        }}
      >
        {done ? <Check className="text-ok" /> : <Copy />}
      </Button>
    </div>
  );
}

/**
 * The message a list shows when it has nothing in it. It grows into the leftover height of a flex-column
 * parent (Body's column, or a `flex flex-col` card) so its dither sits on that parent's bottom edge.
 * The dither is an in-flow strip under the text, not an absolute layer behind it: a short message (no
 * action) used to leave the 96px strip climbing over the title, and a parent taller than the message left
 * the strip's dense edge floating mid-card.
 */
export function EmptyState({ title, body, action, tone = "muted" }: { title: string; body: ReactNode; action?: ReactNode; tone?: "muted" | "ok" }) {
  return (
    <div className="flex grow flex-col">
      <div className="flex grow flex-col items-center justify-center px-6 pt-16 pb-4 text-center">
        <h3 className="text-base font-medium">{title}</h3>
        <p className="mt-1 max-w-xs text-sm text-pretty text-muted-foreground">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
      <DitherBlock tone={tone} edge="bottom" className="h-24 shrink-0 opacity-60" />
    </div>
  );
}

const CHANGE = {
  added: { letter: "A", label: "Added since the last revision", cls: "text-ok bg-ok/12" },
  modified: { letter: "M", label: "Modified since the last revision", cls: "text-warn bg-warn/12" },
  removed: { letter: "D", label: "Removed since the last revision", cls: "text-bad bg-bad/12" },
} as const;

/** A git-style A/M/D marker for an unpublished change. */
export function ChangeMark({ change }: { change?: keyof typeof CHANGE }) {
  if (!change) return <span className="size-4" />;
  const c = CHANGE[change];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] pt-[0.5px] font-mono text-xs leading-none font-semibold", c.cls)} aria-label={c.label}>
          {c.letter}
        </span>
      </TooltipTrigger>
      <TooltipContent>{c.label}</TooltipContent>
    </Tooltip>
  );
}

/** At most this many group chips; the rest collapse into "+N" so a long first name can't hide that more exist. */
const CHIPS_SHOWN = 2;
/** Names this short stay whole: truncating "gpu" to "g…" saves nothing and hides the name. */
const CHIP_WHOLE = 8;

export function GroupChips({ groups, empty = "All machines" }: { groups: string[]; empty?: string }) {
  if (groups.length === 0) return <span className="truncate text-sm text-faint">{empty}</span>;
  const shown = groups.slice(0, CHIPS_SHOWN);
  const rest = groups.slice(CHIPS_SHOWN);
  const chip = "rounded-[4px] border border-border px-1.5 py-px text-xs text-muted-foreground";
  // Long names shrink (in proportion to their length) and truncate, with the full name in the title; short names and the count never shrink.
  return (
    <span className="flex min-w-0 items-center gap-1">
      {shown.map((g) => (
        <span
          key={g}
          title={groupLabel(g)}
          className={cn(chip, groupLabel(g).length <= CHIP_WHOLE ? "shrink-0" : "min-w-8 truncate", g === "canonfig:secrets" ? "font-sans" : "font-mono")}
        >
          {groupLabel(g)}
        </span>
      ))}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn(chip, "shrink-0 tabular-nums")}>
              +{rest.length}
              <span className="sr-only"> more: {rest.map(groupLabel).join(", ")}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 [overflow-wrap:anywhere]">{groups.map(groupLabel).join(", ")}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/** A key/value line inside the detail panel. */
export function Prop({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_1fr] items-baseline gap-3 py-1 text-base">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  );
}

/**
 * A filled settings card with a hairline between its rows, like Linear's preferences. A class, not a
 * component, so a RadioGroup or an <ol> can be the card itself and keep its own role and children.
 */
export const settingsGroup = "grid gap-0 divide-y divide-border/70 overflow-hidden rounded-xl bg-raised/40";

/** One scalar setting inside `settingsGroup`: title, an optional helper line, and the control or value on the right. */
export function SettingRow({
  title,
  description,
  htmlFor,
  error,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  /** Shown under the description as `${htmlFor}-note`; the caller sets aria-invalid and aria-describedby on the control. */
  error?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[56px] items-center gap-4 px-[16px] py-[10px]">
      <div className="grid min-w-0 flex-1 gap-0.5">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-base font-medium text-foreground">
            {title}
          </Label>
        ) : (
          <span className="text-base font-medium text-foreground">{title}</span>
        )}
        {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
        {error && (
          <p id={htmlFor ? `${htmlFor}-note` : undefined} role="alert" className="flex items-center gap-1.5 text-sm text-bad">
            <WarningCircle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * Page body: a scrolling main column and an optional detail panel.
 * The column is a size container, so page layouts follow its width (narrowed by the panel), not the window's.
 * It is a flex column so a child can `grow` into the leftover height (EmptyState anchors its dither to the
 * bottom that way); `*:shrink-0` keeps every child at its content height, as block flow did, so a tall page
 * scrolls instead of squeezing overflow-hidden children.
 * The detail panel sits in one AnimatePresence slot with a fixed key, so it can play a closing animation
 * when `detail` goes empty, while a row change (pages key their panel by row) stays a plain remount.
 */
export function Body({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="@container flex min-w-0 flex-1 flex-col overflow-y-auto *:shrink-0">
        {children}
      </div>
      <AnimatePresence>{detail ? <Fragment key="detail">{detail}</Fragment> : null}</AnimatePresence>
    </div>
  );
}

/**
 * The machine-state header that opens Overview: a StateBand behind the
 * current state. It drifts slowly while idle and speeds up while `running`
 * (a publish or a Synchronization Run).
 */
export function StateHeader({
  tone,
  running,
  title,
  body,
}: {
  tone: "ok" | "warn" | "act" | "bad" | "muted";
  running?: boolean;
  title: ReactNode;
  body: ReactNode;
}) {
  return (
    <section data-tour="overview-head" className="relative isolate overflow-hidden border-b border-border" aria-live="polite">
      <StateBand tone={tone} mode={running ? "running" : "idle"} className="-z-10" />
      {/* Same inset as the Overview grid below it (px-4, px-8 from a 48rem column), so the text shares the lists' left edge. */}
      <div className="max-w-[620px] px-4 pt-8 pb-7 @3xl:px-8">
        <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.01em] text-balance">{title}</h2>
        <p className="mt-2 text-base text-pretty text-muted-foreground">{body}</p>
      </div>
    </section>
  );
}
