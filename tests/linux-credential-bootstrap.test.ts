import { describe, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { expect } from "vitest";

import { sha256Hex } from "../src/profile/profile-codec.ts";
import { CredentialReference } from "../src/domain/brand.ts";
import type { CredentialStorageCapability } from "../src/machine/machine-state.types.ts";
import {
  type LinuxCredentialBootstrapHost,
  parseSearchAttributes,
  runLinuxCredentialBootstrap,
  resumeLinuxCredentialPersistence,
} from "../src/secrets/linux-credential-bootstrap.ts";
import { SecretTransferError } from "../src/secrets/secret-store.ts";

interface HostOptions {
  readonly capability: CredentialStorageCapability;
  readonly storeFailures?: number | undefined;
}

interface HostFixture {
  readonly host: LinuxCredentialBootstrapHost;
  readonly sleeps: Array<number>;
  readonly stored: Map<string, string>;
}

const credentialReference = (key: string): typeof CredentialReference.Type =>
  Schema.decodeUnknownSync(CredentialReference)(`secret-service:${key}`);

const storageFailure = (): SecretTransferError =>
  new SecretTransferError({
    category: "storage",
    operation: "store bootstrap probe",
    message: "the test provider is not ready",
  });

const makeHost = (options: HostOptions): HostFixture => {
  const sleeps: Array<number> = [];
  const stored = new Map<string, string>();
  let storeAttempts = 0;
  let sequence = 0;
  const host: LinuxCredentialBootstrapHost = {
    capability: () => Effect.succeed(options.capability),
    findExecutable: (name) => Effect.succeed(`/usr/bin/${name}`),
    sessionBusAddress: () => "unix:path=/run/user/1000/bus",
    providerIdentity: () => Effect.succeed(undefined),
    keyringIdentity: () => Effect.succeed("session-login-keyring"),
    storeProbe: (name, value) => Effect.suspend(() => {
      storeAttempts += 1;
      if (storeAttempts <= (options.storeFailures ?? 0)) {
        return Effect.fail(storageFailure());
      }
      sequence += 1;
      const key = sha256Hex(name);
      stored.set(key, Redacted.value(value));
      return Effect.succeed({ reference: credentialReference(key), key });
    }),
    loadProbeBytes: (reference) => Effect.suspend(() => {
      const key = String(reference).slice("secret-service:".length);
      const value = stored.get(key);
      return value === undefined
        ? Effect.fail(storageFailure())
        : Effect.succeed(value);
    }),
    probeAttributes: (key) => Effect.succeed(new Map([
      ["canonfig-key", key],
      ["provider-created", "ignored"],
    ])),
    removeProbe: (reference) => Effect.sync(() => {
      stored.delete(String(reference).slice("secret-service:".length));
    }),
    probeAbsent: (key) => Effect.sync(() => !stored.has(key)),
    sleep: (milliseconds) => Effect.sync(() => { sleeps.push(milliseconds); }),
    randomProbeId: () => `probe-${sequence + 1}`,
  };
  return { host, sleeps, stored };
};

describe("Linux credential bootstrap", () => {
  it("normalizes provider-added attribute prefixes and ignores metadata", () => {
    expect(parseSearchAttributes([
      "[/org/freedesktop/secrets/collection/login/1]",
      "attribute.canonfig-key = abc123",
      "attribute.created = provider-value",
    ].join("\n"))).toEqual(new Map([
      ["canonfig-key", "abc123"],
      ["created", "provider-value"],
    ]));
  });

  it.effect("uses an existing provider without starting another daemon", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: {
          kind: "secure-noninteractive",
          provider: "secret-service",
          verification: "provider-presence",
        },
      });

      const result = yield* runLinuxCredentialBootstrap(fixture.host);

      expect(result).toMatchObject({
        selectedPolicy: "secure-store",
        restartPersistence: "manual",
        roundTripsPassed: 1,
      });
      expect(fixture.stored.size).toBe(0);
    }));

  it.effect("resumes a saved probe only after the recorded provider changes", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: { kind: "secure-noninteractive", provider: "secret-service", verification: "provider-presence" },
      });
      type Store = NonNullable<LinuxCredentialBootstrapHost["persistence"]>;
      type Evidence = Parameters<Store["write"]>[0];
      let evidence: Evidence | undefined;
      let owner = ":1.10";
      let process = "existing-process";
      const persistence: Store = {
        read: Effect.sync(() => evidence),
        write: (next) => Effect.sync(() => { evidence = next; }),
      };
      const host = {
        ...fixture.host,
        providerIdentity: () => Effect.sync(() => ({ bus: "a".repeat(32), owner, process })),
        persistence,
      };
      const bootstrap = yield* runLinuxCredentialBootstrap(host);
      expect(bootstrap.restartPersistence).toBe("manual");
      expect(evidence).toMatchObject({ _tag: "Pending" });
      expect(fixture.stored.size).toBe(1);
      expect((yield* resumeLinuxCredentialPersistence(host, persistence))?.verdict).toBe("manual");
      owner = ":1.11";
      expect((yield* resumeLinuxCredentialPersistence(host, persistence))?.verdict).toBe("manual");
      expect(fixture.stored.size).toBe(1);
      process = "new-process";
      expect((yield* resumeLinuxCredentialPersistence(host, persistence))?.verdict).toBe("verified");
      expect(evidence).toEqual({ _tag: "Verified", provider: { bus: "a".repeat(32), owner, process }, keyring: "session-login-keyring" });
      expect(fixture.stored.size).toBe(0);
    }));

  it.effect("journals cold activation before storing and retries cleanup until absence is confirmed", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: { kind: "secure-noninteractive", provider: "secret-service", verification: "provider-presence" },
      });
      type Store = NonNullable<LinuxCredentialBootstrapHost["persistence"]>;
      type Evidence = Parameters<Store["write"]>[0];
      let evidence: Evidence | undefined;
      let absenceConfirmed = false;
      const persistence: Store = {
        read: Effect.sync(() => evidence),
        write: (next) => Effect.sync(() => { evidence = next; }),
      };
      const provider = { bus: "a".repeat(32), owner: ":1.10", process: "existing-process" };
      const host = {
        ...fixture.host,
        storeProbe: () => Effect.suspend(() => {
          expect(evidence).toMatchObject({ _tag: "Preparing", probeId: expect.any(String) });
          return Effect.fail(storageFailure());
        }),
        removeProbe: () => Effect.fail(storageFailure()),
        probeAbsent: () => Effect.sync(() => absenceConfirmed),
        persistence,
      };
      yield* Effect.flip(runLinuxCredentialBootstrap(host, { maxBusAttempts: 1 }));
      expect((yield* resumeLinuxCredentialPersistence(host, persistence))?.verdict).toBe("manual");
      expect(evidence).toMatchObject({ _tag: "Preparing" });
      absenceConfirmed = true;
      expect(yield* resumeLinuxCredentialPersistence(host, persistence)).toBeUndefined();
      expect(evidence).toEqual({ _tag: "Idle" });
      yield* persistence.write({ _tag: "Verified", provider, keyring: "session-login-keyring", probeId: "a".repeat(36) });
      expect((yield* resumeLinuxCredentialPersistence(host, persistence))?.verdict).toBe("verified");
      expect(evidence).toEqual({ _tag: "Verified", provider, keyring: "session-login-keyring" });
    }));

  it.effect("tests current keyring access even with historical evidence", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: { kind: "secure-noninteractive", provider: "secret-service", verification: "provider-presence" },
      });
      type Store = NonNullable<LinuxCredentialBootstrapHost["persistence"]>;
      type Evidence = Parameters<Store["write"]>[0];
      const provider = { bus: "a".repeat(32), owner: ":1.10", process: "existing-process" };
      const pending = { _tag: "Pending", provider, keyring: "session-login-keyring", probeId: "a".repeat(36) } as const;
      const verified = { _tag: "Verified", provider, keyring: "session-login-keyring" } as const;
      for (const marker of [pending, verified]) {
        let evidence: Evidence = marker;
        let locked = true;
        const persistence: Store = {
          read: Effect.sync(() => evidence),
          write: (next) => Effect.sync(() => { evidence = next; }),
        };
        const host = {
          ...fixture.host,
          providerIdentity: () => Effect.succeed(provider),
          storeProbe: (name: string, value: Redacted.Redacted<string>) =>
            locked ? Effect.fail(storageFailure()) : fixture.host.storeProbe(name, value),
          persistence,
        };
        const failed = yield* Effect.flip(runLinuxCredentialBootstrap(host, { maxBusAttempts: 1 }));
        expect(failed.message).toContain("unlock a Secret Service provider");
        expect(evidence).toMatchObject({ _tag: "Preparing", previous: marker });
        locked = false;
        expect((yield* runLinuxCredentialBootstrap(host)).roundTripsPassed).toBe(1);
        expect(evidence).toEqual(marker);
        expect(fixture.stored.size).toBe(0);
      }
    }));

  it.effect("preserves an interrupted probe record across a different keyring and rejects a missing bus tool", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: { kind: "secure-noninteractive", provider: "secret-service", verification: "provider-presence" },
      });
      type Store = NonNullable<LinuxCredentialBootstrapHost["persistence"]>;
      type Evidence = Parameters<Store["write"]>[0];
      const preparing = { _tag: "Preparing", probeId: "a".repeat(36), keyring: "original-keyring" } as const;
      let evidence: Evidence | undefined;
      const persistence: Store = {
        read: Effect.sync(() => evidence),
        write: (next) => Effect.sync(() => { evidence = next; }),
      };
      const noBusTool = { ...fixture.host, persistence, findExecutable: (name: string) =>
        name === "busctl" ? Effect.succeed(undefined) : fixture.host.findExecutable(name) };
      expect((yield* Effect.flip(runLinuxCredentialBootstrap(noBusTool))).message).toContain("busctl is required");
      expect(evidence).toBeUndefined();
      expect(fixture.stored.size).toBe(0);
      evidence = preparing;
      expect((yield* resumeLinuxCredentialPersistence(fixture.host, persistence))?.detail).toContain("different or unavailable");
      expect(evidence).toEqual(preparing);
      expect((yield* Effect.flip(runLinuxCredentialBootstrap({ ...fixture.host, persistence }))).message)
        .toContain("different or unavailable");
      expect(evidence).toEqual(preparing);
    }));

  it.effect("replaces completed evidence after the default keyring changes", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: { kind: "secure-noninteractive", provider: "secret-service", verification: "provider-presence" },
      });
      type Store = NonNullable<LinuxCredentialBootstrapHost["persistence"]>;
      type Evidence = Parameters<Store["write"]>[0];
      const provider = { bus: "a".repeat(32), owner: ":1.10", process: "existing-process" };
      let evidence: Evidence = { _tag: "Verified", provider, keyring: "old-keyring" };
      const persistence: Store = {
        read: Effect.sync(() => evidence),
        write: (next) => Effect.sync(() => { evidence = next; }),
      };
      const host = { ...fixture.host, persistence, providerIdentity: () => Effect.succeed(provider) };
      expect(yield* resumeLinuxCredentialPersistence(host, persistence)).toBeUndefined();
      expect((yield* runLinuxCredentialBootstrap(host)).roundTripsPassed).toBe(1);
      expect(evidence).toMatchObject({ _tag: "Pending", keyring: "session-login-keyring", provider });
      expect(fixture.stored.size).toBe(1);
    }));

  it.effect("keeps an inaccessible probe pending and accepts a fresh baseline after confirmed loss", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: { kind: "secure-noninteractive", provider: "secret-service", verification: "provider-presence" },
      });
      type Store = NonNullable<LinuxCredentialBootstrapHost["persistence"]>;
      type Evidence = Parameters<Store["write"]>[0];
      const original = { bus: "a".repeat(32), owner: ":1.10", process: "original-process" };
      const restarted = { ...original, owner: ":1.11", process: "restarted-process" };
      const pending = { _tag: "Pending", provider: original, keyring: "session-login-keyring", probeId: "a".repeat(36) } as const;
      let evidence: Evidence = pending;
      let absenceConfirmed = false;
      const persistence: Store = {
        read: Effect.sync(() => evidence),
        write: (next) => Effect.sync(() => { evidence = next; }),
      };
      const host = {
        ...fixture.host,
        persistence,
        providerIdentity: () => Effect.succeed(restarted),
        probeAbsent: () => Effect.sync(() => absenceConfirmed),
      };
      expect((yield* resumeLinuxCredentialPersistence(host, persistence))?.verdict).toBe("manual");
      expect(evidence).toEqual(pending);
      absenceConfirmed = true;
      expect(yield* resumeLinuxCredentialPersistence(host, persistence)).toMatchObject({
        verdict: "failed", detail: expect.stringContaining("canonfig secrets bootstrap"),
      });
      expect(evidence).toEqual({ _tag: "Failed", keyring: "session-login-keyring" });
      expect((yield* resumeLinuxCredentialPersistence(host, persistence))?.verdict).toBe("failed");
      const replanned = yield* runLinuxCredentialBootstrap(host);
      expect(replanned.restartPersistence).toBe("manual");
      expect(replanned.persistenceDetail).toContain("did not survive");
      expect(replanned.persistenceDetail).toContain("Run canonfig doctor");
      expect(evidence).toMatchObject({ _tag: "Pending", provider: restarted });
      expect(fixture.stored.size).toBe(1);
    }));

  it.effect("retries a delayed default collection before starting the live journal", () =>
    Effect.gen(function*() {
      const fixture = makeHost({ capability: { kind: "unavailable", recovery: "start a provider" } });
      type Store = NonNullable<LinuxCredentialBootstrapHost["persistence"]>;
      type Evidence = Parameters<Store["write"]>[0];
      let evidence: Evidence | undefined;
      let collectionLookups = 0;
      const persistence: Store = {
        read: Effect.sync(() => evidence),
        write: (next) => Effect.sync(() => { evidence = next; }),
      };
      const provider = { bus: "a".repeat(32), owner: ":1.10", process: "started-process" };
      const result = yield* runLinuxCredentialBootstrap({
        ...fixture.host,
        keyringIdentity: () => Effect.sync(() => {
          collectionLookups += 1;
          if (collectionLookups === 1) {
            expect(evidence).toBeUndefined();
            expect(fixture.stored.size).toBe(0);
            return undefined;
          }
          return "session-login-keyring";
        }),
        providerIdentity: () => Effect.succeed(provider),
        persistence,
      }, { maxBusAttempts: 3, busRetryDelayMilliseconds: 1 });
      expect(result.busAttempts).toBe(2);
      expect(fixture.sleeps).toEqual([1]);
      expect(evidence).toMatchObject({ _tag: "Pending", keyring: "session-login-keyring" });
      expect(fixture.stored.size).toBe(1);
    }));

  it.effect("records the explicit local-file path as unencrypted", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: {
          kind: "local-file",
          path: { platform: "linux", absolute: "/tmp/canonfig-credentials" },
        },
      });

      const result = yield* runLinuxCredentialBootstrap(fixture.host);

      expect(result).toMatchObject({
        selectedPolicy: "local-file",
        backupEncryption: "unencrypted",
      });
      expect(result.backupEncryptionDetail).toContain("/tmp/canonfig-credentials");
      expect(result.backupEncryptionDetail).not.toContain("[object Object]");
    }));
});
