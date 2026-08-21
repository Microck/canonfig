import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import type {
  ArtifactOwner,
  ArtifactState,
  CanonfigState,
  DesiredArtifact,
  Diagnostic,
  Plan,
  PlanEntry,
  TargetId,
} from "./types.ts";
import { assertRealPathInside, assertSafeRelativePath, resolveInside } from "./path.ts";
import { readOptionalFile, atomicWrite, removeFileAndEmptyParents } from "./filesystem.ts";
import { loadState, writeState, HARNESS_CONFIGURATION_VERSION } from "./state.ts";
import { renderArtifacts } from "./render.ts";
import { sha256 } from "./hash.ts";
import { CanonfigError } from "./errors.ts";

export interface PlanOptions { force?: boolean; }

function bytesEqual(left: Uint8Array | undefined, right: string | Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined;
  const rightBytes = typeof right === "string" ? Buffer.from(right) : Buffer.from(right);
  return Buffer.from(left).equals(rightBytes);
}

function isTextArtifacts(artifacts: readonly DesiredArtifact[]): boolean {
  return artifacts.every((artifact) => artifact.kind !== "replace" || typeof artifact.content === "string");
}

function selectedOwner(owner: ArtifactOwner, targets: readonly TargetId[]): boolean {
  return owner === "common" || targets.includes(owner);
}

function ownerFor(artifacts: readonly DesiredArtifact[], diagnostics: Diagnostic[], filePath: string): ArtifactOwner {
  const owners = [...new Set(artifacts.map((artifact) => artifact.owner))];
  if (owners.length > 1) {
    diagnostics.push({
      level: "error",
      code: "ARTIFACT_OWNER_COLLISION",
      message: `Multiple owners target ${filePath}: ${owners.join(", ")}`,
      path: filePath,
    });
  }
  return owners[0] ?? "common";
}

function modeFor(artifacts: readonly DesiredArtifact[]): number | undefined {
  const modes = artifacts.flatMap((artifact) => artifact.kind === "replace" && artifact.mode !== undefined ? [artifact.mode] : []);
  return modes[0];
}

export async function createPlan(
  root: string,
  targets: TargetId[],
  artifacts: DesiredArtifact[],
  diagnostics: Diagnostic[] = [],
  options: PlanOptions = {},
): Promise<Plan> {
  const previousState = await loadState(root);
  const nextArtifacts: Record<string, ArtifactState> = {};
  for (const [filePath, state] of Object.entries(previousState.artifacts)) {
    if (!selectedOwner(state.owner, targets)) nextArtifacts[filePath] = state;
  }

  const groups = new Map<string, DesiredArtifact[]>();
  for (const artifact of artifacts) {
    const safePath = assertSafeRelativePath(artifact.path);
    const list = groups.get(safePath) ?? [];
    list.push({ ...artifact, path: safePath } as DesiredArtifact);
    groups.set(safePath, list);
  }

  const entries: PlanEntry[] = [];
  for (const [filePath, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const absolute = resolveInside(root, filePath);
    await assertRealPathInside(root, absolute);
    const currentBytes = await readOptionalFile(absolute);
    const current = isTextArtifacts(group) && currentBytes !== undefined ? Buffer.from(currentBytes).toString("utf8") : currentBytes;
    const previous = previousState.artifacts[filePath];
    const rendered = renderArtifacts(group, current, previous, options.force ?? false);
    const owner = ownerFor(group, diagnostics, filePath);
    const mode = modeFor(group);

    if (rendered.conflicts.length > 0) {
      entries.push({
        path: filePath,
        owner,
        action: "conflict",
        reason: rendered.conflicts.join(" "),
        before: typeof current === "string" ? current : undefined,
        after: typeof rendered.content === "string" ? rendered.content : undefined,
        content: rendered.content,
        binary: rendered.content instanceof Uint8Array,
        ...(mode === undefined ? {} : { mode }),
      });
      if (previous) nextArtifacts[filePath] = previous;
      continue;
    }

    if (rendered.content === undefined) {
      entries.push({ path: filePath, owner, action: currentBytes === undefined ? "unchanged" : "delete" });
      continue;
    }

    const contentHash = sha256(rendered.content);
    const unmanagedIdenticalReplace =
      previous === undefined &&
      currentBytes !== undefined &&
      group.length === 1 &&
      group[0]?.kind === "replace" &&
      contentHash === sha256(currentBytes);

    let nextState: ArtifactState | undefined;
    if (!unmanagedIdenticalReplace) {
      nextState = {
        owner,
        hash: contentHash,
        existedBefore: previous?.existedBefore ?? currentBytes !== undefined,
        cleanup: rendered.cleanup,
        ...(mode === undefined ? {} : { mode }),
      };
      nextArtifacts[filePath] = nextState;
    } else {
      diagnostics.push({
        level: "info",
        code: "UNMANAGED_IDENTICAL",
        message: `${filePath} already matches generated output; Canonfig left ownership unchanged.`,
        path: filePath,
      });
    }

    const action = currentBytes === undefined ? "create" : bytesEqual(currentBytes, rendered.content) ? "unchanged" : "update";
    entries.push({
      path: filePath,
      owner,
      action,
      before: typeof current === "string" ? current : undefined,
      after: typeof rendered.content === "string" ? rendered.content : undefined,
      content: rendered.content,
      binary: rendered.content instanceof Uint8Array,
      ...(mode === undefined ? {} : { mode }),
      ...(nextState === undefined ? {} : { nextState }),
    });
  }

  const desiredPaths = new Set(groups.keys());
  for (const [filePath, previous] of Object.entries(previousState.artifacts)) {
    if (desiredPaths.has(filePath) || !selectedOwner(previous.owner, targets)) continue;
    const absolute = resolveInside(root, filePath);
    await assertRealPathInside(root, absolute);
    const currentBytes = await readOptionalFile(absolute);
    const current = currentBytes === undefined ? undefined : Buffer.from(currentBytes).toString("utf8");
    const rendered = renderArtifacts([], current, previous, options.force ?? false);
    if (rendered.conflicts.length > 0) {
      entries.push({
        path: filePath,
        owner: previous.owner,
        action: "conflict",
        reason: rendered.conflicts.join(" "),
        before: current,
        after: typeof rendered.content === "string" ? rendered.content : undefined,
      });
      nextArtifacts[filePath] = previous;
      continue;
    }

    const cleaned = previous.existedBefore ? rendered.content : undefined;
    if (cleaned === undefined) {
      entries.push({ path: filePath, owner: previous.owner, action: currentBytes === undefined ? "unchanged" : "delete", before: current });
    } else {
      const action = bytesEqual(currentBytes, cleaned) ? "unchanged" : currentBytes === undefined ? "create" : "update";
      entries.push({
        path: filePath,
        owner: previous.owner,
        action,
        before: current,
        after: typeof cleaned === "string" ? cleaned : undefined,
        content: cleaned,
        binary: cleaned instanceof Uint8Array,
        ...(previous.mode === undefined ? {} : { mode: previous.mode }),
      });
    }
  }

  const nextState: CanonfigState = {
    version: 1,
    generatedAt: new Date().toISOString(),
    canonfigVersion: HARNESS_CONFIGURATION_VERSION,
    artifacts: Object.fromEntries(Object.entries(nextArtifacts).sort(([left], [right]) => left.localeCompare(right))),
  };
  return { root, targets, entries: entries.sort((a, b) => a.path.localeCompare(b.path)), diagnostics, nextState };
}

interface MissingFileSnapshot {
  path: string;
  kind: "missing";
}

interface RegularFileSnapshot {
  path: string;
  kind: "file";
  content: Uint8Array;
  mode: number;
}

interface SymlinkSnapshot {
  path: string;
  kind: "symlink";
  linkTarget: string;
}

type FileSnapshot = MissingFileSnapshot | RegularFileSnapshot | SymlinkSnapshot;

async function snapshotFile(root: string, relativePath: string): Promise<FileSnapshot> {
  const absolute = resolveInside(root, relativePath);
  try {
    const stats = await fs.lstat(absolute);
    if (stats.isSymbolicLink()) {
      return { path: relativePath, kind: "symlink", linkTarget: await fs.readlink(absolute) };
    }
    return {
      path: relativePath,
      kind: "file",
      content: await fs.readFile(absolute),
      mode: stats.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: relativePath, kind: "missing" };
    throw error;
  }
}

async function restoreSnapshots(root: string, snapshots: readonly FileSnapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    const absolute = resolveInside(root, snapshot.path);
    if (snapshot.kind === "missing") {
      await removeFileAndEmptyParents(absolute, root);
    } else if (snapshot.kind === "symlink") {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.rm(absolute, { force: true });
      await fs.symlink(snapshot.linkTarget, absolute);
    } else {
      await atomicWrite(absolute, snapshot.content, snapshot.mode);
    }
  }
}

export async function applyPlan(plan: Plan): Promise<void> {
  const conflicts = plan.entries.filter((entry) => entry.action === "conflict");
  const errors = plan.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (conflicts.length > 0 || errors.length > 0) {
    throw new CanonfigError("PLAN_CONFLICT", `Plan has ${conflicts.length} conflict(s) and ${errors.length} error diagnostic(s).`);
  }

  const mutableEntries = plan.entries.filter((entry) =>
    entry.action === "create" || entry.action === "update" || entry.action === "delete"
  );
  const snapshots: FileSnapshot[] = [];
  for (const entry of mutableEntries) {
    const absolute = resolveInside(plan.root, entry.path);
    await assertRealPathInside(plan.root, absolute);
    snapshots.push(await snapshotFile(plan.root, entry.path));
  }

  try {
    for (const entry of mutableEntries) {
      const absolute = resolveInside(plan.root, entry.path);
      if (entry.action === "create" || entry.action === "update") {
        if (entry.after === undefined && !entry.binary) {
          throw new CanonfigError("PLAN_INVALID", `Missing output content for ${entry.path}`);
        }
        const content = entry.content ?? entry.after;
        if (content === undefined) throw new CanonfigError("PLAN_INVALID", `Missing output content for ${entry.path}`);
        await atomicWrite(absolute, content, entry.mode);
      } else {
        await removeFileAndEmptyParents(absolute, plan.root);
      }
    }
    await writeState(plan.root, plan.nextState);
  } catch (error) {
    try {
      await restoreSnapshots(plan.root, snapshots);
    } catch (rollbackError) {
      throw new CanonfigError(
        "APPLY_ROLLBACK_FAILED",
        `Harness apply failed and rollback also failed: ${String(rollbackError)}`,
        error,
      );
    }
    throw error;
  }
}
