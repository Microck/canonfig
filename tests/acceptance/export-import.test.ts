import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `canonfig export` and `canonfig import` through the real entrypoint, each
 * machine in its own temporary HOME with real SQLite. Nothing is mocked.
 */

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const posix = process.platform !== "win32";
const SECRET = "docs-token-value-8f3a1c";

// Commands run in the machine's home, so a relative --output lands there. The
// tsx loader is named by file URL because `--import tsx` resolves from the cwd.
const tsxLoader = pathToFileURL(resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs")).href;

const invoke = (home: string, args: ReadonlyArray<string>, environment: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, resolve(import.meta.dirname, "../../src/runtime/main.ts"), "--json", ...args], {
    cwd: home,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CANONFIG_LOG_FILE: join(home, "command.log"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, "state"),
      CODEX_HOME: "",
      // Only the fake harness executables a test installs are on PATH.
      PATH: join(home, "bin"),
      ...environment,
    },
  });
  return { ...result, envelope: JSON.parse(result.stdout || result.stderr) };
};

const write = (path: string, content: string | Uint8Array, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

const newHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-archive-"));
  homes.push(home);
  mkdirSync(join(home, "bin"));
  return home;
};

/** A Source's folder with every authored entry and `local/`, plus the machine-local files an export must leave out. */
const sourceHome = (): string => {
  const home = newHome();
  const folder = join(home, ".canonfig");
  write(join(folder, "canonfig.jsonc"), `// exported folder\n${JSON.stringify({
    version: 1,
    harnesses: ["codex"],
    mcp: { docs: { transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_TOKEN" } } } },
    hooks: [{ id: "format", event: "after_tool", run: ["hooks/format.sh"], timeoutMs: 5000 }],
    local: { allow: ["rules"] },
  }, undefined, 2)}\n`);
  write(join(folder, "AGENTS.md"), "# Global instructions\n");
  write(join(folder, "rules", "style.md"), "---\ndescription: Style\n---\nUse two spaces.\n");
  write(join(folder, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\nRun scripts/run.sh.\n");
  write(join(folder, "skills", "deploy", "scripts", "run.sh"), "#!/bin/sh\necho deploy\n", 0o755);
  write(join(folder, "skills", "deploy", "assets", "logo.bin"), new Uint8Array([0, 255, 128, 10, 13]));
  write(join(folder, "agents", "reviewer.md"), "---\ndescription: Reviews\n---\nReview carefully.\n");
  write(join(folder, "commands", "ship.md"), "---\ndescription: Ship\n---\nShip it.\n");
  write(join(folder, "hooks", "format.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  write(join(folder, "local", "local.jsonc"), "{ \"backups\": true }\n");
  write(join(folder, "local", "rules", "mine.md"), "---\ndescription: Mine\n---\nOnly here.\n");
  // Machine-local state that must never leave the machine.
  write(join(folder, "state.sqlite-wal"), "wal");
  write(join(folder, "state.sqlite-shm"), "shm");
  write(join(folder, ".backups", "2026-11-03T09-00-00-000Z", "manifest.json"), "{}");
  write(join(folder, ".runtime", "hooks.json"), "{}");
  write(join(folder, "installers", "bindings.json"), "{}");
  write(join(folder, "credentials", "follower"), SECRET);
  write(join(folder, "setup.json"), "{}");
  write(join(folder, "policy.json"), "{}");
  write(join(folder, "skills-sources.json"), "{}");
  return home;
};

/** Every regular file below `root`, relative with `/`, sorted. */
const filesBelow = (root: string): Array<string> => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
};

const AUTHORED = ["canonfig.jsonc", "AGENTS.md", "rules", "skills", "agents", "commands", "hooks", "local"];
const authoredFiles = (folder: string) =>
  filesBelow(folder).filter((path) => AUTHORED.includes(path.split("/")[0]!));

/** The entries of a gzip-compressed tar as Canonfig writes it: paths from PAX records, content and mode. */
const readTar = (archive: Uint8Array) => {
  const tar = gunzipSync(archive);
  const entries: Array<{ path: string; mode: number; content: Buffer }> = [];
  let pending: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString("latin1"), 8);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const type = String.fromCharCode(tar[offset + 156]!);
    const mode = Number.parseInt(tar.subarray(offset + 100, offset + 108).toString("latin1"), 8);
    if (type === "x") pending = /path=(.*)\n/u.exec(body.toString("utf8"))![1];
    else entries.push({ path: pending!, mode, content: body });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("canonfig export and import", () => {
  it("moves the folder to a fresh machine byte for byte, without state, backups or secret values", () => {
    const source = sourceHome();
    const exported = invoke(source, ["export", "--output", "setup.tar.gz"], { DOCS_TOKEN: SECRET });
    expect(exported.status, exported.stdout + exported.stderr).toBe(0);
    const archivePath = join(source, "setup.tar.gz");
    // Export reports the resolved path (macOS /var -> /private/var, Windows 8.3 names expanded).
    expect(exported.envelope.data).toMatchObject({ output: realpathSync.native(archivePath), role: "standalone", folderFiles: 11, harnessFiles: 0 });
    if (posix) expect(statSync(archivePath).mode & 0o777).toBe(0o600);

    const archive = readFileSync(archivePath);
    expect(exported.envelope.data.sha256).toBe(sha256(archive));
    const entries = readTar(archive);
    expect(entries[0]!.path).toBe("manifest.json");
    const manifest = JSON.parse(entries[0]!.content.toString("utf8"));
    expect(exported.envelope.data.manifestSha256).toBe(sha256(entries[0]!.content));
    expect(manifest).toMatchObject({ format: "canonfig-export", version: 1, canonfigVersion: "5.0.1", role: "standalone" });
    const expected = authoredFiles(join(source, ".canonfig")).map((path) => `folder/${path}`);
    expect(entries.slice(1).map((entry) => entry.path)).toEqual(expected);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(expected);
    for (const [index, file] of manifest.files.entries()) {
      const content = readFileSync(join(source, ".canonfig", ...file.path.slice("folder/".length).split("/")));
      expect(file).toMatchObject({ size: content.length, sha256: sha256(content) });
      expect(entries[index + 1]!.content.equals(content)).toBe(true);
    }
    if (posix) {
      expect(manifest.files.find((file: { path: string }) => file.path === "folder/hooks/format.sh").mode).toBe("0755");
    }
    // The MCP header stays an environment reference; its value never enters the archive.
    const tar = gunzipSync(archive);
    expect(tar.includes("DOCS_TOKEN")).toBe(true);
    expect(tar.includes(SECRET)).toBe(false);

    const target = newHome();
    const planned = invoke(target, ["import", archivePath, "--dry-run"]);
    expect(planned.status, planned.stdout + planned.stderr).toBe(0);
    expect(planned.envelope.data.plan.actions.length).toBeGreaterThan(0);
    expect(authoredFiles(join(target, ".canonfig"))).toEqual([]);

    const imported = invoke(target, ["import", archivePath]);
    expect(imported.status, imported.stdout + imported.stderr).toBe(0);
    expect(imported.envelope.data).toMatchObject({ sha256: sha256(archive), outcome: { outcome: "Converged" }, replaced: [] });
    const restored = authoredFiles(join(target, ".canonfig"));
    expect(restored).toEqual(authoredFiles(join(source, ".canonfig")));
    for (const path of restored) {
      const parts = path.split("/");
      expect(readFileSync(join(target, ".canonfig", ...parts)).equals(readFileSync(join(source, ".canonfig", ...parts))), path).toBe(true);
    }
    if (posix) expect(statSync(join(target, ".canonfig", "hooks", "format.sh")).mode & 0o100).toBe(0o100);
    for (const excluded of [".backups", ".runtime", "installers", "credentials", "setup.json", "policy.json", "skills-sources.json", "state.sqlite-wal"]) {
      expect(existsSync(join(target, ".canonfig", excluded)), excluded).toBe(false);
    }
    // Both commands are in each machine's command journal.
    expect(readFileSync(join(source, "command.log"), "utf8")).toContain("\"command\":\"export\"");
    expect(readFileSync(join(target, "command.log"), "utf8")).toContain("\"command\":\"import\"");

    // The imported folder is authored content: a sync plans no removal of it.
    const sync = invoke(target, ["sync", "--plan"]);
    expect(sync.status, sync.stdout + sync.stderr).toBe(0);
    expect(JSON.stringify(sync.envelope.data.plan.actions)).not.toContain("import:");
  }, 180_000);

  it("refuses a literal credential in canonfig.jsonc and writes nothing", () => {
    const source = sourceHome();
    write(join(source, ".canonfig", "local", "local.jsonc"), `{ "mcp": { "api": { "transport": "streamable-http", "url": "https://example.invalid", "headers": { "Authorization": "Bearer ${SECRET}" } } } }\n`);
    const exported = invoke(source, ["export", "--output", "setup.tar.gz"]);
    expect(exported.status).toBe(2);
    expect(exported.envelope.message).toContain("literal credential");
    expect(exported.envelope.message).not.toContain(SECRET);
    expect(existsSync(join(source, "setup.tar.gz"))).toBe(false);
  }, 60_000);

  it("refuses an existing output without --force and an output outside home", () => {
    const source = sourceHome();
    write(join(source, "setup.tar.gz"), "keep me");
    const refused = invoke(source, ["export", "--output", "setup.tar.gz"]);
    expect(refused.status).toBe(4);
    expect(readFileSync(join(source, "setup.tar.gz"), "utf8")).toBe("keep me");
    const outside = invoke(source, ["export", "--output", join(tmpdir(), `canonfig-outside-${process.pid}.tar.gz`)]);
    expect(outside.status).toBe(2);
    expect(outside.envelope.message).toContain("outside the home directory");
    const forced = invoke(source, ["export", "--output", "setup.tar.gz", "--force"]);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(readTar(readFileSync(join(source, "setup.tar.gz")))[0]!.path).toBe("manifest.json");
  }, 90_000);

  it("refuses an archive changed after export, and an occupied folder unless --replace", () => {
    const source = sourceHome();
    expect(invoke(source, ["export", "--output", "setup.tar.gz"]).status).toBe(0);
    const archivePath = join(source, "setup.tar.gz");
    const tar = gunzipSync(readFileSync(archivePath));
    const at = tar.indexOf("# Global instructions");
    tar[at] = "!".charCodeAt(0);
    const tamperedPath = join(source, "tampered.tar.gz");
    writeFileSync(tamperedPath, gzipSync(tar));

    const target = newHome();
    const tampered = invoke(target, ["import", tamperedPath]);
    expect(tampered.status).toBe(7);
    expect(tampered.envelope.message).toContain("folder/AGENTS.md does not match its checksum");
    expect(authoredFiles(join(target, ".canonfig"))).toEqual([]);

    expect(invoke(target, ["import", archivePath]).status).toBe(0);
    const again = invoke(target, ["import", archivePath]);
    expect(again.status).toBe(4);
    expect(again.envelope.message).toContain("already holds");
    write(join(target, ".canonfig", "skills", "deploy", "added.md"), "added here\n");
    write(join(target, ".canonfig", "AGENTS.md"), "edited here\n");
    const replaced = invoke(target, ["import", archivePath, "--replace"]);
    expect(replaced.status, replaced.stdout + replaced.stderr).toBe(0);
    expect(replaced.envelope.data.replaced).toEqual(expect.arrayContaining(["AGENTS.md", "skills"]));
    expect(existsSync(join(target, ".canonfig", "skills", "deploy", "added.md"))).toBe(false);
    expect(readFileSync(join(target, ".canonfig", "AGENTS.md"), "utf8")).toBe("# Global instructions\n");
  }, 120_000);

  it("captures the harness files Canonfig manages with --include-harnesses and never imports them", () => {
    const source = sourceHome();
    write(join(source, "bin", posix ? "codex" : "codex.exe"), "", 0o755);
    write(join(source, ".codex", "config.toml"), "model = \"o3\"\n");
    write(join(source, ".codex", "auth.json"), `{"token":"${SECRET}"}\n`);
    const applied = invoke(source, ["sync", "--apply"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);

    const exported = invoke(source, ["export", "--include-harnesses", "--output", "setup.tar.gz"]);
    expect(exported.status, exported.stdout + exported.stderr).toBe(0);
    const archive = readFileSync(join(source, "setup.tar.gz"));
    const entries = readTar(archive);
    const manifest = JSON.parse(entries[0]!.content.toString("utf8"));
    const instructions = manifest.files.find((file: { path: string }) => file.path === "harnesses/codex/.codex/AGENTS.md");
    expect(instructions).toMatchObject({ harness: "codex", target: "~/.codex/AGENTS.md" });
    expect(entries.find((entry) => entry.path === instructions.path)!.content.equals(readFileSync(join(source, ".codex", "AGENTS.md")))).toBe(true);
    // A shared file contributes only the keys Canonfig owns there.
    const config = manifest.files.find((file: { path: string }) => file.path === "harnesses/codex/.codex/config.toml");
    expect(config.keys).toEqual(["mcp_servers"]);
    const configEntry = entries.find((entry) => entry.path === config.path)!.content.toString("utf8");
    expect(configEntry).toContain("DOCS_TOKEN");
    expect(configEntry).not.toContain("model");
    expect(entries.some((entry) => entry.path.endsWith("auth.json"))).toBe(false);
    expect(gunzipSync(archive).includes(SECRET)).toBe(false);

    // A surface edited after the apply no longer holds only what Canonfig wrote.
    write(join(source, ".codex", "AGENTS.md"), "edited by hand\n");
    const drifted = invoke(source, ["export", "--include-harnesses", "--output", "drifted.tar.gz"]);
    expect(drifted.status, drifted.stdout + drifted.stderr).toBe(0);
    expect(drifted.envelope.data.skippedHarnessSurfaces).toEqual([expect.objectContaining({ harness: "codex", surface: "instructions" })]);
    expect(readTar(readFileSync(join(source, "drifted.tar.gz"))).some((entry) => entry.path === instructions.path)).toBe(false);

    const target = newHome();
    const imported = invoke(target, ["import", join(source, "setup.tar.gz")]);
    expect(imported.status, imported.stdout + imported.stderr).toBe(0);
    expect(imported.envelope.data.harnessFiles).toMatchObject({ verified: manifest.files.filter((file: { harness?: string }) => file.harness !== undefined).length });
    expect(existsSync(join(target, ".codex"))).toBe(false);
    expect(existsSync(join(target, ".agents"))).toBe(false);
  }, 180_000);
});
