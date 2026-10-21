import { snapshotsEqual } from "../../src/schedule/schedule-manager.layer.ts";
import { renewWindowsTaskRegistration, windowsTaskRegistration } from "../../src/machine/windows.layer.ts";
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

it("renews Windows snapshot registration without changing execution or source metadata", () => {
  const xml = '<Task><RegistrationInfo><Date>2026-09-01T00:00:00Z</Date><Source>Operator &amp; Canonfig</Source><Description>keep</Description></RegistrationInfo><Actions><Exec><Command>keep.exe</Command></Exec></Actions></Task>';
  const first = renewWindowsTaskRegistration(xml, "2026-09-02T00:00:00.000Z", "a".repeat(32));
  const restored = renewWindowsTaskRegistration(first, "2026-09-02T00:00:00.000Z", "b".repeat(32));
  expect(restored).toContain("Operator &amp; Canonfig");
  expect(restored).toContain("<Description>keep</Description>");
  expect(restored).toContain("<Command>keep.exe</Command>");
  expect(restored.match(/canonfig-generation:/gu)).toHaveLength(1);
  expect(restored).not.toContain("a".repeat(32));
  const originalIdentity = registeredSchedulerIdentity(first, windowsTaskRegistration(first).registeredAt)!;
  const restoredIdentity = registeredSchedulerIdentity(restored, windowsTaskRegistration(restored).registeredAt)!;
  expect(restoredIdentity.generation).not.toBe(originalIdentity.generation);
  expect(currentScheduleFires(restoredIdentity, [{ generation: originalIdentity.generation,
    startedAt: "2026-09-02T00:00:01Z", at: "2026-09-03T00:00:00Z", outcome: "completed" }])).toEqual([]);
});

it("verifies Windows restoration while allowing only renewed registration identity", () => {
  const xml = '<Task><RegistrationInfo><Date>2026-09-01T00:00:00Z</Date><Description>keep</Description></RegistrationInfo><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>keep.exe</Command></Exec></Actions></Task>';
  const native = (text: string) => Buffer.from(text).toString("base64");
  const prior = { platform: "windows", mechanism: "task-scheduler", serviceName: "canonfig-sync", state: "present", enabled: true, active: true, servicePresent: false, schedulePresent: false, native: native(xml) } as const;
  const restored = renewWindowsTaskRegistration(xml, "2026-09-02T00:00:00Z", "b".repeat(32));
  expect(snapshotsEqual({ ...prior, native: native(restored) }, prior)).toBe(true);
  for (const changed of [restored.replace("keep.exe", "evil.exe"), restored.replace("<Description>keep", "<Description>changed"), restored.replace("<Enabled>true", "<Enabled>false"), restored.replace("<Source>Canonfig", "<Source>Other")]) {
    expect(snapshotsEqual({ ...prior, native: native(changed) }, prior)).toBe(false);
  }
  expect(snapshotsEqual({ ...prior, enabled: false, native: native(restored) }, prior)).toBe(false);
  expect(snapshotsEqual({ ...prior, platform: "linux", native: native(restored) }, { ...prior, platform: "linux" })).toBe(false);
});
