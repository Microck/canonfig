import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RootContext, SkillReadSource } from "./harness.ts";
import type { ImportContent } from "./import.ts";

const MAX_FILE_BYTES = 1024 * 1024;
/** Bound both one materialized skill and all content retained by setup import. */
export const maxImportContentBytes = 64 * MAX_FILE_BYTES;
const MAX_FILES = 512;
const MAX_DIRECTORIES = 4096;
const MAX_DEPTH = 64;
const MAX_LINKS = 40;

type Refused = { readonly kind: "skip"; readonly reason: string };
type Missing = { readonly kind: "missing" };
type Resolved = { readonly kind: "resolved"; readonly path: string; readonly status: Stats };
type Tree = Extract<ImportContent, { readonly kind: "tree" }>;
type Bytes = { readonly kind: "bytes"; readonly content: Uint8Array; readonly executable: boolean };
type Listing = { readonly kind: "entries"; readonly names: ReadonlyArray<string>; readonly identity: string };

export interface ImportReadLimit {
  readonly kind: "limit";
  readonly path: string;
  readonly maximumBytes: number;
  readonly reason: string;
}

const limited = (path: string, maximumBytes: number): ImportReadLimit => ({
  kind: "limit", path, maximumBytes,
  reason: `import content exceeds the ${maximumBytes}-byte limit; choose fewer items or remove large skill resources and scan again`,
});

const refused = (reason: string): Refused => ({ kind: "skip", reason });
const MISSING: Missing = { kind: "missing" };
const failure = (error: Error): Refused | Missing => {
  const code = "code" in error ? String(error.code) : "unknown error";
  return code === "ENOENT" || code === "ENOTDIR" ? MISSING : refused(`cannot be read (${code})`);
};

const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

/** Resolve even a not-yet-created exclusion through its nearest existing ancestor. */
const exclusionAlias = async (path: string): Promise<string> => {
  let ancestor = resolve(path);
  for (;;) {
    try {
      return resolve(await realpath(ancestor), relative(ancestor, path));
    } catch (error) {
      if (!(error instanceof Error) || failure(error).kind !== "missing" || dirname(ancestor) === ancestor) {
        throw new Error(`Cannot verify protected import path ${path}. Check its path and parent folder permissions, then scan again.`, { cause: error });
      }
      ancestor = dirname(ancestor);
    }
  }
};

/**
 * Skill-only component checks. Other import reads still refuse links.
 * Pathname and inode rechecks assume stable source directories; they do not
 * prevent adversarial parent-directory swaps between checks and reads.
 * No skill body, script or resource is executed.
 */
export class SkillReader {
  private constructor(
    private readonly home: string,
    private readonly physicalHome: string,
    private readonly exclusions: ReadonlyArray<{
      readonly path: string;
      readonly prefix: string;
      readonly foldedPath: string;
      readonly foldedPrefix: string;
      readonly reason: string;
    }>,
  ) {}

  static async create(context: RootContext, neverTouch: ReadonlyArray<string>, folder: string, configPaths: ReadonlyArray<string>): Promise<SkillReader> {
    const exclusions = [
      ...neverTouch.map((path) => ({ path: resolve(path), reason: "never-touch path" })),
      ...configPaths.map((path) => ({
        path: resolve(path), reason: "protected config file; remove the config resource from the skill and scan again",
      })),
      { path: resolve(folder), reason: "inside the Canonical Folder" },
    ];
    const aliases = await Promise.all(exclusions.map(async (entry) => ({ ...entry, path: await exclusionAlias(entry.path) })));
    return new SkillReader(resolve(context.home), await realpath(context.home),
      [...exclusions, ...aliases].map((entry) => {
        const prefix = entry.path.endsWith(sep) ? entry.path : `${entry.path}${sep}`;
        return { ...entry, prefix, foldedPath: entry.path.toLowerCase(), foldedPrefix: prefix.toLowerCase() };
      }));
  }

  private within(path: string, parent: string): boolean {
    return path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  }

  /** Resolve only the home prefix, never a link target's still-unchecked suffix. */
  private async homeRoot(path: string): Promise<string | undefined> {
    if (this.within(path, this.home)) return this.home;
    if (this.within(path, this.physicalHome)) return this.physicalHome;
    for (const root of [this.home, this.physicalHome]) {
      if (!this.within(path.toLowerCase(), root.toLowerCase())) continue;
      const prefix = path.slice(0, root.length);
      try {
        if (await realpath(prefix) === this.physicalHome) return prefix;
      } catch (error) {
        if (!(error instanceof Error) || failure(error).kind !== "missing") throw error;
      }
    }
    return undefined;
  }

  private async blocked(path: string): Promise<Refused | undefined> {
    if (await this.homeRoot(path) === undefined) return refused("resolves outside the home directory");
    const folded = path.toLowerCase();
    let canonical: string | undefined;
    for (const entry of this.exclusions) {
      if (path === entry.path || path.startsWith(entry.prefix)) return refused(entry.reason);
      // A differently cased spelling is only an alias if the filesystem says
      // so. Refresh possible aliases to cover protected files created later.
      if (folded === entry.foldedPath || folded.startsWith(entry.foldedPrefix)) {
        canonical ??= await exclusionAlias(path);
        if (this.within(canonical, await exclusionAlias(entry.path))) return refused(entry.reason);
      }
    }
    return undefined;
  }

  private async inspect(path: string): Promise<Resolved | Refused | Missing> {
    const absolute = resolve(path);
    const denied = await this.blocked(absolute);
    if (denied !== undefined) return denied;
    let current = this.physicalHome;
    const root = (await this.homeRoot(absolute))!;
    let pending = relative(root, absolute).split(sep).filter(Boolean);
    let links = 0;
    for (;;) {
      const protectedPath = await this.blocked(current);
      if (protectedPath !== undefined) return protectedPath;
      let status;
      try {
        status = await lstat(current);
      } catch (error) {
        const problem = error instanceof Error ? failure(error) : refused("cannot be read");
        return problem.kind === "missing" && links > 0 ? refused("is a broken link") : problem;
      }
      if (status.isSymbolicLink()) {
        if (++links > MAX_LINKS) return refused("contains a link cycle or too many links");
        let target;
        try {
          target = await readlink(current);
        } catch (error) {
          return error instanceof Error ? failure(error) : refused("cannot be read");
        }
        if (sep === "\\" && target.includes("/")) {
          return refused("uses forward slashes in a Windows link target; recreate the link with native separators");
        }
        if (isAbsolute(target)) {
          const root = await this.homeRoot(target);
          if (root === undefined) return refused("resolves outside the home directory");
          pending = [...target.slice(root.length).split(sep).filter(Boolean), ...pending];
          current = this.physicalHome;
        } else {
          pending = [...target.split(sep).filter(Boolean), ...pending];
          current = dirname(current);
        }
        // Keep '..' components until after resolving earlier links. Lexically
        // normalizing a link target can bypass a protected ancestor alias.
        continue;
      }
      if (!status.isDirectory() && !status.isFile()) return refused("is not a regular file or directory");
      // Each component passes the boundary check before advancing. Resolve
      // the final spelling once instead of rewalking every prefix.
      if (pending.length === 0) {
        try {
          current = await realpath(current);
        } catch (error) {
          return error instanceof Error ? failure(error) : refused("cannot be read");
        }
        const canonicalDenied = await this.blocked(current);
        if (canonicalDenied !== undefined) return canonicalDenied;
        return { kind: "resolved", path: current, status };
      }
      if (!status.isDirectory()) return MISSING;
      const segment = pending.shift()!;
      if (segment === ".") continue;
      current = segment === ".." ? dirname(current) : join(current, segment);
    }
  }

  private async unchanged(path: string, before: Resolved): Promise<boolean> {
    const after = await this.inspect(path);
    return after.kind === "resolved" && after.path === before.path && sameFile(after.status, before.status);
  }

  async bytes(path: string, maximumBytes = MAX_FILE_BYTES): Promise<Bytes | Refused | Missing | ImportReadLimit> {
    const before = await this.inspect(path);
    if (before.kind !== "resolved") return before;
    return this.bytesFromResolved(path, before, maximumBytes);
  }

  /** Reuse the tree walk's inspection; opened-inode and source rechecks still guard the read. */
  private async bytesFromResolved(path: string, before: Resolved, maximumBytes: number): Promise<Bytes | Refused | Missing | ImportReadLimit> {
    if (!before.status.isFile()) return refused("is a directory, not a file");
    if (before.status.nlink !== 1) return refused("has unverified hard links; leave it out, or replace it with an independent copy of non-private content and scan again");
    if (before.status.size > MAX_FILE_BYTES) return refused("is larger than 1 MiB");
    if (before.status.size > maximumBytes) return limited(path, maximumBytes);
    try {
      // O_NONBLOCK avoids hanging if an entry is replaced with a FIFO. Check
      // the opened inode and both source paths before reading any bytes.
      const handle = await open(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameFile(opened, before.status) || !await this.unchanged(path, before)) {
          return refused("changed while being read; scan again");
        }
        const buffer = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, null);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length !== opened.size || !sameFile(opened, await handle.stat()) || !await this.unchanged(path, before)) {
          return refused("changed while being read; scan again");
        }
        return { kind: "bytes", content: buffer.subarray(0, length), executable: (opened.mode & 0o100) !== 0 };
      } finally {
        await handle.close();
      }
    } catch (error) {
      return error instanceof Error ? failure(error) : refused("cannot be read");
    }
  }

  private async list(path: string): Promise<Listing | Refused | Missing> {
    const before = await this.inspect(path);
    if (before.kind !== "resolved") return before;
    if (!before.status.isDirectory()) return refused("is not a directory");
    try {
      const names = (await readdir(before.path)).sort();
      if (!await this.unchanged(path, before)) return refused("changed while being listed; scan again");
      return { kind: "entries", names, identity: before.path };
    } catch (error) {
      return error instanceof Error ? failure(error) : refused("cannot be read");
    }
  }

  async tree(path: string, maximumBytes = maxImportContentBytes): Promise<Tree | Refused | Missing | ImportReadLimit> {
    const files: Array<Tree["files"][number]> = [];
    const limit = Math.min(maximumBytes, maxImportContentBytes);
    let remaining = limit;
    let directories = 0;
    const visit = async (directory: string, prefix: string, ancestors: ReadonlySet<string>, depth: number): Promise<Refused | Missing | ImportReadLimit | undefined> => {
      if (depth > MAX_DEPTH || ++directories > MAX_DIRECTORIES) return refused("skill tree exceeds its directory traversal bound");
      const listing = await this.list(directory);
      if (listing.kind !== "entries") return listing;
      if (ancestors.has(listing.identity)) return refused(`${prefix || "."} contains a directory link cycle`);
      const chain = new Set([...ancestors, listing.identity]);
      for (const name of listing.names) {
        const entry = join(directory, name);
        const relativePath = `${prefix}${name}`;
        const status = await this.inspect(entry);
        if (status.kind !== "resolved") return refused(`${relativePath} ${status.kind === "skip" ? status.reason : "disappeared while being read"}`);
        if (status.status.isDirectory()) {
          const problem = await visit(entry, `${relativePath}/`, chain, depth + 1);
          if (problem !== undefined) return problem;
        } else {
          if (files.length >= MAX_FILES) return refused(`has more than ${MAX_FILES} files`);
          const read = await this.bytesFromResolved(entry, status, remaining);
          if (read.kind === "limit") return limited(path, limit);
          if (read.kind !== "bytes") return refused(`${relativePath} ${read.kind === "skip" ? read.reason : "disappeared while being read"}`);
          remaining -= read.content.byteLength;
          files.push({ path: relativePath, content: read.content, executable: read.executable });
        }
      }
      return undefined;
    };
    const problem = await visit(path, "", new Set(), 0);
    return problem ?? { kind: "tree", files };
  }

  /** Discover only the adapter's declared root. Never walk home or project trees. */
  async discover(
    source: SkillReadSource,
    found: (path: string, depth: number, flat: boolean) => Promise<void>,
    skipped: (path: string, reason: string) => void,
  ): Promise<void> {
    let directories = 0;
    const visit = async (directory: string, depth: number, ancestors: ReadonlySet<string>): Promise<void> => {
      if (++directories > MAX_DIRECTORIES) return;
      const listing = await this.list(directory);
      if (listing.kind === "missing") return;
      if (listing.kind === "skip") return skipped(directory, listing.reason);
      if (ancestors.has(listing.identity)) return skipped(directory, "contains a directory link cycle");
      const hasManifest = listing.names.includes("SKILL.md");
      if (hasManifest) await found(directory, depth, false);
      if (!hasManifest && depth > 0 && depth >= Math.min(source.depth, MAX_DEPTH)) {
        return skipped(directory, "Missing SKILL.md. Add a SKILL.md file with a name and description to import this skill.");
      }
      if (hasManifest && source.pruneWithinSkill === undefined) return;
      const chain = new Set([...ancestors, listing.identity]);
      let hasChildDirectory = false;
      for (const name of listing.names) {
        if ((!source.includeHidden && name.startsWith(".")) || name === "node_modules" || source.excludedDirectories?.includes(name)
          || (hasManifest && source.pruneWithinSkill?.includes(name))) continue;
        const entry = join(directory, name);
        const status = await this.inspect(entry);
        if (status.kind === "skip") { skipped(entry, status.reason); continue; }
        if (status.kind === "missing") { skipped(entry, "disappeared during discovery"); continue; }
        if (status.status.isDirectory()) {
          hasChildDirectory = true;
          if (depth >= Math.min(source.depth, MAX_DEPTH)) {
            skipped(entry, "exceeds the native skill discovery depth");
          } else if (directories >= MAX_DIRECTORIES) {
            skipped(entry, "skill discovery exceeds its directory traversal bound");
          } else {
            await visit(entry, depth + 1, chain);
          }
        } else if (depth === 0 && source.flat && name.endsWith(".md") && name !== "SKILL.md") {
          await found(entry, depth, true);
        }
      }
      // A direct leaf may be unfinished; deeper leaves can be ordinary package resources.
      if (!hasManifest && depth === 1 && !hasChildDirectory) {
        skipped(directory, "Missing SKILL.md. Add a SKILL.md file with a name and description to import this skill.");
      }
    };
    await visit(source.path, 0, new Set());
  }
}
