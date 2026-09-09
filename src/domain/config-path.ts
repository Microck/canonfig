/** Dotted configuration paths share one ownership and traversal contract. */
export const configPathIssue = (path: string): string | undefined => {
  const segments = path.split(".");
  if (segments.some((segment) => segment.length === 0)) return "config path contains an empty segment";
  if (path.includes("\0")) return "config path contains a NUL byte";
  if (segments.some((segment) => ["__proto__", "constructor", "prototype"].includes(segment))) {
    return "config path contains a reserved prototype segment";
  }
  return undefined;
};

/** A parent key owns its entire value, not only the exact path spelling. */
export const configPathsOverlap = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
