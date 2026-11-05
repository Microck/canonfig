import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOWS_ACL_SCRIPT } from "../../src/logging/command-log.ts";
import { programVersion } from "../../src/cli/help.ts";

const invoke = (home: string, args: readonly string[]) => spawnSync(process.execPath,
  ["--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"), ...args],
  { encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: home, USERPROFILE: home,
    CANONFIG_LOG_FILE: join(home, "command.log"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") } });

const logEntries = (home: string) => {
  const path = join(home, "command.log");
  const content = readFileSync(path, "utf8").trim();
  if (content === "" && process.platform === "win32") {
    const probe = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT], {
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CANONFIG_LOG_ACL_PATH: path },
    });
    throw new Error(`Secure command log was empty: ${JSON.stringify({ status: probe.status, error: probe.error?.message, stderr: probe.stderr })}`);
  }
  expect(content).not.toBe("");
  return content.split("\n").map((line) => JSON.parse(line));
};

describe("global CLI flags", () => {
  it.each([
    ["--json", "secrets", "list"], ["secrets", "--json", "list"],
  ])("routes %j and records its command", (...args) => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-global-flags-"));
    try {
      const result = invoke(home, args);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const command = "secrets.list";
      expect(JSON.parse(result.stdout)).toMatchObject({ schema: "canonfig.cli/v1", command, exitCode: 0 });
      const entries = logEntries(home);
      expect(entries.every((entry) => entry.command === command)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30000);

  it.each(["secrets", "installer"])("answers %s --version without opening state", (group) => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-global-version-"));
    try {
      const result = invoke(home, [group, "--version"]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(programVersion);
      expect(existsSync(join(home, ".canonfig/state.sqlite"))).toBe(false);
      const json = invoke(home, ["--json", group, "--version"]);
      expect(json.status, json.stdout + json.stderr).toBe(0);
      expect(JSON.parse(json.stdout).packageVersion).toBe(programVersion);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30000);

  // Repository harness projects were removed: `harness` is an unknown group,
  // so its help is the global listing and a subcommand is a usage error.
  it("treats harness as an unknown command group", () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-no-harness-"));
    try {
      const global = invoke(home, ["--help"]);
      const help = invoke(home, ["harness", "--help"]);
      expect(help.status, help.stdout + help.stderr).toBe(0);
      expect(help.stdout).toBe(global.stdout);
      const command = invoke(home, ["harness", "plan"]);
      expect(command.status, command.stdout + command.stderr).toBe(2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30000);
});


it.each([[], ["--stdin"]])("logs version-only enrollment calls as version: %j", (...options) => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-enrollment-version-"));
  try {
    const result = invoke(home, ["follower", "enroll", ...options, "--version"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(programVersion);
    const entries = logEntries(home);
    expect(entries.every((entry) => entry.command === "version")).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


it.each([
  [["secrets", "--help", "--version"], "secrets.help", 0],
  [["status", "--help", "--version"], "help", 0],
  [["--json"], "unknown", 2],
  [["--json", "--json"], "unknown", 2],
] as const)("logs option precedence for %j", (args, command, exitCode) => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-option-log-"));
  try {
    const result = invoke(home, args);
    expect(result.status, result.stdout + result.stderr).toBe(exitCode);
    const entries = logEntries(home);
    expect(entries.every((entry) => entry.command === command)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


it("retains secrets JSON group help when version flags accompany it", () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-mixed-help-"));
  try {
    for (const flags of [["--help", "--version"], ["--version", "--help"], ["-V", "-h"]]) {
      const result = invoke(home, ["--json", "secrets", ...flags]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({ schema: "canonfig.cli/v1", command: "secrets.help", exitCode: 0 });
      expect(envelope.data.commands).toContain("bootstrap");
    }
    expect(existsSync(join(home, ".canonfig/state.sqlite"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);


it("preserves positional secrets help over version", () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-positional-help-"));
  try {
    for (const version of ["--version", "-V"]) {
      const result = invoke(home, ["--json", "secrets", "help", version]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ schema: "canonfig.cli/v1", command: "secrets.help", exitCode: 0 });
    }
    const entries = logEntries(home);
    expect(entries.every((entry) => entry.command === "secrets.help")).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);
