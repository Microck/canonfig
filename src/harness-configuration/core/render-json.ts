import type {
  CleanupInstruction,
  DesiredArtifact,
  JsonManagedMapCleanup,
} from "./types.ts";
import {
  containsMarker,
  deepEqual,
  getAtPath,
  identityOf,
  isRecord,
  parseJsonDocument,
  serializeJsonDocument,
  setAtPath,
} from "./render-utils.ts";

export function restoreJsonCleanup(
  document: Record<string, unknown>,
  cleanup: Exclude<
    CleanupInstruction,
    { kind: "replace" | "managed-text" | "toml-block" | "toml-key" }
  >,
  force: boolean,
  conflicts: string[],
): void {
  if (cleanup.kind === "json-managed-map") {
    for (const [key, expected] of Object.entries(cleanup.entries)) {
      const currentMap = getAtPath(document, cleanup.path);
      const current = isRecord(currentMap) ? currentMap[key] : undefined;
      if (!deepEqual(current, expected) && !force) {
        conflicts.push(
          `Managed JSON entry ${[...cleanup.path, key].join(".")} was edited outside Canonfig.`,
        );
        continue;
      }
      const original = cleanup.originals[key];
      setAtPath(
        document,
        [...cleanup.path, key],
        original?.existed ? original.value : undefined,
      );
    }
    return;
  }
  if (cleanup.kind === "json-managed-array") {
    const current = getAtPath(document, cleanup.path);
    if (!Array.isArray(current)) return;
    const remaining = [...current];
    for (const expected of cleanup.values) {
      const expectedIdentity = identityOf(expected, cleanup.identity);
      const index = remaining.findIndex((candidate) => cleanup.identity === undefined
        ? deepEqual(candidate, expected)
        : deepEqual(identityOf(candidate, cleanup.identity), expectedIdentity));
      if (index >= 0) remaining.splice(index, 1);
    }
    setAtPath(document, cleanup.path, remaining);
    return;
  }

  const current = getAtPath(document, cleanup.path);
  if (!isRecord(current)) return;
  const next: Record<string, unknown> = {};
  const managedEvents = cleanup.events === undefined
    ? undefined
    : new Set(cleanup.events);
  for (const [event, entries] of Object.entries(current)) {
    if (managedEvents !== undefined && !managedEvents.has(event)) {
      next[event] = entries;
      continue;
    }
    const filtered = Array.isArray(entries)
      ? entries.filter((entry) => !containsMarker(entry, cleanup.marker))
      : entries;
    const original = cleanup.originals?.[event];
    if (original?.existed === true && !Array.isArray(filtered)) next[event] = original.value;
    else if (Array.isArray(filtered) && filtered.length > 0) next[event] = filtered;
    else if (original?.existed === true) next[event] = original.value;
  }
  setAtPath(document, cleanup.path, next);
}

export function applyJsonArtifact(
  input: string,
  artifact: Extract<DesiredArtifact, { kind: "json" }>,
  force: boolean,
  conflicts: string[],
): { text: string; cleanup: CleanupInstruction[] } {
  const document = parseJsonDocument(input.trim() === "" ? "{}" : input, conflicts);
  const cleanup: CleanupInstruction[] = [];
  const appliedRootDefaults: Record<string, unknown> = {};
  const rootDefaultOriginals: JsonManagedMapCleanup["originals"] = {};

  for (const [key, value] of Object.entries(artifact.rootDefaults ?? {})) {
    if (document[key] === undefined) {
      rootDefaultOriginals[key] = { existed: false };
      document[key] = value;
      appliedRootDefaults[key] = value;
    }
  }
  if (Object.keys(appliedRootDefaults).length > 0) {
    cleanup.push({
      kind: "json-managed-map",
      path: [],
      entries: appliedRootDefaults,
      originals: rootDefaultOriginals,
    });
  }

  for (const operation of artifact.operations) {
    if (operation.kind === "defaults") {
      for (const entry of operation.entries) {
        if (getAtPath(document, entry.path) === undefined) {
          setAtPath(document, entry.path, entry.value);
        }
      }
      continue;
    }
    if (operation.kind === "managed-map") {
      const map = getAtPath(document, operation.path);
      if (map !== undefined && !isRecord(map) && !force) {
        conflicts.push(`JSON path ${operation.path.join(".")} is not an object and is not owned by Canonfig.`);
        continue;
      }
      const object = isRecord(map) ? map : {};
      const originals: JsonManagedMapCleanup["originals"] = {};
      const applied: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(operation.entries)) {
        const existed = Object.prototype.hasOwnProperty.call(object, key);
        const current = object[key];
        originals[key] = existed
          ? { existed: true, value: current }
          : { existed: false };
        if (
          existed
          && !deepEqual(current, value)
          && operation.collision !== "replace"
          && !force
        ) {
          conflicts.push(
            `JSON entry ${[...operation.path, key].join(".")} already exists and is not owned by Canonfig.`,
          );
          continue;
        }
        setAtPath(document, [...operation.path, key], value);
        applied[key] = value;
      }
      if (Object.keys(applied).length > 0) {
        cleanup.push({
          kind: "json-managed-map",
          path: [...operation.path],
          entries: applied,
          originals,
        });
      }
      continue;
    }
    if (operation.kind === "managed-array") {
      const found = getAtPath(document, operation.path);
      if (found !== undefined && !Array.isArray(found) && !force) {
        conflicts.push(`JSON path ${operation.path.join(".")} is not an array and is not owned by Canonfig.`);
        continue;
      }
      const values = Array.isArray(found) ? [...found] : [];
      const added: unknown[] = [];
      for (const value of operation.values) {
        const identity = identityOf(value, operation.identity);
        const existingIndex = values.findIndex((candidate) =>
          operation.identity === undefined
            ? deepEqual(candidate, value)
            : deepEqual(identityOf(candidate, operation.identity), identity)
        );
        if (existingIndex < 0) {
          values.push(value);
          added.push(value);
        } else if (
          operation.identity !== undefined
          && !deepEqual(values[existingIndex], value)
        ) {
          if (!force) {
            conflicts.push(
              `Array entry ${operation.path.join(".")} with ${operation.identity}=${String(identity)} already exists.`,
            );
          } else {
            values[existingIndex] = value;
          }
        }
      }
      setAtPath(document, operation.path, values);
      if (added.length > 0) {
        cleanup.push({
          kind: "json-managed-array",
          path: [...operation.path],
          values: added,
          ...(operation.identity === undefined ? {} : { identity: operation.identity }),
        });
      }
      continue;
    }

    const existingValue = getAtPath(document, operation.path);
    if (existingValue !== undefined && !isRecord(existingValue) && !force) {
      conflicts.push(`JSON path ${operation.path.join(".")} is not an object and is not owned by Canonfig.`);
      continue;
    }
    const existing = isRecord(existingValue) ? existingValue : {};
    const next: Record<string, unknown> = {};
    for (const [event, entries] of Object.entries(existing)) {
      next[event] = Array.isArray(entries)
        ? entries.filter((entry) => !containsMarker(entry, operation.marker))
        : entries;
    }
    const originals: Record<string, { existed: boolean; value?: unknown }> = {};
    for (const [event, entries] of Object.entries(operation.hooks)) {
      originals[event] = Object.prototype.hasOwnProperty.call(existing, event)
        ? { existed: true, value: existing[event] }
        : { existed: false };
      const current = Array.isArray(next[event]) ? next[event] as unknown[] : [];
      next[event] = [...current, ...entries];
    }
    setAtPath(document, operation.path, next);
    cleanup.push({
      kind: "json-managed-hooks",
      path: [...operation.path],
      marker: operation.marker,
      events: Object.keys(operation.hooks),
      originals,
    });
  }
  return { text: serializeJsonDocument(document), cleanup };
}
