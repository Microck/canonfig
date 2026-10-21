import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fileSchedulerIdentity, registeredSchedulerIdentity } from "../../src/machine/scheduler-identity.ts";
import { currentScheduleFires } from "../../src/runtime/readiness.ts";

it("invalidates same-byte reinstall receipts while preserving an unchanged installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "canonfig-scheduler-identity-"));
  const path = join(root, "native-job");
  try {
    await writeFile(path, "same native definition");
    const first = await fileSchedulerIdentity([path]);
    expect(first).toBeDefined();
    expect(await fileSchedulerIdentity([path])).toEqual(first);
    expect(await fileSchedulerIdentity([path], ["a different inspection snapshot"])).toBeUndefined();
    const startedAt = new Date(Date.parse(first!.installedAt) + 1000).toISOString();
    const fire = { at: startedAt, startedAt, generation: first!.generation, outcome: "completed" };
    expect(currentScheduleFires(first!, [fire])).toHaveLength(1);
    await writeFile(join(root, "replacement"), "same native definition");
    await rename(join(root, "replacement"), path);
    const second = await fileSchedulerIdentity([path]);
    expect(second?.generation).not.toBe(first?.generation);
    // Even a completion arriving after reinstallation keeps its start identity.
    expect(currentScheduleFires(second!, [{ ...fire, at: new Date(Date.now() + 2000).toISOString() }])).toEqual([]);
    await rm(path);
    expect(await fileSchedulerIdentity([path])).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("requires observable native registration evidence on Windows", () => {
  expect(registeredSchedulerIdentity("<Task/>", undefined)).toBeUndefined();
  expect(registeredSchedulerIdentity("<Task/>", "invalid")).toBeUndefined();
  const first = registeredSchedulerIdentity("<Date>2026-09-01T00:00:00Z</Date>", "2026-09-01T00:00:00Z");
  const next = registeredSchedulerIdentity("<Date>2026-09-02T00:00:00Z</Date>", "2026-09-02T00:00:00Z");
  expect(next?.generation).not.toBe(first?.generation);
});
