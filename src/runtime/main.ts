#!/usr/bin/env node

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { evaluateCli, runCli, type CliIo } from "../cli/cli.ts";
import { CliExitCode } from "../cli/exit-codes.ts";
import { renderUsageFailure } from "../cli/render.ts";
import {
  isHarnessConfigurationCommand,
  runHarnessConfigurationCli,
} from "../harness-configuration/cli.ts";
import { installCommandLog } from "../logging/command-log.ts";
import {
  isSecretsCommand,
  runSecretsCli,
  secretExitCode,
} from "../secrets/cli.ts";
import { synchronizeSharedSecrets } from "../secrets/secret-client.ts";
import { SecretTransferError } from "../secrets/secret-store.ts";
import {
  EnrollmentInputError,
  isPrivateEnrollmentCommand,
  privateEnrollmentArguments,
  privateEnrollmentHelp,
  readEnrollmentInput,
} from "./enrollment-input.ts";

/**
 * Silences the `node:sqlite` experimental warning.
 *
 * This only works because nothing in this module's static import graph reaches
 * `@effect/sql-sqlite-node`. Node emits that warning while it translates the
 * module, which happens before any module body runs, so a warning filter
 * cannot suppress a statically imported sqlite. Both the runtime layer and the
 * secret runtime layer are therefore loaded with a dynamic import, which
 * happens after this filter is installed.
 */
const warningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning.name === "ExperimentalWarning"
    && warning.message === "SQLite is an experimental feature and might change at any time"
  ) return;
  for (const listener of warningListeners) listener.call(process, warning);
});

const arguments_ = process.argv.slice(2);
// Capture only the original non-secret command line, before reading stdin.
installCommandLog(arguments_);

/** The secret runtime layer, loaded late to keep sqlite out of the static graph. */
const loadSecretRuntimeLayer = () =>
  Effect.promise(() => import("../secrets/runtime-layer.ts"));

const nodeCliIo: CliIo = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

const automaticSecretFailure = (
  error: SecretTransferError,
  json: boolean,
): void => {
  const exitCode = secretExitCode(error);
  nodeCliIo.writeStderr(json
    ? `${JSON.stringify({
      schema: "canonfig.secrets/v1",
      ok: false,
      command: "secrets.sync",
      automatic: true,
      error: {
        category: error.category,
        operation: error.operation,
        message: error.message,
      },
      exitCode,
    })}\n`
    : `Secret synchronization failed: ${error.message}\n`);
  nodeCliIo.setExitCode(exitCode);
};

if (isSecretsCommand(arguments_)) {
  NodeRuntime.runMain(
    loadSecretRuntimeLayer().pipe(
      Effect.flatMap(({ secretRuntimeLayer }) =>
        runSecretsCli(arguments_.slice(1), nodeCliIo).pipe(
          Effect.provide(secretRuntimeLayer()),
        )
      ),
    ),
  );
} else if (isHarnessConfigurationCommand(arguments_)) {
  NodeRuntime.runMain(
    Effect.promise(() =>
      runHarnessConfigurationCli(arguments_.slice(1), nodeCliIo)
    ),
  );
} else if (
  isPrivateEnrollmentCommand(arguments_)
  && !arguments_.some((argument) => ["--help", "-h", "--version", "-V"].includes(argument))
) {
  NodeRuntime.runMain(
    Effect.tryPromise({
      try: async (signal) => {
        const nonSecretArguments = privateEnrollmentArguments(arguments_);
        const invitation = await readEnrollmentInput(process.stdin, { signal });
        // This in-memory argv goes through the existing invitation validation,
        // TLS pinning, enrollment, and recovery contract. process.argv is never
        // modified and no child process receives the invitation in its argv.
        return [...nonSecretArguments, invitation];
      },
      catch: (cause) => cause instanceof EnrollmentInputError
        ? cause
        : new EnrollmentInputError("Private enrollment input could not be read"),
    }).pipe(
      Effect.catch((error) => Effect.sync(() => {
        nodeCliIo.writeStderr(renderUsageFailure(
          error.message,
          arguments_.includes("--json") ? "json" : "human",
        ));
        nodeCliIo.setExitCode(CliExitCode.usageOrConfiguration);
        return undefined;
      })),
      Effect.flatMap((invocation) => {
        if (invocation === undefined) return Effect.void;
        const checked = evaluateCli(invocation);
        if (checked._tag !== "Command") {
          return Effect.sync(() => {
            nodeCliIo.writeStderr(renderUsageFailure(
              checked._tag === "InvalidInput" ? checked.message : "Invalid private enrollment command",
              arguments_.includes("--json") ? "json" : "human",
            ));
            nodeCliIo.setExitCode(CliExitCode.usageOrConfiguration);
          });
        }
        return Effect.promise(() => import("./layers.ts")).pipe(
          Effect.flatMap(({ runtimeLayer }) =>
            runCli(invocation, nodeCliIo).pipe(Effect.provide(runtimeLayer()))
          ),
          Effect.asVoid,
        );
      }),
    ),
  );
} else {
  const outcome = evaluateCli(arguments_);

  if (outcome._tag === "Command") {
    const automaticSecretSync = outcome.command._tag === "Synchronize"
      && outcome.command.mode === "apply";
    NodeRuntime.runMain(
      Effect.promise(() => import("./layers.ts")).pipe(
        Effect.flatMap(({ runtimeLayer }) =>
          runCli(arguments_, nodeCliIo).pipe(
            // Automatic shared-secret synchronization runs only after a
            // successful command. It reads runCli's exit code directly now that
            // there is one, rather than suspending to read the mutable
            // process.exitCode that runCli had just set.
            Effect.tap((exitCode) =>
              automaticSecretSync && exitCode === CliExitCode.success
                ? loadSecretRuntimeLayer().pipe(
                  Effect.flatMap(({ secretRuntimeLayer }) =>
                    synchronizeSharedSecrets().pipe(
                      Effect.provide(secretRuntimeLayer()),
                    )
                  ),
                  Effect.catch((cause) =>
                    Effect.sync(() => {
                      const error = cause instanceof SecretTransferError
                        ? cause
                        : new SecretTransferError({
                          category: "state",
                          operation: "synchronize shared secrets",
                          message: "the secret synchronization state is unavailable",
                        });
                      automaticSecretFailure(
                        error,
                        outcome.format === "json",
                      );
                    })
                  ),
                  Effect.asVoid,
                )
                : Effect.void
            ),
            // `source serve` is the one command that outlives its own effect:
            // it returns once the loopback server is listening and the process
            // must then stay up to serve. Waiting on the exit code rather than
            // on the command name keeps a failed serve from blocking forever on
            // a server that never came up.
            Effect.flatMap((exitCode) =>
              outcome.command._tag === "SourceServe"
                  && exitCode === CliExitCode.success
                ? Effect.never
                : Effect.void
            ),
            Effect.provide(runtimeLayer()),
          )
        ),
      ),
    );
  } else {
    NodeRuntime.runMain(Effect.sync(() => {
      if (outcome._tag === "Help" || outcome._tag === "Version") {
        const extraHelp = outcome._tag === "Help"
          ? `\nPrivate enrollment (bounded pipe input):\n${privateEnrollmentHelp}\n`
          : "";
        nodeCliIo.writeStdout(`${outcome.text}${extraHelp}\n`);
      } else {
        // The same renderer as the in-layer path, so a usage failure caught
        // before the runtime layer is built still honors --json.
        nodeCliIo.writeStderr(
          renderUsageFailure(outcome.message, outcome.format),
        );
      }
      nodeCliIo.setExitCode(outcome.exitCode);
    }));
  }
}
