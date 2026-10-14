/**
 * Config key paths name nested keys with `.` between segments. A segment that
 * itself contains a `.` or `\` escapes it: `amp\.mcpServers` is the single
 * top-level key `amp.mcpServers`, and `\\` is one literal backslash. Any other
 * backslash sequence is rejected, so a path always has exactly one reading.
 */
const reservedSegments = new Set(["__proto__", "constructor", "prototype"]);

type ParsedConfigPath =
  | { readonly segments: ReadonlyArray<string>; readonly issue?: undefined }
  | { readonly segments?: undefined; readonly issue: string };

const parseConfigPath = (path: string): ParsedConfigPath => {
  if (path.includes("\0")) return { issue: "config path contains a NUL byte" };
  const segments: Array<string> = [];
  let segment = "";
  for (let index = 0; index < path.length; index += 1) {
    const character = path[index]!;
    if (character === "\\") {
      const escaped = path[index + 1];
      if (escaped !== "." && escaped !== "\\") {
        return {
          issue: "config path contains an invalid escape; write \\. for a literal dot and \\\\ for a literal backslash",
        };
      }
      segment += escaped;
      index += 1;
      continue;
    }
    if (character === ".") {
      segments.push(segment);
      segment = "";
      continue;
    }
    segment += character;
  }
  segments.push(segment);
  if (segments.some((entry) => entry.length === 0)) return { issue: "config path contains an empty segment" };
  if (segments.some((entry) => reservedSegments.has(entry))) {
    return { issue: "config path contains a reserved prototype segment" };
  }
  return { segments };
};

/** Why a config path is invalid, or undefined when it is valid. */
export const configPathIssue = (path: string): string | undefined => parseConfigPath(path).issue;

/** The literal key segments of a valid config path. Throws a TypeError naming the path otherwise. */
export const configPathSegments = (path: string): ReadonlyArray<string> => {
  const parsed = parseConfigPath(path);
  if (parsed.issue !== undefined) throw new TypeError(`${parsed.issue}: ${path}`);
  return parsed.segments;
};

/** The escaped config path for literal key segments; the inverse of configPathSegments. */
export const formatConfigPath = (segments: ReadonlyArray<string>): string =>
  segments.map((segment) => segment.replaceAll("\\", "\\\\").replaceAll(".", "\\.")).join(".");

/** A parent key owns its entire value, not only the exact path spelling. */
export const configPathsOverlap = (left: string, right: string): boolean => {
  const leftSegments = parseConfigPath(left).segments;
  const rightSegments = parseConfigPath(right).segments;
  if (leftSegments === undefined || rightSegments === undefined) return left === right;
  const shared = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftSegments[index] !== rightSegments[index]) return false;
  }
  return true;
};
