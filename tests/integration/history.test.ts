import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { afterEach, expect, it } from "vitest";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-history-test-"));
  roots.push(root);
  const home = join(root, "home");
  const folder = join(home, ".canonfig");
  const history = join(folder, ".history.git");
  mkdirSync(folder, { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".state"), XDG_CACHE_HOME: join(home, ".cache"),
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG_FILE: join(root, "command.log"),
    CODEX_HOME: join(home, ".codex"),
  };
  const invoke = (args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/runtime/main.ts"), "--json", ...args], {
      encoding: "utf8", timeout: 60_000, env,
    });
    expect(result.status, result.error?.message ?? result.stdout + result.stderr).toBe(expected);
    return JSON.parse(result.stdout || result.stderr);
  };
  const git = (args: string[], input?: string) => {
    const result = spawnSync("git", args, { cwd: folder, encoding: "utf8", env, input, timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const object = (args: string[], input?: string) => git([`--git-dir=${history}`, ...args], input);
  const write = (path: string, bytes: string, mode?: number) => writeFileSync(join(folder, path), bytes, { mode });
  const read = (path: string) => readFileSync(join(folder, path), "utf8");
  return { root, home, folder, history, invoke, git, object, write, read, publish: (reviewer = "Maria") => invoke(["source", "publish", "--reviewer", reviewer]).data };
};

const profile = '"version":1,"profile":{"id":"workstation","name":"Workstation"},"harnesses":[]';
const notes = '"resources":{"notes":{"kind":"file","target":"~/notes.txt","source":"files/notes.txt"}}';
const scanner = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
const scannerUnavailable = scanner.error?.code === "ENOENT";

it("records exact publication files, skips old and repeated publications, reconciles a missing head and restores through a Takeover Snapshot", () => {
  const machine = fixture();
  machine.invoke(["source", "init"]);
  const initialConfig = `{\n// the original bytes\n${profile},${notes}\n}\n`;
  machine.write("canonfig.jsonc", initialConfig);
  mkdirSync(join(machine.folder, "files"));
  machine.write("files/notes.txt", "Original notes.\r\n", 0o755);
  machine.write("AGENTS.md", "First.\n", 0o755);
  mkdirSync(join(machine.folder, "local"));
  machine.write("local/AGENTS.md", "Only this machine.\n");
  machine.git(["init", "-b", "user"]);
  const userHead = machine.read(".git/HEAD");
  expect(machine.publish().sequence).toBe(1);

  machine.invoke(["history", "enable"]);
  expect(machine.publish().history).toBeUndefined();
  expect(machine.invoke(["history"]).data.entries).toEqual([]);

  machine.write("AGENTS.md", "Second.\n", 0o755);
  const second = machine.publish();
  expect(second.sequence).toBe(2);
  expect(second.history).toMatchObject({ commit: expect.any(String), push: { status: "local" } });
  expect(machine.object(["show", "canonfig:canonfig.jsonc"])).toBe(initialConfig);
  expect(machine.object(["show", "canonfig:files/notes.txt"])).toBe("Original notes.\r\n");
  const tree = machine.object(["ls-tree", "-r", "canonfig"]);
  expect(tree).toContain("files/notes.txt");
  expect(tree).not.toContain("local/");
  expect(tree).not.toContain(".git");
  if (process.platform !== "win32") expect(tree).toMatch(/100755 blob [a-f0-9]+\tfiles\/notes.txt/u);
  expect(machine.read(".git/HEAD")).toBe(userHead);
  expect(machine.publish().history).toBeUndefined();

  machine.object(["update-ref", "-d", "refs/heads/canonfig"]);
  const reconciled = machine.publish("Another reviewer");
  expect(reconciled).toMatchObject({ id: second.id, history: { commit: second.history.commit } });
  expect(machine.invoke(["history"]).data.entries).toEqual([expect.objectContaining({ sequence: 2, author: "Maria" })]);

  machine.write("canonfig.jsonc", `{${profile}}\n`);
  rmSync(join(machine.folder, "files"), { recursive: true });
  mkdirSync(join(machine.folder, "skills", "review"), { recursive: true });
  machine.write("skills/review/SKILL.md", "---\nname: review\ndescription: Review work\n---\nReview.\n");
  machine.publish();
  const diff = machine.invoke(["history", "diff", second.history.commit]).data;
  expect(diff.names).toEqual(expect.arrayContaining(["D\tfiles/notes.txt", "A\tskills/review/SKILL.md"]));
  expect(diff.patch).toContain("-// the original bytes");
  machine.invoke(["history", "diff", "HEAD"], 2);
  machine.invoke(["history", "restore", "2"], 2);

  const restored = machine.invoke(["history", "restore", "2", "--reviewer", "Maria"]).data;
  expect(restored.revision.sequence).toBe(4);
  expect(machine.read("canonfig.jsonc")).toBe(initialConfig);
  expect(machine.read("files/notes.txt")).toBe("Original notes.\r\n");
  expect(existsSync(join(machine.folder, "skills"))).toBe(false);
  expect(existsSync(join(machine.folder, ".backups", restored.backup))).toBe(true);
  machine.invoke(["restore", restored.backup]);
  expect(machine.read("skills/review/SKILL.md")).toContain("Review.");
  expect(machine.read("canonfig.jsonc")).toBe(`{${profile}}\n`);

  const archive = join(machine.home, "folder.tar.gz");
  machine.invoke(["export", "--output", archive]);
  const exported = gunzipSync(readFileSync(archive)).toString("utf8");
  expect(exported).not.toContain(".history.git");
  expect(exported).not.toContain("history.json");
}, 150_000);

const gitRemote = (machine: ReturnType<typeof fixture>, name = "remote.git") => {
  const path = join(machine.root, name);
  machine.git(["init", "--bare", "--initial-branch=main", path]);
  return { path, url: pathToFileURL(path).href, git: (args: string[], input?: string) => machine.git([`--git-dir=${path}`, ...args], input) };
};

it("records only converged changed applies on a standalone machine and restores with Projection", () => {
  const machine = fixture();
  machine.write("canonfig.jsonc", '{"version":1,"harnesses":[]}\n');
  machine.write("AGENTS.md", "First.\n");
  machine.invoke(["history", "enable"]);
  const first = machine.invoke(["sync", "--apply"]).data.history.commit;
  expect(first).toMatch(/^[0-9a-f]{7,40}$/u);
  expect(machine.invoke(["sync", "--apply"]).data.history).toBeUndefined();
  rmSync(join(machine.folder, "AGENTS.md"));
  machine.invoke(["sync", "--apply"]);
  const restored = machine.invoke(["history", "restore", first]).data;
  expect(restored.outcome.outcome).toBe("Converged");
  expect(machine.read("AGENTS.md")).toBe("First.\n");
  expect(machine.invoke(["history"]).data.entries.map((entry: { subject: string }) => entry.subject))
    .toEqual(["Apply: 1 added", "Apply: 1 removed", "Apply: 2 added"]);
  machine.invoke(["history", "disable"]);
  machine.write("AGENTS.md", "Changed while disabled.\n");
  machine.invoke(["sync", "--apply"]);
  expect(machine.invoke(["history"]).data).toMatchObject({ enabled: false, entries: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]) });
  expect(machine.invoke(["history"]).data.entries).toHaveLength(3);
}, 120_000);

it.skipIf(scannerUnavailable)(`retries offline history pushes and refuses divergence (${scannerUnavailable ? "gitleaks missing on PATH" : "real gitleaks"})`, () => {
  const machine = fixture();
  const remote = gitRemote(machine);
  machine.invoke(["source", "init"]);
  machine.write("canonfig.jsonc", `{${profile}}\n`);
  machine.invoke(["history", "enable", "--remote", remote.url]);
  const offline = `${remote.path}.offline`;
  renameSync(remote.path, offline);
  machine.write("AGENTS.md", "First.\n");
  expect(machine.publish().history.push).toMatchObject({ status: "not-pushed", reason: "remote unreachable" });
  expect(machine.invoke(["history"]).data.backlog).toBe(1);
  renameSync(offline, remote.path);
  expect(machine.publish().history.push.status).toBe("pushed");
  expect(machine.invoke(["history"]).data.backlog).toBe(0);

  renameSync(remote.path, offline);
  machine.write("AGENTS.md", "Second.\n");
  expect(machine.publish().history.push.status).toBe("not-pushed");
  renameSync(offline, remote.path);
  expect(machine.invoke(["history", "push"]).data.status).toBe("pushed");

  const alternate = gitRemote(machine, "alternate.git");
  const tree = alternate.git(["mktree"], "").trim();
  const outsider = alternate.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@canonfig.invalid", "commit-tree", tree, "-m", "Other history"]).trim();
  alternate.git(["update-ref", "refs/heads/main", outsider]);
  machine.invoke(["history", "enable", "--remote", alternate.url]);
  expect(machine.invoke(["history"]).data.backlog).toBe(2);
  expect(machine.invoke(["history", "push"], 4).message).toContain("remote branch diverged");
  expect(alternate.git(["rev-parse", "refs/heads/main"]).trim()).toBe(outsider);
}, 150_000);

it.skipIf(scannerUnavailable)(`blocks secrets deleted from an unpushed ancestor (${scannerUnavailable ? "gitleaks missing on PATH" : "real gitleaks"})`, () => {
  const machine = fixture();
  const remote = gitRemote(machine);
  machine.write("canonfig.jsonc", '{"version":1,"harnesses":[]}\n');
  machine.invoke(["history", "enable"]);
  const fixtureToken = ["ghp", "AD9KpW8qR1vcHT65Nd3ymBGhU0a7StXM4EjF"].join("_");
  machine.write("AGENTS.md", `Example token: ${fixtureToken} # gitleaks:allow\n`);
  machine.invoke(["sync", "--apply"]);
  machine.write("AGENTS.md", "No credentials here.\n");
  machine.invoke(["sync", "--apply"]);
  machine.invoke(["history", "enable", "--branch", "configuration", "--remote", remote.url]);
  const blocked = machine.invoke(["history", "push"], 7);
  expect(blocked.message).toContain("github-pat");
  expect(JSON.stringify(blocked)).not.toContain(fixtureToken);
  expect(machine.invoke(["history"]).data.backlog).toBe(2);
  expect(remote.git(["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("");
}, 120_000);
