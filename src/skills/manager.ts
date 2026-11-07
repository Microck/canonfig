import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { CanonfigError } from "./errors.ts";
import { assertNoSymlinkPathComponents, atomicWrite, ensureDirectoryNoFollow } from "./filesystem.ts";
import { fetchSkill, fingerprint, inventory, normalizeSource, readLocalSkill, safePath, validateSource, type SkillFile, type SkillSource } from "./upstream.ts";

export interface TrackedSkill extends SkillSource { name: string; path: string; commit: string; digest: string }
export interface SkillConfig { version: 1; skills: TrackedSkill[] }
export interface SkillLocation { root: string; config: string }
export interface SkillCheck { name: string; path: string; previousCommit: string; nextCommit: string; status: "unchanged" | "update-available" | "local-edits"; added: string[]; changed: string[]; removed: string[] }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CanonfigError("SKILL_CONFIG_INVALID", "Expected a configuration object");
  return value as Record<string, unknown>;
}
export function parseConfig(input: unknown): SkillConfig {
  const value = object(input);
  if (value.version !== 1 || !Array.isArray(value.skills) || Object.keys(value).some((key) => key !== "version" && key !== "skills")) throw new CanonfigError("SKILL_CONFIG_INVALID", "Expected version 1 and skills array");
  const names = new Set<string>();
  const paths: string[] = [];
  const skills = value.skills.map((item): TrackedSkill => {
    const entry = object(item);
    const fields = ["name", "path", "source", "ref", "subdir", "commit", "digest"];
    if (fields.some((key) => typeof entry[key] !== "string") || Object.keys(entry).some((key) => !fields.includes(key))) throw new CanonfigError("SKILL_CONFIG_INVALID", "Skill source fields must be exactly name, path, source, ref, subdir, commit and digest");
    const skill = entry as unknown as TrackedSkill;
    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(skill.name) || names.has(skill.name.toLowerCase())) throw new CanonfigError("SKILL_NAME_CONFLICT", "Skill names must be unique simple identifiers");
    names.add(skill.name.toLowerCase());
    const relative = safePath(skill.path).normalize("NFC").toLowerCase();
    if (paths.some((other) => relative === other || relative.startsWith(`${other}/`) || other.startsWith(`${relative}/`))) throw new CanonfigError("SKILL_PATH_CONFLICT", "Tracked skill directories cannot overlap");
    paths.push(relative);
    if (!/^[a-f0-9]{40,64}$/u.test(skill.commit) || !/^[a-f0-9]{64}$/u.test(skill.digest)) throw new CanonfigError("SKILL_CONFIG_INVALID", "Invalid recorded commit or content digest");
    normalizeSource(skill.source, process.cwd());
    validateSource(skill);
    return { ...skill };
  });
  return { version: 1, skills };
}
function configPath(location: SkillLocation): string {
  return path.join(location.root, safePath(location.config));
}
async function readConfig(location: SkillLocation): Promise<SkillConfig> {
  const file = configPath(location);
  await assertNoSymlinkPathComponents(location.root, file);
  try {
    const stat = await fs.stat(file);
    if (stat.size > 1024 * 1024) throw new CanonfigError("SKILL_CONFIG_INVALID", "Skill configuration exceeds 1 MiB");
    return parseConfig(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, skills: [] };
    if (error instanceof CanonfigError) throw error;
    throw new CanonfigError("SKILL_CONFIG_INVALID", "Could not parse skill source configuration; it was not reset or overwritten");
  }
}
function checkDestination(location: SkillLocation, skill: TrackedSkill): void {
  const destination = safePath(skill.path).normalize("NFC").toLowerCase();
  const config = safePath(location.config).normalize("NFC").toLowerCase();
  if (config === destination || config.startsWith(`${destination}/`) || destination.startsWith(`${config}/`)) throw new CanonfigError("SKILL_PATH_CONFLICT", "A skill directory cannot contain its source configuration");
}
async function writeConfig(location: SkillLocation, config: SkillConfig, write = atomicWrite): Promise<void> {
  const validated = parseConfig(config);
  for (const skill of validated.skills) checkDestination(location, skill);
  await write(configPath(location), JSON.stringify(validated, null, 2) + "\n", 0o600, location.root);
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function withLock<T>(location: SkillLocation, action: () => Promise<T>): Promise<T> {
  const lock = `${configPath(location)}.lock`;
  await ensureDirectoryNoFollow(location.root, path.dirname(lock));
  await assertNoSymlinkPathComponents(location.root, lock);
  let handle;
  try { handle = await fs.open(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CanonfigError("SKILL_LOCK_CONFLICT", "Another update or interrupted operation holds the skill lock. Inspect the lock and recovery journal before removing a stale lock");
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    if (await exists(`${configPath(location)}.pending`)) {
      let phase = "The journal has no trustworthy phase (including released version 1 journals)";
      try {
        const journal = Schema.decodeUnknownSync(SkillTransaction)(JSON.parse(await fs.readFile(`${configPath(location)}.pending`, "utf8")));
        phase = `The recorded transaction phase is ${journal._tag}; swap phases are ${journal.swaps.map((swap) => `${swap.path}: ${swap._tag}`).join(", ")}`;
      } catch { /* Old or unreadable journals require the same conservative manual recovery. */ }
      throw new CanonfigError("SKILL_RECOVERY_REQUIRED", `A previous update left a .pending recovery journal. ${phase}. Preserve the journal and backups, compare installed trees and source configuration with the recorded digests, and finish or restore that update manually before removing the journal and any stale lock`);
    }
    return await action();
  } finally { await handle.close(); await fs.unlink(lock); }
}
export async function listSkills(location: SkillLocation): Promise<SkillConfig> { return readConfig(location); }
export async function trackSkill(location: SkillLocation, input: SkillSource & { name: string; path: string }): Promise<TrackedSkill> {
  return withLock(location, async () => {
    const config = await readConfig(location);
    const source = normalizeSource(input.source, location.root);
    const fetched = await fetchSkill({ ...input, source });
    const skill: TrackedSkill = { ...input, source, commit: fetched.commit, digest: fingerprint(fetched.files) };
    const candidate = parseConfig({ version: 1, skills: [...config.skills, skill] });
    checkDestination(location, skill);
    const local = await readLocalSkill(location.root, skill.path);
    if (fingerprint(local) !== skill.digest) throw new CanonfigError("SKILL_LOCAL_EDITED", "Installed skill differs from the specified upstream revision; tracking refuses to adopt or overwrite unexplained local edits. Select its original ref or reconcile it first");
    if (JSON.stringify(await readConfig(location)) !== JSON.stringify(config)) throw new CanonfigError("SKILL_CONFIG_EDITED", "Source configuration changed during tracking; nothing was recorded");
    await writeConfig(location, candidate);
    return skill;
  });
}
interface Prepared { skill: TrackedSkill; check: SkillCheck; files: SkillFile[]; digest: string }
async function prepare(location: SkillLocation, config: SkillConfig, names: readonly string[]): Promise<Prepared[]> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const name of wanted) if (!config.skills.some((skill) => skill.name.toLowerCase() === name)) throw new CanonfigError("SKILL_NAME_NOT_FOUND", `Skill is not tracked: ${name}`);
  const result: Prepared[] = [];
  for (const skill of config.skills) {
    if (wanted.size && !wanted.has(skill.name.toLowerCase())) continue;
    checkDestination(location, skill);
    const local = await readLocalSkill(location.root, skill.path);
    const fetched = await fetchSkill({ ...skill, source: normalizeSource(skill.source, location.root) });
    const digest = fingerprint(fetched.files);
    const before = inventory(local); const after = inventory(fetched.files);
    result.push({ skill, files: fetched.files, digest, check: {
      name: skill.name, path: skill.path, previousCommit: skill.commit, nextCommit: fetched.commit,
      status: fingerprint(local) !== skill.digest ? "local-edits" : digest === skill.digest ? "unchanged" : "update-available",
      added: Object.keys(after).filter((key) => !Object.hasOwn(before, key)),
      removed: Object.keys(before).filter((key) => !Object.hasOwn(after, key)),
      changed: Object.keys(after).filter((key) => Object.hasOwn(before, key) && before[key] !== after[key]),
    } });
  }
  return result;
}
export async function checkSkills(location: SkillLocation, names: readonly string[]): Promise<SkillCheck[]> {
  return (await prepare(location, await readConfig(location), names)).map((item) => item.check);
}

/** Injectable transaction boundary; defaults always use the real filesystem. */
export interface SkillUpdateOperations {
  rename: typeof fs.rename;
  remove: typeof fs.rm;
  writeFile: typeof fs.writeFile;
  writeAtomic: typeof atomicWrite;
}
export const skillUpdateOperations: SkillUpdateOperations = {
  rename: fs.rename, remove: fs.rm, writeFile: fs.writeFile, writeAtomic: atomicWrite,
};

const swapFields = {
  path: Schema.String, staged: Schema.String, backup: Schema.String,
  previousDigest: Schema.String, expectedDigest: Schema.String,
};
const SkillSwap = Schema.TaggedUnion({
  Staging: swapFields,
  Staged: swapFields,
  MovingOld: swapFields,
  OldMoved: swapFields,
  Installing: swapFields,
  Installed: swapFields,
  RemovingNew: swapFields,
  Restoring: swapFields,
  Restored: swapFields,
  RecoveryRequired: { ...swapFields, cause: Schema.String },
});
type SkillSwap = typeof SkillSwap.Type;
const transactionFields = {
  version: Schema.Literal(2),
  previousConfig: Schema.Struct({
    version: Schema.Literal(1),
    skills: Schema.Array(Schema.Struct({
      name: Schema.String, path: Schema.String, source: Schema.String,
      ref: Schema.String, subdir: Schema.String, commit: Schema.String, digest: Schema.String,
    })),
  }),
  swaps: Schema.Array(SkillSwap),
};
const SkillTransaction = Schema.TaggedUnion({
  Preparing: transactionFields,
  Swapping: transactionFields,
  PublishingConfig: transactionFields,
  ConfigCommitted: transactionFields,
  RollingBack: transactionFields,
  Finished: transactionFields,
});
type SkillTransaction = typeof SkillTransaction.Type;
type SkillTransition =
  | { readonly _tag: "Record" }
  | { readonly _tag: "Transaction"; readonly phase: SkillTransaction["_tag"] }
  | { readonly _tag: "Swap"; readonly index: number; readonly phase: Exclude<SkillSwap["_tag"], "RecoveryRequired"> }
  | { readonly _tag: "Recovery"; readonly index: number; readonly cause: string };

function swapTransitionAllowed(transaction: SkillTransaction["_tag"], from: SkillSwap["_tag"], to: SkillSwap["_tag"]): boolean {
  switch (transaction) {
    case "Preparing":
      return from === "Staging" && to === "Staged";
    case "Swapping":
      switch (from) {
        case "Staged": return to === "MovingOld";
        case "MovingOld": return to === "OldMoved" || to === "Staged";
        case "OldMoved": return to === "Installing";
        case "Installing": return to === "Installed" || to === "OldMoved";
        default: return false;
      }
    case "RollingBack":
      if (to === "RecoveryRequired") return from !== "RecoveryRequired";
      switch (from) {
        case "Staging":
        case "Staged":
        case "Restoring": return to === "Restored";
        case "OldMoved": return to === "Restoring";
        case "Installed": return to === "RemovingNew";
        case "RemovingNew": return to === "OldMoved";
        default: return false;
      }
    default:
      return false;
  }
}
const transactionTransitions = {
  Preparing: ["Swapping", "RollingBack"],
  Swapping: ["PublishingConfig", "RollingBack"],
  PublishingConfig: ["ConfigCommitted", "RollingBack"],
  ConfigCommitted: ["Finished"],
  RollingBack: ["Finished"],
  Finished: [],
} satisfies Readonly<Record<SkillTransaction["_tag"], ReadonlyArray<SkillTransaction["_tag"]>>>;
export async function updateSkills(location: SkillLocation, names: readonly string[], operations: SkillUpdateOperations = skillUpdateOperations, validateSelection?: (config: SkillConfig) => void): Promise<SkillCheck[]> {
  return withLock(location, async () => {
    const original = await readConfig(location);
    validateSelection?.(original);
    const prepared = await prepare(location, original, names);
    if (prepared.some((item) => item.check.status === "local-edits")) throw new CanonfigError("SKILL_LOCAL_EDITED", "Local edits detected. No skill was updated; check the preview and reconcile changes before applying");
    const changed = prepared.filter((item) => item.check.status === "update-available");
    if (!changed.length) return prepared.map((item) => item.check);
    const swaps: SkillSwap[] = [];
    for (const item of changed) {
      const destination = path.join(location.root, item.skill.path);
      await assertNoSymlinkPathComponents(location.root, destination);
      const suffix = randomUUID();
      swaps.push({
        _tag: "Staging", path: item.skill.path,
        staged: path.relative(location.root, `${destination}.canonfig-stage-${suffix}`),
        backup: path.relative(location.root, `${destination}.canonfig-backup-${suffix}`),
        previousDigest: item.skill.digest, expectedDigest: item.digest,
      });
    }
    const journal = `${configPath(location)}.pending`;
    let transaction = Schema.decodeUnknownSync(SkillTransaction)({ _tag: "Preparing", version: 2, previousConfig: original, swaps });
    const swapAt = (index: number): SkillSwap => {
      const swap = transaction.swaps[index];
      if (swap === undefined) throw new CanonfigError("SKILL_TRANSITION_INVALID", `Unknown skill swap ${index}`);
      return swap;
    };
    // This is the only writer of transaction and per-skill lifecycle state.
    // Intent phases precede renames so a crash never claims a rename did not run.
    const transition = async (event: SkillTransition): Promise<void> => {
      if (event._tag === "Transaction") {
        if (!transactionTransitions[transaction._tag].some((phase) => phase === event.phase)
          || event.phase === "Swapping" && transaction.swaps.some((swap) => swap._tag !== "Staged")
          || event.phase === "PublishingConfig" && transaction.swaps.some((swap) => swap._tag !== "Installed")
          || event.phase === "Finished" && transaction._tag === "RollingBack" && transaction.swaps.some((swap) => swap._tag !== "Restored")) {
          throw new CanonfigError("SKILL_TRANSITION_INVALID", `Cannot transition skill transaction from ${transaction._tag} to ${event.phase}`);
        }
        if (event.phase === "Finished") {
          const next: SkillTransaction = { ...transaction, _tag: "Finished" };
          await operations.writeAtomic(journal, JSON.stringify(next, null, 2) + "\n", 0o600, location.root);
          transaction = next;
          return;
        }
        transaction = { ...transaction, _tag: event.phase };
      } else if (event._tag === "Swap" || event._tag === "Recovery") {
        const previous = transaction.swaps[event.index];
        const phase = event._tag === "Recovery" ? "RecoveryRequired" : event.phase;
        if (previous === undefined
          || !swapTransitionAllowed(transaction._tag, previous._tag, phase)) {
          throw new CanonfigError("SKILL_TRANSITION_INVALID", `Cannot transition skill swap to ${phase} in ${transaction._tag}`);
        }
        const { _tag: _, ...fields } = previous;
        const next: SkillSwap = event._tag === "Recovery"
          ? { ...fields, _tag: "RecoveryRequired", cause: event.cause }
          : { ...fields, _tag: event.phase };
        transaction = { ...transaction, swaps: transaction.swaps.map((swap, index) => index === event.index ? next : swap) };
      }
      await operations.writeAtomic(journal, JSON.stringify(transaction, null, 2) + "\n", 0o600, location.root);
    };
    await transition({ _tag: "Record" });
    try {
      for (const [index, item] of changed.entries()) {
        const swap = swapAt(index);
        const destination = path.join(location.root, swap.path);
        const staged = path.join(location.root, swap.staged);
        const originalDirectoryMode = (await fs.stat(destination)).mode & 0o777;
        await fs.mkdir(staged, { mode: 0o700 });
        for (const file of item.files) {
          const target = path.join(staged, safePath(file.path));
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const previous = path.join(destination, file.path);
          const previousStat = await fs.lstat(previous).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
          const permissions = previousStat?.isFile() ? (previousStat.mode & 0o666) : 0o600;
          const mode = permissions | (file.executable ? ((permissions & 0o444) >> 2) : 0);
          await operations.writeFile(target, file.bytes, { flag: "wx", mode });
          if (process.platform !== "win32") await fs.chmod(target, mode);
        }
        if (process.platform !== "win32") await fs.chmod(staged, originalDirectoryMode);
        if (fingerprint(await readLocalSkill(location.root, path.relative(location.root, staged).split(path.sep).join("/"))) !== item.digest) throw new CanonfigError("SKILL_VERIFY_FAILED", "Staged skill did not match fetched content");
        await transition({ _tag: "Swap", index, phase: "Staged" });
      }
      if (JSON.stringify(await readConfig(location)) !== JSON.stringify(original)) throw new CanonfigError("SKILL_CONFIG_EDITED", "Source configuration changed while updates were prepared");
      await transition({ _tag: "Transaction", phase: "Swapping" });
      for (const [index, swap] of transaction.swaps.entries()) {
        const destination = path.join(location.root, swap.path);
        const backup = path.join(location.root, swap.backup);
        await assertNoSymlinkPathComponents(location.root, destination);
        if (fingerprint(await readLocalSkill(location.root, swap.path)) !== swap.previousDigest) throw new CanonfigError("SKILL_LOCAL_EDITED", "Skill changed while update was staged; refusing replacement");
        await transition({ _tag: "Swap", index, phase: "MovingOld" });
        try { await operations.rename(destination, backup); }
        catch (error) { await transition({ _tag: "Swap", index, phase: "Staged" }); throw error; }
        await transition({ _tag: "Swap", index, phase: "OldMoved" });
        if (fingerprint(await readLocalSkill(location.root, swap.backup.split(path.sep).join("/"))) !== swap.previousDigest) throw new CanonfigError("SKILL_LOCAL_EDITED", "Skill changed during replacement; restoring its backup");
        await transition({ _tag: "Swap", index, phase: "Installing" });
        try { await operations.rename(path.join(location.root, swap.staged), destination); }
        catch (error) { await transition({ _tag: "Swap", index, phase: "OldMoved" }); throw error; }
        await transition({ _tag: "Swap", index, phase: "Installed" });
      }
      const next: SkillConfig = { version: 1, skills: original.skills.map((skill) => {
        const updated = changed.find((item) => item.skill.name === skill.name);
        return updated ? { ...skill, commit: updated.check.nextCommit, digest: updated.digest } : skill;
      }) };
      if (JSON.stringify(await readConfig(location)) !== JSON.stringify(original)) throw new CanonfigError("SKILL_CONFIG_EDITED", "Source configuration changed during update; restoring installed skills");
      await transition({ _tag: "Transaction", phase: "PublishingConfig" });
      await writeConfig(location, next, operations.writeAtomic);
      await transition({ _tag: "Transaction", phase: "ConfigCommitted" });
      await transition({ _tag: "Transaction", phase: "Finished" });
    } catch (error) {
      // Never roll back installed bytes once the source configuration committed.
      if (transaction._tag === "ConfigCommitted" || transaction._tag === "Finished") {
        throw new CanonfigError("SKILL_RECOVERY_REQUIRED", `Skill configuration committed but recovery bookkeeping failed. Preserve installed skills and inspect ${location.config}.pending`);
      }
      await transition({ _tag: "Transaction", phase: "RollingBack" });
      for (let index = transaction.swaps.length - 1; index >= 0; index--) {
        const swap = swapAt(index);
        const destination = path.join(location.root, swap.path);
        try {
          if (swap._tag === "Installed") {
            if (fingerprint(await readLocalSkill(location.root, swap.path)) !== swap.expectedDigest) throw new Error("New local edits require manual recovery");
            await transition({ _tag: "Swap", index, phase: "RemovingNew" });
            await operations.remove(destination, { recursive: true });
            await transition({ _tag: "Swap", index, phase: "OldMoved" });
          }
          const current = swapAt(index);
          if (current._tag === "OldMoved") {
            await transition({ _tag: "Swap", index, phase: "Restoring" });
            await operations.rename(path.join(location.root, swap.backup), destination);
          } else if (current._tag !== "Staging" && current._tag !== "Staged") {
            throw new Error(`Interrupted ${current._tag} needs manual recovery`);
          }
          await transition({ _tag: "Swap", index, phase: "Restored" });
        } catch (cause) {
          await transition({ _tag: "Recovery", index, cause: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      if (transaction.swaps.some((swap) => swap._tag === "RecoveryRequired")) {
        throw new CanonfigError("SKILL_RECOVERY_REQUIRED", `Update stopped and rollback needs manual recovery. Backups are preserved; inspect ${location.config}.pending`);
      }
      await transition({ _tag: "Transaction", phase: "Finished" });
      throw error;
    } finally {
      if (transaction._tag === "Finished") {
        for (const swap of transaction.swaps) {
          try { await operations.remove(path.join(location.root, swap.staged), { recursive: true, force: true }); }
          catch { /* Best-effort cleanup must not mask the transaction result. */ }
          if (swap._tag === "Installed") {
            try { await operations.remove(path.join(location.root, swap.backup), { recursive: true, force: true }); }
            catch { /* Retain the backup without preventing journal cleanup. */ }
          }
        }
        if (await exists(journal)) await fs.unlink(journal);
      }
    }
    return prepared.map((item) => item.check);
  });
}
