import { expect, it } from "vitest";
import { cacheSuccessfulProcessIdentity } from "../../src/synchronization/process-identity.ts";

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
