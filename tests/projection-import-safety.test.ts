import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RootContext } from "../src/projection/harness.ts";
import { ImportChangedError, readImportContent, scanImports } from "../src/projection/import.ts";

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const makeHome = (): string => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "canonfig-import-safety-")));
  homes.push(home);
  return home;
};

const context = (home: string): RootContext => ({
  platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  home,
  appData: join(home, ".config"),
  environment: () => undefined,
  join,
});

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const manifest = "---\nname: demo\ndescription: Public fixture skill\n---\nUse the public guide.\n";
const skillRoot = (home: string): string => join(home, ".claude", "skills", "demo");
const scan = (home: string) => scanImports({
  context: context(home), harnesses: ["claude-code"], folder: join(home, ".canonfig"),
});

describe("skill resource filesystem boundaries", () => {
  it("does not offer a skill containing a hard-linked protected config file", async () => {
    const home = makeHome();
    const protectedConfig = join(home, ".claude.json");
    const original = JSON.stringify({ oauthAccount: { fixture: "private fixture content" }, mcpServers: {} });
    write(protectedConfig, original);
    write(join(skillRoot(home), "SKILL.md"), manifest);
    linkSync(protectedConfig, join(skillRoot(home), "resource.json"));

    const found = await scan(home);

    expect(found.candidates.filter((candidate) => candidate.category === "skills")).toEqual([]);
    expect(found.skipped.map((entry) => entry.path)).toContain(skillRoot(home));
    expect(readFileSync(protectedConfig, "utf8")).toBe(original);
  });

  it("does not offer a hard-linked skill manifest", async () => {
    const home = makeHome();
    const external = join(home, "library", "manifest.md");
    write(external, manifest);
    mkdirSync(skillRoot(home), { recursive: true });
    linkSync(external, join(skillRoot(home), "SKILL.md"));

    const found = await scan(home);

    expect(found.candidates.filter((candidate) => candidate.category === "skills")).toEqual([]);
    expect(found.skipped.map((entry) => entry.path)).toContain(skillRoot(home));
    expect(readFileSync(external, "utf8")).toBe(manifest);
  });

  it("imports independent regular files without changing their native content", async () => {
    const home = makeHome();
    const guide = "Public guide.\n";
    write(join(skillRoot(home), "SKILL.md"), manifest);
    write(join(skillRoot(home), "guide.md"), guide);
    const found = await scan(home);
    const candidate = found.candidates.find((entry) => entry.target === "skills/demo");
    if (candidate === undefined) throw new Error("Expected the public fixture skill");

    const content = await readImportContent(candidate, context(home), join(home, ".canonfig"));

    expect(found.skipped).toEqual([]);
    expect(content.kind).toBe("tree");
    if (content.kind !== "tree") throw new Error("Expected a portable skill tree");
    expect(content.files.map((file) => [file.path, new TextDecoder().decode(file.content)])).toEqual([
      ["SKILL.md", manifest], ["guide.md", guide],
    ]);
    expect(readFileSync(join(skillRoot(home), "SKILL.md"), "utf8")).toBe(manifest);
    expect(readFileSync(join(skillRoot(home), "guide.md"), "utf8")).toBe(guide);
  });

  it("refuses a resource that becomes hard-linked after review", async () => {
    const home = makeHome();
    const resource = join(skillRoot(home), "guide.md");
    write(join(skillRoot(home), "SKILL.md"), manifest);
    write(resource, "Public guide.\n");
    const found = await scan(home);
    const candidate = found.candidates.find((entry) => entry.target === "skills/demo");
    if (candidate === undefined) throw new Error("Expected the reviewed fixture skill");
    // A second name outside the skill changes sharing, but not content/digest.
    linkSync(resource, join(home, "another-guide.md"));

    await expect(readImportContent(candidate, context(home), join(home, ".canonfig")))
      .rejects.toBeInstanceOf(ImportChangedError);
    expect(readFileSync(resource, "utf8")).toBe("Public guide.\n");
  });
});
