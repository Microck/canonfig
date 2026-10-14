import type { Readable } from "node:stream";

import { Effect } from "effect";

import type { CliIo } from "../cli/cli.ts";
import {
  CliExitCode,
  type CliExitCode as CliExitCodeValue,
} from "../cli/exit-codes.ts";
import { resolveLinuxSessionBus } from "../machine/linux.layer.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { StateRepository } from "../state/state-repository.service.ts";
import {
  decodeSecretName,
  listSecrets,
  maximumSecretBytes,
  removeSecret,
  SECRET_SHARE_GROUP,
  type SharedSecretSummary,
  SecretTransferError,
  storeSecret,
} from "./secret-store.ts";
import {
  type LinuxCredentialBootstrapResult,
  machineStateBootstrapHost,
  runLinuxCredentialBootstrap,
} from "./linux-credential-bootstrap.ts";
import {
  synchronizeSharedSecrets,
  type SecretSynchronizationResult,
} from "./secret-client.ts";
export const secretsHelpText = `Canonfig shared secrets

Usage: canonfig secrets <command> [options]

Commands:
  set <name>      Read a secret from stdin and store it securely
  list            List secret names and origins
  remove <name>   Remove a stored secret
  sync            Pull authorized secrets from the enrolled source
  bootstrap       Verify the native credential store end to end

Options:
  --json          Emit machine-readable JSON
  -h, --help      Show help

Secret values are accepted only through stdin and are never printed. Piped
values are stored byte for byte, trailing newlines included. At a terminal,
entry is hidden and the Enter that ends it is not stored. Values hold at most
${maximumSecretBytes} bytes of UTF-8 and no NUL bytes.
Followers must be enrolled with the ${SECRET_SHARE_GROUP} group to receive them.
Bootstrap stores only disposable probes, removes them, and reports the
selected credential policy with backup-encryption and persistence evidence.
`;

export const secretExitCode = (
  error: SecretTransferError,
): CliExitCodeValue => {
  switch (error.category) {
    case "usage":
    case "state":
      return CliExitCode.usageOrConfiguration;
    case "storage":
      return CliExitCode.humanActionRequired;
    case "authentication":
      return CliExitCode.authenticationOrRevocation;
    case "transport":
      return CliExitCode.transport;
  }
};

const usageError = (message: string): SecretTransferError =>
  new SecretTransferError({
    category: "usage",
    operation: "parse secrets command",
    message,
  });

/** stdin, or a stand-in: a byte stream that, at a terminal, offers raw mode. */
export type SecretInputStream = Readable & {
  readonly isTTY?: boolean;
  readonly setRawMode?: (mode: boolean) => void;
};

export interface SecretInputOptions {
  /** How long a pipe may stay open without EOF. Terminal entry has no bound. */
  readonly timeoutMilliseconds?: number;
}

const secretInputTimeoutMilliseconds = 10_000;

type SecretInputResult =
  | { readonly _tag: "Entered"; readonly value: string }
  | { readonly _tag: "Interrupted" };

const inputError = (message: string): SecretTransferError =>
  new SecretTransferError({
    category: "usage",
    operation: "read secret from stdin",
    message,
  });

const oversizedInputMessage =
  `the secret on stdin exceeds the ${maximumSecretBytes} byte limit; shared secrets hold at most ${maximumSecretBytes} bytes of UTF-8`;

/**
 * Validate collected bytes and decode them exactly: no trimming, and a leading
 * byte-order mark stays part of the value. The bytes are zeroed either way.
 */
const decodeSecretBytes = (bytes: Uint8Array): string => {
  try {
    if (bytes.byteLength === 0) {
      throw inputError("the secret on stdin is empty; supply a non-empty UTF-8 secret");
    }
    if (bytes.includes(0)) {
      throw inputError("the secret on stdin contains a NUL byte; secrets must be UTF-8 text without NUL bytes");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw inputError("the secret on stdin is not valid UTF-8");
    }
  } finally {
    bytes.fill(0);
  }
};

const asSecretInputError = (cause: unknown): SecretTransferError =>
  cause instanceof SecretTransferError
    ? cause
    : inputError("stdin could not be read; pipe the secret to canonfig secrets set <name>");

/**
 * Take a piped secret byte for byte. EOF is required within a fixed bound, and
 * oversized input fails as soon as it crosses the limit.
 */
const readPipedSecret = (
  name: string,
  input: SecretInputStream,
  timeoutMilliseconds: number,
  signal: AbortSignal,
): Promise<SecretInputResult> => {
  if (input.readableObjectMode) {
    return Promise.reject(inputError("stdin must be a byte stream"));
  }
  if (input.destroyed || input.readableEnded) {
    return Promise.reject(
      inputError(`stdin is closed or already consumed; pipe the secret to canonfig secrets set ${name}`),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      input.pause();
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = (error: SecretTransferError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      // Copy: zeroing the private buffer must not mutate caller-owned memory.
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > maximumSecretBytes) {
        value.fill(0);
        fail(inputError(oversizedInputMessage));
        return;
      }
      chunks.push(value);
    };
    const onEnd = (): void => {
      if (settled) return;
      let value: string;
      try {
        value = decodeSecretBytes(Buffer.concat(chunks, bytes));
      } catch (cause) {
        fail(asSecretInputError(cause));
        return;
      }
      settled = true;
      cleanup();
      resolve({ _tag: "Entered", value });
    };
    const onError = (): void => fail(asSecretInputError(undefined));
    const onAbort = (): void => fail(inputError("reading the secret from stdin was interrupted"));
    const timer = setTimeout(
      () =>
        fail(inputError(
          `secrets set timed out after ${timeoutMilliseconds / 1000} s waiting for end of input on stdin; pipe the secret and close the pipe (printf '%s' "$VALUE" | canonfig secrets set ${name})`,
        )),
      timeoutMilliseconds,
    );
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

const carriageReturn = 0x0d;
const lineFeed = 0x0a;
const endOfText = 0x03;
const endOfTransmission = 0x04;
const backspace = 0x08;
const deleteKey = 0x7f;

/**
 * Hidden terminal entry: raw mode with echo off until Enter. The terminating
 * CR or LF is the one byte not kept. Ctrl-C interrupts like SIGINT, Ctrl-D on
 * an empty entry cancels, and every exit path restores the terminal.
 */
const readTerminalSecret = (
  name: string,
  input: SecretInputStream,
  writeStderr: (text: string) => void,
  signal: AbortSignal,
): Promise<SecretInputResult> => {
  const setRawMode = input.setRawMode;
  if (setRawMode === undefined) {
    return Promise.reject(inputError(
      `stdin is a terminal without raw-mode support; pipe the secret instead (printf '%s' "$VALUE" | canonfig secrets set ${name})`,
    ));
  }
  if (signal.aborted) {
    return Promise.reject(inputError("reading the secret from stdin was interrupted"));
  }
  return new Promise((resolve, reject) => {
    const entry = Buffer.alloc(maximumSecretBytes);
    let length = 0;
    let settled = false;
    // The finalizer for every outcome: success, failure, Ctrl-C and abort.
    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      try {
        setRawMode.call(input, false);
      } catch {
        // Only a terminal that is already gone (hangup) refuses; nothing is
        // left to restore on it.
      }
      input.pause();
      entry.fill(0);
      writeStderr("\n");
    };
    const settle = (outcome: () => SecretInputResult): void => {
      if (settled) return;
      settled = true;
      let result: SecretInputResult;
      try {
        result = outcome();
      } catch (cause) {
        cleanup();
        reject(asSecretInputError(cause));
        return;
      }
      cleanup();
      resolve(result);
    };
    const fail = (error: SecretTransferError): void =>
      settle(() => {
        throw error;
      });
    const submit = (): void =>
      settle(() => ({ _tag: "Entered", value: decodeSecretBytes(entry.subarray(0, length)) }));
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of bytes) {
        if (byte === carriageReturn || byte === lineFeed) {
          submit();
          return;
        }
        if (byte === endOfText) {
          settle(() => ({ _tag: "Interrupted" }));
          return;
        }
        if (byte === endOfTransmission) {
          if (length === 0) {
            fail(inputError("secrets set was cancelled: no secret was entered"));
          } else {
            submit();
          }
          return;
        }
        if (byte === backspace || byte === deleteKey) {
          // Erase one whole UTF-8 character: its continuation bytes and lead.
          let start = Math.max(0, length - 1);
          while (start > 0 && ((entry[start] ?? 0) & 0xc0) === 0x80) start -= 1;
          entry.fill(0, start, length);
          length = start;
          continue;
        }
        if (length === maximumSecretBytes) {
          fail(inputError(oversizedInputMessage));
          return;
        }
        entry[length] = byte;
        length += 1;
      }
    };
    const onEnd = (): void =>
      length === 0 ? fail(inputError("secrets set was cancelled: no secret was entered")) : submit();
    const onError = (): void => fail(asSecretInputError(undefined));
    const onAbort = (): void => fail(inputError("reading the secret from stdin was interrupted"));
    setRawMode.call(input, true);
    writeStderr(`Secret for ${name} (input hidden): `);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * Read one secret for `secrets set`. Piped input is stored exactly as given;
 * interactive entry is hidden and drops only the Enter that ends it. Ctrl-C
 * at the prompt interrupts the command like SIGINT.
 */
export const readSecretInput = (
  name: string,
  input: SecretInputStream,
  writeStderr: (text: string) => void,
  options: SecretInputOptions = {},
): Effect.Effect<string, SecretTransferError> =>
  Effect.tryPromise({
    try: (signal) =>
      input.isTTY === true
        ? readTerminalSecret(name, input, writeStderr, signal)
        : readPipedSecret(
          name,
          input,
          options.timeoutMilliseconds ?? secretInputTimeoutMilliseconds,
          signal,
        ),
    catch: asSecretInputError,
  }).pipe(
    Effect.flatMap((result) =>
      result._tag === "Interrupted" ? Effect.interrupt : Effect.succeed(result.value)
    ),
  );

type SecretCliData =
  | SharedSecretSummary
  | SecretSynchronizationResult
  | LinuxCredentialBootstrapResult
  | { readonly commands: ReadonlyArray<string> }
  | { readonly secrets: ReadonlyArray<SharedSecretSummary> }
  | { readonly name: string; readonly removed: boolean };

const writeSuccess = (
  io: CliIo,
  json: boolean,
  command: string,
  data: SecretCliData,
  human: string,
): void => {
  if (json) {
    io.writeStdout(`${JSON.stringify({
      schema: "canonfig.secrets/v1",
      ok: true,
      command,
      data,
    })}\n`);
  } else {
    io.writeStdout(human);
  }
  io.setExitCode(CliExitCode.success);
};

const writeFailure = (
  io: CliIo,
  json: boolean,
  command: string,
  error: SecretTransferError,
): void => {
  const exitCode = secretExitCode(error);
  if (json) {
    io.writeStderr(`${JSON.stringify({
      schema: "canonfig.secrets/v1",
      ok: false,
      command,
      error: {
        category: error.category,
        operation: error.operation,
        message: error.message,
      },
      exitCode,
    })}\n`);
  } else {
    io.writeStderr(`${error.message}\n`);
  }
  io.setExitCode(exitCode);
};

/**
 * Whether `canonfig secrets …` asks only for help. Help needs no state or
 * credential store, so the entrypoint answers it before building the secret
 * runtime layer (which opens state.sqlite and may create ~/.canonfig).
 */
export const secretsHelpRequested = (arguments_: ReadonlyArray<string>): boolean => {
  const positional = arguments_.filter((argument) => argument !== "--json");
  return positional.length === 0
    || positional[0] === "help"
    || positional.includes("--help")
    || positional.includes("-h");
};

export const writeSecretsHelp = (arguments_: ReadonlyArray<string>, io: CliIo): void =>
  writeSuccess(
    io,
    arguments_.includes("--json"),
    "secrets.help",
    { commands: ["set", "list", "remove", "sync", "bootstrap"] },
    secretsHelpText,
  );

export const runSecretsCli = (
  arguments_: ReadonlyArray<string>,
  io: CliIo,
  input: SecretInputStream = process.stdin,
): Effect.Effect<void, never, MachineState | StateRepository> => {
  const json = arguments_.includes("--json");
  const positional = arguments_.filter((argument) => argument !== "--json");
  const [command = "help", ...rest] = positional;
  const commandName = `secrets.${command}`;

  const program = Effect.gen(function*() {
    if (secretsHelpRequested(arguments_)) {
      writeSecretsHelp(arguments_, io);
      return;
    }
    if (command === "set") {
      if (rest.length !== 1) return yield* usageError("usage: canonfig secrets set <name>");
      // Reject a bad name before the user pipes or types the value.
      const name = yield* decodeSecretName(rest[0]!);
      const value = yield* readSecretInput(name, input, io.writeStderr);
      const secret = yield* storeSecret(name, value, "local");
      writeSuccess(
        io,
        json,
        commandName,
        secret,
        `Stored secret ${secret.name}.\n`,
      );
      return;
    }
    if (command === "list") {
      if (rest.length !== 0) return yield* usageError("usage: canonfig secrets list");
      const secrets = yield* listSecrets();
      writeSuccess(
        io,
        json,
        commandName,
        { secrets },
        secrets.length === 0
          ? "No secrets stored.\n"
          : `${secrets.map((secret) => `${secret.name}\t${secret.origin}`).join("\n")}\n`,
      );
      return;
    }
    if (command === "remove") {
      if (rest.length !== 1) return yield* usageError("usage: canonfig secrets remove <name>");
      const name = rest[0]!;
      const removed = yield* removeSecret(name);
      writeSuccess(
        io,
        json,
        commandName,
        { name, removed },
        removed ? `Removed secret ${name}.\n` : `Secret ${name} is not stored.\n`,
      );
      return;
    }
    if (command === "sync") {
      if (rest.length !== 0) return yield* usageError("usage: canonfig secrets sync");
      const result = yield* synchronizeSharedSecrets();
      const human = result.status === "not-enrolled"
        ? "This machine is not enrolled.\n"
        : result.status === "not-shared"
        ? "The source does not share secrets with this follower.\n"
        : `Synchronized ${result.secrets.length} secret${result.secrets.length === 1 ? "" : "s"}.\n`;
      writeSuccess(io, json, commandName, result, human);
      return;
    }
    if (command === "bootstrap") {
      if (rest.length !== 0) return yield* usageError("usage: canonfig secrets bootstrap");
      const machine = yield* MachineState;
      // The same bus the machine layer resolved, including the
      // $XDG_RUNTIME_DIR/bus fallback, so bootstrap probes what runs use.
      const sessionBus = resolveLinuxSessionBus();
      const host = machineStateBootstrapHost(
        machine,
        sessionBus.kind === "missing"
          ? []
          : [{ name: "DBUS_SESSION_BUS_ADDRESS", value: sessionBus.address }],
      );
      const result = yield* runLinuxCredentialBootstrap(host);
      const provider = result.provider === "secret-service"
        ? `Secret Service (${result.secretTool ?? "secret-tool"})`
        : "local file";
      const human = [
        "Credential bootstrap complete.",
        `Provider: ${provider}`,
        `Selected policy: ${result.selectedPolicy}`,
        `Backup encryption: ${result.backupEncryption} (${result.backupEncryptionDetail})`,
        `Round trips passed: ${result.roundTripsPassed}`,
        `Restart persistence: ${result.restartPersistence}`,
        `Logout and reboot persistence: ${result.logoutPersistence} (${result.persistenceDetail})`,
        "",
      ].join("\n");
      writeSuccess(io, json, commandName, result, human);
      return;
    }
    return yield* usageError(`unknown secrets command: ${command}`);
  });

  return program.pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        const error = cause instanceof SecretTransferError
          ? cause
          : new SecretTransferError({
            category: "state",
            operation: commandName,
            message: "the secrets command failed",
          });
        writeFailure(io, json, commandName, error);
      })
    ),
  );
};
