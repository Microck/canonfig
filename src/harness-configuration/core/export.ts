import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { encodeArchive, validateArchivePath, type ArchiveFile } from "./archive.ts";
import { HarnessConfigurationCompiler } from "./compiler.ts";
import { loadConfig } from "./config.ts";
import { CanonfigError } from "./errors.ts";
import { assertNoSymlinkPathComponents } from "./filesystem.ts";
import { sha256 } from "./hash.ts";
import { resolveInside } from "./path.ts";
import { renderArtifacts } from "./render.ts";
import type { DesiredArtifact, Diagnostic, TargetId } from "./types.ts";

export interface ExportOptions {
  root: string;
  output: string;
  targets?: readonly TargetId[] | undefined;
  includeSource: boolean;
  sourceOnly: boolean;
  strict: boolean;
  dryRun: boolean;
}

/** Explicit authored inputs only. Never walk home directories or native state. */
async function authoredFiles(root: string, includeConfig: boolean): Promise<ArchiveFile[]> {
  const loaded = await loadConfig(root);
  const canonical = path.join(root, ".canonfig");
  const inputs = new Set([
    loaded.config.instructions.root,
    ...loaded.config.instructions.rules.map((item) => item.file),
    ...loaded.config.skills.roots,
    ...loaded.config.agents.map((item) => item.file),
    ...loaded.config.commands.map((item) => item.file),
  ]);
  // Hooks can refer to support files next to their entry point. Include only
  // explicitly named .canonfig paths, not arbitrary argv or executable paths.
  for (const hook of loaded.config.hooks) {
    for (const argument of hook.run) {
      if (argument.startsWith(".canonfig/")) {
        const relative = argument.slice(".canonfig/".length);
        inputs.add(relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : relative);
      }
    }
  }
  if (includeConfig) {
    inputs.add(path.basename(loaded.path));
    try { await fs.lstat(path.join(canonical, "skills-sources.json")); inputs.add("skills-sources.json"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const files = new Map<string, ArchiveFile>();
  let total = 0;
  async function collect(relative: string, optional: boolean): Promise<void> {
    const file = resolveInside(canonical, relative);
    await assertNoSymlinkPathComponents(root, file);
    const archivePath = `.canonfig/${path.relative(canonical, file).split(path.sep).join("/")}`;
    validateArchivePath(archivePath);
    const components = archivePath.split("/").slice(1);
    if (components.some((part) => part === ".git" || part === "node_modules" || part === ".harness-state.json"
      || part === ".runtime" || part === ".env" || part.startsWith(".env.")
      || /^(?:auth|credentials)\.json$/iu.test(part))) {
      throw new CanonfigError("ARCHIVE_SOURCE_INVALID", `Refusing runtime or credential-like source: ${archivePath}`);
    }
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (optional) return;
        throw new CanonfigError("SOURCE_NOT_FOUND", `Declared archive source is missing: ${archivePath}`);
      }
      throw error;
    }
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(file)).sort()) await collect(`${relative}/${child}`, false);
    } else if (stat.isFile()) {
      if (files.has(archivePath)) return;
      total += stat.size;
      if (total > 128 * 1024 * 1024 || files.size >= 20_000) throw new CanonfigError("ARCHIVE_LIMIT_INVALID", "Archive source exceeds size or file limit");
      const content = await fs.readFile(file);
      files.set(archivePath, { path: archivePath, content, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
    } else throw new CanonfigError("ARCHIVE_SOURCE_INVALID", `Not a regular source file: ${archivePath}`);
  }
  for (const input of inputs) await collect(input, loaded.config.skills.roots.includes(input));
  return [...files.values()];
}

function projectedFiles(artifacts: readonly DesiredArtifact[]): ArchiveFile[] {
  const groups = new Map<string, DesiredArtifact[]>();
  for (const artifact of artifacts) {
    const group = groups.get(artifact.path) ?? [];
    group.push(artifact);
    groups.set(artifact.path, group);
  }
  return [...groups].map(([name, group]) => {
    const rendered = renderArtifacts(group, undefined, undefined);
    if (rendered.conflicts.length || rendered.content === undefined) {
      throw new CanonfigError("ARCHIVE_COLLISION", `Cannot render ${name}: ${rendered.conflicts.join("; ")}`);
    }
    const content = typeof rendered.content === "string" ? Buffer.from(rendered.content) : rendered.content;
    const executable = group.some((artifact) => artifact.kind === "replace" && ((artifact.mode ?? 0) & 0o111));
    return { path: name, content, mode: executable ? 0o755 : 0o644 };
  });
}

export async function exportHarness(options: ExportOptions): Promise<{
  output: string; format: "zip" | "tar.gz"; targets: readonly TargetId[];
  source: boolean; files: Array<{ path: string; bytes: number; sha256: string }>;
  diagnostics: Diagnostic[]; written: boolean;
}> {
  const output = path.resolve(options.output);
  const format = output.endsWith(".tar.gz") ? "tar.gz" : output.endsWith(".zip") ? "zip" : undefined;
  if (format === undefined) throw new CanonfigError("ARCHIVE_FORMAT_INVALID", "Output must end in .zip or .tar.gz");
  if (options.sourceOnly && options.targets?.length) throw new CanonfigError("ARCHIVE_SELECTION_INVALID", "--source-only cannot be combined with target selection; use --include-source");
  const source = options.includeSource || options.sourceOnly;
  const authored = await authoredFiles(options.root, source);
  const built = options.sourceOnly ? undefined : await new HarnessConfigurationCompiler().build({
    root: options.root, targets: options.targets, strict: options.strict,
  });
  const diagnostics = built?.diagnostics ?? [];
  if (diagnostics.some((item) => item.level === "error")) {
    throw new CanonfigError("ARCHIVE_CONFIG_INVALID", diagnostics.filter((item) => item.level === "error").map((item) => `${item.code}: ${item.message}`).join("\n"));
  }
  const files = [
    ...authored,
    ...projectedFiles(built?.artifacts ?? []),
  ];
  const inventory = files.map((file) => ({ path: file.path, bytes: file.content.length, sha256: sha256(file.content) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  files.push({ path: "canonfig-export.json", mode: 0o644, content: Buffer.from(JSON.stringify({
    version: 1, kind: "canonfig-harness-export", source, targets: built?.targets ?? [], files: inventory,
    notes: ["Native files are freshly projected, not copies of machine-local edits.",
      "Review literal values before sharing. Environment references are not resolved.",
      "External executables, MCP services, user-profile configuration and files outside .canonfig are not included.",
      "Inspect executable hooks and scripts before using the archive."],
  }, null, 2) + "\n") });
  const bytes = encodeArchive(files, format);
  let parent: string;
  try {
    parent = await fs.realpath(path.dirname(output));
    if (!(await fs.stat(parent)).isDirectory()) throw new CanonfigError("ARCHIVE_OUTPUT_PARENT_NOT_FOUND", "Output parent must be an existing directory");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new CanonfigError("ARCHIVE_OUTPUT_PARENT_NOT_FOUND", "Output parent must be an existing directory");
    throw error;
  }
  if (!options.dryRun) {
    // Same-directory temporary + exclusive hard link publishes a complete file
    // without replacing existing output, including a concurrently created file.
    const destination = path.join(parent, path.basename(output));
    const temporary = path.join(parent, `.canonfig-export-${randomUUID()}.tmp`);
    let owned = false;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      owned = true;
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      try { await fs.link(temporary, destination); }
      catch (error) {
        if (["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new CanonfigError("ARCHIVE_FILESYSTEM_UNSUPPORTED", "Atomic archive publication requires hard-link support and permission. Choose a local filesystem that supports it; no partial-copy fallback was used");
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CanonfigError("ARCHIVE_OUTPUT_CONFLICT", "Output already exists; select a new archive filename");
      throw error;
    } finally { if (owned) await fs.rm(temporary, { force: true }); }
  }
  return { output, format, targets: built?.targets ?? [], source, files: inventory, diagnostics, written: !options.dryRun };
}
