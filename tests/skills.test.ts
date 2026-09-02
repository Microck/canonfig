import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateCli } from "../src/cli/cli.ts";

const projectRoot = resolve(import.meta.dirname, "..");

const readProjectFile = (relativePath: string): string =>
  readFileSync(resolve(projectRoot, relativePath), "utf8");

const installSkill = readProjectFile("skills/install-canonfig/SKILL.md");
const operationsSkill = readProjectFile("skills/operate-canonfig/SKILL.md");
const followerOperations = readProjectFile(
  "skills/operate-canonfig/references/follower-operations.md",
);
const platformBoundaries = readProjectFile(
  "skills/operate-canonfig/references/platform-boundaries.md",
);

describe("Canonfig skill platform scenarios", () => {
  it.each([
    {
      platform: "Linux",
      reference: "skills/install-canonfig/references/linux.md",
      credentialProvider: "Secret Service",
      scheduler: "systemd user timer",
      recipe: "apt",
      install: "npm install --global @microck/canonfig@2.2.0",
    },
    {
      platform: "macOS",
      reference: "skills/install-canonfig/references/macos.md",
      credentialProvider: "Keychain",
      scheduler: "launchd user agent",
      recipe: "Homebrew",
      install: "npm install --global @microck/canonfig@2.2.0",
    },
    {
      platform: "Windows",
      reference: "skills/install-canonfig/references/windows.md",
      credentialProvider: "Credential Manager",
      scheduler: "per-user Task Scheduler",
      recipe: "winget",
      install: "npm install --global @microck/canonfig@2.2.0",
    },
  ])(
    "installs and operates safely on $platform",
    ({ reference, credentialProvider, scheduler, recipe, install }) => {
      const branch = readProjectFile(reference);
      expect(branch).toContain("Node.js 24");
      expect(branch).toContain("@microck/canonfig@2.2.0");
      expect(branch).toContain(install);
      expect(branch).toContain(credentialProvider);
      expect(branch).toContain(scheduler);
      expect(branch).toContain("Human Action Required");
      expect(branch).toMatch(/Do not|do not/u);
      expect(installSkill).toContain(reference.replace("skills/install-canonfig/", ""));
      expect(platformBoundaries).toContain(credentialProvider);
      expect(platformBoundaries).toContain(scheduler);
      expect(platformBoundaries).toContain(recipe);
      expect(operationsSkill).toContain("references/platform-boundaries.md");
    },
  );
});

describe("Canonfig skill safety scenarios", () => {
  it("refuses trust bypass and requests fresh enrollment material", () => {
    expect(installSkill).toContain("Refuse an expired, replayed");
    expect(installSkill).toContain("Request a new invitation");
    expect(installSkill).toContain("never reset trust or suppress verification");
  });

  it("preserves Human Action Required instead of embedding a credential", () => {
    expect(installSkill).toContain("preserve the Human Action");
    expect(installSkill).toContain("Keep secrets out of command arguments");
    expect(followerOperations).toContain("Present the recorded reason, exact instructions");
    expect(followerOperations).toContain("Keep tokens off the command line");
  });

  it("preserves a follower-modified skill instead of forcing convergence", () => {
    expect(operationsSkill).toContain("Preserve modified follower skills");
    expect(followerOperations).toContain("preserve it and report the conflict");
    expect(followerOperations).toContain("Unattended agents do not make this");
  });

  it("keeps scheduled apply noninteractive and failures visible", () => {
    const outcome = evaluateCli(["sync", "--apply", "--no-input", "--json"]);
    expect(outcome._tag).toBe("Command");
    expect(operationsSkill).toContain("Scheduled runs never wait for approval");
    expect(operationsSkill).toContain("Keep failure output visible");
  });

  it("keeps recovery on the persisted journal", () => {
    const outcome = evaluateCli(["recover", "--no-input", "--json"]);
    expect(outcome._tag).toBe("Command");
    expect(followerOperations).toContain("resumes the recorded plan");
    expect(followerOperations).toContain("preserve SQLite state and the action journal");
  });
});
