import { Effect } from "effect";

import type { CliIo } from "../cli/cli.ts";
import {
  CliExitCode,
  type CliExitCode as CliExitCodeValue,
} from "../cli/exit-codes.ts";
import type { MachineState } from "../machine/machine-state.service.ts";
import type { StateRepository } from "../state/state-repository.service.ts";
import {
  listSecrets,
  maximumSecretBytes,
  removeSecret,
  SecretTransferError,
  storeSecret,
} from "./secret-store.ts";
import { synchronizeSharedSecrets } from "./secret-client.ts";

export const secretsHelpText = `Canonfig shared secrets

Usage: canonfig secrets <command> [options]

Commands:
  set <name>      Read a secret from stdin and store it securely
  list            List secret names and origins
  remove <name>   Remove a stored secret
  sync            Pull authorized secrets from the enrolled source

Options:
  --json          Emit machine-readable JSON
  -h, --help      Show help

Secret values are accepted only through stdin and are never printed.
`;

export const isSecretsCommand = (
  arguments_: ReadonlyArray<string>,
): boolean => arguments_[0] === "secrets";

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

const readSecretFromStdin = (): Effect.Effect<string, SecretTransferError> =>
  Effect.tryPromise({
    try: async () => {
      if (process.stdin.isTTY) {
        throw new Error("stdin is interactive");
      }
      const chunks: Array<Buffer> = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maximumSecretBytes + 2) {
          throw new Error("stdin exceeds the size limit");
        }
        chunks.push(buffer);
      }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      const value = raw.endsWith("\r\n")
        ? raw.slice(0, -2)
        : raw.endsWith("\n")
        ? raw.slice(0, -1)
        : raw;
      if (
        value.length === 0
        || value.includes("\0")
        || Buffer.byteLength(value, "utf8") > maximumSecretBytes
      ) {
        throw new Error("stdin does not contain a valid secret");
      }
      return value;
    },
    catch: () =>
      new SecretTransferError({
        category: "usage",
        operation: "read secret from stdin",
        message:
          `pipe a non-empty UTF-8 secret of at most ${maximumSecretBytes} bytes to stdin`,
      }),
  });

const writeSuccess = (
  io: CliIo,
  json: boolean,
  command: string,
  data: unknown,
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

export const runSecretsCli = (
  arguments_: ReadonlyArray<string>,
  io: CliIo,
): Effect.Effect<void, never, MachineState | StateRepository> => {
  const json = arguments_.includes("--json");
  const positional = arguments_.filter((argument) => argument !== "--json");
  const [command = "help", ...rest] = positional;
  const commandName = `secrets.${command}`;

  const program = Effect.gen(function*() {
    if (command === "help" || command === "--help" || command === "-h") {
      if (rest.length > 0) return yield* usageError("help does not accept arguments");
      writeSuccess(io, json, "secrets.help", { commands: ["set", "list", "remove", "sync"] }, secretsHelpText);
      return;
    }
    if (command === "set") {
      if (rest.length !== 1) return yield* usageError("usage: canonfig secrets set <name>");
      const value = yield* readSecretFromStdin();
      const secret = yield* storeSecret(rest[0]!, value, "local");
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
      const removed = yield* removeSecret(rest[0]!);
      writeSuccess(
        io,
        json,
        commandName,
        { name: rest[0], removed },
        removed ? `Removed secret ${rest[0]}.\n` : `Secret ${rest[0]} is not stored.\n`,
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
