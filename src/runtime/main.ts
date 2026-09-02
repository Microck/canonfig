#!/usr/bin/env node

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { evaluateCli, runCli, type CliIo } from "../cli/cli.ts";
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
import { secretRuntimeLayer } from "../secrets/runtime-layer.ts";
import { SecretTransferError } from "../secrets/secret-store.ts";

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
installCommandLog(arguments_);
const outcome = evaluateCli(arguments_);
const json = arguments_.includes("--json");
const commandArguments = arguments_.filter((argument) => argument !== "--json");
const routedArguments = json
  ? [...commandArguments, "--json"]
  : commandArguments;

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

const renderNonCommandOutcome = (): void => {
  if (outcome._tag === "Help" || outcome._tag === "Version") {
    nodeCliIo.writeStdout(`${outcome.text}\n`);
  } else if (outcome._tag === "Invalid") {
    nodeCliIo.writeStderr(`${outcome.message}\n`);
  }
  nodeCliIo.setExitCode(outcome.exitCode);
};

if (outcome._tag === "Help" || outcome._tag === "Version") {
  NodeRuntime.runMain(Effect.sync(renderNonCommandOutcome));
} else if (isSecretsCommand(routedArguments)) {
  NodeRuntime.runMain(
    runSecretsCli(routedArguments.slice(1), nodeCliIo).pipe(
      Effect.provide(secretRuntimeLayer()),
    ),
  );
} else if (isHarnessConfigurationCommand(routedArguments)) {
  NodeRuntime.runMain(
    Effect.promise(() =>
      runHarnessConfigurationCli(routedArguments.slice(1), nodeCliIo)
    ),
  );
} else if (outcome._tag === "Command") {
  const automaticSecretSync = outcome.command._tag === "Synchronize"
    && outcome.command.mode === "apply";
  NodeRuntime.runMain(
    Effect.promise(() => import("./layers.ts")).pipe(
      Effect.flatMap(({ runtimeLayer }) =>
        runCli(arguments_, nodeCliIo).pipe(
          Effect.andThen(
            automaticSecretSync
              ? Effect.suspend(() =>
                (process.exitCode ?? 0) === 0
                  ? synchronizeSharedSecrets().pipe(
                    Effect.provide(secretRuntimeLayer()),
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
              )
              : Effect.void,
          ),
          Effect.andThen(
            outcome.command._tag === "SourceServe"
              ? Effect.never
              : Effect.void,
          ),
          Effect.provide(runtimeLayer()),
        )
      ),
    ),
  );
} else {
  NodeRuntime.runMain(Effect.sync(renderNonCommandOutcome));
}
