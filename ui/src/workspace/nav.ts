// Each role's sidebar: its pages, then its settings. The sidebar (frame.tsx) renders it, and the
// tour picker (guide.tsx) draws a small copy of it to show where a chapter goes.
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  CalendarDots,
  ClockCounterClockwise,
  CloudDownload,
  Devices,
  FileCode,
  HardDrives,
  Key,
  ListChecks,
  Monitor,
  Package,
  Plug,
  Robot,
  SquaresFour,
  Stack,
  Stethoscope,
  type IconComponent,
} from "@/components/icons";
import { DEMO, PLAIN, type Role } from "@/shared/metadata";
import type { AppRoute, WorkspaceRole } from "./routes";
import type { View } from "./store";

export interface NavItem {
  view: View;
  label: string;
  icon: IconComponent;
}

const SOURCE_NAV: NavItem[] = [
  { view: "overview", label: "Overview", icon: SquaresFour },
  { view: "profile", label: "Profile", icon: FileCode },
  { view: "machines", label: "Machines", icon: Devices },
  { view: "revisions", label: "Revisions", icon: ClockCounterClockwise },
  { view: "backups", label: "Backups", icon: ArrowCounterClockwise },
  { view: "secrets", label: "Secrets", icon: Key },
];

const SOURCE_SETTINGS: NavItem[] = [
  { view: "service", label: "Source service", icon: HardDrives },
  { view: "agent", label: "Agent policy", icon: Robot },
  { view: "installers", label: "Installers", icon: Package },
  { view: "setup", label: "Setup", icon: ListChecks },
  { view: "doctor", label: "Health check", icon: Stethoscope },
  { view: "version", label: "Canonfig version", icon: CloudDownload },
];

const FOLLOWER_NAV: NavItem[] = [
  { view: "overview", label: "Overview", icon: SquaresFour },
  { view: "machines", label: "Machines", icon: Devices },
  { view: "sync", label: "Sync", icon: ArrowsClockwise },
  { view: "schedule", label: "Schedule", icon: CalendarDots },
  { view: "local", label: PLAIN.localNav, icon: Stack },
  { view: "backups", label: "Backups", icon: ArrowCounterClockwise },
  { view: "secrets", label: "Secrets", icon: Key },
];

const FOLLOWER_SETTINGS: NavItem[] = [
  { view: "tunnel", label: "SSH tunnel", icon: Plug },
  { view: "agent", label: "Agent policy", icon: Robot },
  { view: "doctor", label: "Health check", icon: Stethoscope },
  { view: "machine", label: "Enrollment", icon: Monitor },
  { view: "version", label: "Canonfig version", icon: CloudDownload },
];

export const NAV: Record<WorkspaceRole, { main: NavItem[]; settings: NavItem[] }> = {
  source: { main: SOURCE_NAV, settings: SOURCE_SETTINGS },
  follower: { main: FOLLOWER_NAV, settings: FOLLOWER_SETTINGS },
};

/** The sidebar entry for a role's page, if it has one (the not-found view has none). */
export function navItem(role: WorkspaceRole, view: View): NavItem | undefined {
  const navigation = navigationForRole(role);
  return navigation.main.find((item) => item.view === view) ?? navigation.settings.find((item) => item.view === view);
}

/** The session role chooses routes; demo-only backups never enter Source live navigation. */
export function navigationForRole(role: WorkspaceRole, live = !DEMO) {
  const navigation = NAV[role];
  if (!live) return navigation;
  return {
    main: navigation.main.filter((item) => role !== "source" || item.view !== "backups"),
    settings: role === "follower"
      ? [...navigation.settings, ...SOURCE_SETTINGS.filter((item) => item.view === "installers" || item.view === "setup")]
      : navigation.settings,
  };
}

export function isRouteForRole(route: AppRoute, role: Role): boolean {
  if (role === "unconfigured") return route.kind === "setup";
  if (route.kind !== "workspace" || route.role !== role) return false;
  const navigation = navigationForRole(role, true);
  return [...navigation.main, ...navigation.settings].some((item) => item.view === route.view);
}
