import { useMemo, useSyncExternalStore, type MouseEvent } from "react";
import type { Role } from "@/shared/metadata";
import type { FollowerView, SourceView, View } from "./store";

export type WorkspaceRole = Role;
/** Profile tabs: the folder's items, its harness list, Follower Groups, and the profile's name, schedule and local policy. */
export type ProfileTab = "items" | "harnesses" | "groups" | "defaults";
const PROFILE_TABS: Exclude<ProfileTab, "items">[] = ["harnesses", "groups", "defaults"];
export type MachinesMode = "map" | "list";

// Vite sets /demo/ for the public build and / for the installed GUI and dev server.
const APP_BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");

const SOURCE_PATHS: Record<SourceView, string> = {
  overview: "overview",
  profile: "profile",
  machines: "machines",
  revisions: "revisions",
  sync: "sync",
  local: "local-settings",
  backups: "backups",
  secrets: "secrets",
  service: "settings/service",
  installers: "settings/installers",
  setup: "settings/setup",
  doctor: "settings/health",
  version: "settings/version",
};

const FOLLOWER_PATHS: Record<FollowerView, string> = {
  overview: "overview",
  machines: "machines",
  sync: "sync",
  schedule: "schedule",
  local: "local-settings",
  backups: "backups",
  secrets: "secrets",
  tunnel: "settings/tunnel",
  agent: "settings/agent",
  installers: "settings/installers",
  setup: "settings/setup",
  doctor: "settings/health",
  machine: "settings/enrollment",
  version: "settings/version",
};

const PATHS: Record<WorkspaceRole, Partial<Record<View, string>>> = {
  source: SOURCE_PATHS, follower: FOLLOWER_PATHS, unconfigured: { sync: "sync", backups: "backups" },
};

export interface WorkspaceRoute {
  kind: "workspace";
  role: WorkspaceRole;
  view: View;
  profileTab: ProfileTab;
  machinesMode: MachinesMode;
  focus: string | null;
}

export type AppRoute = WorkspaceRoute | { kind: "setup" } | { kind: "not-found" };
export interface NavigateOptions { replace?: boolean }
export type Navigate = (href: string, options?: NavigateOptions) => void;

export function workspaceHref(role: WorkspaceRole, view: View, options: {
  focus?: string | null;
  profileTab?: ProfileTab;
  machinesMode?: MachinesMode;
} = {}): string {
  const paths = PATHS[role];
  const segment = paths[view];
  if (!segment) throw new Error(`No ${role} route for ${view}`);
  let path = `${APP_BASE}/${role === "unconfigured" ? "local" : role}/${segment}`;
  if (view === "profile" && options.profileTab && options.profileTab !== "items") path += `/${options.profileTab}`;
  if (view === "machines" && options.machinesMode === "list") path += "/list";
  if (options.focus != null) path += `?${new URLSearchParams({ focus: options.focus })}`;
  return path;
}

export function roleHref(role: Role): string {
  return role === "unconfigured" ? `${APP_BASE}/setup` : workspaceHref(role, "overview");
}

export function parseRoute(href: string): AppRoute {
  const url = new URL(href, "http://canonfig.local");
  if (!url.pathname.startsWith(`${APP_BASE}/`)) return { kind: "not-found" };
  const pathname = url.pathname.slice(APP_BASE.length);
  if (pathname === "/setup") return { kind: "setup" };
  const [, prefix, ...parts] = pathname.split("/");
  if (prefix !== "source" && prefix !== "follower" && prefix !== "local") return { kind: "not-found" };
  const role = prefix === "local" ? "unconfigured" : prefix;
  const segment = parts.join("/");
  const paths = PATHS[role];
  let view = (Object.keys(paths) as View[]).find((key) => paths[key] === segment);
  let profileTab: ProfileTab = "items";
  let machinesMode: MachinesMode = "map";
  const tab = PROFILE_TABS.find((t) => segment === `profile/${t}`);
  if (role === "source" && tab) {
    view = "profile";
    profileTab = tab;
  }
  if (segment === "machines/list") {
    view = "machines";
    machinesMode = "list";
  }
  // Invalid pages keep the role's demo edits, but never substitute a valid screen.
  return { kind: "workspace", role, view: view ?? "not-found", profileTab, machinesMode, focus: url.searchParams.get("focus") };
}

type HistoryEntry = { href: string; position: number };

const locationHref = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
const historyPosition = (): number | undefined => window.history.state?.canonfigPosition;
const pageAddress = (href: string) => href.split("#", 1)[0];
const locationListeners = new Set<() => void>();
let currentEntry: HistoryEntry | null = null;
let restore: { proceed?: () => void } | null = null;
let approvedPosition: number | undefined;
let guard: NavigationGuard | null = null;

/** The guard returns true when it owns the decision and can call proceed after confirmation. */
export type NavigationGuard = (proceed: () => void) => boolean;

function registerEntry(positionIfNew = 0): HistoryEntry {
  const savedPosition = historyPosition();
  const position = savedPosition ?? positionIfNew;
  if (savedPosition === undefined) {
    window.history.replaceState({ canonfigPosition: position }, "");
  }
  return { href: locationHref(), position };
}

function publishEntry(entry: HistoryEntry) {
  currentEntry = entry;
  for (const notify of locationListeners) notify();
}

function onHistoryTraversal() {
  const from = currentEntry;
  const position = historyPosition();
  if (!from || position === undefined) {
    // Native fragment navigation creates a same-document entry without state.
    // Previous entries have already been indexed, so stamp the new successor.
    publishEntry(registerEntry(from ? from.position + 1 : 0));
    return;
  }
  const offset = position - from.position;
  const href = locationHref();
  if (restore) {
    if (offset !== 0) {
      // Another browser traversal can supersede the queued return.
      window.history.go(-offset);
      return;
    }
    const { proceed } = restore;
    restore = null;
    proceed?.();
    return;
  }
  const approved = approvedPosition === position;
  approvedPosition = undefined;
  const fromPage = pageAddress(from.href);
  const draft = guard;
  if (offset !== 0 && pageAddress(href) !== fromPage && !approved && draft?.(() => {
    const proceed = () => {
      // Fragment traversal changes the offset without changing the guarded draft.
      if (!currentEntry || guard !== draft || pageAddress(currentEntry.href) !== fromPage) return;
      approvedPosition = position;
      window.history.go(position - currentEntry.position);
    };
    if (restore) restore.proceed = proceed;
    else proceed();
  })) {
    // popstate fires after the address changes. Keep rendering the draft and
    // return to its history entry without pushing or replacing anything.
    restore = {};
    window.history.go(-offset);
    return;
  }
  publishEntry({ href, position });
}

function subscribeLocation(onChange: () => void) {
  if (locationListeners.size === 0) {
    currentEntry = registerEntry();
    window.addEventListener("popstate", onHistoryTraversal);
  }
  locationListeners.add(onChange);
  return () => {
    locationListeners.delete(onChange);
    if (locationListeners.size === 0) {
      currentEntry = null;
      restore = null;
      approvedPosition = undefined;
      window.removeEventListener("popstate", onHistoryTraversal);
    }
  };
}

const routeSnapshot = () => currentEntry?.href ?? locationHref();

export function useAppRoute(): AppRoute {
  const href = useSyncExternalStore(subscribeLocation, routeSnapshot);
  return useMemo(() => parseRoute(href), [href]);
}

function confirmDocumentExit(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = true;
}

/** Installs the same draft's guard for workspace navigation and document exits. */
export function holdNavigation(next: NavigationGuard) {
  guard = next;
  window.addEventListener("beforeunload", confirmDocumentExit);
  return () => {
    if (guard !== next) return;
    guard = null;
    window.removeEventListener("beforeunload", confirmDocumentExit);
  };
}

export const navigate: Navigate = (href, { replace = false } = {}) => {
  if (restore || href === routeSnapshot()) return;
  const proceed = () => {
    const current = currentEntry ?? registerEntry();
    const position = replace ? current.position : current.position + 1;
    window.history[replace ? "replaceState" : "pushState"]({ canonfigPosition: position }, "", href);
    if (locationListeners.size) publishEntry({ href: locationHref(), position });
  };
  if (guard?.(proceed)) return;
  proceed();
};

/** Replace the entry URL, not a separate history entry that Back would revisit. */
export function initializeAppRoute() {
  if (window.location.pathname !== `${APP_BASE}/` && window.location.pathname !== APP_BASE) return;
  const tour = new URLSearchParams(window.location.search).get("tour") === "1" ? "?tour=1" : "";
  navigate(`${workspaceHref("source", "overview")}${tour}`, { replace: true });
}

/**
 * After an in-app page change, focus moves to the new page's h1 so screen readers announce the page and Tab
 * continues from its content. The h1 gets tabIndex -1 here so kit headings need no focus wiring; :focus-visible
 * keeps the ring off after pointer navigation and on after keyboard navigation. Focus a detail panel already took
 * inside main (e.g. the mobile panel's close button) stays where it is.
 */
export function focusPageHeading() {
  const main = document.getElementById("workspace-content");
  const active = document.activeElement;
  if (!main || (active && active !== main && main.contains(active))) return;
  const heading = main.querySelector<HTMLElement>("h1");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

/** Leave modified clicks and new-window links to the browser. */
export function followLink(event: MouseEvent<HTMLAnchorElement>, go: Navigate = navigate) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.currentTarget.target || event.currentTarget.hasAttribute("download")) return;
  event.preventDefault();
  go(event.currentTarget.getAttribute("href")!);
}
