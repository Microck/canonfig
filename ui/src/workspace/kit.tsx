// Workspace layout components: page headers, dense rows, and detail panels.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { Check, Copy, FileText, Folder, Key, Question, SlidersHorizontal, Sparkle, WarningCircle, Wrench, X, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatedNumber, DitherBlock, Hint, StateBand, goldButton } from "@/shared/shared";
import { PLAIN, profile, type ResourceKind } from "@/shared/data";
import { useSharedState, useWorkspace } from "./store";
import { PAGE_TIPS } from "./page-tips";
import { followLink, holdNavigation } from "./routes";

export const KIND_ICON: Record<ResourceKind, PhosphorIcon> = {
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

/** Renders `backtick` spans in mock data as inline code instead of raw backticks. */
export function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 ? (
          <code key={i} className="font-mono text-xs text-foreground">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * The 44px bar at the top of the content panel: breadcrumb on the left, view actions on the right.
 * Pages with a first-visit tip get a quiet "?" that shows it again; the tip card opens under it.
 * Sizes are explicit px so the bar matches Linear's measured 44px header whatever the rem scale.
 * The 18px left inset lines the crumb up with the toolbar pills and list text below it.
 */
export function PageHeader({ crumbs, actions }: { crumbs: ReactNode[]; actions?: ReactNode }) {
  const ws = useWorkspace();
  const hasTip = PAGE_TIPS[ws.role][ws.view] !== undefined;
  return (
    <header className="flex h-[44px] shrink-0 items-center gap-2 border-b border-border pr-[10px] pl-[18px]">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-base">
        {crumbs.map((c, i) =>
          i === crumbs.length - 1 ? (
            <h1 key={i} className="truncate font-medium text-foreground">
              {c}
            </h1>
          ) : (
            <span key={i} className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span className="truncate">{c}</span>
              <span aria-hidden className="text-faint">
                /
              </span>
            </span>
          ),
        )}
      </nav>
      <div className="ml-auto flex items-center gap-1.5">
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
        {actions}
      </div>
    </header>
  );
}

/** The gold publish action, shown only while the profile has unpublished changes. */
export function PublishButton() {
  const ws = useWorkspace();
  if (ws.pending.length === 0) return null;
  return (
    <Button size="sm" data-tour="publish" className={goldButton} onClick={() => ws.setPublishOpen(true)}>
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
 * 18px in, under the header crumb and the toolbar pill labels. Rows use a width instead of
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
 */
export function ListHead({ cols, minWidth, children }: { cols: string; minWidth?: number; children: ReactNode }) {
  return (
    <div
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
}: {
  cols: string;
  minWidth?: number;
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
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
  if (!onClick) return <div className={base} style={style}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className={cn(base, "outline-none focus-visible:before:bg-raised focus-visible:before:shadow-[inset_2px_0_0_var(--ring)]")}
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
export function GroupRow({ icon: Icon, label, count, hint }: { icon?: PhosphorIcon; label: string; count?: number; hint?: ReactNode }) {
  return (
    <div className={cn("group/band flex h-[36px] items-center gap-2 rounded-lg bg-raised/50 text-base", LIST_INSET)}>
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

/**
 * The right-side panel that opens on row click. It slides in 8px and fades
 * (300ms, still under reduced motion). The left edge resizes it between 320 and 560px,
 * by dragging or with the arrow keys once focused; Escape closes it while focus is inside.
 * Closing it with focus inside returns focus to whatever opened it, usually the list row.
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
  const reduce = useReducedMotion();
  // Remember the opener on mount and hand focus back on unmount, so Close and Escape don't drop
  // keyboard users at the top of the document. Skipped when focus already moved elsewhere,
  // e.g. a click on another row that swaps this panel for the next one.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || !!el?.contains(active);
      if (lost && opener?.isConnected) opener.focus();
    };
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
    <motion.aside
      ref={panel}
      initial={reduce ? false : { opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: SNAP }}
      className="relative flex w-[380px] shrink-0 flex-col border-l border-border bg-panel"
      aria-label="Details"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) onClose();
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
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1 after:w-px hover:after:bg-ring/60 focus-visible:after:w-0.5 focus-visible:after:bg-ring"
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
      <div className="flex h-[44px] shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <h2 className="min-w-0 truncate text-base font-medium">{title}</h2>
        {subtitle && <div className="shrink-0 truncate text-sm text-muted-foreground">{subtitle}</div>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" onClick={onClose} aria-label="Close details">
              <X />
            </Button>
          </TooltipTrigger>
          {/* Radix consumes Escape while this tooltip is open; keep the advertised panel shortcut working. */}
          <TooltipContent onEscapeKeyDown={onClose}>
            Close <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">{footer}</div>}
    </motion.aside>
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
export function Cli({ children, className }: { children: string; className?: string }) {
  const [done, flash] = useCopied();
  return (
    <div className={cn("group flex min-w-0 items-center gap-2 font-mono text-xs text-faint", className)}>
      <span aria-hidden className="select-none">
        $
      </span>
      <span className="truncate text-muted-foreground" title={children}>
        {children}
      </span>
      <button
        type="button"
        aria-label="Copy the CLI equivalent"
        title="Copy the CLI equivalent"
        onClick={async () => {
          if (await copy(children, "Command copied")) flash();
        }}
        className="relative shrink-0 rounded p-0.5 text-faint outline-none before:absolute before:-inset-1.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
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

export function EmptyState({ title, body, action, tone = "muted" }: { title: string; body: ReactNode; action?: ReactNode; tone?: "muted" | "ok" }) {
  return (
    <div className="relative flex flex-col items-center justify-center overflow-hidden px-6 py-16 text-center">
      <DitherBlock tone={tone} edge="bottom" className="absolute inset-x-0 bottom-0 h-24 opacity-60" />
      <h3 className="relative text-base font-medium">{title}</h3>
      <p className="relative mt-1 max-w-xs text-sm text-pretty text-muted-foreground">{body}</p>
      {action && <div className="relative mt-4">{action}</div>}
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
        <span role="img" className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] font-mono text-[10px] font-semibold", c.cls)} aria-label={c.label}>
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
 */
export function Body({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="@container min-w-0 flex-1 overflow-y-auto">
        {children}
      </div>
      {detail}
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
      <div className="max-w-[620px] px-8 pt-8 pb-7">
        <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.01em] text-balance">{title}</h2>
        <p className="mt-2 text-base text-pretty text-muted-foreground">{body}</p>
      </div>
    </section>
  );
}
