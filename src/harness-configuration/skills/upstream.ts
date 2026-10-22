import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { CanonfigError } from "../core/errors.ts";
import { assertNoSymlinkPathComponents } from "../core/filesystem.ts";

const execute = promisify(execFile);
export interface SkillFile { path: string; bytes: Buffer; executable: boolean }
export interface SkillSource { source: string; ref: string; subdir: string }
export const MAX_FILES = 10_000;
export const MAX_BYTES = 64 * 1024 * 1024;

export function safePath(value: string): string {
  if (!value || value.includes("\\") || /^[a-z]:/iu.test(value) || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"
      || /[:<>"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new CanonfigError("SKILL_PATH_INVALID", `Unsafe skill-relative path: ${value}`);
  }
  return value;
}
export function normalizeSource(source: string, root: string): string {
  if (source.startsWith("https://")) {
    const url = new URL(source);
    if (url.username || url.password || url.search || url.hash) throw new CanonfigError("SKILL_SOURCE_INVALID", "Git source URLs cannot contain credentials, queries or fragments");
    return url.href;
  }
  if (source.includes("://") || source.startsWith("-") || (!path.isAbsolute(source) && source.includes(":"))) {
    throw new CanonfigError("SKILL_SOURCE_INVALID", "Use an HTTPS Git URL or an explicit local repository path");
  }
  return path.resolve(root, source);
}
export function validateSource(source: SkillSource): void {
  if (!source.ref || source.ref.startsWith("-") || !/^[A-Za-z0-9_./-]+$/u.test(source.ref)
    || source.ref.includes("..") || source.ref.endsWith("/") || source.ref.includes("//")) {
    throw new CanonfigError("SKILL_REF_INVALID", "Specify a branch, tag or commit ref (not a Git expression)");
  }
  if (source.subdir !== ".") safePath(source.subdir);
}
export function fingerprint(files: readonly SkillFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(`${Buffer.byteLength(file.path)}:${file.path}:${file.executable ? 1 : 0}:${file.bytes.length}:`);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}
export function inventory(files: readonly SkillFile[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, fingerprint([file])]));
}
function checkFiles(files: readonly SkillFile[]): void {
  if (!files.some((file) => file.path === "SKILL.md")) throw new CanonfigError("SKILL_MANIFEST_REQUIRED", "Selected directory must contain SKILL.md");
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    safePath(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (names.has(key)) throw new CanonfigError("SKILL_PATH_CONFLICT", `Case-colliding skill file: ${file.path}`);
    names.add(key);
    total += file.bytes.length;
  }
  if (total > MAX_BYTES || files.length > MAX_FILES) throw new CanonfigError("SKILL_LIMIT_INVALID", "Skill exceeds 64 MiB or 10,000 files");
}

export async function readLocalSkill(root: string, relative: string): Promise<SkillFile[]> {
  safePath(relative);
  const directory = path.join(root, relative);
  await assertNoSymlinkPathComponents(root, directory);
  await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new CanonfigError("SKILL_LOCAL_EDITED", `Installed skill directory is missing: ${relative}; restore it before checking or updating`);
    throw error;
  });
  const files: SkillFile[] = [];
  let total = 0;
  async function visit(current: string): Promise<void> {
    await assertNoSymlinkPathComponents(root, current);
    const stat = await fs.lstat(current);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(current)).sort()) await visit(path.join(current, name));
    } else if (stat.isFile()) {
      const name = path.relative(directory, current).split(path.sep).join("/");
      safePath(name);
      total += stat.size;
      if (total > MAX_BYTES || files.length >= MAX_FILES) throw new CanonfigError("SKILL_LIMIT_INVALID", "Skill exceeds 64 MiB or 10,000 files");
      files.push({ path: name, bytes: await fs.readFile(current), executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0 });
    } else throw new CanonfigError("SKILL_PATH_INVALID", "Skill files must be regular files or directories");
  }
  await visit(directory);
  checkFiles(files);
  return files;
}

/** Fetch Git objects only: no checkout, hooks, filters, submodules or skill execution. */
export async function fetchSkill(source: SkillSource): Promise<{ commit: string; files: SkillFile[] }> {
  validateSource(source);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "canonfig-skill-fetch-"));
  try {
    const config = path.join(temporary, "empty-config");
    const hooks = path.join(temporary, "hooks");
    await fs.writeFile(config, ""); await fs.mkdir(hooks);
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY,
      ALL_PROXY: process.env.ALL_PROXY, NO_PROXY: process.env.NO_PROXY,
      https_proxy: process.env.https_proxy, http_proxy: process.env.http_proxy,
      all_proxy: process.env.all_proxy, no_proxy: process.env.no_proxy,
      HOME: temporary, USERPROFILE: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_LFS_SKIP_SMUDGE: "1" };
    const repository = path.join(temporary, "repo.git");
    async function git(args: string[], maxBuffer = MAX_BYTES): Promise<Buffer> {
      try {
        const result = await execute("git", ["-c", `core.hooksPath=${hooks}`, "-c", "credential.helper=", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=always", ...args], {
          cwd: temporary, env, encoding: "buffer", timeout: 120_000, maxBuffer,
        });
        return result.stdout;
      } catch {
        throw new CanonfigError("SKILL_FETCH_FAILED", "Could not fetch the configured Git source/ref; verify access, Git installation and repository availability (no credentials or remote output printed)");
      }
    }
    await git(["init", "--bare", repository]);
    await git(["--git-dir", repository, "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", source.source, source.ref]);
    const commit = (await git(["--git-dir", repository, "rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toString().trim();
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new CanonfigError("SKILL_COMMIT_INVALID", "Git did not resolve an immutable commit");
    const tree = source.subdir === "." ? commit : `${commit}:${source.subdir}`;
    const entries = (await git(["--git-dir", repository, "ls-tree", "-r", "-z", "-l", tree], 4 * 1024 * 1024)).toString().split("\0").filter(Boolean);
    if (entries.length > MAX_FILES) throw new CanonfigError("SKILL_LIMIT_INVALID", "Upstream skill has too many files");
    const files: SkillFile[] = [];
    let total = 0;
    for (const entry of entries) {
      const match = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/su.exec(entry);
      if (!match) throw new CanonfigError("SKILL_SOURCE_INVALID", "Upstream skill contains a symlink, submodule or unsupported object");
      const name = safePath(match[4]!);
      total += Number(match[3]);
      if (total > MAX_BYTES) throw new CanonfigError("SKILL_LIMIT_INVALID", "Upstream skill exceeds 64 MiB");
      const bytes = await git(["--git-dir", repository, "cat-file", "blob", match[2]!]);
      files.push({ path: name, bytes, executable: process.platform !== "win32" && match[1] === "100755" });
    }
    checkFiles(files);
    return { commit, files };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
