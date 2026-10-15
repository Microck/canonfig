// Machine map model: how each machine looks in this app, where its
// node sits, and how a follower's state reads as an edge. Looks and positions
// are GUI-only presentation kept in this browser's localStorage; nothing here
// is ever sent to the Source Machine or to followers.
import { createContext, useSyncExternalStore } from "react";
import type { Icon } from "@phosphor-icons/react";
import {
  Briefcase,
  Circuitry,
  Cloud,
  Cpu,
  Desktop,
  DeviceMobile,
  GameController,
  HardDrives,
  House,
  Laptop,
  Monitor,
  Package,
} from "@phosphor-icons/react";
import { ditherPath } from "@/lib/dither";
import type { Follower, FollowerState } from "@/shared/data";

export type MapRole = "source" | "follower";

/** The Source Machine's node id; followers use their Follower Identity id. */
export const SOURCE_ID = "source";

export const DEVICE_ICONS = {
  desktop: { label: "Desktop", Icon: Desktop },
  laptop: { label: "Laptop", Icon: Laptop },
  server: { label: "Server", Icon: HardDrives },
  gaming: { label: "Gaming PC", Icon: GameController },
  compute: { label: "Workstation", Icon: Cpu },
  cloud: { label: "Cloud machine", Icon: Cloud },
  display: { label: "All-in-one", Icon: Monitor },
  mobile: { label: "Mobile", Icon: DeviceMobile },
  board: { label: "Single-board computer", Icon: Circuitry },
  vm: { label: "Virtual machine", Icon: Package },
  home: { label: "Home", Icon: House },
  work: { label: "Work", Icon: Briefcase },
} as const satisfies Record<string, { label: string; Icon: Icon }>;
export type DeviceIcon = keyof typeof DEVICE_ICONS;

/** Accents from the Canonfig dither palette; state colours stay on edges and labels. */
export const ACCENTS = {
  blue: { label: "Blue", color: "var(--dither-color-blue)" },
  purple: { label: "Purple", color: "var(--dither-color-purple)" },
  pink: { label: "Pink", color: "var(--dither-color-pink)" },
  green: { label: "Green", color: "var(--dither-color-green)" },
  gold: { label: "Gold", color: "var(--dither-color-gold)" },
  slate: { label: "Slate", color: "var(--muted-foreground)" },
} as const;
export type Accent = keyof typeof ACCENTS;

export interface Look {
  name?: string;
  purpose?: string;
  icon?: DeviceIcon;
  accent?: Accent;
}
export type ResolvedLook = Required<Look>;

// Demo defaults so the map reads like the user's sketch out of the box.
const DEFAULT_LOOKS: Record<string, Omit<ResolvedLook, "name">> = {
  [SOURCE_ID]: { purpose: "Main desktop", icon: "desktop", accent: "purple" },
  f_8c21: { purpose: "Work laptop", icon: "laptop", accent: "blue" },
  f_3b90: { purpose: "Design studio", icon: "display", accent: "pink" },
  f_d417: { purpose: "Games and CUDA", icon: "gaming", accent: "green" },
  f_71ea: { purpose: "Build server", icon: "server", accent: "slate" },
};

const PLATFORM_ICON: Record<Follower["platform"], DeviceIcon> = { macos: "laptop", windows: "desktop", linux: "server" };

export function defaultLook(id: string, hostname: string, platform: Follower["platform"]): ResolvedLook {
  const preset = DEFAULT_LOOKS[id];
  return { name: hostname, purpose: preset?.purpose ?? "", icon: preset?.icon ?? PLATFORM_ICON[platform], accent: preset?.accent ?? "slate" };
}

export function resolveLook(id: string, hostname: string, platform: Follower["platform"], look: Look | undefined): ResolvedLook {
  const base = defaultLook(id, hostname, platform);
  return {
    name: look?.name?.trim() || base.name,
    purpose: look?.purpose ?? base.purpose,
    icon: look?.icon && look.icon in DEVICE_ICONS ? look.icon : base.icon,
    accent: look?.accent && look.accent in ACCENTS ? look.accent : base.accent,
  };
}

// ---------------------------------------------------------------------------
// Local store: one JSON value under one key, shared by every map on the page
// and kept in step with other tabs through the storage event.

export const STORAGE_KEY = "canonfig-ui:machine-map";

export interface XY {
  x: number;
  y: number;
}

interface Saved {
  looks: Record<string, Look>;
  positions: Partial<Record<MapRole, Record<string, XY>>>;
}

const EMPTY: Saved = { looks: {}, positions: {} };

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Blocked storage: behave as if nothing was saved, the map still works.
    return null;
  }
}

function parse(raw: string | null): Saved {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Partial<Saved>;
    return { looks: parsed.looks ?? {}, positions: parsed.positions ?? {} };
  } catch {
    // Unreadable data: start from defaults rather than break the map.
    return EMPTY;
  }
}

/** The cached document and the stored text it came from, so a reload can tell whether anything changed. */
let snapshot: Saved | null = null;
let snapshotRaw: string | null = null;
const listeners = new Set<() => void>();

/** Replaces the cache from storage; true when the stored text differs from the cached one. */
function reload(): boolean {
  const raw = readRaw();
  if (snapshot && raw === snapshotRaw) return false;
  snapshot = parse(raw);
  snapshotRaw = raw;
  return true;
}

function read(): Saved {
  if (!snapshot) reload();
  return snapshot!;
}

function commit(next: Saved) {
  snapshot = next;
  snapshotRaw = JSON.stringify(next);
  try {
    localStorage.setItem(STORAGE_KEY, snapshotRaw);
  } catch {
    // Quota or private mode: keep the change for this session only.
  }
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent) {
  if (e.key !== STORAGE_KEY || !reload()) return;
  for (const l of listeners) l();
}

// Storage events keep the cache current only while something is subscribed.
// So the first subscriber re-checks storage (another tab may have written while
// no map was mounted, or between render and subscribe) and the last one drops
// the cache, so reads and edits in between start from storage, not an old copy.
function subscribe(onChange: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    if (reload()) onChange();
  }
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    if (listeners.size > 0) return;
    window.removeEventListener("storage", onStorage);
    snapshot = null;
  };
}

export const useMapStore = () => useSyncExternalStore(subscribe, read, () => EMPTY);

export const mapStore = {
  /** Saved positions, read once to seed nodes; not reactive. */
  positions(role: MapRole): Record<string, XY> {
    return read().positions[role] ?? {};
  },
  setLook(id: string, patch: Look) {
    const s = read();
    commit({ ...s, looks: { ...s.looks, [id]: { ...s.looks[id], ...patch } } });
  },
  resetLook(id: string) {
    const s = read();
    const { [id]: _removed, ...looks } = s.looks;
    commit({ ...s, looks });
  },
  setPositions(role: MapRole, positions: Record<string, XY>) {
    const s = read();
    commit({ ...s, positions: { ...s.positions, [role]: positions } });
  },
  resetPositions(role: MapRole) {
    const s = read();
    const { [role]: _removed, ...positions } = s.positions;
    commit({ ...s, positions });
  },
};

// ---------------------------------------------------------------------------
// Layout: the Source on top, followers in centred rows under it.

export const NODE_W = 248;
export const NODE_H = 104;
/** The "Add machine" slot is narrower than a machine, so the row stays readable at fit. */
export const ADD_W = 156;
export const ADD_ID = "add-machine";
const GAP_X = 28;
const ROW_Y = NODE_H + 120;
/** Wider than this, a single row only fits a panel at an unreadable zoom, so followers wrap. */
const ROW_MAX = 6;
const ROW_GAP = 48;

/** Default top-left positions for the given ids in follower rows (plus the Source). */
export function defaultLayout(ids: readonly string[]): Record<string, XY> {
  const out: Record<string, XY> = { [SOURCE_ID]: { x: -NODE_W / 2, y: 0 } };
  for (let start = 0; start < ids.length; start += ROW_MAX) {
    const row = ids.slice(start, start + ROW_MAX);
    const widths = row.map((id) => (id === ADD_ID ? ADD_W : NODE_W));
    const y = ROW_Y + (start / ROW_MAX) * (NODE_H + ROW_GAP);
    let x = -(widths.reduce((sum, w) => sum + w, 0) + (row.length - 1) * GAP_X) / 2;
    row.forEach((id, i) => {
      out[id] = { x, y };
      x += widths[i] + GAP_X;
    });
  }
  return out;
}

/** What a node can ask of the map. Context, not node data, so node data stays plain values. */
export interface MapActions {
  open: (id: string) => void;
  invite: () => void;
  /** Open the Customize sheet for this machine, or close it if it is already open for it. */
  toggleCustomize: (id: string) => void;
  /** The machine the Customize sheet is open for. */
  customizingId: string | null;
}

export const MapActionsContext = createContext<MapActions>({
  open: () => {},
  invite: () => {},
  toggleCustomize: () => {},
  customizingId: null,
});

// ---------------------------------------------------------------------------
// Edge semantics: what the line from the Source to a follower says.

export type LinkTone = "quiet" | "warn" | "act" | "bad";

export const TONE_STROKE: Record<LinkTone, string> = {
  quiet: "var(--border-strong)",
  warn: "var(--warn)",
  act: "var(--act)",
  bad: "var(--bad)",
};
/** Packets on a quiet line are green: data on its way, not a problem. */
export const PACKET_FILL: Record<LinkTone, string> = { ...TONE_STROKE, quiet: "var(--dither-color-green)" };
/** A packet: half the cells of a 4x4 Bayer tile, a checkerboard square 4 units across. */
export const PACKET_PATH = ditherPath(0.5, "bayer4");

export interface Link {
  state: FollowerState;
  tone: LinkTone;
  /** Data is on its way: a newer revision waits, or a Synchronization Run is in progress. */
  flowing: boolean;
  /** A Synchronization Run is in progress right now: packets move faster. */
  running: boolean;
  /** The follower can't reach the Source: no line can carry anything. */
  broken: boolean;
  /** One sentence beyond STATE_META's hint about what is travelling, if anything. */
  detail: string | null;
}

export function linkFor(f: Pick<Follower, "state" | "revision" | "schedule" | "behind">, latest: number, syncing: boolean): Link {
  const broken = f.state === "offline";
  const behind = f.revision === null || f.revision < latest;
  const tone: LinkTone =
    f.state === "drift" ? "warn" : f.state === "human-action" ? "act" : f.state === "failed" || broken ? "bad" : "quiet";
  const flowing = !broken && (syncing || behind);
  let detail: string | null = null;
  if (broken && behind) detail = f.behind ?? `Revision ${latest} can't reach it yet; it's still on ${f.revision === null ? "nothing" : `revision ${f.revision}`}.`;
  else if (syncing) detail = `Updating now to revision ${latest}.`;
  else if (behind) detail = `Revision ${latest} is on its way. It updates on its schedule (${f.schedule}).`;
  return { state: f.state, tone, flowing, running: flowing && syncing, broken, detail };
}
