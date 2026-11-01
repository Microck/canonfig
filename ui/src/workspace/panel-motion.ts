// How DetailPanel (kit.tsx) opens, swaps and closes.
//
// PROTOTYPE, TEMPORARY: the user is choosing between these open styles live. Pick one with
// `?panel=<n>` (remembered in localStorage) or cycle with `[` and `]`; a small label in the bottom-left
// corner names the active one. Once a style is chosen, delete the other entries, `installPanelPrototype`
// and its label, and keep the winner's three functions as DetailPanel's only motion.
//
// Every style touches only transform, opacity and clip-path, uses the repo's one curve (--ease-snap),
// closes faster than it opens, and does nothing under prefers-reduced-motion. Motion runs through WAAPI
// from DetailPanel's layout effects, so the first frame is already the start pose (no flash) and no
// React state changes per frame.

/** index.css `--ease-snap`. Its small overshoot gives the scale style a spring-like settle. */
const SNAP = "cubic-bezier(0.175, 0.885, 0.32, 1.1)";

/** What a style needs to know about the panel it moves. */
export interface PanelMotionTarget {
  /** The `<aside>` itself. */
  panel: HTMLElement;
  /** Its header, scroll body and footer: what "content" fades act on. */
  parts: HTMLElement[];
  /** Below md the panel is a full-screen overlay instead of a column beside the list. */
  overlay: boolean;
  /** Vertical centre of whatever opened the panel, in the panel's own coordinates. */
  originY: number;
}

interface PanelStyle {
  name: string;
  /** A fresh open: no panel was showing. */
  open: (t: PanelMotionTarget) => Animation[];
  /** Another row replaced the panel's contents (the panel remounts with the new key). */
  swap: (t: PanelMotionTarget) => Animation[];
  /** The panel is leaving; it unmounts when these finish. */
  close: (t: PanelMotionTarget) => Animation[];
}

const fadeParts = (t: PanelMotionTarget, duration: number, delay = 0) =>
  t.parts.map((part) => part.animate({ opacity: [0, 1] }, { duration, delay, easing: SNAP, fill: "backwards" }));

const none = () => [];

export const PANEL_STYLES: PanelStyle[] = [
  {
    // What shipped before the prototype: every mount, including row-to-row swaps, slides 8px and fades
    // over 300ms; closing is instant.
    name: "current: 8px slide + fade",
    open: ({ panel }) => [panel.animate({ opacity: [0, 1], transform: ["translateX(8px)", "none"] }, { duration: 300, easing: SNAP })],
    swap: (t) => PANEL_STYLES[0].open(t),
    close: none,
  },
  {
    // Raycast-style: the panel is a frequent, list-driven action, so it just appears and disappears.
    name: "instant",
    open: none,
    swap: none,
    close: none,
  },
  {
    // The panel's left edge wipes in from the right edge of the page, then its content fades up behind
    // it. clip-path keeps the box at full width from the first frame, so the list reflows once, at the
    // start, instead of tracking a growing width. The overlay wipes across the whole screen the same way.
    name: "wipe from the right edge",
    open: (t) => [
      t.panel.animate({ clipPath: ["inset(0 0 0 100%)", "inset(0 0 0 0)"] }, { duration: t.overlay ? 260 : 220, easing: SNAP }),
      ...fadeParts(t, 150, 80),
    ],
    swap: (t) => fadeParts(t, 120),
    close: (t) => [t.panel.animate({ clipPath: ["inset(0 0 0 0)", "inset(0 0 0 100%)"] }, { duration: t.overlay ? 160 : 140, easing: SNAP, fill: "forwards" })],
  },
  {
    // The shipped slide, made half as far and under half as long, so it reads as a settle, not travel.
    name: "short slide: 4px + 120ms fade",
    open: ({ panel }) => [panel.animate({ opacity: [0, 1], transform: ["translateX(4px)", "none"] }, { duration: 120, easing: SNAP })],
    swap: (t) => fadeParts(t, 100),
    close: ({ panel }) => [panel.animate({ opacity: [1, 0], transform: ["none", "translateX(4px)"] }, { duration: 90, easing: SNAP, fill: "forwards" })],
  },
  {
    // Grows out of the row that opened it: scale from 0.96 with the origin on the panel's left edge (or
    // the overlay's centre line) at the row's height, so the panel visibly comes from that row.
    name: "scale from the row",
    open: ({ panel, overlay, originY }) => {
      panel.style.transformOrigin = `${overlay ? "50%" : "0"} ${originY}px`;
      return [panel.animate({ opacity: [0, 1], transform: ["scale(0.96)", "none"] }, { duration: 220, easing: SNAP })];
    },
    swap: (t) => fadeParts(t, 120),
    close: ({ panel }) => [panel.animate({ opacity: [1, 0], transform: ["none", "scale(0.98)"] }, { duration: 120, easing: SNAP, fill: "forwards" })],
  },
  {
    // The panel's frame is there at once; only what's inside fades in, on open and on every row swap.
    name: "content fade only",
    open: (t) => fadeParts(t, 150),
    swap: (t) => fadeParts(t, 150),
    close: ({ panel }) => [panel.animate({ opacity: [1, 0] }, { duration: 100, easing: SNAP, fill: "forwards" })],
  },
];

const STORAGE_KEY = "canonfig:proto:panel";
let active = 0;

/** The style DetailPanel uses right now. Read at animation time, so switching needs no re-render. */
export function panelStyle(): PanelStyle | null {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? null : PANEL_STYLES[active];
}

// Where the last press landed. Safari doesn't focus a clicked button, so focus alone can't say which
// row opened the panel; a keyboard open still prefers the focused row (see panelMotionTarget).
let pointerY: number | null = null;
document.addEventListener("pointerdown", (e) => (pointerY = e.clientY), true);

/**
 * Measures a just-mounted (or leaving) panel for a style. The opener is the focused element outside the
 * panel, else the last press; with neither, the panel's own centre.
 */
export function panelMotionTarget(panel: HTMLElement): PanelMotionTarget {
  const rect = panel.getBoundingClientRect();
  const opener = document.activeElement;
  let openerY = pointerY;
  if (opener instanceof HTMLElement && opener !== document.body && !panel.contains(opener)) {
    const r = opener.getBoundingClientRect();
    openerY = r.top + r.height / 2;
  }
  return {
    panel,
    parts: [...panel.querySelectorAll<HTMLElement>(":scope > [data-panel-part]")],
    overlay: window.matchMedia("(max-width: 767.98px)").matches,
    originY: (openerY ?? rect.top + rect.height / 2) - rect.top,
  };
}

/**
 * PROTOTYPE CHROME: reads `?panel=<n>` or the remembered choice, binds `[` / `]`, and draws the
 * bottom-left label. Plain DOM, so it is one call to delete. Runs once, on DetailPanel's module load.
 */
function installPanelPrototype() {
  const fromUrl = Number(new URLSearchParams(location.search).get("panel"));
  let stored = 0;
  try {
    stored = Number(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Blocked site data: the choice then lasts only this page.
  }
  const pick = (n: number) => (Number.isInteger(n) && n >= 1 && n <= PANEL_STYLES.length ? n - 1 : null);
  active = pick(fromUrl) ?? pick(stored) ?? 0;

  const label = document.createElement("div");
  label.setAttribute("aria-hidden", "true");
  label.className = "pointer-events-none fixed bottom-1 left-1 z-[100] rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white";
  const render = () => {
    label.textContent = `Panel ${active + 1}/${PANEL_STYLES.length}: ${PANEL_STYLES[active].name}`;
    try {
      localStorage.setItem(STORAGE_KEY, String(active + 1));
    } catch {
      // As above.
    }
  };
  render();
  document.body.append(label);

  document.addEventListener("keydown", (e) => {
    if ((e.key !== "[" && e.key !== "]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    if (target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable]")) return;
    active = (active + (e.key === "]" ? 1 : -1) + PANEL_STYLES.length) % PANEL_STYLES.length;
    render();
  });
}

installPanelPrototype();
