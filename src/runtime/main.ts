#!/usr/bin/env node

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { evaluateCli, runCli, type CliIo } from "../cli/cli.ts";

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
const outcome = evaluateCli(arguments_);

if (outcome._tag === "Command") {
  NodeRuntime.runMain(
    Effect.promise(() => import("./layers.ts")).pipe(
      Effect.flatMap(({ runtimeLayer }) =>
        runCli(arguments_, nodeCliIo).pipe(
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
