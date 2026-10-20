import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { programVersion } from "../../src/cli/help.ts";

const invoke = (home: string, args: readonly string[]) => spawnSync(process.execPath,
  ["--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"), ...args],
  { encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: home, USERPROFILE: home,
    CANONFIG_LOG_FILE: join(home, "command.log"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") } });

describe("global CLI flags", () => {
  it.each([
    ["--json", "secrets", "list"], ["secrets", "--json", "list"],
    ["--json", "harness", "targets"], ["harness", "--json", "targets"],
  ])("routes %j and records its command", (...args) => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-global-flags-"));
    try {
      const result = invoke(home, args);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const command = args.includes("secrets") ? "secrets.list" : "harness.targets";
      expect(JSON.parse(result.stdout)).toMatchObject({ schema: "canonfig.cli/v1", command, exitCode: 0 });
      const entries = readFileSync(join(home, "command.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.every((entry) => entry.command === command)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30000);

  it.each(["secrets", "harness", "installer"])("answers %s --version without opening state", (group) => {
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
});


it.each([[], ["--stdin"]])("logs version-only enrollment calls as version: %j", (...options) => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-enrollment-version-"));
  try {
    const result = invoke(home, ["follower", "enroll", ...options, "--version"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(programVersion);
    const entries = readFileSync(join(home, "command.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
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
    const entries = readFileSync(join(home, "command.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.every((entry) => entry.command === command)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


it.each(["secrets", "harness"])("retains %s JSON group help when version flags accompany it", (group) => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-mixed-help-"));
  try {
    for (const flags of [["--help", "--version"], ["--version", "--help"], ["-V", "-h"]]) {
      const result = invoke(home, ["--json", group, ...flags]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({ schema: "canonfig.cli/v1", command: `${group}.help`, exitCode: 0 });
      expect(envelope.data.commands).toContain(group === "secrets" ? "bootstrap" : "targets");
    }
    expect(existsSync(join(home, ".canonfig/state.sqlite"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);


it.each(["secrets", "harness"])("preserves positional %s help over version", (group) => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-positional-help-"));
  try {
    for (const version of ["--version", "-V"]) {
      const result = invoke(home, ["--json", group, "help", version]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ schema: "canonfig.cli/v1", command: `${group}.help`, exitCode: 0 });
    }
    const entries = readFileSync(join(home, "command.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.every((entry) => entry.command === `${group}.help`)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);
