import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CanonfigError } from "../skills/errors.ts";

const contains = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate);
  return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
};
const managedRoot = () => join(homedir(), ".canonfig");

/** Rebase paths that will be created under an existing, possibly linked directory. */
async function realPathForWrite(path: string, allowInaccessible = false): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (!(error instanceof Error && "code" in error) || parent === path) throw error;
    const missing = error.code === "ENOENT" || error.code === "ENOTDIR";
    const inaccessible = error.code === "EACCES" || error.code === "EPERM";
    if (!missing && !(allowInaccessible && inaccessible)) throw error;
    return join(await realPathForWrite(parent, allowInaccessible), basename(path));
  }
}

export async function guardStateOverlap(folder: string, target: string, allowInaccessibleDestination = false): Promise<boolean> {
  const authored = resolve(folder);
  const managed = managedRoot();
  const destination = resolve(target);
  const [realAuthored, realManaged, realDestination] = await Promise.all([
    realPathForWrite(authored), realPathForWrite(managed), realPathForWrite(destination, allowInaccessibleDestination),
  ]);
  const candidates = [destination.toLowerCase(), realDestination.toLowerCase()];
  // A directory resource can own an ancestor of the protected state as well.
  // Keep checking the name of a protected entry even if it is itself a link.
  return [authored, managed, realAuthored, realManaged].some((root) =>
    ["guard.jsonc", ".guard"].some((leaf) => {
      const protectedPath = resolve(root, leaf).toLowerCase();
      return candidates.some((candidate) => contains(protectedPath, candidate) || contains(candidate, protectedPath));
    }));
}

export const guardTargetOverlap = (folder: string, target: string): Promise<boolean> =>
  guardStateOverlap(folder, resolve(homedir(), target.slice(2)));

/** The Source may only be able to resolve a prefix of a Follower's destination. */
export const guardPublicationTargetOverlap = (folder: string, target: string): Promise<boolean> =>
  guardStateOverlap(folder, resolve(homedir(), target.slice(2)), true);

export async function isManagedFollower(root: string): Promise<boolean> {
  const { enrolledFollowerRow } = await import("../runtime/credential-policy.ts");
  return enrolledFollowerRow(join(root, "state.sqlite")) !== undefined;
}

export async function refuseManagedFollowerRoot(root: string, targets: readonly string[] = []): Promise<void> {
  const managed = managedRoot();
  const [realRoot, realManaged] = await Promise.all([realPathForWrite(resolve(root)), realPathForWrite(managed)]);
  const touchesMirror = contains(realManaged, realRoot) ||
    (await Promise.all(targets.map((target) => realPathForWrite(resolve(root, target))))).some((target) =>
      contains(realManaged, target) || contains(target, realManaged));
  if (touchesMirror && await isManagedFollower(managed)) {
    throw new CanonfigError("SKILL_FOLLOWER_NOT_ALLOWED", "The enrolled Follower's managed mirror is read-only. Update skills on the Source and publish.");
  }
}
