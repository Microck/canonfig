// First-time guidance, split three ways because one long tour is the pattern
// the evidence warns against (Chameleon 2025: tours past 5 steps lose most
// users, self-started tours get ~2x the engagement; NN/g: tutorials shown out
// of context are skipped and forgotten):
//   1. TourOffer/TourHost: a 4-stop tour (2 below md), offered in a corner card, never forced.
//      Its last stop hands over to the Get started list, so it ends in doing.
//      TourPicker ("Take the tour") lists it again with one opt-in chapter per area
//      (tour-steps.tsx), each short enough to stay inside the same benchmark, and
//      previews the selected chapter's route through the sidebar before it starts.
//   2. GetStarted: Linear-style "learn by doing" list on Overview; each item
//      ticks itself off from real state, not from clicking a checkbox.
//   3. TipHost: one spotlight the first time a complex page opens (PAGE_TIPS),
//      re-openable from that page's "?" button.
import { useEffect, useRef, useState, type Ref } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, FoldedMap, Star, X } from "@/components/icons";
import { toast } from "sonner";
import { cn, SNAP } from "@/lib/utils";
import { fillStyle } from "@/lib/dither";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DEMO } from "@/shared/data";
import { DitherBlock, DitherProgress, StatusMark } from "@/shared/shared";
import { Tour, type TourStep } from "@/tour/tour";
import { PAGE_TIPS } from "./page-tips";
import { tourChapters, type TourChapter } from "./tour-steps";
import { useWorkspace, type View, type Workspace } from "./store";
import { NAV, navItem, type NavItem } from "./nav";
import { focusPageHeading } from "./routes";

export interface GetStartedItem {
  id: string;
  label: string;
  why: string;
  done: boolean;
  run: () => void;
}

/** The list for this role, derived from live state so items tick themselves off. */
export function getStartedItems(ws: Workspace): GetStartedItem[] {
  if (ws.role === "source")
    return [
      {
        id: "profile",
        label: "Choose what to sync",
        why: "Add the instructions, skills, MCP servers, settings and tools your machines should share.",
        done: ws.latest > 0 || ws.resources.some((r) => !ws.proposed.includes(r.id)),
        run: () => ws.setView("profile"),
      },
      {
        id: "publish",
        label: "Publish your first revision",
        why: "Nothing reaches another machine until you publish.",
        done: ws.latest > 0,
        run: () => (ws.pending.length > 0 ? ws.setPublishOpen(true) : ws.setView("profile")),
      },
      {
        id: "machine",
        label: "Add a machine",
        why: "Create an invitation, then join from the other machine.",
        done: ws.followers.length > 0 || ws.invitations.length > 0,
        run: () => ws.setInviteOpen(true),
      },
      {
        id: "health",
        label: "Run a health check",
        why: "Confirms this machine can keep serving while you're away.",
        done: ws.milestones.has("health-check"),
        run: () => ws.go("doctor", "run"),
      },
    ];
  return [
    {
      id: "apply",
      label: "Apply the latest revision",
      why: "See what it would change here first; nothing happens until you apply.",
      done: ws.phase === "done",
      run: () => ws.setView("sync"),
    },
    {
      id: "schedule",
      label: "Choose when it updates",
      why: "So this machine stays current without you.",
      done: ws.milestones.has("schedule"),
      run: () => ws.setView("schedule"),
    },
    {
      id: "health",
      label: "Run a health check",
      why: "Confirms updates can run while you're away.",
      done: ws.milestones.has("health-check"),
      run: () => ws.go("doctor", "run"),
    },
  ];
}

/**
 * Embedded as the first block of Overview's main column, so it shares that column's edges. Hidden for good with its X; ⌘K brings it back.
 * `rowInset` is the horizontal padding of that Overview's own rows (Source rows are 4px-inset buttons, Follower rows sit flush):
 * the step rows hang their 8px-padded fill outside the column by the difference, so marks and buttons line up with those rows.
 */
export function GetStarted({ rowInset }: { rowInset: 0 | 4 }) {
  const ws = useWorkspace();
  if (ws.getStartedHidden) return null;
  const items = getStartedItems(ws);
  const done = items.filter((i) => i.done).length;
  const next = items.find((i) => !i.done);
  const hide = () => {
    ws.setGetStartedHidden(true);
    const heading = document.querySelector<HTMLElement>("main h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
    toast("Get started is hidden", { description: "Bring it back from search (Ctrl K)." });
  };

  // Finished: one quiet line instead of a list of crossed-out steps.
  if (!next)
    return (
      <section data-tour="get-started" aria-label="Get started" className="flex items-center gap-3">
        <span aria-hidden className="grid size-5 place-items-center rounded-full bg-ok/15 text-ok">
          <Check className="size-3" />
        </span>
        <p className="text-base">You're set up. Every first step is done.</p>
        <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={hide}>
          Hide
        </Button>
      </section>
    );

  return (
    <section data-tour="get-started" aria-labelledby="get-started-title">
      {/* Narrow headers put progress below the title, clear of dismiss. */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 sm:flex sm:gap-3">
        <h2 id="get-started-title" className="whitespace-nowrap text-base font-medium">
          Get started
        </h2>
        <span className="col-start-1 row-start-2 whitespace-nowrap text-sm text-faint">
          {done} of {items.length} done
        </span>
        <DitherProgress value={(done / items.length) * 100} label="Get started progress" className="col-start-2 row-start-2 w-32 max-w-full" />
        <Button
          variant="ghost"
          size="icon-xs"
          className="col-start-3 row-span-2 row-start-1 ml-auto text-faint"
          aria-label="Hide Get started"
          onClick={hide}
        >
          <X />
        </Button>
      </div>
      <ol className="mt-3 grid gap-px" style={{ marginInline: rowInset - 8 }}>
        {items.map((item, i) => (
          <li key={item.id} className={cn("flex min-h-10 items-center gap-3 rounded-md px-2 py-1.5", item === next && "bg-raised/60")}>
            <span
              aria-hidden
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full border text-xs leading-none tabular-nums",
                item.done ? "border-transparent bg-ok/15 text-ok" : item === next ? "border-foreground/50 text-foreground" : "border-border-strong text-faint",
              )}
            >
              {item.done ? <Check className="size-3" /> : <span className="block -translate-y-px">{i + 1}</span>}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block text-base", item.done ? "text-muted-foreground line-through decoration-faint" : "text-foreground")}>
                {item.label}
                <span className="sr-only">{item.done ? ", done" : ""}</span>
              </span>
              {!item.done && <span className="block text-sm text-muted-foreground">{item.why}</span>}
            </span>
            {!item.done && (
              <Button size="sm" variant={item === next ? "default" : "ghost"} onClick={item.run}>
                {item === next ? "Start" : "Open"}
                {item === next && <ArrowRight />}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * True while a DetailPanel (kit.tsx, `aside[aria-label="Details"]`) is mounted. The panel's open state
 * lives in each screen's local state, not the workspace store, so the DOM is the one shared signal.
 */
function useDetailPanelOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(document.querySelector('aside[aria-label="Details"]') !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return open;
}

/** Corner card that offers the tour once. Not modal: the app stays usable around it. */
export function TourOffer() {
  const ws = useWorkspace();
  const reduce = useReducedMotion();
  const busy = ws.tourOpen || ws.tourPickerOpen || ws.paletteOpen || ws.publishOpen || ws.inviteOpen;
  // A short delay so the offer arrives after the page has settled, not with it.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), 900);
    return () => window.clearTimeout(t);
  }, []);
  const detailOpen = useDetailPanelOpen();
  // The machine map's control row spans the full content width at the bottom, so any
  // corner card covers zoom/fit/reset; the offer waits for a non-map page instead.
  const onMap = ws.view === "machines" && ws.machinesMode === "map";
  const show = ws.tourOffered && ready && !busy && !detailOpen && !onMap;
  const { dismissTourOffer, view } = ws;
  // Toasts live in the same bottom-right corner (App.tsx). While the card is on screen its height
  // plus an 8px gap becomes --toast-lift, so toasts stack above it; removing the card resets the lift.
  // A ResizeObserver also covers the card being display:none on small screens (height 0, no lift).
  const offerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const card = offerRef.current;
    if (!show || !card) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const height = card.offsetHeight;
      root.style.setProperty("--toast-lift", height ? `${height + 8}px` : "0px");
    });
    observer.observe(card);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--toast-lift");
    };
  }, [show]);
  useEffect(() => {
    if (!show) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Hidden mobile offers must not consume Escape on other pages.
      if (view !== "overview" && !window.matchMedia("(min-width: 48rem)").matches) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      dismissTourOffer();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [show, view, dismissTourOffer]);

  return (
    <AnimatePresence>
      {show && (
        <motion.aside
          ref={offerRef}
          role="region"
          aria-label="Tour offer"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 8, transition: { duration: 0.15 } }}
          transition={{ duration: 0.2, ease: SNAP }}
          // Pinned to the main panel's bottom-right corner (main uses an 8px m-2 inset); mobile offers appear only on Overview.
          // Stay below detail panels, the demo switcher, and dialogs; hide while Details is open.
          className={cn(
            "fixed right-2 bottom-2 z-30 w-[280px] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border-strong bg-popover shadow-[0_16px_48px_rgba(0,0,0,0.55)]",
            view !== "overview" && "max-md:hidden",
          )}
        >
          {/* Purple (the focus-ring violet) keeps gold for the page's own primary action. */}
          <div className="relative h-20 border-b border-border bg-panel">
            <DitherBlock tone="purple" edge="bottom" className="absolute inset-0" />
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss tour offer" onClick={ws.dismissTourOffer} className="absolute top-2 right-2 bg-popover/70">
              <X />
            </Button>
          </div>
          <div className="p-4 max-md:p-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <FoldedMap className="size-4 text-dither-purple" />
              Find your way around
            </h2>
            <p className="mt-1 text-sm text-pretty text-muted-foreground">A one-minute quick tour, plus a chapter for each area.</p>
            {/* Opens the same picker as the sidebar's Take the tour, with the quick tour selected while it isn't done,
                so the chapters are discoverable from the first offer, not only the quick tour. */}
            <Button size="sm" variant="secondary" className="mt-3 w-full" onClick={() => ws.setTourPickerOpen(true)}>
              Take the tour <ArrowRight />
            </Button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

const REPOSITORY_URL = "https://github.com/Microck/canonfig";
// Two keys, like T3 Code's star prompt, so a time count written by another tab can never undo a dismissal.
const STAR_USED_KEY = "canonfig-ui:star:used-ms";
const STAR_DISMISSED_KEY = "canonfig-ui:star:dismissed";
/** Time with the workspace on screen before asking for a star. */
const STAR_AFTER_MS = 15 * 60_000;
/** How often visible time is added to the stored total; a closed tab loses at most this much. */
const STAR_TICK_MS = 30_000;
// Once per page load at most, even if the toast is closed without saving the dismissal.
let starAskedThisLoad = false;

function dismissStarPrompt() {
  try {
    localStorage.setItem(STAR_DISMISSED_KEY, "1");
  } catch {
    // Nothing to keep it in; starAskedThisLoad still stops a second ask on this page load.
  }
}

/** Stored visible time in ms, or null once dismissed. Throws when storage is unusable. */
function starTimeSoFar(): number | null {
  if (localStorage.getItem(STAR_DISMISSED_KEY) !== null) return null;
  return Number(localStorage.getItem(STAR_USED_KEY)) || 0;
}

/**
 * Asks for a GitHub star once someone has had the workspace on screen for STAR_AFTER_MS in
 * total, across visits. Only time with the tab visible and focused counts. Every way of closing the toast
 * saves the dismissal, so it is asked for at most once per page load until then and never after.
 * Storage that can't be read or written could not keep a dismissal, so it then never asks.
 * It waits while other guidance (tour, tour offer, page tip) or a dialog has the person's
 * attention. In the demo, `?star=1` asks straight away to preview it.
 */
export function StarPrompt() {
  const ws = useWorkspace();
  const busy = ws.tourOpen || ws.tourPickerOpen || ws.tourOffered || ws.activeTip !== null || ws.paletteOpen || ws.publishOpen || ws.inviteOpen;
  // "off": dismissed, or storage unusable. "counting": still adding up visible time. "due": ask.
  const [stage, setStage] = useState<"off" | "counting" | "due">(() => {
    if (DEMO && new URLSearchParams(location.search).get("star") === "1") return "due";
    try {
      const used = starTimeSoFar();
      if (used === null) return "off";
      return used >= STAR_AFTER_MS ? "due" : "counting";
    } catch {
      return "off";
    }
  });
  const due = stage === "due";
  useEffect(() => {
    if (stage !== "counting") return;
    const timer = window.setInterval(() => {
      // Only the focused tab counts, so two open tabs never add the same minute twice.
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      try {
        // Re-read every tick: other open tabs add to the same total, and may have dismissed it.
        const before = starTimeSoFar();
        if (before === null) return setStage("off");
        const used = before + STAR_TICK_MS;
        localStorage.setItem(STAR_USED_KEY, String(used));
        if (used >= STAR_AFTER_MS) setStage("due");
      } catch {
        setStage("off");
      }
    }, STAR_TICK_MS);
    return () => window.clearInterval(timer);
  }, [stage]);
  useEffect(() => {
    if (!due || busy || starAskedThisLoad) return;
    // Arrive after the page settles, not with it.
    const t = window.setTimeout(() => {
      starAskedThisLoad = true;
      toast("Enjoying Canonfig?", {
        description: "A star on GitHub helps other people find it.",
        icon: <Star bold className="size-4 text-warn" />,
        duration: Infinity,
        // Buttons drop to their own row, right-aligned, so the description keeps the toast's width.
        // Sonner's stylesheet sets flex: 1 1 0% on the content, so the basis needs !important.
        classNames: { toast: "flex-wrap", content: "basis-[calc(100%-30px)]!", icon: "self-start mt-0.5", cancelButton: "ml-auto", actionButton: "ml-2!" },
        // Sonner runs neither onDismiss nor onAutoClose for its action and cancel buttons, so each saves the dismissal too.
        action: {
          label: "Star on GitHub",
          onClick: () => {
            dismissStarPrompt();
            window.open(REPOSITORY_URL, "_blank", "noopener,noreferrer");
          },
        },
        cancel: { label: "Dismiss", onClick: dismissStarPrompt },
        onDismiss: dismissStarPrompt,
      });
    }, 1500);
    return () => window.clearTimeout(t);
  }, [due, busy]);
  return null;
}

/**
 * Below md the sidebar lives in the menu sheet, so the machine and nav stops have no
 * visible target and the tour would skip straight to its last stop. Fold them into one
 * stop on the mobile top bar (machine name + menu button), listing what the menu holds.
 * Opening the sheet instead would fight the tour for focus and the click blocker.
 */
function narrowSteps(steps: TourStep[]): TourStep[] {
  if (window.matchMedia("(min-width: 48rem)").matches) return steps;
  const sidebar = steps.filter((s) => s.target?.some((id) => id === "machine" || id.startsWith("nav-")));
  const [machineStop, ...navStops] = sidebar;
  if (!machineStop) return steps;
  const topBar: TourStep = {
    selector: 'div:has(> button[aria-label="Open navigation"])',
    title: machineStop.title,
    body: (
      <>
        {machineStop.body}
        <span className="mt-2 block">The menu button opens every page, including:</span>
        {navStops.map((s) => (
          <span key={s.title} className="mt-1 block">
            <span className="font-medium text-foreground">{s.title}.</span> {s.body}
          </span>
        ))}
      </>
    ),
  };
  return [topBar, ...steps.filter((s) => !sidebar.includes(s))];
}

/** The picker's entries with each tour's sidebar stops folded for narrow screens; only the short tour has any. */
function chaptersFor(ws: Workspace, live: () => Workspace) {
  return tourChapters(ws, live).map((chapter) => ({ ...chapter, steps: narrowSteps(chapter.steps) }));
}

/**
 * The running tour. WorkspaceApp keys it by tour id, so "Next chapter" mounts a fresh one; steps
 * are built once per tour, and the short tour's last stop reads live state through a ref.
 */
export function TourHost() {
  const ws = useWorkspace();
  const live = useRef(ws);
  live.current = ws;
  // `tour` only ever holds an id from this role's list: the picker, the offer and ?tour=1 ("quick").
  const [chapter] = useState(() => chaptersFor(ws, () => live.current).find((c) => c.id === ws.tour)!);
  const close = (finished: boolean) => {
    ws.closeTour(finished);
    // A Source fresh out of onboarding came to review the proposed tools; the short tour passed
    // through Overview, so put them back where they were headed (unless the last stop moved them).
    if (chapter.id === "quick" && ws.proposed.length > 0 && live.current.view === "overview") ws.setView("profile");
  };
  return <Tour steps={chapter.steps} onClose={close} onFocusFallback={focusPageHeading} />;
}

/**
 * "Take the tour": the short tour, then one chapter per area. The list marks each chapter done,
 * next or not started; the preview beside it shows the selected chapter's route through a small
 * copy of the sidebar, and its steps. Finished chapters stay re-runnable.
 */
export function TourPicker() {
  const ws = useWorkspace();
  const chosen = useRef<string | null>(null);
  return (
    <Dialog open={ws.tourPickerOpen} onOpenChange={ws.setTourPickerOpen}>
      {/*
        Radix focuses the first tabbable control on open: the selected chapter, the list's one tab stop.
        Below md the preview sits under the list and changes height with the selected chapter, so the
        dialog hangs from the top there: centred, it would re-centre and slide the list under the pointer.
      */}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-md md:max-w-4xl max-md:top-4 max-md:translate-y-0"
        onCloseAutoFocus={() => {
          // Start only after the dialog is gone and Radix has handed focus back to the opener,
          // so the tour returns focus there when it ends and never fights this dialog's focus trap.
          const id = chosen.current;
          chosen.current = null;
          if (id) requestAnimationFrame(() => ws.startTour(id));
        }}
      >
        <DialogHeader>
          <DialogTitle>Take the tour</DialogTitle>
          <DialogDescription className="text-base text-pretty">Choose a chapter to see where it goes, then start it.</DialogDescription>
        </DialogHeader>
        <ChapterPicker
          onChoose={(id) => {
            chosen.current = id;
            ws.setTourPickerOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inside DialogContent, so the steps are only built while the picker is mounted. The next chapter
 * starts selected, or the short tour once every chapter is done.
 *
 * Hover (mouse only), focus and the arrow keys select a chapter and the preview follows. Enter, the
 * gold button, a mouse click or a tap on the selected chapter starts it. A mouse user has seen the
 * preview on hover, so a click starts at once, even when the picker opened under a resting pointer
 * that never hovered. A tap on an unselected chapter only selects it, so touch users see the preview
 * first. The selected chapter is the list's one tab stop, so Tab goes straight from the list to the
 * button.
 */
export function ChapterPicker({ onChoose }: { onChoose: (id: string) => void }) {
  const ws = useWorkspace();
  const chapters = chaptersFor(ws, () => ws);
  const nextId = chapters.find((chapter) => !ws.tourFinished(chapter.id))?.id;
  const doneCount = chapters.filter((chapter) => ws.tourFinished(chapter.id)).length;
  const [selectedId, select] = useState(nextId ?? chapters[0].id);
  // Whether the press should start its chapter: always for a mouse, otherwise only when the chapter
  // was already selected at pointerdown, since focus selects it before click runs.
  const armed = useRef<string | null>(null);
  const preview = useRef<HTMLElement>(null);
  const active = chapters.find((chapter) => chapter.id === selectedId)!;
  return (
    <>
      <div className="flex items-center gap-3">
        <DitherProgress value={(doneCount / chapters.length) * 100} label="Chapters done" className="flex-1" />
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {doneCount} of {chapters.length} done
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <ul className="grid content-start gap-px">
          {chapters.map((chapter, i) => {
            const done = ws.tourFinished(chapter.id);
            const next = chapter.id === nextId;
            const isActive = chapter.id === active.id;
            return (
              <li key={chapter.id}>
                <button
                  type="button"
                  data-chapter={chapter.id}
                  tabIndex={isActive ? 0 : -1}
                  onFocus={() => select(chapter.id)}
                  onPointerEnter={(event) => {
                    if (event.pointerType === "mouse") select(chapter.id);
                  }}
                  onPointerDown={(event) => {
                    armed.current = event.pointerType === "mouse" || isActive ? chapter.id : null;
                  }}
                  onClick={(event) => {
                    // detail 0: Enter or Space, which always start.
                    if (event.detail === 0 || armed.current === chapter.id) {
                      onChoose(chapter.id);
                      return;
                    }
                    select(chapter.id);
                    // Below md the preview sits under the list.
                    requestAnimationFrame(() => preview.current?.scrollIntoView({ block: "nearest" }));
                  }}
                  onKeyDown={(event) => {
                    const moves: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: chapters.length - 1 };
                    const to = moves[event.key];
                    if (to === undefined) return;
                    event.preventDefault();
                    // Focusing a chapter selects it.
                    event.currentTarget.closest("ul")!.querySelectorAll("button")[Math.min(Math.max(to, 0), chapters.length - 1)].focus();
                  }}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    isActive && "bg-raised",
                  )}
                >
                  <ChapterMark done={done} next={next} />
                  <span className="min-w-0 flex-1 font-medium">
                    {chapter.title}
                    <span className="sr-only">
                      {done ? ", done" : next ? ", next" : ""}, {chapter.steps.length} steps
                    </span>
                  </span>
                  {next && (
                    <span aria-hidden className="text-xs text-dither-purple">
                      Next
                    </span>
                  )}
                  <span aria-hidden className="w-[2ch] text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {chapter.steps.length}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <ChapterPreview ref={preview} chapter={active} done={ws.tourFinished(active.id)} onChoose={onChoose} />
      </div>
    </>
  );
}

/** Done is the status tick, next a violet radio (the tour's colour since the offer card), the rest an empty ring. */
function ChapterMark({ done, next }: { done: boolean; next: boolean }) {
  if (done) return <StatusMark kind="ok" />;
  if (!next) return <StatusMark kind="off" />;
  return (
    <span aria-hidden className="grid size-[14px] shrink-0 place-items-center rounded-full border-[1.5px] border-dither-purple">
      <span className="size-1.5 rounded-full bg-dither-purple" />
    </span>
  );
}

/**
 * The selected chapter: its route through a copy of the sidebar (from md up) or a numbered row of
 * pages (below md), what it covers, its steps and the one button that starts it.
 */
function ChapterPreview({ chapter, done, onChoose, ref }: { chapter: TourChapter; done: boolean; onChoose: (id: string) => void; ref: Ref<HTMLElement> }) {
  const role = useWorkspace().role;
  const nav = NAV[role];
  const route = chapter.pages.map((view) => navItem(role, view)!);
  return (
    <section ref={ref} aria-label={`Preview: ${chapter.title}`} className="grid overflow-hidden rounded-lg border border-border bg-panel md:grid-cols-[12rem_minmax(0,1fr)]">
      <RouteSidebar main={nav.main} settings={nav.settings} pages={chapter.pages} />
      <div className="flex min-w-0 flex-col items-start gap-4 p-4 md:p-5">
        <div>
          <h3 className="text-lg font-semibold">{chapter.title}</h3>
          <p className="text-pretty text-muted-foreground">{chapter.summary}</p>
        </div>
        <p className="sr-only">Goes to {route.map((page) => page.label).join(", ")}.</p>
        <RouteRow route={route} />
        <ol className="grid gap-1.5">
          {chapter.steps.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="font-mono text-muted-foreground tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              {step.title}
            </li>
          ))}
        </ol>
        <Button variant="primary" size="lg" className="mt-auto max-md:w-full" onClick={() => onChoose(chapter.id)}>
          {done ? "Replay" : "Start"} {chapter.title} <ArrowRight />
        </Button>
      </div>
    </section>
  );
}

/** The dotted violet line that joins a route's pages in visit order, in the sidebar copy and the phone row alike. */
const ROUTE_LINE = { stroke: "var(--dither-color-purple)", strokeWidth: 1.5, strokeDasharray: "0.1 3.5", strokeLinecap: "round" } as const;

/** A lit page: violet dither thinning away from the icon, sparse enough to keep its label legible. Static, so it never repaints. */
const LIT = fillStyle("gradient", { color: "purple", edge: "left", length: 80, from: 0.6, to: 0.04, cell: 1.5 });

/** A page's place in the route. The fill hides the route line where it passes under the badge. */
function RouteBadge({ n, className }: { n: number; className?: string }) {
  return <span className={cn("grid size-[18px] shrink-0 place-items-center rounded-full border border-dither-purple font-mono text-xs text-dither-purple", className)}>{n}</span>;
}

// RouteSidebar's geometry, which its route line is drawn from: p-1.5 padding, h-7 rows and the h-6 Settings label.
const NAV_PAD = 6;
const NAV_ROW = 28;
const NAV_LABEL = 24;

/**
 * A copy of the role's sidebar with the chapter's pages lit and numbered in visit order, joined by
 * a dotted line that bows out to the right between badges. From md up; RouteRow takes over below.
 */
function RouteSidebar({ main, settings, pages }: { main: NavItem[]; settings: NavItem[]; pages: View[] }) {
  const rowY = (view: View) => {
    const inMain = main.findIndex((item) => item.view === view);
    const row = inMain >= 0 ? inMain : main.length + settings.findIndex((item) => item.view === view);
    return NAV_PAD + row * NAV_ROW + (inMain >= 0 ? 0 : NAV_LABEL) + NAV_ROW / 2;
  };
  const ys = pages.map(rowY);
  // Badges centre 23px in from the right edge (6px padding, 8px row padding, half the 18px badge):
  // x 25 in this 48px-wide svg. Legs alternate how far they bow, so legs that overlap stay apart.
  const x = 25;
  const d = ys
    .slice(1)
    .map((y, i) => {
      const bow = x + 12 + (i % 2) * 8;
      return `M${x} ${ys[i]} C${bow} ${ys[i]} ${bow} ${y} ${x} ${y}`;
    })
    .join(" ");
  const row = (item: NavItem) => {
    const order = pages.indexOf(item.view);
    const lit = order >= 0;
    const Icon = item.icon;
    return (
      <li key={item.view} className={cn("relative flex h-7 items-center gap-2 rounded-md px-2 text-xs", lit ? "font-medium text-foreground" : "text-muted-foreground")}>
        {lit && <span className="absolute inset-0 rounded-md opacity-50" style={LIT} />}
        <Icon className="relative size-3.5 shrink-0" bold={lit} />
        <span className="relative min-w-0 flex-1 truncate">{item.label}</span>
        {lit && <RouteBadge n={order + 1} className="relative bg-sidebar" />}
      </li>
    );
  };
  return (
    <div aria-hidden className="relative border-r border-border bg-sidebar p-1.5 max-md:hidden">
      {d && (
        <svg className="pointer-events-none absolute top-0 right-0 h-full w-12" fill="none">
          <path d={d} {...ROUTE_LINE} />
        </svg>
      )}
      <ul className="relative">{main.map(row)}</ul>
      <p className="relative flex h-6 items-end px-2 pb-1 text-xs text-muted-foreground">Settings</p>
      <ul className="relative">{settings.map(row)}</ul>
    </div>
  );
}

/** Below md the sidebar copy would outgrow the screen, so the route reads as a row of numbered pages. */
function RouteRow({ route }: { route: NavItem[] }) {
  return (
    <ol aria-hidden className="flex flex-wrap items-center gap-y-2 text-xs md:hidden">
      {route.map(({ view, label }, i) => (
        <li key={view} className="flex items-center">
          {i > 0 && (
            <svg className="mx-1.5 h-0.5 w-4" fill="none">
              <path d="M1 1H15" {...ROUTE_LINE} />
            </svg>
          )}
          <RouteBadge n={i + 1} />
          <span className="ml-1.5">{label}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Opens a page's tip on its first visit, once nothing else is asking for attention. A tip it opened
 * itself that finds no free spot (Tour's onNoRoom, e.g. a full-screen detail panel on a phone) is
 * withdrawn unseen and retried only when the page or the detail panel's presence changes, so it
 * never loops; the "?" still opens it on demand.
 */
export function TipHost() {
  const ws = useWorkspace();
  const role = ws.role === "source" ? "source" : "follower";
  const tip = PAGE_TIPS[role][ws.view];
  // A loading page is busy too: the tip measures its targets, so it waits for the content, and its own
  // delay below then covers skullet's reveal.
  const busy = ws.pageLoading || ws.tourOpen || ws.tourPickerOpen || ws.tourOffered || ws.paletteOpen || ws.publishOpen || ws.inviteOpen || ws.changeGroups !== null;
  const { openTip, withdrawTip, activeTip, view } = ws;
  const seen = ws.tipSeen(view);
  const detailOpen = useDetailPanelOpen();
  // The tip this host opened, as opposed to one asked for from "?"; cleared once it closes.
  const [autoTip, setAutoTip] = useState<View | null>(null);
  if (autoTip !== null && autoTip !== activeTip) setAutoTip(null);
  const [deferred, setDeferred] = useState<{ view: View; detailOpen: boolean } | null>(null);
  const waiting = deferred?.view === view && deferred.detailOpen === detailOpen;

  useEffect(() => {
    if (!tip || busy || activeTip || seen || waiting) return;
    // Let the page render and the eye land before pointing at part of it.
    const t = window.setTimeout(() => {
      setAutoTip(view);
      openTip(view);
    }, 700);
    return () => window.clearTimeout(t);
  }, [tip, busy, activeTip, view, seen, waiting, openTip]);

  const active = activeTip ? PAGE_TIPS[role][activeTip] : undefined;
  if (!active || ws.tourOpen) return null;
  const onNoRoom =
    autoTip === activeTip
      ? () => {
          setDeferred({ view, detailOpen });
          withdrawTip();
        }
      : undefined;
  return <Tour key={activeTip} steps={[active]} onClose={ws.closeTip} modal={false} onNoRoom={onNoRoom} />;
}
