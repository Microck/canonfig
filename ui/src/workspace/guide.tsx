// First-time guidance, split three ways because one long tour is the pattern
// the evidence warns against (Chameleon 2025: tours past 5 steps lose most
// users, self-started tours get ~2x the engagement; NN/g: tutorials shown out
// of context are skipped and forgotten):
//   1. TourOffer/TourHost: a 4-stop tour, offered in a corner card, never forced.
//      Its last stop hands over to the Get started list, so it ends in doing.
//   2. GetStarted: Linear-style "learn by doing" list on Overview; each item
//      ticks itself off from real state, not from clicking a checkbox.
//   3. TipHost: one spotlight the first time a complex page opens (PAGE_TIPS),
//      re-openable from that page's "?" button.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, Signpost, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DitherProgress } from "@/shared/shared";
import { Tour } from "@/tour/tour";
import { PAGE_TIPS } from "./page-tips";
import { tourSteps } from "./tour-steps";
import { useWorkspace, type Workspace } from "./store";

const SNAP = [0.175, 0.885, 0.32, 1.1] as const;

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
        why: "Add the files, settings, skills and tools your machines should share.",
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

/** Embedded on Overview. Hidden for good with its X; ⌘K brings it back. */
export function GetStarted() {
  const ws = useWorkspace();
  if (ws.getStartedHidden) return null;
  const items = getStartedItems(ws);
  const done = items.filter((i) => i.done).length;
  const next = items.find((i) => !i.done);
  const hide = () => {
    ws.setGetStartedHidden(true);
    toast("Get started is hidden", { description: "Bring it back from search (Ctrl K)." });
  };

  // Finished: one quiet line instead of a list of crossed-out steps.
  if (!next)
    return (
      <section data-tour="get-started" aria-label="Get started" className="flex items-center gap-3 border-b border-border px-8 py-3">
        <span aria-hidden className="grid size-5 place-items-center rounded-full bg-ok/15 text-ok">
          <Check weight="bold" className="size-3" />
        </span>
        <p className="text-base">You're set up. Every first step is done.</p>
        <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={hide}>
          Hide
        </Button>
      </section>
    );

  return (
    <section data-tour="get-started" aria-labelledby="get-started-title" className="border-b border-border px-8 pt-5 pb-6">
      <div className="flex items-center gap-3">
        <h2 id="get-started-title" className="text-base font-medium">
          Get started
        </h2>
        <span className="text-sm text-faint">
          {done} of {items.length} done
        </span>
        <DitherProgress value={(done / items.length) * 100} label="Get started progress" className="w-32" />
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-faint"
          aria-label="Hide Get started"
          onClick={hide}
        >
          <X />
        </Button>
      </div>
      <ol className="mt-3 grid gap-px">
        {items.map((item, i) => (
          <li key={item.id} className={cn("flex min-h-10 items-center gap-3 rounded-md px-2 py-1.5", item === next && "bg-raised/60")}>
            <span
              aria-hidden
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full border text-xs",
                item.done ? "border-transparent bg-ok/15 text-ok" : item === next ? "border-foreground/50 text-foreground" : "border-border-strong text-faint",
              )}
            >
              {item.done ? <Check weight="bold" className="size-3" /> : i + 1}
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

/** Corner card that offers the tour once. Not modal: the app stays usable around it. */
export function TourOffer() {
  const ws = useWorkspace();
  const reduce = useReducedMotion();
  const busy = ws.tourOpen || ws.paletteOpen || ws.publishOpen || ws.inviteOpen;
  // A short delay so the offer arrives after the page has settled, not with it.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), 900);
    return () => window.clearTimeout(t);
  }, []);
  const show = ws.tourOffered && ready && !busy;

  return (
    <AnimatePresence>
      {show && (
        <motion.aside
          role="region"
          aria-label="Tour offer"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 8, transition: { duration: 0.15 } }}
          transition={{ duration: 0.3, ease: SNAP }}
          className="fixed right-4 bottom-16 z-[80] w-[300px] rounded-xl border border-border-strong bg-popover p-4 shadow-[0_16px_48px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-muted-foreground">
              <Signpost className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">New to Canonfig?</h2>
              <p className="mt-1 text-sm text-pretty text-muted-foreground">A 4-stop tour of where things are. About a minute.</p>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={ws.dismissTourOffer}>
              Not now
            </Button>
            <Button size="sm" onClick={() => ws.setTourOpen(true)}>
              Show me around
            </Button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** The tour itself; steps are built once, the last one reads live state through a ref. */
export function TourHost() {
  const ws = useWorkspace();
  const live = useRef(ws);
  live.current = ws;
  const [steps] = useState(() => tourSteps(ws, () => live.current));
  const close = () => {
    ws.setTourOpen(false);
    // A Source fresh out of onboarding came to review the proposed tools; the tour passed
    // through Overview, so put them back where they were headed (unless the last stop moved them).
    if (ws.proposed.length > 0 && live.current.view === "overview") ws.setView("profile");
  };
  return <Tour steps={steps} onClose={close} />;
}

/** Opens a page's tip on its first visit, once nothing else is asking for attention. */
export function TipHost() {
  const ws = useWorkspace();
  const role = ws.role === "source" ? "source" : "follower";
  const tip = PAGE_TIPS[role][ws.view];
  const busy = ws.tourOpen || ws.tourOffered || ws.paletteOpen || ws.publishOpen || ws.inviteOpen || ws.changeGroups !== null;
  const { openTip, activeTip, view } = ws;
  const seen = ws.tipSeen(view);

  useEffect(() => {
    if (!tip || busy || activeTip || seen) return;
    // Let the page render and the eye land before pointing at part of it.
    const t = window.setTimeout(() => openTip(view), 700);
    return () => window.clearTimeout(t);
  }, [tip, busy, activeTip, view, seen, openTip]);

  const active = activeTip ? PAGE_TIPS[role][activeTip] : undefined;
  if (!active || ws.tourOpen) return null;
  return <Tour key={activeTip} steps={[active]} onClose={ws.closeTip} modal={false} />;
}
