import { spawn } from "node:child_process";
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

const maximumCredentialInputBytes = 64 * 1024;
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
    command: NativeCredentialWriteCommand,
  ) => Effect.Effect<number | null, MachineStateError>) | undefined;
}

const commandEnvironment = (
  additions: ReadonlyArray<ProcessEnvironmentEntry>,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of additions) environment[entry.name] = entry.value;
  return environment;
};

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
  command: NativeCredentialWriteCommand,
): Effect.Effect<number | null, MachineStateError> => {
  if (command.standardInput.byteLength > maximumCredentialInputBytes) {
    return Effect.fail(new CredentialStorageError({
      operation: "store credential",
      reference: command.provider,
      message: "credential input exceeds the native-store size limit",
    }));
  }

  return Effect.tryPromise({
    try: (signal) =>
      new Promise<number | null>((resolveCommand, rejectCommand) => {
        const child = spawn(command.executable, [...command.arguments], {
          env: commandEnvironment(command.environment),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let outputBytes = 0;
        let failed = false;
        const fail = (cause: unknown): void => {
          if (failed) return;
          failed = true;
          child.kill();
          rejectCommand(cause);
        };
        const capture = (chunk: Buffer): void => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maximumCredentialOutputBytes) {
            fail(new Error("native credential command exceeded its output limit"));
          }
        };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.once("error", fail);
        child.stdin.once("error", fail);
        const timer = setTimeout(
          () => fail(new Error("native credential command timed out")),
          credentialTimeoutMilliseconds,
        );
        const abort = (): void => fail(new Error("native credential command aborted"));
        signal.addEventListener("abort", abort, { once: true });
        child.once("close", (exitCode) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (!failed) resolveCommand(exitCode);
        });
        child.stdin.end(command.standardInput);
      }),
    catch: () => failure(command.provider),
  });
};

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
            command,
          );
          if (exitCode !== 0) return yield* failure(command.provider);
          return command.reference;
        }),
    })),
  ).pipe(Layer.provide(base));
