import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateCli } from "../src/cli/cli.ts";

const projectRoot = resolve(import.meta.dirname, "..");

const readProjectFile = (relativePath: string): string =>
  readFileSync(resolve(projectRoot, relativePath), "utf8");

const setupSkill = readProjectFile("skills/setup-canonfig/SKILL.md");
const setupSource = readProjectFile("skills/setup-canonfig/references/source.md");
const setupFollower = readProjectFile("skills/setup-canonfig/references/follower.md");
const operateSkill = readProjectFile("skills/operate-canonfig/SKILL.md");
const multiMachine = readProjectFile("skills/operate-canonfig/references/multi-machine.md");
const debugSkill = readProjectFile("skills/debug-canonfig/SKILL.md");

describe("Canonfig skill structure and disclosure", () => {
  it("keeps top-level skills concise and discloses multi-machine branches via pointers", () => {
    expect(setupSkill.split(/\r?\n/u).length).toBeLessThanOrEqual(180);
    expect(operateSkill.split(/\r?\n/u).length).toBeLessThanOrEqual(150);
    expect(debugSkill.split(/\r?\n/u).length).toBeLessThanOrEqual(180);
    expect(setupSkill).toContain("references/source.md");
    expect(setupSkill).toContain("references/follower.md");
    expect(operateSkill).toContain("references/multi-machine.md");
    expect(operateSkill).toContain("../debug-canonfig/SKILL.md");
  });

  it("guides local-first setup with explicit preview and mental-model orientation", () => {
    expect(setupSkill).toContain("Just this computer");
    expect(setupSkill).toContain("Which harness do you use most?");
    expect(setupSkill).toContain("What should Canonfig manage?");
    expect(setupSkill).toContain("Where should the shared config apply?");
    expect(setupSkill).toContain("Apply the changes shown above?");
    expect(setupSkill).toContain("~/.canonfig/local/");
    expect(setupSkill).toContain("Takeover Snapshot");
  });
});

describe("Canonfig skill safety and platform contracts", () => {
  it.each([
    { platform: "Linux", credentialProvider: "Secret Service", scheduler: "systemd user timer" },
    { platform: "macOS", credentialProvider: "Keychain", scheduler: "launchd user agent" },
    { platform: "Windows", credentialProvider: "Credential Manager", scheduler: "per-user Task Scheduler" },
  ])("documents platform boundaries for $platform", ({ credentialProvider, scheduler }) => {
    expect(multiMachine).toContain(credentialProvider);
    expect(multiMachine).toContain(scheduler);
    expect(setupSource).toContain(credentialProvider);
  });

  it("protects secrets, trust pins, drift, and interrupted-run recovery", () => {
    expect(setupSkill).toContain("keep credentials out of chat");
    expect(setupSource).toContain('{ "fromEnv": "NAME" }');
    expect(setupFollower).toContain("never paste invitations in chat");
    expect(setupFollower).toContain("Never reset pins or bypass");
    expect(operateSkill).toContain("Never force-overwrite drift");
    expect(operateSkill).toContain("canonfig recover");
    expect(operateSkill).toContain("clientLoaded");
  });

  it("defines the debug-canonfig A-vs-B triage workflow and safety guardrails", () => {
    expect(debugSkill).toContain("Category A");
    expect(debugSkill).toContain("Category B");
    expect(debugSkill).toContain("preserveMcp");
    expect(debugSkill).toContain('"enabled": false');
    expect(debugSkill).toContain("fromSecret");
    expect(debugSkill).toContain("EBADPLATFORM");
    expect(debugSkill).toContain("downgrade");
    expect(debugSkill).toContain("__pycache__");
    expect(debugSkill).toContain(".DS_Store");
    expect(debugSkill).toContain("executable-present");
    expect(debugSkill).toContain("NTFS ACL");
    expect(debugSkill).toContain("\\Canonfig\\canonfig-sync");
    expect(debugSkill).toContain("Back up `~/.canonfig/local/local.jsonc`");
    expect(debugSkill).toContain("Microck/canonfig");
  });

  it("references valid CLI commands", () => {
    for (const argv of [
      ["sync", "--plan", "--json"],
      ["sync", "--apply", "--no-input", "--json"],
      ["local", "mcp", "preserve", "--harness", "codex"],
      ["local", "mcp", "status"],
      ["overlay", "list"],
      ["schedule", "run", "--timeout-ms", "600000", "--json"],
      ["recover", "--no-input", "--json"],
    ]) {
      expect(evaluateCli(argv)._tag).toBe("Command");
    }
  });
});
