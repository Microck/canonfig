export { cn } from "cn"

/** The --ease-snap curve (index.css) for motion and WAAPI code, which can't read CSS variables. */
export const SNAP = [0.175, 0.885, 0.32, 1.1] as const;
/** --ease-snap as a WAAPI easing string. */
export const SNAP_EASING = `cubic-bezier(${SNAP.join(", ")})`;

/**
 * Rises elements into place one after another: each fades in from `distance` px lower,
 * `gap` ms after the one before, starting after `delay`. From the `cap`th element on they
 * share the last slot, so a long list doesn't trail. WAAPI with a backwards fill: each
 * element stays hidden until its turn and keeps no style once done. Decoration only: the
 * elements take clicks and focus throughout.
 */
export function riseIn(elements: Iterable<Element>, { delay = 0, gap = 40, duration = 300, distance = 8, cap = Infinity } = {}) {
  let index = 0;
  for (const element of elements) {
    element.animate([{ opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: "translateY(0px)" }], {
      duration,
      delay: delay + Math.min(index++, cap) * gap,
      easing: SNAP_EASING,
      fill: "backwards",
    });
  }
}
