import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CanonfigError } from "../core/errors.ts";
import { assertNoSymlinkPathComponents, atomicWrite, ensureDirectoryNoFollow } from "../core/filesystem.ts";
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
    if (await exists(`${configPath(location)}.pending`)) throw new CanonfigError("SKILL_RECOVERY_REQUIRED", "A previous update left a .pending recovery journal. Inspect its recorded backups and configuration before another update; the previous operation may have changed installed data");
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

export async function updateSkills(location: SkillLocation, names: readonly string[], operations: SkillUpdateOperations = skillUpdateOperations, validateSelection?: (config: SkillConfig) => void): Promise<SkillCheck[]> {
  return withLock(location, async () => {
    const original = await readConfig(location);
    validateSelection?.(original);
    const prepared = await prepare(location, original, names);
    if (prepared.some((item) => item.check.status === "local-edits")) throw new CanonfigError("SKILL_LOCAL_EDITED", "Local edits detected. No skill was updated; check the preview and reconcile changes before applying");
    const changed = prepared.filter((item) => item.check.status === "update-available");
    if (!changed.length) return prepared.map((item) => item.check);
    const swaps: Array<{ item: Prepared; destination: string; staged: string; backup: string; moved: boolean; installed: boolean }> = [];
    const journal = `${configPath(location)}.pending`;
    let committed = false;
    let rollbackFailed = false;
    try {
      for (const item of changed) {
        const destination = path.join(location.root, item.skill.path);
        await assertNoSymlinkPathComponents(location.root, destination);
        const suffix = randomUUID();
        const staged = `${destination}.canonfig-stage-${suffix}`;
        const backup = `${destination}.canonfig-backup-${suffix}`;
        const swap = { item, destination, staged, backup, moved: false, installed: false };
        swaps.push(swap);
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
      }
      if (JSON.stringify(await readConfig(location)) !== JSON.stringify(original)) throw new CanonfigError("SKILL_CONFIG_EDITED", "Source configuration changed while updates were prepared");
      await operations.writeAtomic(journal, JSON.stringify({ version: 1, previousConfig: original, swaps: swaps.map((swap) => ({ path: swap.item.skill.path, staged: path.relative(location.root, swap.staged), backup: path.relative(location.root, swap.backup), expectedDigest: swap.item.digest })) }, null, 2) + "\n", 0o600, location.root);
      for (const swap of swaps) {
        await assertNoSymlinkPathComponents(location.root, swap.destination);
        if (fingerprint(await readLocalSkill(location.root, swap.item.skill.path)) !== swap.item.skill.digest) throw new CanonfigError("SKILL_LOCAL_EDITED", "Skill changed while update was staged; refusing replacement");
        await operations.rename(swap.destination, swap.backup); swap.moved = true;
        if (fingerprint(await readLocalSkill(location.root, path.relative(location.root, swap.backup).split(path.sep).join("/"))) !== swap.item.skill.digest) throw new CanonfigError("SKILL_LOCAL_EDITED", "Skill changed during replacement; restoring its backup");
        await operations.rename(swap.staged, swap.destination); swap.installed = true;
      }
      const next: SkillConfig = { version: 1, skills: original.skills.map((skill) => {
        const updated = changed.find((item) => item.skill.name === skill.name);
        return updated ? { ...skill, commit: updated.check.nextCommit, digest: updated.digest } : skill;
      }) };
      if (JSON.stringify(await readConfig(location)) !== JSON.stringify(original)) throw new CanonfigError("SKILL_CONFIG_EDITED", "Source configuration changed during update; restoring installed skills");
      await writeConfig(location, next, operations.writeAtomic);
      committed = true;
    } catch (error) {
      for (const swap of [...swaps].reverse()) {
        try {
          if (swap.installed) {
            if (fingerprint(await readLocalSkill(location.root, swap.item.skill.path)) !== swap.item.digest) throw new Error("New local edits require manual recovery");
            await operations.remove(swap.destination, { recursive: true });
          }
          if (swap.moved) await operations.rename(swap.backup, swap.destination);
        } catch { rollbackFailed = true; }
      }
      if (rollbackFailed) throw new CanonfigError("SKILL_RECOVERY_REQUIRED", `Update stopped and rollback needs manual recovery. Backups are preserved; inspect ${location.config}.pending`);
      throw error;
    } finally {
      for (const swap of swaps) {
        try { if (await exists(swap.staged)) await operations.remove(swap.staged, { recursive: true }); }
        catch { /* Best-effort cleanup must not mask the transaction result. */ }
        try { if (committed && await exists(swap.backup)) await operations.remove(swap.backup, { recursive: true }); }
        catch { /* Retain the backup without preventing journal cleanup. */ }
      }
      if (!rollbackFailed && await exists(journal)) await fs.unlink(journal);
    }
    return prepared.map((item) => item.check);
  });
}
