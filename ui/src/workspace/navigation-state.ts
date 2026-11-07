import { useCallback, useEffect, useState } from "react";
import { DEMO } from "@/shared/metadata";
import { workspaceHref, type Navigate, type NavigateOptions, type WorkspaceRoute } from "./routes";
import type { View, Milestone } from "./workspace-types";
import { TransitionError, useStateMachine } from "@/lib/state-machine";

/** localStorage prefix for guidance state; role and item are appended (e.g. `:source:tip:profile`). */
const GUIDE_KEY = "canonfig-ui:guide";

/**
 * Where guidance preferences (seen tour, finished tour chapters, seen tips, hidden Get started) live. A browser can deny
 * localStorage, for example with blocked site data; then they are kept in memory for this page
 * load instead, so a refused preference never stops the workspace from opening. Machine state
 * is unaffected: it is demo state and never stored.
 */
const guidePrefs: { has: (key: string) => boolean; keys: () => string[]; set: (key: string) => void; remove: (key: string) => void } = (() => {
  try {
    const storage = window.localStorage;
    // Reading the property can succeed while writes throw, so probe a write as well.
    const probe = `${GUIDE_KEY}:probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return {
      has: (key) => storage.getItem(key) !== null,
      keys: () => Object.keys(storage),
      set: (key) => storage.setItem(key, "1"),
      remove: (key) => storage.removeItem(key),
    };
  } catch {
    const memory = new Set<string>();
    return {
      has: (key) => memory.has(key),
      keys: () => [...memory],
      set: (key) => void memory.add(key),
      remove: (key) => void memory.delete(key),
    };
  }
})();

const SIMULATED_LOAD_MS = 700;
const loadedPages = new Set<string>();

type GuidanceMode = { kind: "idle" } | { kind: "picker" } | { kind: "closing-picker"; chapter: string } | { kind: "tour"; chapter: string }
  | { kind: "tip"; view: View; origin: "manual" | "automatic" } | { kind: "tip-deferred"; view: View; layoutKey: string };
type GuidanceState = GuidanceMode | { kind: "suspended"; previous: GuidanceMode };
type GuidanceEvent = { kind: "picker"; open: boolean } | { kind: "tour"; chapter: string } | { kind: "tip"; view: View; origin: "manual" | "automatic" }
  | { kind: "defer-tip"; layoutKey: string } | { kind: "close-tour" | "close-tip" | "picker-closed" } | { kind: "availability"; blocked: boolean };
function transitionGuidance(state: GuidanceState, event: GuidanceEvent): GuidanceState {
  if (event.kind === "availability") return event.blocked
    ? state.kind === "suspended" ? state : { kind: "suspended", previous: state }
    : state.kind === "suspended" ? state.previous : state;
  const mode = state.kind === "suspended" ? state.previous : state;
  let next: GuidanceMode;
  if (event.kind === "picker") next = event.open ? { kind: "picker" } : { kind: "idle" };
  else if (event.kind === "tour") next = { kind: mode.kind === "picker" ? "closing-picker" : "tour", chapter: event.chapter };
  else if (event.kind === "picker-closed") {
    if (mode.kind !== "closing-picker") throw new TransitionError("Guidance", mode.kind, event.kind);
    next = { kind: "tour", chapter: mode.chapter };
  }
  else if (event.kind === "defer-tip") {
    if (mode.kind !== "tip" || mode.origin !== "automatic") throw new TransitionError("Guidance", mode.kind, event.kind);
    next = { kind: "tip-deferred", view: mode.view, layoutKey: event.layoutKey };
  } else if (event.kind === "tip") {
    if (mode.kind !== "idle" && mode.kind !== "tip" && mode.kind !== "tip-deferred") throw new TransitionError("Guidance", mode.kind, event.kind);
    next = { kind: "tip", view: event.view, origin: event.origin };
  } else {
    if (mode.kind !== (event.kind === "close-tour" ? "tour" : "tip")) throw new TransitionError("Guidance", mode.kind, event.kind);
    next = { kind: "idle" };
  }
  return state.kind === "suspended" ? { kind: "suspended", previous: next } : next;
}

/** Navigation and guidance preferences shared by both data sources. */
export function useWorkspaceNavigation(route: WorkspaceRoute, navigate: Navigate, scheduled = false) {
  const { role, view, focus, profileTab, machinesMode } = route;
  const go = useCallback((next: View, id?: string, options?: NavigateOptions) => {
    navigate(workspaceHref(role, next, { focus: id }), options);
  }, [role, navigate]);
  const setView = useCallback((next: View) => go(next), [go]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const seenKey = (what: string) => `${GUIDE_KEY}:${role}:${what}`;
  const [tourOffered, setTourOffered] = useState(() => !guidePrefs.has(seenKey("tour")));
  // Taking or declining the tour both settle the offer for good; the tour stays one click away.
  const dismissTourOffer = () => {
    guidePrefs.set(seenKey("tour"));
    setTourOffered(false);
  };
  const guidance = useStateMachine<GuidanceState, GuidanceEvent>(new URLSearchParams(location.search).get("tour") === "1" ? { kind: "tour", chapter: "quick" } : { kind: "idle" }, transitionGuidance);
  const { send: sendGuidance, current: guidanceCurrent } = guidance;
  const mode = guidance.state.kind === "suspended" ? guidance.state.previous : guidance.state;
  const tour = mode.kind === "tour" ? mode.chapter : null;
  const tourPickerOpen = mode.kind === "picker" && guidance.state.kind !== "suspended";
  const activeTip = mode.kind === "tip" ? mode.view : null;
  const guidanceBlocked = guidance.state.kind === "suspended";
  useEffect(() => {
    const check = () => {
      const blocked = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], aside[aria-label="Details"]')]
        .some((element) => !element.closest("[data-guidance]") && element.getAttribute("data-state") !== "closed");
      if (blocked !== (guidanceCurrent.current.kind === "suspended")) sendGuidance({ kind: "availability", blocked });
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
    return () => observer.disconnect();
  }, [sendGuidance, guidanceCurrent]);
  const startTour = (id: string) => {
    dismissTourOffer();
    sendGuidance({ kind: "tour", chapter: id });
  };
  const [finishedTours, setFinishedTours] = useState<ReadonlySet<string>>(
    () => new Set(guidePrefs.keys().filter((k) => k.startsWith(seenKey("chapter:"))).map((k) => k.slice(seenKey("chapter:").length))),
  );
  const closeTour = (finished: boolean) => {
    if (finished && tour) {
      guidePrefs.set(seenKey(`chapter:${tour}`));
      setFinishedTours((prev) => new Set(prev).add(tour));
    }
    sendGuidance({ kind: "close-tour" });
  };
  const tourFinished = (id: string) => finishedTours.has(id);
  // Finding the tour on your own settles the offer the same way taking it does.
  const setTourPickerOpen = (open: boolean) => {
    if (open) dismissTourOffer();
    sendGuidance({ kind: "picker", open });
  };
  // Each page tab is its own fetch (Profile items and groups), so the key includes them; outside Profile and
  // Machines those parts stay at their defaults. A tour, or its picker about to start one, settles the load at
  // once, and pages it opens never start one.
  const pageKey = `${role}:${view}:${profileTab}:${machinesMode}`;
  const guided = tour !== null || tourPickerOpen || mode.kind === "closing-picker";
  const [loadingPage, setLoadingPage] = useState<string | null>(null);
  // Started during render, like the tip reset below, so a page's first frame (the app's first one too) is
  // already its skeleton.
  const [shownPage, setShownPage] = useState<string | null>(null);
  if (shownPage !== pageKey) {
    setShownPage(pageKey);
    setLoadingPage(!DEMO || guided || loadedPages.has(pageKey) ? null : pageKey);
  } else if (guided && loadingPage !== null) {
    loadedPages.add(loadingPage);
    setLoadingPage(null);
  }
  useEffect(() => {
    if (loadingPage === null) return;
    const t = window.setTimeout(() => {
      loadedPages.add(loadingPage);
      setLoadingPage(null);
    }, SIMULATED_LOAD_MS);
    return () => window.clearTimeout(t);
  }, [loadingPage]);
  const [seenTips, setSeenTips] = useState<ReadonlySet<string>>(
    () => new Set(guidePrefs.keys().filter((k) => k.startsWith(seenKey("tip:"))).map((k) => k.slice(seenKey("tip:").length))),
  );
  const openTip = (view: View, origin: "manual" | "automatic" = "manual") => { sendGuidance({ kind: "tip", view, origin }); };
  const closeTip = () => {
    if (activeTip) {
      guidePrefs.set(seenKey(`tip:${activeTip}`));
      setSeenTips((prev) => new Set(prev).add(activeTip));
    }
    sendGuidance({ kind: "close-tip" });
  };
  // A tip explains one page. When the route moves on, including browser Back/Forward, which
  // bypass closeTip, leaving counts as closing it, so the next page never shows the old text.
  // Adjusted during render rather than in an effect so the stale tip never paints; marking it
  // seen is idempotent, so a repeated render does no harm.
  if (activeTip !== null && activeTip !== view) closeTip();
  const tipSeen = (v: View) => seenTips.has(v);
  const [getStartedHidden, setHidden] = useState(() => guidePrefs.has(seenKey("get-started-hidden")));
  const setGetStartedHidden = (hidden: boolean) => {
    if (hidden) guidePrefs.set(seenKey("get-started-hidden"));
    else guidePrefs.remove(seenKey("get-started-hidden"));
    setHidden(hidden);
  };
  // A schedule turned on during onboarding already settles the Get started schedule step.
  const [milestones, setMilestones] = useState<ReadonlySet<Milestone>>(() => new Set<Milestone>(scheduled ? ["schedule"] : []));
  const reach = useCallback((m: Milestone) => setMilestones((prev) => (prev.has(m) ? prev : new Set(prev).add(m))), []);
  return { role, view, focus, profileTab, machinesMode, navigate, go, setView,
    paletteOpen, setPaletteOpen, tourOffered, dismissTourOffer, tour, tourOpen: tour !== null, guidanceBlocked,
    startTour, closeTour, tourPickerOpen, setTourPickerOpen, pendingTour: mode.kind === "closing-picker",
    finishTourSelection: () => { sendGuidance({ kind: "picker-closed" }); }, pageLoading: loadingPage === pageKey,
    tourFinished, activeTip, openTip, closeTip, tipSeen,
    activeTipOrigin: mode.kind === "tip" ? mode.origin : null,
    tipDeferred: mode.kind === "tip-deferred" ? { view: mode.view, layoutKey: mode.layoutKey } : null,
    deferTip: (layoutKey: string) => { sendGuidance({ kind: "defer-tip", layoutKey }); },
    getStartedHidden, setGetStartedHidden, milestones, reach,
  };
}
