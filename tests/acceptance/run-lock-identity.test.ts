import { expect, it } from "vitest";
import { cacheSuccessfulProcessIdentity, darwinProcessIdentity, processIdentity } from "../../src/synchronization/process-identity.ts";

it("retries a transient process identity failure and caches only a success", async () => {
  let attempts = 0;
  const identity = cacheSuccessfulProcessIdentity(async () => {
    attempts++;
    return attempts === 1 ? undefined : "stable-start-identity";
  });
  expect(await identity()).toBeUndefined();
  expect(await identity()).toBe("stable-start-identity");
  expect(await identity()).toBe("stable-start-identity");
  expect(attempts).toBe(2);
});

it("uses a stable macOS boot UUID rather than wall-clock-derived boot time", async () => {
  const uuid = "12345678-1234-5678-9012-123456789ABC";
  let clock = "before adjustment";
  const requested: string[] = [];
  const run = async (_file: string, args: string[]) => {
    requested.push(args.join(" "));
    if (args.includes("kern.boottime")) return clock;
    return args.includes("kern.bootsessionuuid") ? uuid : "Mon Oct 19 12:00:00 2026";
  };
  const before = await darwinProcessIdentity(42, run);
  clock = "after adjustment";
  expect(await darwinProcessIdentity(42, run)).toBe(before);
  expect(before).toContain(uuid.toLowerCase());
  expect(requested.some((args) => args.includes("kern.boottime"))).toBe(false);
  expect(await darwinProcessIdentity(42, async () => "invalid")).toBeUndefined();
});

it.skipIf(process.platform !== "darwin")("reads a live macOS process with a UUID boot identity", async () => {
  const first = await processIdentity(process.pid);
  expect(first).toMatch(/^darwin:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:/u);
  expect(await processIdentity(process.pid)).toBe(first);
});
