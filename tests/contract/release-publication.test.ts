import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { waitForPublishedVersion } from "../../tools/release/verify-published.mjs";

it("waits through registry processing instead of republishing", async () => {
  let time = 0, calls = 0;
  await waitForPublishedVersion("4.0.1", {
    query: async () => ++calls < 4 ? undefined : "4.0.1",
    sleep: async (milliseconds: number) => { time += milliseconds; },
    now: () => time, timeoutMilliseconds: 60000, intervalMilliseconds: 10000,
  });
  expect(calls).toBe(4); expect(time).toBe(30000);
});

it("times out with verification-only recovery guidance", async () => {
  let time = 0;
  await expect(waitForPublishedVersion("4.0.1", {
    query: async () => "4.0.0",
    sleep: async (milliseconds: number) => { time += milliseconds; },
    now: () => time, timeoutMilliseconds: 25000, intervalMilliseconds: 10000,
  })).rejects.toThrow("Do not republish; retry verification only");
  expect(time).toBe(25000);
});

it.each(["", "latest", "4.0.1;echo wrong", "4.0.1-beta", "01.0.0"])("rejects non-release input %s before querying npm", async (version) => {
  let called = false;
  await expect(waitForPublishedVersion(version, { query: () => { called = true; } })).rejects.toThrow("exact stable");
  expect(called).toBe(false);
});

it("keeps publication out of the independently rerunnable verification job", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");
  const verification = source.split("\n  verify:\n")[1]!;
  expect(verification).toContain("needs: publish");
  expect(verification).toContain("contents: read");
  expect(verification).toContain("verify-published.mjs");
  expect(verification).not.toContain("npm publish");
  expect(verification).not.toContain("gh release create");
  expect(verification).not.toContain("id-token: write");
});
