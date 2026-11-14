import type { CSSProperties } from 'react';

/**
 * Inline style for one `.rv` piece of a `[data-reveal]` section: how long it
 * waits after the section is revealed before it rises (page.css). A plain
 * module, not a client one, so server components can call it.
 */
export function revealDelay(ms: number): CSSProperties {
  // SAFETY: a custom property; React passes unknown style keys through as-is.
  return { '--rv': `${ms}ms` } as CSSProperties;
}
