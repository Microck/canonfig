import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enable, parseVersion, update } from "../../src/runtime/self-update/core.ts";
import { commandLease, updateDirectory } from "../../src/runtime/self-update/coordination.ts";
import { createGuiSelfUpdateFixture, previous, type GuiSelfUpdateFixture } from "../gui/self-update-fixture.ts";

const machines: GuiSelfUpdateFixture[] = [];
afterEach(async () => { for (const machine of machines.splice(0)) await machine.cleanup(); });
const [major, minor, patch] = parseVersion(previous);
const nextPatch = `${major}.${minor}.${patch + 1}`;
const nextMinor = `${major}.${minor + 1}.2`;
const nextMajor = `${major + 1}.3.2`;
const newestMajor = `${major + 2}.1.4`;
async function fixture(releases: readonly string[]) {
  const machine = await createGuiSelfUpdateFixture({ fixtureRuntime: true, releases });
  machines.push(machine);
  await enable(machine.root, machine.npmCli, true, undefined, machine.home);
  return machine;
}
const settings = (machine: GuiSelfUpdateFixture) => JSON.parse(readFileSync(join(updateDirectory(machine.root), "settings.json"), "utf8"));

describe("self-update release policy with real npm and an isolated registry", () => {
  it("auto picks the newest major's latest stable release over a current-line patch", async () => {
    const machine = await fixture([nextPatch, nextMinor, nextMajor, newestMajor, `${major + 3}.0.0-rc.1`]);
    const result = await update(machine.root, false, "auto", undefined, undefined, machine.home);
    expect(result).toMatchObject({ status: "available", candidate: newestMajor });
    expect(result.detail).toContain("Source and Followers only pair on the same major.minor");
    expect(result.detail).toContain("may refuse older state");
    expect(result.detail).toContain("old build");
  }, 60_000);

  it("auto ignores an in-major minor and selects only a current-line patch", async () => {
    const machine = await fixture([nextMinor, nextPatch]);
    expect(await update(machine.root, false, "auto", undefined, undefined, machine.home))
      .toMatchObject({ status: "available", candidate: nextPatch, detail: expect.stringContaining("never an in-major minor") });
  }, 60_000);

  it("manual picks a newer minor and reports but never selects the newer major", async () => {
    const machine = await fixture([nextPatch, nextMinor, nextMajor, `${major}.${minor + 2}.0-beta.1`]);
    const result = await update(machine.root, false, "manual", undefined, undefined, machine.home);
    expect(result).toMatchObject({ status: "available", candidate: nextMinor });
    expect(result.detail).toContain("Source and Followers only pair on the same major.minor");
    expect(result.detail).toContain("a new major is available");
    expect(result.detail).toContain(`npm install --global @microck/canonfig@${nextMajor}`);
    expect(result.detail).toContain("automatically if auto updates are on");
  }, 60_000);

  it("manual remains current when only a newer major or prerelease exists", async () => {
    const machine = await fixture([nextMajor, `${major}.${minor + 1}.0-rc.1`]);
    expect(await update(machine.root, false, "manual", undefined, undefined, machine.home))
      .toMatchObject({ status: "current", candidate: previous, detail: expect.stringContaining("a new major is available") });
  }, 60_000);

  it.each(["manual", "auto"] as const)("moves the saved line after %s activation and admits the next command/check", async (mode) => {
    const machine = await fixture([mode === "manual" ? nextMinor : nextMajor]);
    const original = settings(machine);
    const result = await update(machine.root, true, mode, undefined, undefined, machine.home);
    const expected = mode === "manual" ? nextMinor : nextMajor;
    expect(result).toMatchObject({ status: "updated", candidate: expected });
    expect(machine.version()).toBe(expected);
    expect(settings(machine)).toEqual({ ...original, line: expected.split(".").slice(0, 2).join(".") });
    expect(result.detail).toContain("Source and Followers only pair on the same major.minor");
    if (mode === "auto") expect(result.detail).toContain("may refuse older state");
    commandLease(machine.root)?.();
    expect(await update(machine.root, false, mode, undefined, undefined, machine.home))
      .toMatchObject({ status: "current", candidate: expected });
  }, 60_000);

  it("retains recovery evidence and restart-required semantics when publishing the new line fails", async () => {
    const machine = await fixture([nextMinor]);
    const original = settings(machine);
    const directory = updateDirectory(machine.root);
    const result = await update(machine.root, true, "manual", undefined, undefined, machine.home, (progress) => {
      if (progress.phase === "activating") {
        const { operationId } = JSON.parse(readFileSync(join(directory, "progress.json"), "utf8"));
        // Obstruct only this disposable transaction's future settings file.
        mkdirSync(join(directory, `settings.json.${operationId}.tmp`));
      }
    });
    expect(result).toMatchObject({ status: "updated", candidate: nextMinor, detail: expect.stringContaining("bookkeeping failed") });
    expect(machine.version()).toBe(nextMinor);
    expect(settings(machine)).toEqual(original);
    expect(JSON.parse(readFileSync(join(directory, "pending.json"), "utf8"))).toMatchObject({ _tag: "Installed" });
    expect(() => commandLease(machine.root)).toThrow("Interrupted self-update");
  }, 60_000);
});
