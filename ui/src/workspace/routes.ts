import { useMemo, useSyncExternalStore, type MouseEvent } from "react";
import type { Role } from "@/shared/data";
import type { FollowerView, SourceView, View } from "./store";

export type WorkspaceRole = Exclude<Role, "unconfigured">;
/** Profile tabs: the folder's items, its harness list, Follower Groups, and the profile's name, schedule and local policy. */
export type ProfileTab = "items" | "harnesses" | "groups" | "defaults";
const PROFILE_TABS: Exclude<ProfileTab, "items">[] = ["harnesses", "groups", "defaults"];
export type MachinesMode = "map" | "list";

const SOURCE_PATHS: Record<SourceView, string> = {
  overview: "overview",
  profile: "profile",
  machines: "machines",
  revisions: "revisions",
  backups: "backups",
  secrets: "secrets",
  service: "settings/service",
  agent: "settings/agent",
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
  doctor: "settings/health",
  machine: "settings/enrollment",
  version: "settings/version",
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
  const paths: Partial<Record<View, string>> = role === "source" ? SOURCE_PATHS : FOLLOWER_PATHS;
  const segment = paths[view];
  if (!segment) throw new Error(`No ${role} route for ${view}`);
  let path = `/${role}/${segment}`;
  if (view === "profile" && options.profileTab && options.profileTab !== "items") path += `/${options.profileTab}`;
  if (view === "machines" && options.machinesMode === "list") path += "/list";
  if (options.focus != null) path += `?${new URLSearchParams({ focus: options.focus })}`;
  return path;
}

export function roleHref(role: Role): string {
  return role === "unconfigured" ? "/setup" : workspaceHref(role, "overview");
}

export function parseRoute(href: string): AppRoute {
  const url = new URL(href, "http://canonfig.local");
  if (url.pathname === "/setup") return { kind: "setup" };
  const [, role, ...parts] = url.pathname.split("/");
  if (role !== "source" && role !== "follower") return { kind: "not-found" };
  const segment = parts.join("/");
  const paths: Partial<Record<View, string>> = role === "source" ? SOURCE_PATHS : FOLLOWER_PATHS;
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

const LOCATION_EVENT = "canonfig:navigate";
const locationSnapshot = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

function subscribeLocation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(LOCATION_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(LOCATION_EVENT, onChange);
  };
}

export function useAppRoute(): AppRoute {
  const href = useSyncExternalStore(subscribeLocation, locationSnapshot);
  return useMemo(() => parseRoute(href), [href]);
}

/**
 * One screen with unsaved edits can hold up in-app navigation. The guard receives the pending
 * navigation and returns true when it took over: it shows its own confirmation and calls `proceed`
 * if the person chooses to discard. Browser Back/Forward and full reloads are not intercepted.
 * Forms register through `useLeaveGuard` in kit.tsx rather than calling this directly.
 */
export type NavigationGuard = (proceed: () => void) => boolean;
let guard: NavigationGuard | null = null;

/** Registers `next` as the only guard; the returned disposer removes it only if it is still the active one. */
export function holdNavigation(next: NavigationGuard) {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

export const navigate: Navigate = (href, { replace = false } = {}) => {
  if (href === locationSnapshot()) return;
  const proceed = () => {
    window.history[replace ? "replaceState" : "pushState"](null, "", href);
    window.dispatchEvent(new Event(LOCATION_EVENT));
  };
  if (guard?.(proceed)) return;
  proceed();
};

/** Replace the entry URL, not a separate history entry that Back would revisit. */
export function initializeAppRoute() {
  if (window.location.pathname !== "/") return;
  const tour = new URLSearchParams(window.location.search).get("tour") === "1" ? "?tour=1" : "";
  navigate(`/source/overview${tour}`, { replace: true });
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
