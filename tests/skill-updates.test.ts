import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSkills, listSkills, parseConfig, trackSkill, updateSkills, type SkillLocation } from "../src/harness-configuration/skills/manager.ts";
import { fetchSkill, normalizeSource, safePath } from "../src/harness-configuration/skills/upstream.ts";
import { runSkillsCli } from "../src/harness-configuration/skills/cli.ts";
import { isSkillsCommand, skillsArguments } from "../src/runtime/command-routing.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function write(root: string, file: string, bytes: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), bytes);
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "canonfig-skills-")); roots.push(root);
  const upstream = path.join(root, "upstream"); await mkdir(upstream); git(upstream, "init", "-b", "main");
  await write(upstream, "skills/demo/SKILL.md", "---\nname: demo\ndescription: Fixture\n---\nVersion one\n");
  await write(upstream, "skills/demo/assets/data.bin", Buffer.from([0, 255, 128]));
  git(upstream, "add", "."); git(upstream, "commit", "-m", "initial");
  await mkdir(path.join(root, ".canonfig", "skills"), { recursive: true });
  await cp(path.join(upstream, "skills", "demo"), path.join(root, ".canonfig", "skills", "demo"), { recursive: true });
  const location: SkillLocation = { root, config: ".canonfig/skills-sources.json" };
  const input = { name: "demo", path: ".canonfig/skills/demo", source: upstream, ref: "main", subdir: "skills/demo" };
  return { root, upstream, location, input };
}
async function advance(upstream: string) {
  await write(upstream, "skills/demo/SKILL.md", "---\nname: demo\ndescription: Fixture\n---\nVersion two\n");
  await write(upstream, "skills/demo/references/new.md", "new reference");
  await rm(path.join(upstream, "skills/demo/assets/data.bin"));
  git(upstream, "add", "-A"); git(upstream, "commit", "-m", "advance");
}

describe("tracked upstream skill updates", () => {
  it("tracks exact installed content and previews all added, changed and removed files", async () => {
    const { location, input, upstream } = await fixture();
    await trackSkill(location, input);
    const original = await readFile(path.join(location.root, location.config));
    await advance(upstream);
    const [check] = await checkSkills(location, []);
    expect(check?.status).toBe("update-available");
    expect(check?.added).toEqual(["references/new.md"]);
    expect(check?.removed).toEqual(["assets/data.bin"]);
    expect(check?.changed).toEqual(["SKILL.md"]);
    expect(await readFile(path.join(location.root, location.config))).toEqual(original);
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version one");
    await updateSkills(location, ["demo"]);
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version two");
    expect((await checkSkills(location, []))[0]?.status).toBe("unchanged");
    expect((await listSkills(location)).skills[0]?.commit).toBe(git(upstream, "rev-parse", "HEAD"));
  });
  it("preserves local edits and blocks the complete selected update", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input);
    await cp(path.join(location.root, input.path), path.join(location.root, ".canonfig/skills/second"), { recursive: true });
    await trackSkill(location, { ...input, name: "second", path: ".canonfig/skills/second" });
    await write(location.root, `${input.path}/notes.md`, "my own notes");
    await advance(upstream);
    expect((await checkSkills(location, []))[0]?.status).toBe("local-edits");
    await expect(updateSkills(location, [])).rejects.toThrow("Local edits");
    expect(await readFile(path.join(location.root, input.path, "notes.md"), "utf8")).toBe("my own notes");
    expect(await readFile(path.join(location.root, ".canonfig/skills/second/SKILL.md"), "utf8")).toContain("Version one");
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version one");
  });
  it("refuses to invent a baseline for a modified or untracked skill", async () => {
    const { location, input } = await fixture();
    await write(location.root, `${input.path}/SKILL.md`, "local edits");
    await expect(trackSkill(location, input)).rejects.toThrow("differs");
    expect((await listSkills(location)).skills).toEqual([]);
    await expect(checkSkills(location, ["missing"])).rejects.toThrow("not tracked");
  });
  it("honors branch/tag refs and subdirectories, and retains a pinned commit", async () => {
    const { location, input, upstream } = await fixture(); const pinned = git(upstream, "rev-parse", "HEAD");
    await trackSkill(location, { ...input, ref: pinned });
    await advance(upstream);
    expect((await checkSkills(location, []))[0]?.status).toBe("unchanged");
  });
  it("fails closed on malformed config instead of resetting provenance", async () => {
    const { location } = await fixture(); await write(location.root, location.config, "{ broken");
    await expect(listSkills(location)).rejects.toThrow("not reset");
    expect(await readFile(path.join(location.root, location.config), "utf8")).toBe("{ broken");
  });
  it("refuses concurrent or interrupted updates", async () => {
    const { location, input } = await fixture(); await trackSkill(location, input);
    await write(location.root, `${location.config}.lock`, "held");
    await expect(updateSkills(location, [])).rejects.toThrow("skill lock");
    await rm(path.join(location.root, `${location.config}.lock`));
    await write(location.root, `${location.config}.pending`, "manual recovery");
    await expect(updateSkills(location, [])).rejects.toThrow("recovery journal");
  });
  it("supports configurable locations and named selection", async () => {
    const { location, input, root, upstream } = await fixture();
    const custom = { root, config: "settings/upstreams.json" };
    await trackSkill(custom, input);
    await expect(checkSkills(custom, ["other"])).rejects.toThrow("not tracked");
    expect((await checkSkills(custom, ["DEMO"]))[0]?.name).toBe("demo");
    expect((await listSkills(location)).skills).toEqual([]);
    expect(upstream).toBeTruthy();
  });
  it.skipIf(process.platform === "win32")("rejects local and upstream symlinks and detects executable changes", async () => {
    const { location, input, upstream } = await fixture();
    await trackSkill(location, input);
    await chmod(path.join(location.root, input.path, "SKILL.md"), 0o755);
    expect((await checkSkills(location, []))[0]?.status).toBe("local-edits");
    await symlink("/etc/passwd", path.join(upstream, "skills/demo/escape"));
    git(upstream, "add", "."); git(upstream, "commit", "-m", "bad link");
    await expect(fetchSkill(input)).rejects.toThrow("symlink");
    await symlink("/etc/passwd", path.join(location.root, input.path, "escape"));
    await expect(checkSkills(location, [])).rejects.toThrow("symbolic link");
  });
  it("rejects ambiguous names, overlaps and traversal", () => {
    const base = { name: "demo", path: "skills/demo", source: "https://example.invalid/repo.git", ref: "main", subdir: ".", commit: "a".repeat(40), digest: "b".repeat(64) };
    expect(() => parseConfig({ version: 1, skills: [base, { ...base, name: "other", path: "skills/demo/nested" }] })).toThrow("overlap");
    for (const name of ["../bad", "/tmp/bad", "C:/bad", "a\\b", "a/CON", "a/../b"]) expect(() => safePath(name)).toThrow();
    for (const source of ["https://user:token@example.invalid/repo", "https://example.invalid/repo?token=x", "ext::danger", "ssh://example.invalid/repo"]) expect(() => normalizeSource(source, "/tmp")).toThrow();
  });
  it("CLI is preview-first, rejects force and routes global JSON correctly", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input); await advance(upstream);
    let stdout = ""; let stderr = ""; let code = -1;
    const io = { writeStdout: (value: string) => { stdout += value; }, writeStderr: (value: string) => { stderr += value; }, setExitCode: (value: number) => { code = value; } };
    await runSkillsCli(["update", "--root", location.root, "--json"], io);
    expect(code).toBe(0); expect(JSON.parse(stdout).data.applied).toBe(false);
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version one");
    await runSkillsCli(["update", "--force"], io);
    expect(code).not.toBe(0); expect(stderr).toContain("Unknown");
    expect(isSkillsCommand(["--json", "skills", "list"])).toBe(true);
    expect(skillsArguments(["--json", "skills", "list"])).toEqual(["--json", "list"]);
  });
});
