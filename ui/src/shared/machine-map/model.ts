// Machine map model: how each machine looks in this app, where its
// node sits, and how a follower's state reads as an edge. Looks and positions
// are GUI-only presentation kept in this browser's localStorage; nothing here
// is ever sent to the Source Machine or to followers.
import { createContext, useSyncExternalStore } from "react";
import type { IconComponent } from "@/components/icons";
import { Briefcase, Circuitry, Cloud, Cpu, Desktop, DeviceMobile, GameController, HardDrives, House, Laptop, Package } from "@/components/icons";
import { ditherPath } from "@/lib/dither";
import type { Follower, FollowerState } from "@/shared/metadata";

export type MapRole = "source" | "follower";

/** The Source Machine's node id; followers use their Follower Identity id. */
export const SOURCE_ID = "source";

// Eleven presets plus the Custom tile keep the picker a full 2x6 grid.
export const DEVICE_ICONS = {
  desktop: { label: "Desktop", Icon: Desktop },
  laptop: { label: "Laptop", Icon: Laptop },
  server: { label: "Server", Icon: HardDrives },
  gaming: { label: "Gaming PC", Icon: GameController },
  compute: { label: "Workstation", Icon: Cpu },
  cloud: { label: "Cloud machine", Icon: Cloud },
  mobile: { label: "Mobile", Icon: DeviceMobile },
  board: { label: "Single-board computer", Icon: Circuitry },
  vm: { label: "Virtual machine", Icon: Package },
  home: { label: "Home", Icon: House },
  work: { label: "Work", Icon: Briefcase },
} as const satisfies Record<string, { label: string; Icon: IconComponent }>;
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

/** Uploaded icons: SVG or PNG, read into a data URL and drawn as a mask in the accent colour. */
export const CUSTOM_ICON_TYPES = ["image/svg+xml", "image/png"] as const;
export const CUSTOM_ICON_MAX_BYTES = 64 * 1024;
/** Icons and marks need 3:1 against what they sit on (WCAG 1.4.11, non-text contrast). */
export const ACCENT_MIN_CONTRAST = 3;
/** The node's icon tile tints the card with this share of the accent (see MachineNode); contrast is measured on it. */
export const ICON_TILE_TINT = 0.09;

export interface Look {
  name?: string;
  purpose?: string;
  icon?: DeviceIcon | "custom";
  accent?: Accent | "custom";
  /** The uploaded icon as a `data:image/svg+xml` or `data:image/png` URL, kept while a preset is picked. */
  customIcon?: string;
  /** `#rrggbb`, already lifted to `ACCENT_MIN_CONTRAST` by the sheet; kept while a preset is picked. */
  customAccent?: string;
}

export interface ResolvedLook {
  name: string;
  purpose: string;
  icon: DeviceIcon | "custom";
  accent: Accent | "custom";
  /** The uploaded icon's data URL, or "" when none is saved. */
  iconSrc: string;
  /** The saved custom colour, or "" when none is saved. */
  customAccent: string;
  /** The CSS colour to draw this machine with, preset or custom. */
  color: string;
}

// Demo defaults so the map reads like the user's sketch out of the box.
const DEFAULT_LOOKS: Record<string, { purpose: string; icon: DeviceIcon; accent: Accent }> = {
  [SOURCE_ID]: { purpose: "Main desktop", icon: "desktop", accent: "purple" },
  f_8c21: { purpose: "Work laptop", icon: "laptop", accent: "blue" },
  f_3b90: { purpose: "Design studio", icon: "desktop", accent: "pink" },
  f_d417: { purpose: "Games and CUDA", icon: "gaming", accent: "green" },
  f_71ea: { purpose: "Build server", icon: "server", accent: "slate" },
};

const PLATFORM_ICON: Record<NonNullable<Follower["platform"]>, DeviceIcon> = { macos: "laptop", windows: "desktop", linux: "server" };

const CUSTOM_ICON_SRC = /^data:image\/(svg\+xml|png)[;,]/;
const HEX = /^#[0-9a-f]{6}$/i;

export function resolveLook(id: string, hostname: string, platform: Follower["platform"] | undefined, look: Look | undefined): ResolvedLook {
  const preset = platform === undefined ? undefined : DEFAULT_LOOKS[id];
  const baseIcon = preset?.icon ?? (platform === undefined ? "desktop" : PLATFORM_ICON[platform]);
  const baseAccent = preset?.accent ?? "slate";
  // Stored looks come from localStorage (and other tabs), so unknown keys and malformed custom values fall back.
  const iconSrc = look?.customIcon && CUSTOM_ICON_SRC.test(look.customIcon) ? look.customIcon : "";
  const customAccent = look?.customAccent && HEX.test(look.customAccent) ? look.customAccent : "";
  const icon = look?.icon === "custom" ? (iconSrc ? "custom" : baseIcon) : look?.icon && look.icon in DEVICE_ICONS ? look.icon : baseIcon;
  const accent = look?.accent === "custom" ? (customAccent ? "custom" : baseAccent) : look?.accent && look.accent in ACCENTS ? look.accent : baseAccent;
  return {
    name: look?.name?.trim() || hostname,
    purpose: look?.purpose ?? preset?.purpose ?? "",
    icon,
    accent,
    iconSrc,
    customAccent,
    color: accent === "custom" ? customAccent : ACCENTS[accent].color,
  };
}

// ---------------------------------------------------------------------------
// Contrast: WCAG relative luminance on #rrggbb colours.

function hexToRgb(hex: string): number[] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb: ArrayLike<number>): string {
  return `#${Array.from(rgb, (c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast of an accent's icon on its tile: the card tinted by `ICON_TILE_TINT` of that same accent. The tint makes
 * the tile lighter than the bare card, so measuring against the card alone would pass colours that fall short on
 * the tile. sRGB mixing stands in for the tile's oklab color-mix, which is close enough at a 9% tint.
 */
function tileContrast(rgb: readonly number[], card: readonly number[]): number {
  const tile = card.map((c, i) => c + (rgb[i] - c) * ICON_TILE_TINT);
  const [a, b] = [luminance(rgb), luminance(tile)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The colour itself when its icon reads at `ACCENT_MIN_CONTRAST` on a `card` tile, else the least mix of it with
 * white that does. Mixing toward white keeps the hue and gives up some saturation: navy becomes a muted blue-violet.
 */
export function liftAccent(hex: string, card: string): string {
  const rgb = hexToRgb(hex);
  const cardRgb = hexToRgb(card);
  if (tileContrast(rgb, cardRgb) >= ACCENT_MIN_CONTRAST) return hex;
  // Rounded per step, so the 8-bit colour that gets saved is the one that passed.
  const mix = (t: number) => rgb.map((c) => Math.round(c + (255 - c) * t));
  // Contrast grows with t on a dark card; 12 halvings resolve below one 8-bit step.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const t = (lo + hi) / 2;
    if (tileContrast(mix(t), cardRgb) >= ACCENT_MIN_CONTRAST) hi = t;
    else lo = t;
  }
  return rgbToHex(mix(hi));
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

export function linkFor(f: Required<Pick<Follower, "state" | "revision" | "schedule">> & Pick<Follower, "behind">, latest: number, syncing: boolean): Link {
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
