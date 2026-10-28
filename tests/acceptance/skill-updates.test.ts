import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink, chmod, readdir, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSkills, listSkills, parseConfig, trackSkill, updateSkills, type SkillLocation, skillUpdateOperations } from "../../src/harness-configuration/skills/manager.ts";
import { atomicWrite } from "../../src/harness-configuration/core/filesystem.ts";
import { fetchSkill, normalizeSource, safePath } from "../../src/harness-configuration/skills/upstream.ts";
import { runSkillsCli } from "../../src/harness-configuration/skills/cli.ts";
import { isSkillsCommand, skillsArguments } from "../../src/runtime/command-routing.ts";

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
  it("classifies a deleted installed directory as drift with a relative path", async () => {
    const { location, input } = await fixture(); await trackSkill(location, input);
    await rm(path.join(location.root, input.path), { recursive: true });
    await expect(checkSkills(location, [])).rejects.toMatchObject({ code: "SKILL_LOCAL_EDITED" });
    let stderr = ""; let code = -1;
    await runSkillsCli(["check", "--root", location.root, "--json"], {
      writeStdout: () => {}, writeStderr: (value) => { stderr += value; }, setExitCode: (value) => { code = value; },
    });
    expect(code).toBe(4); expect(stderr).not.toContain(location.root);
    expect(stderr).toContain(input.path);
  });
  it("rolls back an installed tree when atomic configuration publication fails", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input); await advance(upstream);
    const configuration = path.join(location.root, location.config);
    const before = await readFile(configuration);
    let installedBeforeFailure = false;
    await expect(updateSkills(location, [], {
      ...skillUpdateOperations,
      writeAtomic: async (file, content, mode, root) => {
        if (file === configuration) {
          installedBeforeFailure = (await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).includes("Version two");
          // Exercise real atomicWrite with a controlled non-directory ancestor.
          return atomicWrite(path.join(configuration, "blocked"), content, mode, root);
        }
        return atomicWrite(file, content, mode, root);
      },
    })).rejects.toMatchObject({ code: "PATH_COMPONENT_NOT_DIRECTORY" });
    expect(installedBeforeFailure).toBe(true);
    expect(await readFile(configuration)).toEqual(before);
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version one");
    expect(await readdir(path.dirname(path.join(location.root, input.path)))).toEqual(["demo"]);
    await expect(readFile(`${configuration}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("restores the original directory after a mid-swap rename failure", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input); await advance(upstream);
    let failed = false;
    await expect(updateSkills(location, [], {
      ...skillUpdateOperations,
      rename: async (from, to) => {
        if (!failed && String(from).includes(".canonfig-stage-")) {
          failed = true;
          return skillUpdateOperations.rename(path.join(String(from), "nonexistent"), to);
        }
        return skillUpdateOperations.rename(from, to);
      },
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(failed).toBe(true);
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version one");
    expect(await readdir(path.dirname(path.join(location.root, input.path)))).toEqual(["demo"]);
    await expect(readFile(path.join(location.root, `${location.config}.pending`))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves backups and the journal when rollback cannot restore a directory", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input); await advance(upstream);
    await expect(updateSkills(location, [], {
      ...skillUpdateOperations,
      rename: async (from, to) => {
        if (String(from).includes(".canonfig-stage-") || String(from).includes(".canonfig-backup-")) {
          return skillUpdateOperations.rename(path.join(String(from), "nonexistent"), to);
        }
        return skillUpdateOperations.rename(from, to);
      },
    })).rejects.toMatchObject({ code: "SKILL_RECOVERY_REQUIRED" });
    const journal = JSON.parse(await readFile(path.join(location.root, `${location.config}.pending`), "utf8"));
    expect(await readFile(path.join(location.root, journal.swaps[0].backup, "SKILL.md"), "utf8")).toContain("Version one");
    await expect(updateSkills(location, [])).rejects.toMatchObject({ code: "SKILL_RECOVERY_REQUIRED" });
  });
  it("rejects corrupt staged bytes without changing the installed tree", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input); await advance(upstream);
    await expect(updateSkills(location, [], {
      ...skillUpdateOperations,
      writeFile: async (file, bytes, options) => {
        await skillUpdateOperations.writeFile(file, bytes, options);
        if (String(file).endsWith("SKILL.md")) await appendFile(file, "corrupted staged content");
      },
    })).rejects.toMatchObject({ code: "SKILL_VERIFY_FAILED" });
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version one");
    expect(await readdir(path.dirname(path.join(location.root, input.path)))).toEqual(["demo"]);
  });
  it("preserves local edits made after staging and before the first swap", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input); await advance(upstream);
    const configuration = path.join(location.root, location.config); const before = await readFile(configuration);
    await expect(updateSkills(location, [], {
      ...skillUpdateOperations,
      writeAtomic: async (file, content, mode, root) => {
        await atomicWrite(file, content, mode, root);
        if (file.endsWith(".pending")) await writeFile(path.join(location.root, input.path, "SKILL.md"), "new local edit");
      },
    })).rejects.toMatchObject({ code: "SKILL_LOCAL_EDITED" });
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toBe("new local edit");
    expect(await readFile(configuration)).toEqual(before);
    expect(await readdir(path.dirname(path.join(location.root, input.path)))).toEqual(["demo"]);
    await expect(readFile(`${configuration}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not let best-effort backup cleanup prevent journal cleanup after commit", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input); await advance(upstream);
    let cleanupAttempted = false;
    await updateSkills(location, [], {
      ...skillUpdateOperations,
      remove: async (file, options) => {
        if (String(file).includes(".canonfig-backup-")) { cleanupAttempted = true; throw new Error("fixture cleanup refused"); }
        return skillUpdateOperations.remove(file, options);
      },
    });
    expect(cleanupAttempted).toBe(true);
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version two");
    await expect(readFile(path.join(location.root, `${location.config}.pending`))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(path.dirname(path.join(location.root, input.path)))).some((file) => file.includes(".canonfig-backup-"))).toBe(true);
  });
  it("propagates journal-unlink failure after commit and keeps the recovery gate visible", async () => {
    const { location, input, upstream } = await fixture(); await trackSkill(location, input); await advance(upstream);
    const configuration = path.join(location.root, location.config);
    await expect(updateSkills(location, [], {
      ...skillUpdateOperations,
      writeAtomic: async (file, content, mode, root) => {
        await atomicWrite(file, content, mode, root);
        if (file === configuration) { await rm(`${configuration}.pending`); await mkdir(`${configuration}.pending`); }
      },
    })).rejects.toThrow();
    expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version two");
    await expect(updateSkills(location, [])).rejects.toMatchObject({ code: "SKILL_RECOVERY_REQUIRED" });
  });
  it("classifies fetch failures without printing remote diagnostics", async () => {
    const { location, input } = await fixture();
    let stdout = ""; let stderr = ""; let code = -1;
    await runSkillsCli(["track", "--root", location.root, "--name", input.name, "--path", input.path, "--source", input.source, "--ref", "missing-branch", "--subdir", input.subdir, "--json"], {
      writeStdout: (value) => { stdout += value; }, writeStderr: (value) => { stderr += value; }, setExitCode: (value) => { code = value; },
    });
    expect(stdout).toBe(""); expect(code).toBe(6);
    expect(JSON.parse(stderr).data.code).toBe("SKILL_FETCH_FAILED");
    expect(stderr).not.toContain("fatal:");
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

it("runs an automatic one-shot through the real CLI without publishing or applying harnesses", async () => {
  const { location, input, upstream } = await fixture(); await trackSkill(location, input);
  await write(location.root, "profile.jsonc", '{"sentinel":"not published"}\n');
  await advance(upstream);
  const output: string[] = []; let exitCode = -1;
  await runSkillsCli(["auto", "--root", location.root, "--apply", "--once", "--json"], {
    writeStdout: (text) => output.push(text), writeStderr: (text) => output.push(text), setExitCode: (code) => { exitCode = code; },
  });
  expect(exitCode).toBe(0); expect(output.join("")).toContain("skills.auto");
  expect(await readFile(path.join(location.root, input.path, "SKILL.md"), "utf8")).toContain("Version two");
  expect(await readFile(path.join(location.root, "profile.jsonc"), "utf8")).toBe('{"sentinel":"not published"}\n');
});
