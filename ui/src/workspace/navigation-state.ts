import { useCallback, useEffect, useState } from "react";
import { DEMO } from "@/shared/metadata";
import { workspaceHref, type Navigate, type NavigateOptions, type WorkspaceRoute } from "./routes";
import type { View, Milestone } from "./workspace-types";

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
  const [tour, setTour] = useState<string | null>(() => (new URLSearchParams(location.search).get("tour") === "1" ? "quick" : null));
  const startTour = (id: string) => {
    dismissTourOffer();
    setTour(id);
  };
  const [finishedTours, setFinishedTours] = useState<ReadonlySet<string>>(
    () => new Set(guidePrefs.keys().filter((k) => k.startsWith(seenKey("chapter:"))).map((k) => k.slice(seenKey("chapter:").length))),
  );
  const closeTour = (finished: boolean) => {
    if (finished && tour) {
      guidePrefs.set(seenKey(`chapter:${tour}`));
      setFinishedTours((prev) => new Set(prev).add(tour));
    }
    setTour(null);
  };
  const tourFinished = (id: string) => finishedTours.has(id);
  const [tourPickerOpen, setPickerOpen] = useState(false);
  // Finding the tour on your own settles the offer the same way taking it does.
  const setTourPickerOpen = (open: boolean) => {
    if (open) dismissTourOffer();
    setPickerOpen(open);
  };
  // Each page tab is its own fetch (Profile items and groups), so the key includes them; outside Profile and
  // Machines those parts stay at their defaults. A tour, or its picker about to start one, settles the load at
  // once, and pages it opens never start one.
  const pageKey = `${role}:${view}:${profileTab}:${machinesMode}`;
  const guided = tour !== null || tourPickerOpen;
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
  const [activeTip, setActiveTip] = useState<View | null>(null);
  const [seenTips, setSeenTips] = useState<ReadonlySet<string>>(
    () => new Set(guidePrefs.keys().filter((k) => k.startsWith(seenKey("tip:"))).map((k) => k.slice(seenKey("tip:").length))),
  );
  const openTip: (view: View) => void = setActiveTip;
  const closeTip = () => {
    if (activeTip) {
      guidePrefs.set(seenKey(`tip:${activeTip}`));
      setSeenTips((prev) => new Set(prev).add(activeTip));
    }
    setActiveTip(null);
  };
  const withdrawTip = () => setActiveTip(null);
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
    paletteOpen, setPaletteOpen, tourOffered, dismissTourOffer, tour, tourOpen: tour !== null,
    startTour, closeTour, tourPickerOpen, setTourPickerOpen, pageLoading: loadingPage === pageKey,
    tourFinished, activeTip, openTip, closeTip, withdrawTip, tipSeen,
    getStartedHidden, setGetStartedHidden, milestones, reach,
  };
}
