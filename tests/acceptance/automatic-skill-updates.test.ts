import { describe, expect, it, vi } from "vitest";
import { assertAutomaticSelection, automaticSkillUpdates, type AutomaticSkillOperations } from "../../src/harness-configuration/skills/automatic.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSkillsArguments, runSkillsCli } from "../../src/harness-configuration/skills/cli.ts";
import type { TrackedSkill, SkillCheck } from "../../src/harness-configuration/skills/manager.ts";

const skill: TrackedSkill = { name: "demo", path: "skills/demo", source: "https://example.invalid/skills.git", ref: "main", subdir: "demo", commit: "a".repeat(40), digest: "b".repeat(64) };
const check: SkillCheck = { name: "demo", path: skill.path, previousCommit: skill.commit, nextCommit: "c".repeat(40), status: "update-available", added: [], changed: ["SKILL.md"], removed: [] };
const location = { root: process.cwd(), config: ".canonfig/skills-sources.json" };
function fixture(): AutomaticSkillOperations {
  return {
    list: vi.fn(async () => ({ version: 1 as const, skills: [{ ...skill }] })),
    check: vi.fn(async () => [check]),
    update: vi.fn(async (_location, _names, _operations, guard) => { guard?.({ version: 1, skills: [{ ...skill }] }); return [check]; }),
    sleep: vi.fn(async () => undefined),
  };
}

describe("automatic upstream skill updates", () => {
  it("emits the documented zero-pass JSON envelope without data", async () => {
    const root=await mkdtemp(path.join(tmpdir(),"canonfig-auto-empty-"));
    try {
      await mkdir(path.join(root,".canonfig"));
      await writeFile(path.join(root,".canonfig/skills-sources.json"),JSON.stringify({version:1,skills:[]}));
      const output:string[]=[];let exit=-1;
      await runSkillsCli(["auto","--root",root,"--json"],{writeStdout:text=>{output.push(text);},writeStderr:text=>{throw new Error(text);},setExitCode:code=>{exit=code;}});
      expect(output).toHaveLength(1);const envelope=JSON.parse(output[0]);
      expect(envelope).toMatchObject({command:"skills.auto",exitCode:0,message:"No automatic update pass ran"});
      expect(envelope).not.toHaveProperty("data");expect(exit).toBe(0);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it("previews only once by default, without an update or timer", async () => {
    const run = fixture(); const onPass = vi.fn();
    expect(await automaticSkillUpdates(location, [], { apply: false, once: false, intervalSeconds: 86400, onPass }, run)).toBe(1);
    expect(run.check).toHaveBeenCalledWith(location, ["demo"]);
    expect(run.update).not.toHaveBeenCalled(); expect(run.sleep).not.toHaveBeenCalled();
    expect(onPass).toHaveBeenCalledWith([check], 1);
  });
  it("applies one pass for a scheduler without sleeping", async () => {
    const run = fixture();
    expect(await automaticSkillUpdates(location, [], { apply: true, once: true, intervalSeconds: 60, onPass: vi.fn() }, run)).toBe(1);
    expect(run.update).toHaveBeenCalledOnce(); expect(run.sleep).not.toHaveBeenCalled();
  });
  it("runs non-overlapping passes and cancels during the wait", async () => {
    const run = fixture(); const controller = new AbortController();
    run.sleep = vi.fn(async (_milliseconds, signal) => { controller.abort(); expect(signal?.aborted).toBe(true); throw new Error("aborted"); });
    expect(await automaticSkillUpdates(location, [], { apply: true, once: false, intervalSeconds: 60, signal: controller.signal, onPass: vi.fn() }, run)).toBe(1);
    expect(run.update).toHaveBeenCalledOnce(); expect(run.sleep).toHaveBeenCalledWith(60000, controller.signal);
  });
  it("stops on a local-edit, fetch, recovery or write failure without retry", async () => {
    const run = fixture(); run.update = vi.fn(async () => { throw new Error("Local edits"); });
    await expect(automaticSkillUpdates(location, [], { apply: true, once: false, intervalSeconds: 60, onPass: vi.fn() }, run)).rejects.toThrow("Local edits");
    expect(run.sleep).not.toHaveBeenCalled();
  });
  it("freezes the selected source identities but permits updater-owned baselines to advance", () => {
    expect(() => assertAutomaticSelection([{ ...skill, commit: "d".repeat(40), digest: "e".repeat(64) }], [skill])).not.toThrow();
    for (const patch of [{ ref: "other" }, { path: "other" }, { source: "https://example.invalid/other.git" }, { subdir: "other" }]) {
      expect(() => assertAutomaticSelection([{ ...skill, ...patch }], [skill])).toThrow("changed or removed");
    }
    expect(() => assertAutomaticSelection([], [skill])).toThrow("changed or removed");
    expect(() => assertAutomaticSelection([skill, { ...skill, name: "new" }], [skill])).not.toThrow();
  });
  it("validates the frozen identity inside the update transaction", async () => {
    const run = fixture(); run.update = vi.fn(async (_location, _names, _operations, guard) => {
      guard?.({ version: 1, skills: [{ ...skill, ref: "changed" }] }); return [check];
    });
    await expect(automaticSkillUpdates(location, [], { apply: true, once: true, intervalSeconds: 60, onPass: vi.fn() }, run)).rejects.toThrow("changed or removed");
  });
  it("rejects unknown selections and invalid intervals before mutation", async () => {
    const run = fixture();
    await expect(automaticSkillUpdates(location, ["unknown"], { apply: true, once: true, intervalSeconds: 60, onPass: vi.fn() }, run)).rejects.toThrow("not tracked");
    for (const intervalSeconds of [0, 59, 1.5, Infinity, 604801]) {
      await expect(automaticSkillUpdates(location, [], { apply: true, once: true, intervalSeconds, onPass: vi.fn() }, run)).rejects.toThrow("interval");
    }
    expect(run.update).not.toHaveBeenCalled();
  });
  it("parses explicit automatic operation flags without accepting them elsewhere", () => {
    expect(parseSkillsArguments(["auto", "--apply", "--once", "--interval", "60"])).toMatchObject({ command: "auto", apply: true, once: true, intervalSeconds: 60 });
    expect(parseSkillsArguments(["auto", "--dry-run"])).toMatchObject({ apply: false, intervalSeconds: 86400 });
    for (const args of [["auto", "--interval", "1h"], ["auto", "--apply", "--dry-run"], ["update", "--once"], ["list", "--interval", "60"]]) {
      expect(() => parseSkillsArguments(args)).toThrow();
    }
  });
  it("does nothing for an empty or pre-aborted selection", async () => {
    const run = fixture(); const controller = new AbortController(); controller.abort();
    expect(await automaticSkillUpdates(location, [], { apply: true, once: false, intervalSeconds: 60, signal: controller.signal, onPass: vi.fn() }, run)).toBe(0);
    run.list = vi.fn(async () => ({ version: 1, skills: [] }));
    expect(await automaticSkillUpdates(location, [], { apply: true, once: false, intervalSeconds: 60, onPass: vi.fn() }, run)).toBe(0);
    expect(run.update).not.toHaveBeenCalled();
  });
});
