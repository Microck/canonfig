import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Schema } from "effect";
import { applyEdits, modify } from "jsonc-parser";
import { decodeMachineProfileJsonc, type ProfileResourceInput } from "../domain/profile.ts";
import { parseJsonc } from "./profile-codec.ts";
import { CanonfigError } from "../harness-configuration/core/errors.ts";
import { assertNoSymlinkPathComponents, atomicWrite } from "../harness-configuration/core/filesystem.ts";

const Observation = Schema.Struct({
  id: Schema.String, directory: Schema.String, identity: Schema.String,
  parentDevice: Schema.String, parentInode: Schema.String,
});
const ObservationState = Schema.Struct({ version: Schema.Literal(1), profileId: Schema.String, skills: Schema.Array(Observation) });
type ObservationState = typeof ObservationState.Type;
type Observation = typeof Observation.Type;

export interface SkillReconciliationResult {
  readonly applied: boolean;
  readonly removed: readonly string[];
  readonly observed: readonly string[];
  readonly skipped: readonly string[];
  readonly backup?: string | undefined;
}

const identity = (resource: ProfileResourceInput): string => createHash("sha256").update(JSON.stringify(resource)).digest("hex");
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Only complete, source-backed skill trees have an unambiguous source directory.
 * Inline, mixed-source, symlink and outside-profile-directory resources are skipped. */
function skillDirectory(root: string, resource: ProfileResourceInput): string | undefined {
  if (resource.kind !== "skill" || resource.spec.kind !== "skill") return undefined;
  const marker = resource.spec.files.find((file) => file.path === "SKILL.md");
  if (!marker?.source || marker.content !== undefined || marker.symlinkTo !== undefined) return undefined;
  const directory = path.dirname(path.resolve(root, marker.source));
  if (!inside(root, directory)) return undefined;
  for (const file of resource.spec.files) {
    const expected = path.resolve(directory, file.path);
    if (!file.source || file.content !== undefined || file.symlinkTo !== undefined
      || !inside(directory, expected) || path.resolve(root, file.source) !== expected) return undefined;
  }
  return directory;
}

async function readRegular(file: string, optional = false): Promise<string | undefined> {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new CanonfigError("PROFILE_SKILL_RECONCILE_INVALID", "Profile and observation state must be regular files of at most 4 MiB");
  return fs.readFile(file, "utf8");
}

export interface ReconciliationOperations { readonly write: typeof atomicWrite; readonly beforeCommit?: (() => Promise<void>) | undefined }
const operations: ReconciliationOperations = { write: atomicWrite };

/** Reconcile only deletions observed after explicit initialization. Writes an
 * authored profile and private backup, never signs/publishes or deletes a skill. */
export async function reconcileSourceSkills(input: string, apply: boolean, run: ReconciliationOperations = operations): Promise<SkillReconciliationResult> {
  const inputPath = path.resolve(input);
  const root = await fs.realpath(path.dirname(inputPath));
  const file = path.join(root, path.basename(inputPath));
  const stateFile = `${file}.skills-observed.json`;
  const lockFile = `${file}.skills-reconcile.lock`;
  let lock;
  if (apply) {
    try { lock = await fs.open(lockFile, "wx", 0o600); }
    catch { throw new CanonfigError("PROFILE_SKILL_RECONCILE_LOCKED", "Another reconciliation or interrupted operation holds the profile lock; inspect it before removing a stale lock"); }
  }
  try {
    const original = await readRegular(file);
    if (original === undefined) throw new CanonfigError("PROFILE_SKILL_RECONCILE_INVALID", "Profile file is missing");
    const profile = parseProfile(original);
    const stateText = await readRegular(stateFile, true);
    const state: ObservationState = stateText === undefined
      ? { version: 1, profileId: profile.id, skills: [] }
      : parseObservationState(stateText);
    if (state.profileId !== profile.id) throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "Observation state belongs to a different profile; inspect it before initializing a new one");
    const observed: Observation[] = []; const removed: string[] = []; const skipped: string[] = [];
    for (const resource of profile.resources) {
      if (resource.kind !== "skill") continue;
      const directory = skillDirectory(root, resource);
      if (directory === undefined) { skipped.push(resource.id); continue; }
      await assertNoSymlinkPathComponents(root, directory);
      // A missing/replaced parent can mean an unavailable mount, not deletion.
      const parent = await fs.lstat(path.dirname(directory), { bigint: true });
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "Skill parent directory is unavailable or unsafe; nothing was reconciled");
      const relative = path.relative(root, directory).split(path.sep).join("/");
      const current: Observation = { id: resource.id, directory: relative, identity: identity(resource), parentDevice: String(parent.dev), parentInode: String(parent.ino) };
      let stat;
      try { stat = await fs.lstat(directory); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (stat === undefined) {
        const previous = state.skills.find((skill) => skill.id === resource.id);
        if (!previous || previous.directory !== relative || previous.identity !== current.identity
          || previous.parentDevice !== current.parentDevice || previous.parentInode !== current.parentInode) {
          throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "Missing skill has no matching prior observation, its profile declaration changed, or its parent changed; nothing was reconciled");
        }
        removed.push(resource.id);
      } else {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "Skill source is no longer a regular directory; nothing was reconciled");
        await assertNoSymlinkPathComponents(root, path.join(directory, "SKILL.md"));
        if (await readRegular(path.join(directory, "SKILL.md"), true) === undefined) throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "SKILL.md is missing but its directory remains; this is not an unambiguous skill deletion");
        observed.push(current);
      }
    }
    // The domain decoder sorts resources by ID; edits must address the original
    // JSONC array, not the normalized profile's positions.
    const authored = Schema.decodeUnknownSync(Schema.Struct({
      resources: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
    }))(parseJsonc(original));
    const removedIds = new Set(removed);
    const removedIndices = (authored.resources ?? []).flatMap((resource, index) => removedIds.has(resource.id) ? [index] : []);
    let next = original;
    for (const index of removedIndices.reverse()) next = applyEdits(next, modify(next, ["resources", index], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    // Dangling dependencies or other invalid combinations block the whole edit.
    parseProfile(next);
    if (!apply) return { applied: false, removed, observed: observed.map((skill) => skill.id), skipped };
    await run.beforeCommit?.();
    if (await readRegular(file) !== original || await readRegular(stateFile, true) !== stateText) throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "Profile or observation state changed during reconciliation; nothing was written");
    // Recheck absence immediately before committing the profile edit.
    for (const id of removed) {
      const record = state.skills.find((skill) => skill.id === id);
      if (!record) throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "Deletion observation changed");
      const candidate = path.join(root, record.directory);
      await assertNoSymlinkPathComponents(root, candidate);
      const parent = await fs.lstat(path.dirname(candidate), { bigint: true });
      if (!parent.isDirectory() || parent.isSymbolicLink() || String(parent.dev) !== record.parentDevice || String(parent.ino) !== record.parentInode) throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "Skill parent changed before commit; nothing was written");
      try { await fs.lstat(candidate); throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", "A removed skill reappeared; nothing was written"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    let backup: string | undefined;
    if (next !== original) {
      backup = `${file}.skills-backup-${randomUUID()}.jsonc`;
      await fs.writeFile(backup, original, { flag: "wx", mode: 0o600 });
      if (await readRegular(file) !== original || await readRegular(stateFile, true) !== stateText) throw new CanonfigError("PROFILE_SKILL_RECONCILE_CONFLICT", `Profile or observation state changed during backup; nothing was replaced. Backup: ${backup}`);
      await run.write(file, next, undefined, root);
      for (const id of removed) {
        const record = state.skills.find((skill) => skill.id === id);
        if (record === undefined) continue;
        try { await fs.lstat(path.join(root, record.directory)); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw new CanonfigError("PROFILE_SKILL_RECONCILE_RECOVERY", `Profile was updated and backed up at ${backup}, but skill absence could not be verified; observation state was not refreshed. Inspect before retrying`);
        }
        throw new CanonfigError("PROFILE_SKILL_RECONCILE_RECOVERY", `Profile was updated and backed up at ${backup}, but removed skill ${id} reappeared during commit; observation state was not refreshed. Compare the backup and current profile before retrying; no automatic restore was attempted`);
      }
    }
    // If interrupted after profile commit, the old observation is harmless:
    // already removed resource IDs are absent and disappear on the next pass.
    try { await run.write(stateFile, JSON.stringify({ version: 1, profileId: profile.id, skills: observed }, null, 2) + "\n", 0o600, root); }
    catch { throw new CanonfigError("PROFILE_SKILL_RECONCILE_RECOVERY", backup ? `Profile was updated and backed up at ${backup}, but observation refresh failed; inspect before retrying` : "Could not record skill observations; profile was not changed"); }
    return { applied: true, removed, observed: observed.map((skill) => skill.id), skipped, backup };
  } finally {
    if (lock !== undefined) { await lock.close(); await fs.unlink(lockFile); }
  }
}

function parseProfile(text: string) {
  try { return decodeMachineProfileJsonc(text); }
  catch { throw new CanonfigError("PROFILE_SKILL_RECONCILE_INVALID", "Authored profile is invalid (including resource dependencies); inspect it locally before reconciliation"); }
}
function parseObservationState(text: string): ObservationState {
  try { return Schema.decodeUnknownSync(Schema.fromJsonString(ObservationState))(text); }
  catch { throw new CanonfigError("PROFILE_SKILL_RECONCILE_INVALID", "Skill observation state is invalid; it was not reset or overwritten"); }
}
