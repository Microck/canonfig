import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { encodeArchive } from "../../src/harness-configuration/core/archive.ts";
import { exportHarness, type ExportOptions } from "../../src/harness-configuration/core/export.ts";
import { scaffoldProject } from "../../src/harness-configuration/core/scaffold.ts";
import { runHarnessConfigurationCli } from "../../src/harness-configuration/cli.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<ExportOptions> {
  const root = await mkdtemp(path.join(tmpdir(), "canonfig-export-"));
  roots.push(root);
  await scaffoldProject(root, { targets: ["codex", "claude-code"], format: "json", force: false });
  return { root, output: path.join(root, "setup.zip"), targets: ["codex"], includeSource: false, sourceOnly: false, strict: false, dryRun: false };
}
function unzip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extra;
    files.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
  return files;
}

describe("portable harness archives", () => {
  it("exports only selected native targets and shared dependencies without changing native files", async () => {
    const options = await fixture();
    await writeFile(path.join(options.root, "AGENTS.md"), "PRIVATE LOCAL EDIT");
    const result = await exportHarness(options);
    const files = unzip(await readFile(options.output));
    expect(result.targets).toEqual(["codex"]);
    expect(files.has("AGENTS.md")).toBe(true);
    expect(files.has("CLAUDE.md")).toBe(false);
    expect(files.has(".canonfig/harness.json")).toBe(false);
    expect([...files.values()].some((bytes) => bytes.includes("PRIVATE LOCAL EDIT"))).toBe(false);
    expect(await readFile(path.join(options.root, "AGENTS.md"), "utf8")).toBe("PRIVATE LOCAL EDIT");
    expect(files.has("canonfig-export.json")).toBe(true);
  });
  it("packages source alone or source plus several harnesses", async () => {
    const options = await fixture();
    await writeFile(path.join(options.root, ".canonfig", "skills-sources.json"), JSON.stringify({ version: 1, skills: [] }));
    await exportHarness({ ...options, sourceOnly: true, targets: undefined });
    let files = unzip(await readFile(options.output));
    expect(files.has(".canonfig/harness.json")).toBe(true);
    expect(files.has(".canonfig/skills-sources.json")).toBe(true);
    expect(files.has("AGENTS.md")).toBe(false);
    const output = path.join(options.root, "combined.zip");
    await exportHarness({ ...options, output, targets: ["codex", "claude-code"], includeSource: true });
    files = unzip(await readFile(output));
    expect(files.has(".canonfig/harness.json")).toBe(true);
    expect(files.has("AGENTS.md")).toBe(true);
    expect(files.has("CLAUDE.md")).toBe(true);
  });
  it("supports deterministic tar.gz with binary files and long Unicode names", () => {
    const name = `skills/${"long".repeat(40)}/é.bin`;
    const files = [{ path: name, content: Buffer.from([0, 255, 128, 10]), mode: 0o755 }];
    const first = encodeArchive(files, "tar.gz");
    expect(first).toEqual(encodeArchive(files, "tar.gz"));
    const tar = gunzipSync(first);
    expect(tar.subarray(512, 1024).toString()).toContain(`path=${name}\n`);
    expect(tar.subarray(1536, 1540)).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(tar.subarray(1124, 1132).toString()).toBe("0000755\0");
  });
  it("is reproducible and never overwrites output", async () => {
    const options = await fixture();
    await exportHarness(options);
    const first = await readFile(options.output);
    const secondPath = path.join(options.root, "second.zip");
    await exportHarness({ ...options, output: secondPath });
    expect(await readFile(secondPath)).toEqual(first);
    await expect(exportHarness(options)).rejects.toThrow("Output already exists");
    expect(await readFile(options.output)).toEqual(first);
  });
  it("publishes exactly one complete archive when writers race", async () => {
    const options = await fixture();
    const outcomes = await Promise.allSettled([exportHarness(options), exportHarness(options)]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(unzip(await readFile(options.output)).has("canonfig-export.json")).toBe(true);
  });
  it("dry-run lists paths without writing", async () => {
    const options = await fixture();
    const result = await exportHarness({ ...options, dryRun: true });
    expect(result.written).toBe(false);
    expect(result.files.length).toBeGreaterThan(0);
    await expect(readFile(options.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not collect hidden runtime or unrelated user files", async () => {
    const options = await fixture();
    await writeFile(path.join(options.root, ".canonfig", ".harness-state.json"), "sensitive state");
    await mkdir(path.join(options.root, ".codex"), { recursive: true });
    await writeFile(path.join(options.root, ".codex", "auth.json"), "secret token");
    await exportHarness({ ...options, includeSource: true });
    const files = unzip(await readFile(options.output));
    expect(files.has(".codex/auth.json")).toBe(false);
    expect(files.has(".canonfig/.harness-state.json")).toBe(false);
  });
  it("rejects credential-like files in declared source trees", async () => {
    const options = await fixture();
    await mkdir(path.join(options.root, ".canonfig", "skills", "bad"), { recursive: true });
    await writeFile(path.join(options.root, ".canonfig", "skills", "bad", ".env"), "TOKEN=secret");
    await expect(exportHarness({ ...options, sourceOnly: true, targets: undefined })).rejects.toThrow("credential-like");
  });
  it.skipIf(process.platform === "win32")("refuses source symlinks instead of following sensitive files", async () => {
    const options = await fixture();
    await symlink("/etc/passwd", path.join(options.root, ".canonfig", "skills", "escape"));
    await expect(exportHarness({ ...options, sourceOnly: true, targets: undefined })).rejects.toThrow("symbolic link");
  });
  it.each(["../x", "/x", "C:/x", "x\\y", "x/../y", "x/CON.txt", "x/a:", "x/a."])("rejects unsafe archive path %s", (name) => {
    expect(() => encodeArchive([{ path: name, content: Buffer.from("x"), mode: 0o644 }], "zip")).toThrow();
  });
  it("rejects case collisions and archive limits", () => {
    expect(() => encodeArchive(["A", "a"].map((name) => ({ path: name, content: Buffer.from("x"), mode: 0o644 })), "zip")).toThrow("case-colliding");
    expect(() => encodeArchive(Array.from({ length: 20001 }, (_, n) => ({ path: `${n}`, content: Buffer.alloc(0), mode: 0o644 })), "zip")).toThrow("20,000");
  });
  it("validates selection and extension", async () => {
    const options = await fixture();
    await expect(exportHarness({ ...options, sourceOnly: true })).rejects.toThrow("--source-only");
    await expect(exportHarness({ ...options, output: "bad.tgz" })).rejects.toThrow(".zip or .tar.gz");
  });
  it("rejects missing required sources and output parents as configuration failures", async () => {
    const options = await fixture();
    await expect(exportHarness({ ...options, output: path.join(options.root, "missing", "out.zip"), dryRun: true })).rejects.toMatchObject({ code: "ARCHIVE_OUTPUT_PARENT_NOT_FOUND" });
    await rm(path.join(options.root, ".canonfig/instructions/AGENTS.md"));
    await expect(exportHarness({ ...options, sourceOnly: true, targets: undefined })).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });
  it("refuses missing output with a structured usage error", async () => {
    const options = await fixture();
    let stdout = ""; let stderr = ""; let exitCode = -1;
    await runHarnessConfigurationCli(["export", "--root", options.root, "--json"], { writeStdout: (text) => { stdout += text; }, writeStderr: (text) => { stderr += text; }, setExitCode: (code) => { exitCode = code; } });
    expect(stdout).toBe("");
    expect(JSON.parse(stderr).data.code).toBe("ARCHIVE_OUTPUT_REQUIRED");
    expect(exitCode).toBe(2);
  });
  it("routes CLI export and emits structured, content-free dry-run output", async () => {
    const options = await fixture();
    let stdout = ""; let stderr = ""; let exitCode = -1;
    await runHarnessConfigurationCli(["export", "--root", options.root, "--source-only", "--output", options.output, "--dry-run", "--json"], {
      writeStdout: (text) => { stdout += text; }, writeStderr: (text) => { stderr += text; }, setExitCode: (code) => { exitCode = code; },
    });
    expect(stderr).toBe(""); expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).command).toBe("harness.export");
    expect(stdout).not.toContain("# Canonical");
  });
});
