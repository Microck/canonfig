import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { CredentialStorageError } from "../src/machine/machine-state.errors.ts";
import {
  keychainSessionProbe,
  probeServicePrefix,
  type KeychainProbeInvocation,
  type SecurityRunner,
} from "../src/machine/keychain-session-probe.ts";
import { macosMachineStateLayer } from "../src/machine/macos.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import type { ProcessResult } from "../src/machine/machine-state.types.ts";
import { nativeSecretStoreLayer } from "../src/secrets/native-secret-store.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

interface FakeKeychainBehavior {
  readonly addExit?: number;
  readonly loadExit?: number;
  readonly loadValue?: string;
  readonly deleteExit?: number;
}

const fakeKeychain = (behavior: FakeKeychainBehavior = {}) => {
  const invocations: Array<{ operation: string; service: string; account: string }> = [];
  const services: Array<string> = [];
  const result = (
    exitCode: number,
    standardOutput: Uint8Array,
  ): ProcessResult => ({
    exitCode,
    signal: null,
    standardOutput,
    standardError: new Uint8Array(),
  });
  const runner: SecurityRunner = (invocation: KeychainProbeInvocation) =>
    Effect.sync(() => {
      const payload = JSON.parse(new TextDecoder().decode(invocation.standardInput)) as {
        operation: string;
        service: string;
        account: string;
      };
      invocations.push(payload);
      if (!services.includes(payload.service)) services.push(payload.service);
      switch (payload.operation) {
        case "probe-add":
          return result(behavior.addExit ?? 0, new Uint8Array());
        case "probe-load":
          return behavior.loadExit !== undefined || behavior.loadValue !== undefined
            ? result(behavior.loadExit ?? 0, encode(behavior.loadValue ?? ""))
            : result(0, encode("canonfig-session-probe write check"));
        default:
          return result(behavior.deleteExit ?? 0, new Uint8Array());
      }
    });
  return { invocations, services, runner };
};

const runProbe = (runner: SecurityRunner) =>
  Effect.runPromise(keychainSessionProbe(runner));

describe("keychain session probe", () => {
  it("verifies the session with a full add, read-back, and delete lifecycle", async () => {
    const fake = fakeKeychain();
    const outcome = await runProbe(fake.runner);
    expect(outcome).toEqual({ ok: true });
    expect(fake.invocations.map((item) => item.operation)).toEqual([
      "probe-add",
      "probe-load",
      "probe-delete",
    ]);
  });

  it("uses a unique Canonfig-owned namespace and never the real account", async () => {
    const fake = fakeKeychain();
    await runProbe(fake.runner);
    await runProbe(fake.runner);
    expect(fake.invocations.every((item) => item.account === "canonfig-session-probe")).toBe(true);
    expect(fake.services).toHaveLength(2);
    for (const service of fake.services) {
      expect(service.startsWith(probeServicePrefix)).toBe(true);
      expect(service).not.toBe(`${probeServicePrefix}canonfig`);
    }
    expect(new Set(fake.services).size).toBe(2);
  });

  it("attempts cleanup and reports add when the item cannot be created", async () => {
    const fake = fakeKeychain({ addExit: 45 });
    const outcome = await runProbe(fake.runner);
    expect(outcome).toEqual({ ok: false, stage: "add", exitCode: 45 });
    expect(fake.invocations.map((item) => item.operation)).toEqual([
      "probe-add",
      "probe-delete",
    ]);
  });

  it("attempts cleanup and reports read-back when the read is denied", async () => {
    const fake = fakeKeychain({ loadExit: 45 });
    const outcome = await runProbe(fake.runner);
    expect(outcome).toEqual({ ok: false, stage: "read-back", exitCode: 45 });
    expect(fake.invocations.map((item) => item.operation)).toEqual([
      "probe-add",
      "probe-load",
      "probe-delete",
    ]);
  });

  it("reports read-back when the value does not match the sentinel", async () => {
    const fake = fakeKeychain({ loadValue: "something else entirely" });
    const outcome = await runProbe(fake.runner);
    expect(outcome).toEqual({ ok: false, stage: "read-back", exitCode: 0 });
    expect(fake.invocations.at(-1)?.operation).toBe("probe-delete");
  });

  it("reports cleanup when the probe item cannot be deleted", async () => {
    const fake = fakeKeychain({ deleteExit: 45 });
    const outcome = await runProbe(fake.runner);
    expect(outcome).toEqual({ ok: false, stage: "cleanup", exitCode: 45 });
  });
});

describe("macOS credential capability", () => {
  const layerWith = (runner: SecurityRunner) =>
    macosMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      credentialStoreAccess: "available",
      environment: [
        { name: "HOME", value: "/tmp/canonfig-probe-fixture" },
      ],
      securityRunner: runner,
    });

  it("reports session-probe verification after a successful probe", async () => {
    const fake = fakeKeychain();
    const capability = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) => machine.credentialCapability())
        .pipe(Effect.provide(layerWith(fake.runner))),
    );
    expect(capability).toEqual({
      kind: "secure-noninteractive",
      provider: "keychain",
      verification: "session-probe",
    });
  });

  it("reports unavailable with session guidance when the probe is denied", async () => {
    const fake = fakeKeychain({ addExit: 45 });
    const capability = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) => machine.credentialCapability())
        .pipe(Effect.provide(layerWith(fake.runner))),
    );
    expect(capability.kind).toBe("unavailable");
    if (capability.kind === "unavailable") {
      expect(capability.recovery).toContain("session probe failed at add");
      expect(capability.recovery).toContain("graphical session");
      expect(capability.recovery).toContain("gui/");
      expect(capability.recovery.toLowerCase()).not.toContain("unlock the login keychain");
    }
  });

  it("reports unavailable instead of failing when the probe cannot run", async () => {
    const brokenRunner: SecurityRunner = () =>
      Effect.fail(new CredentialStorageError({
        operation: "run probe",
        reference: "fixture",
        message: "osascript vanished",
      }));
    const capability = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) => machine.credentialCapability())
        .pipe(Effect.provide(layerWith(brokenRunner))),
    );
    expect(capability.kind).toBe("unavailable");
    if (capability.kind === "unavailable") {
      expect(capability.recovery).toContain("could not run");
      expect(capability.recovery).toContain("osascript vanished");
    }
  });

  it("never reaches the native credential write path when the probe failed", async () => {
    let nativeWrites = 0;
    let fallbackWrites = 0;
    const unavailableAfterFailedProbe = Layer.effect(
      MachineState,
      Effect.map(MachineState, (machine) => ({
        ...machine,
        storeCredential: () =>
          Effect.sync(() => {
            fallbackWrites += 1;
            return null as never;
          }),
        credentialCapability: () =>
          Effect.map(
            keychainSessionProbe(fakeKeychain({ addExit: 45 }).runner),
            (probe) => {
              if (probe.ok) throw new Error("fixture probe should have failed");
              return {
                kind: "unavailable",
                recovery: "fixture",
              } as const;
            },
          ),
      })),
    ).pipe(Layer.provide(linuxMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: join(mkdtempSync(join(tmpdir(), "canonfig-probe-")), "credentials"),
      },
    })));
    const store = nativeSecretStoreLayer(unavailableAfterFailedProbe, {
      runCommand: () =>
        Effect.sync(() => {
          nativeWrites += 1;
          return 0;
        }),
    });
    const reference = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) => machine.storeCredential({
        name: "fixture-credential",
        value: Redacted.make("fixture-secret"),
      })).pipe(Effect.provide(store)),
    );
    expect(nativeWrites).toBe(0);
    expect(fallbackWrites).toBe(1);
    expect(reference).toBeNull();
  });
});
