import { createHash } from "node:crypto";
import { win32 } from "node:path";

import { Effect, Layer, Redacted, Schema } from "effect";

import { CredentialReference } from "../domain/brand.ts";
import {
  CredentialStorageError,
  HumanActionRequiredError,
  type MachineStateError,
} from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type {
  CredentialStorageCapability,
  ProcessEnvironmentEntry,
  StoreCredentialInput,
} from "../machine/machine-state.types.ts";

const maximumCredentialOutputBytes = 1024 * 1024;
const credentialTimeoutMilliseconds = 5_000;
const decode = Schema.decodeUnknownSync;

export interface NativeCredentialWriteCommand {
  readonly provider: "keychain" | "credential-manager";
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<ProcessEnvironmentEntry>;
  readonly standardInput: Uint8Array;
  readonly reference: typeof CredentialReference.Type;
}

export interface NativeSecretStoreLayerOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly runCommand?: ((
    machine: MachineState["Service"],
    command: NativeCredentialWriteCommand,
  ) => Effect.Effect<number | null, MachineStateError>) | undefined;
}

const failure = (
  provider: NativeCredentialWriteCommand["provider"],
): HumanActionRequiredError =>
  provider === "keychain"
    ? new HumanActionRequiredError({
      action: "unlock macOS Keychain",
      recovery: "Unlock the login Keychain for this user session, then retry.",
    })
    : new HumanActionRequiredError({
      action: "unlock Windows Credential Manager",
      recovery: "Sign in interactively and make Credential Manager available, then retry.",
    });

const runNativeCredentialCommand = (
  machine: MachineState["Service"],
  command: NativeCredentialWriteCommand,
): Effect.Effect<number | null, MachineStateError> =>
  Effect.gen(function*() {
    const executable = yield* machine.normalizePath({
      path: command.executable,
    });
    const result = yield* machine.runProcess({
      executable,
      arguments: command.arguments,
      environment: command.environment,
      standardInput: command.standardInput,
      timeoutMilliseconds: credentialTimeoutMilliseconds,
      maximumOutputBytes: maximumCredentialOutputBytes,
    });
    return result.exitCode;
  });

export const nativeCredentialWriteCommand = (
  capability: Extract<CredentialStorageCapability, {
    readonly kind: "secure-noninteractive";
  }>,
  input: StoreCredentialInput,
  environment: NodeJS.ProcessEnv = process.env,
): NativeCredentialWriteCommand | undefined => {
  if (capability.provider === "secret-service") return undefined;
  const key = createHash("sha256").update(input.name).digest("hex");
  const value = Redacted.value(input.value);

  if (capability.provider === "keychain") {
    const hexadecimalValue = Buffer.from(value, "utf8").toString("hex");
    return {
      provider: "keychain",
      executable: "/usr/bin/security",
      arguments: [],
      environment: [],
      standardInput: new TextEncoder().encode(
        `add-generic-password -U -a canonfig -s dev.canonfig.${key} -X ${hexadecimalValue}\n`,
      ),
      reference: decode(CredentialReference)(`keychain:${key}`),
    };
  }

  const powershell = environment.CANONFIG_POWERSHELL
    ?? win32.join(
      environment.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$secret=[Console]::In.ReadToEnd()",
    "$vault=New-Object Windows.Security.Credentials.PasswordVault",
    "$credential=New-Object Windows.Security.Credentials.PasswordCredential("
      + "$env:CANONFIG_TARGET,'canonfig',$secret)",
    "$vault.Add($credential)",
  ].join(";");
  return {
    provider: "credential-manager",
    executable: powershell,
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ],
    environment: [{
      name: "CANONFIG_TARGET",
      value: `dev.canonfig.${key}`,
    }],
    standardInput: new TextEncoder().encode(value),
    reference: decode(CredentialReference)(`credential-manager:${key}`),
  };
};

export const nativeSecretStoreLayer = (
  base: Layer.Layer<MachineState>,
  options: NativeSecretStoreLayerOptions = {},
): Layer.Layer<MachineState> =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, (machine) => ({
      ...machine,
      storeCredential: (input: StoreCredentialInput) =>
        Effect.gen(function*() {
          if (input.name.trim().length === 0) {
            return yield* new CredentialStorageError({
              operation: "store credential",
              reference: "native-store",
              message: "credential name must not be empty",
            });
          }
          const capability = yield* machine.credentialCapability();
          if (capability.kind !== "secure-noninteractive") {
            return yield* machine.storeCredential(input);
          }
          const command = nativeCredentialWriteCommand(
            capability,
            input,
            options.environment,
          );
          if (command === undefined) return yield* machine.storeCredential(input);
          const exitCode = yield* (options.runCommand ?? runNativeCredentialCommand)(
            machine,
            command,
          );
          if (exitCode !== 0) return yield* failure(command.provider);
          return command.reference;
        }),
    })),
  ).pipe(Layer.provide(base));
