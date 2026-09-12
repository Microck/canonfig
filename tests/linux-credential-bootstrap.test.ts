import { describe, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { expect } from "vitest";

import { CredentialReference } from "../src/domain/brand.ts";
import type { CredentialStorageCapability } from "../src/machine/machine-state.types.ts";
import {
  type LinuxCredentialBootstrapHost,
  parseSearchAttributes,
  runLinuxCredentialBootstrap,
} from "../src/secrets/linux-credential-bootstrap.ts";
import { SecretTransferError } from "../src/secrets/secret-store.ts";

interface HostOptions {
  readonly capability: CredentialStorageCapability;
  readonly storeFailures?: number | undefined;
  readonly recycle?: "manual" | "preserve" | "lose" | undefined;
}

interface HostFixture {
  readonly host: LinuxCredentialBootstrapHost;
  readonly commands: Array<ReadonlyArray<string>>;
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
  const commands: Array<ReadonlyArray<string>> = [];
  const sleeps: Array<number> = [];
  const stored = new Map<string, string>();
  let storeAttempts = 0;
  let sequence = 0;
  const host: LinuxCredentialBootstrapHost = {
    capability: () => Effect.succeed(options.capability),
    findExecutable: (name) => Effect.succeed(`/usr/bin/${name}`),
    runCommand: (_executable, arguments_) => {
      commands.push(arguments_);
      return Effect.succeed({
        exitCode: 0,
        stdout: arguments_.includes("--components=secrets")
          ? "GNOME_KEYRING_PID=321\n"
          : "",
        stderr: "",
      });
    },
    sessionBusAddress: () => "unix:path=/run/user/1000/bus",
    storeProbe: (name, value) => {
      storeAttempts += 1;
      if (storeAttempts <= (options.storeFailures ?? 0)) {
        return Effect.fail(storageFailure());
      }
      sequence += 1;
      const key = `${name}-${sequence}`;
      stored.set(key, Redacted.value(value));
      return Effect.succeed({ reference: credentialReference(key), key });
    },
    loadProbeBytes: (reference) => {
      const key = String(reference).slice("secret-service:".length);
      const value = stored.get(key);
      return value === undefined
        ? Effect.fail(storageFailure())
        : Effect.succeed(`${value}\n`);
    },
    probeAttributes: (key) => Effect.succeed(new Map([
      ["canonfig-key", key],
      ["provider-created", "ignored"],
    ])),
    removeProbe: (reference) => {
      stored.delete(String(reference).slice("secret-service:".length));
      return Effect.void;
    },
    recycleProvider: () => {
      if (options.recycle === "manual" || options.recycle === undefined) {
        return Effect.succeed({ recycled: false });
      }
      if (options.recycle === "lose") stored.clear();
      return Effect.succeed({ recycled: true });
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Effect.void;
    },
    randomProbeId: () => `probe-${sequence + 1}`,
  };
  return { host, commands, sleeps, stored };
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
        recycle: "manual",
      });

      const result = yield* runLinuxCredentialBootstrap(fixture.host);

      expect(result).toMatchObject({
        selectedPolicy: "secure-store",
        restartPersistence: "manual",
        roundTripsPassed: 2,
      });
      expect(fixture.commands).toEqual([]);
      expect(fixture.stored.size).toBe(0);
    }));

  it.effect("starts a cold provider and tolerates delayed D-Bus registration", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: {
          kind: "unavailable",
          recovery: "start a provider",
        },
        storeFailures: 2,
      });

      const result = yield* runLinuxCredentialBootstrap(fixture.host, {
        maxBusAttempts: 3,
        busRetryDelayMilliseconds: 1,
      });

      expect(result.busAttempts).toBe(2);
      expect(fixture.commands).toContainEqual(["--start", "--components=secrets"]);
      expect(fixture.sleeps).toEqual([1]);
      expect(fixture.stored.size).toBe(0);
    }));

  it.effect("verifies the same credential survives an owned provider restart", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: {
          kind: "secure-noninteractive",
          provider: "secret-service",
          verification: "session-probe",
        },
        recycle: "preserve",
      });

      const result = yield* runLinuxCredentialBootstrap(fixture.host, {
        maxBusAttempts: 2,
        busRetryDelayMilliseconds: 1,
      });

      expect(result.restartPersistence).toBe("verified");
      expect(result.roundTripsPassed).toBe(2);
      expect(fixture.stored.size).toBe(0);
    }));

  it.effect("reports failed restart persistence when the stored probe is lost", () =>
    Effect.gen(function*() {
      const fixture = makeHost({
        capability: {
          kind: "secure-noninteractive",
          provider: "secret-service",
          verification: "session-probe",
        },
        recycle: "lose",
      });

      const result = yield* runLinuxCredentialBootstrap(fixture.host, {
        maxBusAttempts: 2,
        busRetryDelayMilliseconds: 1,
      });

      expect(result.restartPersistence).toBe("failed");
      expect(result.roundTripsPassed).toBe(1);
      expect(fixture.stored.size).toBe(0);
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
