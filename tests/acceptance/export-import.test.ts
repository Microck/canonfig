import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const AUTHORED = ["canonfig.jsonc", "AGENTS.md", "rules", "skills", "agents", "commands", "hooks", "files", "local"];
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

/** The machine's `archive_events` rows, oldest first, without their ids and times. */
const archiveEvents = (home: string) => {
  const database = new DatabaseSync(join(home, ".canonfig", "state.sqlite"), { readOnly: true });
  try {
    return database.prepare("SELECT command, outcome, archive, sha256, signer FROM archive_events ORDER BY id").all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
};

const syncRuns = (home: string): number => {
  const database = new DatabaseSync(join(home, ".canonfig", "state.sqlite"), { readOnly: true });
  try {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM synchronization_runs").get()?.count);
  } finally {
    database.close();
  }
};

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
    expect(manifest).toMatchObject({ format: "canonfig-export", version: 1, canonfigVersion: "7.1.1", role: "standalone" });
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

    // An authored config resource's keys get publication's field-name rule,
    // which catches a value the text pattern alone does not.
    rmSync(join(source, ".canonfig", "local", "local.jsonc"));
    write(join(source, ".canonfig", "canonfig.jsonc"), `${JSON.stringify({
      version: 1,
      harnesses: [],
      resources: { tool: { kind: "config", target: "~/.config/tool/settings.json", format: "json", keys: { env: [{ name: "API_TOKEN", value: SECRET }] } } },
    })}\n`);
    const resource = invoke(source, ["export", "--output", "setup.tar.gz"]);
    expect(resource.status, resource.stdout + resource.stderr).toBe(2);
    expect(resource.envelope.message).toContain("literal credential at keys.resources.tool");
    expect(resource.envelope.message).not.toContain(SECRET);
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

  it("refuses an archive changed after export, and backs up an occupied folder it replaces with --replace", () => {
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
    const folder = join(target, ".canonfig");
    const before = new Map(authoredFiles(folder).map((path) => [path, readFileSync(join(folder, ...path.split("/")))]));
    const replaced = invoke(target, ["import", archivePath, "--replace"]);
    expect(replaced.status, replaced.stdout + replaced.stderr).toBe(0);
    expect(replaced.envelope.data.replaced).toEqual(expect.arrayContaining(["AGENTS.md", "skills"]));
    expect(existsSync(join(folder, "skills", "deploy", "added.md"))).toBe(false);
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toBe("# Global instructions\n");

    // Every file it replaced went to a takeover snapshot first, byte for byte,
    // under the home-relative path of the folder.
    const backup = replaced.envelope.data.backup;
    expect(backup).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    const copies = join(folder, ".backups", backup, "canonfig", ".canonfig");
    expect(filesBelow(copies)).toEqual([...before.keys()]);
    for (const [path, bytes] of before) expect(readFileSync(join(copies, ...path.split("/"))).equals(bytes), path).toBe(true);

    // Restoring that snapshot puts the folder back, after a snapshot of the
    // imported entries it replaces in turn.
    const restored = invoke(target, ["restore", backup]);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    expect(restored.envelope.data).toMatchObject({ restored: backup, excludedHarnesses: [], outcome: { outcome: "Converged" } });
    expect(authoredFiles(folder)).toEqual([...before.keys()]);
    for (const [path, bytes] of before) expect(readFileSync(join(folder, ...path.split("/"))).equals(bytes), path).toBe(true);
    const undo = join(folder, ".backups", restored.envelope.data.backup, "canonfig", ".canonfig");
    expect(readFileSync(join(undo, "AGENTS.md"), "utf8")).toBe("# Global instructions\n");
  }, 180_000);

  it("signs a Source's export, verifies the signature on import and journals both", () => {
    const source = sourceHome();
    const credentials = { CANONFIG_LOCAL_CREDENTIAL_ROOT: join(source, "credential-store") };
    const initialized = invoke(source, ["source", "init"], credentials);
    expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
    const fingerprint: string = invoke(source, ["status"], credentials).envelope.data.machineRole.sourceFingerprint;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);

    const exported = invoke(source, ["export", "--output", "setup.tar.gz"], credentials);
    expect(exported.status, exported.stdout + exported.stderr).toBe(0);
    expect(exported.envelope.data).toMatchObject({ role: "source", signer: fingerprint });
    const archivePath = join(source, "setup.tar.gz");
    const entries = readTar(readFileSync(archivePath));
    expect(entries.slice(0, 2).map((entry) => entry.path)).toEqual(["manifest.json", "signature.json"]);
    expect(JSON.parse(entries[1]!.content.toString("utf8"))).toMatchObject({ fingerprint });
    // The export is journaled apart from synchronization runs.
    expect(archiveEvents(source)).toEqual([
      { command: "export", outcome: "Exported", archive: realpathSync.native(archivePath), sha256: exported.envelope.data.sha256, signer: fingerprint },
    ]);
    expect(syncRuns(source)).toBe(0);

    const target = newHome();
    const planned = invoke(target, ["import", archivePath, "--dry-run", "--expect-key", fingerprint.toUpperCase()]);
    expect(planned.status, planned.stdout + planned.stderr).toBe(0);
    expect(planned.envelope.data.signer).toBe(fingerprint);
    const other = "0".repeat(64);
    const wrongKey = invoke(target, ["import", archivePath, "--expect-key", other]);
    expect(wrongKey.status).toBe(7);
    expect(wrongKey.envelope.message).toContain(`is signed by key ${fingerprint}, not by the --expect-key ${other}`);
    expect(authoredFiles(join(target, ".canonfig"))).toEqual([]);

    // A signature that no longer matches the manifest refuses the whole archive.
    const tar = gunzipSync(readFileSync(archivePath));
    const at = tar.indexOf("\"ed25519:") + 20;
    tar[at] = tar[at] === "A".charCodeAt(0) ? "B".charCodeAt(0) : "A".charCodeAt(0);
    const forgedPath = join(source, "forged.tar.gz");
    writeFileSync(forgedPath, gzipSync(tar));
    const forged = invoke(target, ["import", forgedPath]);
    expect(forged.status).toBe(7);
    expect(forged.envelope.message).toContain("signature.json that does not match manifest.json");
    expect(authoredFiles(join(target, ".canonfig"))).toEqual([]);

    const imported = invoke(target, ["import", archivePath, "--expect-key", fingerprint]);
    expect(imported.status, imported.stdout + imported.stderr).toBe(0);
    expect(imported.envelope.data).toMatchObject({ signer: fingerprint, outcome: { outcome: "Converged" } });
    expect(authoredFiles(join(target, ".canonfig"))).toEqual(authoredFiles(join(source, ".canonfig")));
    // The dry run wrote nothing, so the journal holds the two refusals and the import.
    expect(archiveEvents(target).map((event) => [event.outcome, event.signer])).toEqual([
      ["Error", null],
      ["Error", null],
      ["Converged", fingerprint],
    ]);
  }, 180_000);

  it("leaves a non-Source export unsigned, which --expect-key refuses", () => {
    const source = sourceHome();
    const exported = invoke(source, ["export", "--output", "setup.tar.gz"]);
    expect(exported.status, exported.stdout + exported.stderr).toBe(0);
    expect(exported.envelope.data).toMatchObject({ role: "standalone", signer: "unsigned" });
    const archivePath = join(source, "setup.tar.gz");
    expect(readTar(readFileSync(archivePath)).some((entry) => entry.path === "signature.json")).toBe(false);

    const target = newHome();
    const refused = invoke(target, ["import", archivePath, "--expect-key", "a".repeat(64)]);
    expect(refused.status).toBe(7);
    expect(refused.envelope.message).toContain(`is unsigned, but --expect-key requires a signature by key ${"a".repeat(64)}`);
    expect(authoredFiles(join(target, ".canonfig"))).toEqual([]);
    const imported = invoke(target, ["import", archivePath]);
    expect(imported.status, imported.stdout + imported.stderr).toBe(0);
    expect(imported.envelope.data.signer).toBe("unsigned");
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

    // A file added to a skill directory Canonfig applied leaves that surface
    // out too, although every file Canonfig recorded there is unchanged.
    const skill = manifest.files.find((file: { path: string; harness?: string }) =>
      file.harness !== undefined && file.path.endsWith("/deploy/SKILL.md"));
    const skillDirectory = join(source, ...dirname(skill.target.slice("~/".length)).split("/"));
    write(join(skillDirectory, "notes.md"), "added by hand\n");
    const added = invoke(source, ["export", "--include-harnesses", "--output", "added.tar.gz"]);
    expect(added.status, added.stdout + added.stderr).toBe(0);
    expect(added.envelope.data.skippedHarnessSurfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining("notes.md, which Canonfig did not write") }),
    ]));
    expect(readTar(readFileSync(join(source, "added.tar.gz"))).some((entry) => entry.path === skill.path)).toBe(false);

    const target = newHome();
    const imported = invoke(target, ["import", join(source, "setup.tar.gz")]);
    expect(imported.status, imported.stdout + imported.stderr).toBe(0);
    expect(imported.envelope.data.harnessFiles).toMatchObject({ verified: manifest.files.filter((file: { harness?: string }) => file.harness !== undefined).length });
    expect(existsSync(join(target, ".codex"))).toBe(false);
    expect(existsSync(join(target, ".agents"))).toBe(false);
  }, 180_000);

  it("carries authored resources, files/, Local Overlays and key claims, and resource projections an import accepts", () => {
    const source = newHome();
    const folder = join(source, ".canonfig");
    write(join(folder, "canonfig.jsonc"), `${JSON.stringify({
      version: 1,
      harnesses: [],
      local: { allow: ["rules"] },
      resources: {
        gitconfig: { kind: "file", target: "~/.gitconfig", source: "files/gitconfig" },
        team: { kind: "file", target: "~/notes/TEAM.md", source: "files/TEAM.md", policy: "append-local" },
        scripts: { kind: "directory", target: "~/.local/share/team-scripts", source: "files/scripts" },
        tool: { kind: "config", target: "~/.config/tool/settings.json", format: "json", keys: { editor: "vim" } },
      },
    }, undefined, 2)}\n`);
    write(join(folder, "files", "gitconfig"), "[user]\n\tname = Team\n");
    write(join(folder, "files", "TEAM.md"), "Team notes.\n");
    write(join(folder, "files", "scripts", "build.sh"), "#!/bin/sh\nexit 0\n", 0o755);
    write(join(folder, "rules", "style.md"), "---\ndescription: Style\n---\nUse two spaces.\n");
    write(join(folder, "local", "rules", "style.md"), "---\ndescription: Style\n---\nUse tabs here.\n");
    write(join(folder, "local", "local.jsonc"), `${JSON.stringify({ overlays: ["rules/style", "settings/codex#model"] })}\n`);
    write(join(source, "notes", "TEAM.md"), "My own notes.\n");
    write(join(source, ".config", "tool", "settings.json"), JSON.stringify({ theme: "dark" }));
    const applied = invoke(source, ["sync", "--apply"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);

    const exported = invoke(source, ["export", "--include-harnesses", "--output", "setup.tar.gz"]);
    expect(exported.status, exported.stdout + exported.stderr).toBe(0);
    const archivePath = join(source, "setup.tar.gz");
    const archive = readFileSync(archivePath);
    const entries = readTar(archive);
    const manifest = JSON.parse(entries[0]!.content.toString("utf8"));
    const listed = manifest.files.map((file: { path: string }) => file.path);
    expect(listed.filter((path: string) => path.startsWith("folder/"))).toEqual(authoredFiles(folder).map((path) => `folder/${path}`));
    expect(listed).toEqual(expect.arrayContaining(["folder/files/gitconfig", "folder/files/scripts/build.sh", "folder/local/local.jsonc", "folder/local/rules/style.md"]));
    // Authored resources project like a harness; the append-local one also
    // holds this machine's own text, so it stays out.
    const projected = manifest.files.filter((file: { harness?: string }) => file.harness === "resources");
    expect(projected.map((file: { target: string }) => file.target).sort()).toEqual(["~/.config/tool/settings.json", "~/.gitconfig", "~/.local/share/team-scripts/build.sh"]);
    expect(exported.envelope.data.skippedHarnessSurfaces).toEqual([
      expect.objectContaining({ harness: "resources", surface: "team", reason: expect.stringContaining("append-local") }),
    ]);
    expect(gunzipSync(archive).includes("My own notes.")).toBe(false);
    const tool = projected.find((file: { target: string }) => file.target === "~/.config/tool/settings.json");
    expect(JSON.parse(entries.find((entry) => entry.path === tool.path)!.content.toString("utf8"))).toEqual({ editor: "vim" });

    const target = newHome();
    const imported = invoke(target, ["import", archivePath]);
    expect(imported.status, imported.stdout + imported.stderr).toBe(0);
    expect(imported.envelope.data).toMatchObject({ outcome: { outcome: "Converged" }, harnessFiles: { verified: 3 } });
    for (const path of authoredFiles(folder)) {
      expect(readFileSync(join(target, ".canonfig", ...path.split("/"))).equals(readFileSync(join(folder, ...path.split("/")))), path).toBe(true);
    }
    expect(existsSync(join(target, ".gitconfig"))).toBe(false);
    // The overlay and the key claim arrive as this machine's own decisions.
    const overlays = invoke(target, ["overlay", "list"]);
    expect(overlays.status, overlays.stdout + overlays.stderr).toBe(0);
    expect(overlays.envelope.data.overlays).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "item", item: "rules/style", local: true, published: true }),
      expect.objectContaining({ kind: "claim", item: "settings/codex#model" }),
    ]));
    // The next sync projects the imported resources.
    const synced = invoke(target, ["sync", "--apply"]);
    expect(synced.status, synced.stdout + synced.stderr).toBe(0);
    expect(readFileSync(join(target, ".gitconfig"), "utf8")).toBe("[user]\n\tname = Team\n");
    expect(readFileSync(join(target, "notes", "TEAM.md"), "utf8")).toContain("Team notes.");
  }, 240_000);
});
