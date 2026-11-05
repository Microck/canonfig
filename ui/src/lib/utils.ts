import { flushSync } from "react-dom";

export { cn } from "cn"

/** The --ease-snap curve (index.css) for motion and WAAPI code, which can't read CSS variables. */
export const SNAP = [0.175, 0.885, 0.32, 1.1] as const;
/** --ease-snap as a WAAPI easing string. */
export const SNAP_EASING = `cubic-bezier(${SNAP.join(", ")})`;

/**
 * True on touch screens. Opening a dialog or panel there must not focus a text field: that raises the software
 * keyboard over half the view before the person has chosen to type.
 */
export const isCoarsePointer = () => window.matchMedia("(pointer: coarse)").matches;

/**
 * Removes a list item from its own X button and keeps keyboard focus in the list: on the next item's X, else the
 * previous one, else the element with id `fallback` (the list's Add control). Without it, focus falls to <body>
 * with the removed button and Tab starts again from the top of the page. The list is every button that shares
 * this button's `data-remove` value.
 */
export function removeKeepingFocus(button: HTMLElement, remove: () => void, fallback: string) {
  const buttons = [...document.querySelectorAll<HTMLElement>(`[data-remove="${button.dataset.remove}"]`)];
  const at = buttons.indexOf(button);
  const neighbour = buttons[at + 1] ?? buttons[at - 1];
  flushSync(remove);
  (neighbour?.isConnected ? neighbour : document.getElementById(fallback))?.focus();
}

/**
 * Rises elements into place one after another: each fades in from `distance` px lower,
 * `gap` ms after the one before, starting after `delay`. From the `cap`th element on they
 * share the last slot, so a long list doesn't trail. WAAPI with a backwards fill: each
 * element stays hidden until its turn and keeps no style once done. Decoration only: the
 * elements take clicks and focus throughout. Returns the animations, so a caller can pin
 * their start time.
 */
export function riseIn(elements: Iterable<Element>, { delay = 0, gap = 40, duration = 300, distance = 8, cap = Infinity } = {}): Animation[] {
  let index = 0;
  return Array.from(elements, (element) =>
    element.animate([{ opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: "translateY(0px)" }], {
      duration,
      delay: delay + Math.min(index++, cap) * gap,
      easing: SNAP_EASING,
      fill: "backwards",
    }),
  );
}
