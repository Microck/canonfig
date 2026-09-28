import { createHash } from "node:crypto";

import { Effect, Layer, Redacted, Schema } from "effect";

import { CredentialReference } from "../domain/brand.ts";
import {
  CredentialStorageError,
  credentialFailureDetail,
  HumanActionRequiredError,
  type MachineStateError,
} from "../machine/machine-state.errors.ts";
import { keychainSessionGuidance } from "../machine/keychain-session-probe.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { windowsCredentialScript, windowsCredentialTimeoutMilliseconds, windowsPowerShellExecutable } from "../machine/windows-credentials.ts";
import type {
  CredentialStorageCapability,
  LoadCredentialInput,
  ProcessEnvironmentEntry,
  StoreCredentialInput,
  ProcessResult,
} from "../machine/machine-state.types.ts";

const maximumCredentialOutputBytes = 1024 * 1024;
const keychainTimeoutMilliseconds = 5_000;
const keychainHexPrefix = "keychain-hex:";
const decode = Schema.decodeUnknownSync;

// SecurityTool's interactive input is limited to 4 KiB. The native framework
// accepts the full secret over stdin; the same host reads its Keychain items.
// Core Foundation constants must become Objective-C objects before dictionary use.
const keychainArguments = ["-l", "JavaScript", "-e", [
  "ObjC.import('Foundation');",
  "ObjC.import('Security');",
  "function run() {",
  "  const bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;",
  "  const payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));",
  "  const query = $.NSMutableDictionary.dictionary;",
  "  query.setObjectForKey(ObjC.castRefToObject($.kSecClassGenericPassword), ObjC.castRefToObject($.kSecClass));",
  "  query.setObjectForKey($(payload.service), ObjC.castRefToObject($.kSecAttrService));",
  "  query.setObjectForKey($('canonfig'), ObjC.castRefToObject($.kSecAttrAccount));",
  "  if (payload.operation === 'load') {",
  "    query.setObjectForKey($.NSNumber.numberWithBool(true), ObjC.castRefToObject($.kSecReturnData));",
  "    const output = Ref();",
  "    const status = $.SecItemCopyMatching(query, output);",
  "    if (status !== 0) throw Error('Keychain read failed: ' + status);",
  "    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(output[0]), $.NSUTF8StringEncoding));",
  "  }",
  "  const attributes = $.NSMutableDictionary.dictionary;",
  "  attributes.setObjectForKey($(payload.hexadecimal).dataUsingEncoding($.NSUTF8StringEncoding), ObjC.castRefToObject($.kSecValueData));",
  "  let status = $.SecItemUpdate(query, attributes);",
  "  if (status === -25300) { // errSecItemNotFound",
  "    query.addEntriesFromDictionary(attributes);",
  "    status = $.SecItemAdd(query, null);",
  "  }",
  "  if (status !== 0) throw Error('Keychain write failed: ' + status);",
  "}",
].join("\n")];

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
      action: "access the macOS Keychain from this session",
      recovery: `The Keychain refused the native credential write from this execution session. ${keychainSessionGuidance(process.getuid?.() ?? 0)}`,
    })
    : new HumanActionRequiredError({
      action: "unlock Windows Credential Manager",
      recovery: "Sign in interactively and make Credential Manager available, then retry.",
    });

/**
 * A failed `keychain-hex:` read. The helper script reports the Security
 * framework status (`Keychain read failed: <OSStatus>`) on standard error;
 * a missing item is a local state problem, anything else is the session's
 * Keychain refusing access, which only the operator can resolve.
 */
const keychainReadFailure = (
  input: LoadCredentialInput,
  result: ProcessResult,
): HumanActionRequiredError | CredentialStorageError => {
  const status = /Keychain read failed: (-?\d+)/u.exec(
    new TextDecoder().decode(result.standardError),
  )?.[1];
  if (status === "-25300") {
    return new CredentialStorageError({
      operation: "load credential",
      reference: String(input.reference),
      message: "the macOS login Keychain has no item for this credential (Keychain status -25300, item not found)",
    });
  }
  const meaning = status === "-25308"
    ? ", user interaction is not allowed: the login Keychain is locked in this session"
    : status === "-128"
    ? ", the Keychain unlock prompt was cancelled"
    : "";
  const evidence = status === undefined
    ? `osascript exited with code ${result.exitCode ?? "signal"}`
    : `osascript exited with code ${result.exitCode ?? "signal"}, Keychain status ${status}${meaning}`;
  return new HumanActionRequiredError({
    action: "unlock the macOS login Keychain",
    recovery: `The Keychain credential could not be read from this execution session (${evidence}). ${keychainSessionGuidance(process.getuid?.() ?? 0)}`,
  });
};

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
      timeoutMilliseconds: command.provider === "credential-manager" ? windowsCredentialTimeoutMilliseconds : keychainTimeoutMilliseconds,
      maximumOutputBytes: maximumCredentialOutputBytes,
    });
    return result.exitCode;
  });

const keychainStorageReference = (
  reference: typeof CredentialReference.Type,
): typeof CredentialReference.Type | undefined => {
  const text = String(reference);
  if (!text.startsWith(keychainHexPrefix)) return undefined;
  return decode(CredentialReference)(`keychain:${text.slice(keychainHexPrefix.length)}`);
};

const decodeKeychainValue = (
  input: LoadCredentialInput,
  value: Redacted.Redacted<string>,
): Effect.Effect<Redacted.Redacted<string>, CredentialStorageError> =>
  Effect.try({
    try: () => {
      const hexadecimal = Redacted.value(value);
      if (!/^(?:[0-9a-f]{2})+$/u.test(hexadecimal)) {
        throw new Error("invalid Keychain hex payload");
      }
      return Redacted.make(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(hexadecimal, "hex"),
        ),
      );
    },
    catch: () => new CredentialStorageError({
      operation: "load credential",
      reference: String(input.reference),
      message: "the versioned Keychain credential is invalid",
    }),
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
      executable: "/usr/bin/osascript",
      arguments: keychainArguments,
      environment: [],
      standardInput: new TextEncoder().encode(
        JSON.stringify({ operation: "store", service: `dev.canonfig.${key}`, hexadecimal: hexadecimalValue }),
      ),
      reference: decode(CredentialReference)(`${keychainHexPrefix}${key}`),
    };
  }

  const powershell = windowsPowerShellExecutable(environment);
  const script = windowsCredentialScript("store");
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

const loadKeychainHexCredential = (
  machine: MachineState["Service"],
  input: LoadCredentialInput,
): Effect.Effect<Redacted.Redacted<string>, MachineStateError> =>
  Effect.gen(function*() {
    const reference = String(input.reference);
    const executable = yield* machine.normalizePath({ path: "/usr/bin/osascript" });
    const loaded = yield* machine.runProcess({
      executable,
      arguments: keychainArguments,
      standardInput: new TextEncoder().encode(JSON.stringify({
        operation: "load",
        service: `dev.canonfig.${reference.slice(keychainHexPrefix.length)}`,
      })),
      timeoutMilliseconds: keychainTimeoutMilliseconds,
      maximumOutputBytes: maximumCredentialOutputBytes,
    });
    if (loaded.exitCode !== 0) return yield* keychainReadFailure(input, loaded);
    return yield* decodeKeychainValue(input, Redacted.make(
      new TextDecoder().decode(loaded.standardOutput).trim(),
    ));
  });

const providerName = (capability: CredentialStorageCapability): string =>
  capability.kind === "local-file"
    ? "local-file credential store"
    : capability.kind === "unavailable"
    ? "credential store"
    : capability.provider === "secret-service"
    ? "Secret Service"
    : capability.provider === "keychain"
    ? "macOS Keychain"
    : "Windows Credential Manager";

export const nativeSecretStoreLayer = (
  base: Layer.Layer<MachineState>,
  options: NativeSecretStoreLayerOptions = {},
): Layer.Layer<MachineState> =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, (machine) => {
      const loadCredential = (input: LoadCredentialInput) =>
        String(input.reference).startsWith(keychainHexPrefix)
          ? loadKeychainHexCredential(machine, input)
          : machine.loadCredential(input);
      const removeCredential = (reference: typeof CredentialReference.Type) =>
        machine.removeCredential(keychainStorageReference(reference) ?? reference);
      const writeCredential = (
        input: StoreCredentialInput,
        capability: CredentialStorageCapability,
      ): Effect.Effect<typeof CredentialReference.Type, MachineStateError> =>
        Effect.gen(function*() {
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
        });
      return {
        ...machine,
        /**
         * Every store is read back and compared by digest before its
         * reference is returned. A provider that truncates or rewrites the
         * value (secret-tool silently keeps 8192 bytes of a longer pipe, for
         * example) must fail the store, never report success over a
         * corrupted credential; the partial item is removed.
         */
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
            const reference = yield* writeCredential(input, capability);
            const provider = providerName(capability);
            const discard = removeCredential(reference).pipe(Effect.ignore);
            const stored = yield* loadCredential({ reference }).pipe(
              Effect.tapError(() => discard),
              Effect.mapError((error) =>
                new CredentialStorageError({
                  operation: "store credential",
                  reference: String(reference),
                  message: `the ${provider} accepted the credential but it could not be read back, so it was removed: ${credentialFailureDetail(error)}`,
                })
              ),
            );
            const expected = Redacted.value(input.value);
            const actual = Redacted.value(stored);
            if (
              createHash("sha256").update(actual, "utf8").digest("hex")
                !== createHash("sha256").update(expected, "utf8").digest("hex")
            ) {
              yield* discard;
              return yield* new CredentialStorageError({
                operation: "store credential",
                reference: String(reference),
                message: `the ${provider} returned ${Buffer.byteLength(actual, "utf8")} bytes for a ${Buffer.byteLength(expected, "utf8")}-byte credential, so the credential was removed instead of being kept corrupted; nothing was stored`,
              });
            }
            return reference;
          }),
        loadCredential,
        removeCredential,
      };
    }),
  ).pipe(Layer.provide(base));
