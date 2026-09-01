#!/usr/bin/env node

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { evaluateCli, runCli, type CliIo } from "../cli/cli.ts";
import {
  isHarnessConfigurationCommand,
  runHarnessConfigurationCli,
} from "../harness-configuration/cli.ts";
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

const nodeCliIo: CliIo = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

const arguments_ = process.argv.slice(2);

if (isSecretsCommand(arguments_)) {
  NodeRuntime.runMain(
    runSecretsCli(arguments_.slice(1), nodeCliIo).pipe(
      Effect.provide(secretRuntimeLayer()),
    ),
  );
} else if (isHarnessConfigurationCommand(arguments_)) {
  NodeRuntime.runMain(
    Effect.promise(() =>
      runHarnessConfigurationCli(arguments_.slice(1), nodeCliIo)
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
                          nodeCliIo.writeStderr(
                            `Secret synchronization failed: ${error.message}\n`,
                          );
                          nodeCliIo.setExitCode(secretExitCode(error));
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
    NodeRuntime.runMain(Effect.sync(() => {
      if (outcome._tag === "Help" || outcome._tag === "Version") {
        nodeCliIo.writeStdout(`${outcome.text}\n`);
      } else {
        nodeCliIo.writeStderr(`${outcome.message}\n`);
      }
      nodeCliIo.setExitCode(outcome.exitCode);
    }));
  }
}
