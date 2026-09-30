#!/usr/bin/env node

import type * as EffectModule from "effect";

import type { CliIo } from "../cli/cli.ts";
import { CliExitCode } from "../cli/exit-codes.ts";
import { helpOrVersion } from "../cli/help.ts";
import { installCommandLog, observedSignalExitCode } from "../logging/command-log.ts";
import { minimumSupportedNodeMajor, nodeRuntimeIsSupported } from "./build-identity.ts";
import {
  installerArguments,
  isHarnessConfigurationCommand,
  isInstallerCommand,
  isSecretsCommand,
} from "./command-routing.ts";
import {
  EnrollmentInputError,
  isPrivateEnrollmentCommand,
  isPublicEnrollmentCommand,
  privateEnrollmentArguments,
  readEnrollmentInput,
} from "./enrollment-input.ts";

/**
 * Silences the `node:sqlite` experimental warning.
 *
 * This only works because nothing in this module's static import graph reaches
 * `@canonfig/effect-sql-sqlite-node`. Node emits that warning while it translates the
 * module, which happens before any module body runs, so a warning filter
 * cannot suppress a statically imported sqlite. Every command graph is
 * therefore loaded with a dynamic import, which happens after this filter is
 * installed.
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

/**
 * Until runMain hands SIGINT and SIGTERM to the Effect runtime, a signal exits
 * with its conventional status (130/143); the command log's exit listener
 * records that same status. Without this, a signal that arrived while a command
 * graph was still being imported either killed the process before the command
 * log listened, or was re-raised by the command log's handler with nothing
 * left to catch it: either way the process died by the signal instead of
 * exiting 143. Registered before the command log so its listener runs first.
 */
const exitBeforeRuntime = (signal: NodeJS.Signals): void => {
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.on("SIGINT", exitBeforeRuntime);
process.on("SIGTERM", exitBeforeRuntime);

const arguments_ = process.argv.slice(2);
// Capture only the original non-secret command line, before reading stdin.
installCommandLog(arguments_);

const nodeCliIo: CliIo = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

const format = arguments_.includes("--json") ? "json" : "human";

/**
 * Runs one program under the Effect runtime, which is loaded only here.
 *
 * Every module below Effect is imported dynamically on purpose, not by
 * accident: starting the CLI used to cost about 200 ms before any command
 * ran, most of it compiling Effect and every command graph that this module
 * imported statically. Help and `--version` now load neither, and each
 * command loads only its own graph.
 *
 * NodeRuntime.runMain turns SIGINT and SIGTERM into an interrupt, which the
 * default teardown reports as 130. The command log has already recorded the
 * signal's own status (143 for SIGTERM), so a signalled command exits with it.
 */
const runMain = async (
  program: (effect: typeof EffectModule) => EffectModule.Effect.Effect<unknown, unknown>,
): Promise<void> => {
  const [effect, NodeRuntime] = await Promise.all([
    import("effect"),
    // Imported under canonfig's own npm alias: an in-place upgrade over an
    // older tree kept stale top-level Effect packages that resolved a
    // different `effect`, and a fresh install name is the one npm always
    // re-places.
    import("@canonfig/effect-platform-node-shared/NodeRuntime"),
  ]);
  const teardown: EffectModule.Runtime.Teardown = (exit, onExit) =>
    effect.Runtime.defaultTeardown(exit, (code) => onExit(observedSignalExitCode() ?? code));
  process.removeListener("SIGINT", exitBeforeRuntime);
  process.removeListener("SIGTERM", exitBeforeRuntime);
  NodeRuntime.runMain(program(effect), { teardown });
};

const writeUsageFailure = async (message: string): Promise<void> => {
  const { renderUsageFailure } = await import("../cli/render.ts");
  nodeCliIo.writeStderr(renderUsageFailure(message, format));
  nodeCliIo.setExitCode(CliExitCode.usageOrConfiguration);
};

/** Shared-secret synchronization after a successful apply; a failure is reported on its own. */
const synchronizeSecretsAfterApply = ({ Effect }: typeof EffectModule) =>
  Effect.promise(() => Promise.all([
    import("../secrets/runtime-layer.ts"),
    import("../secrets/secret-client.ts"),
    import("../secrets/secret-store.ts"),
    import("../secrets/cli.ts"),
  ])).pipe(
    Effect.flatMap(([
      { secretRuntimeLayer },
      { synchronizeSharedSecrets },
      { SecretTransferError },
      { secretExitCode },
    ]) =>
      synchronizeSharedSecrets().pipe(
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
            const exitCode = secretExitCode(error);
            nodeCliIo.writeStderr(format === "json"
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
          })
        ),
      )
    ),
    Effect.asVoid,
  );

// Help and --version are answered here, before any command graph loads. The
// groups with their own dispatchers answer their own help, and a positional
// invitation is refused below even when --help accompanies it.
const early = isSecretsCommand(arguments_)
    || isHarnessConfigurationCommand(arguments_)
    || isInstallerCommand(arguments_)
    || isPublicEnrollmentCommand(arguments_)
  ? undefined
  : helpOrVersion(arguments_);

if (early !== undefined) {
  // Help lists every command group, including the private enrollment pipe and
  // installer bindings, so nothing is appended here.
  nodeCliIo.writeStdout(`${early.text}\n`);
  nodeCliIo.setExitCode(early.exitCode);
} else if (
  !nodeRuntimeIsSupported(process.versions.node)
  && !arguments_.includes("--help")
  && !arguments_.includes("-h")
  && !(isSecretsCommand(arguments_) && arguments_.length === 1)
  && !isPublicEnrollmentCommand(arguments_)
) {
  // A layer import can require node:sqlite before setup's preflight runs.
  // Reject the runtime before any command graph or credential input loads.
  const { renderCliResult } = await import("../cli/render.ts");
  nodeCliIo.writeStderr(renderCliResult({
    command: "runtime",
    message: `Node.js ${process.versions.node} is unsupported; Canonfig requires Node.js ${minimumSupportedNodeMajor} or newer. Install a supported Node.js runtime, then retry.`,
    exitCode: CliExitCode.humanActionRequired,
  }, format));
  nodeCliIo.setExitCode(CliExitCode.humanActionRequired);
} else if (isSecretsCommand(arguments_)) {
  const secrets = await import("../secrets/cli.ts");
  if (secrets.secretsHelpRequested(arguments_.slice(1))) {
    // Help reads no state: answer it without opening state.sqlite.
    secrets.writeSecretsHelp(arguments_.slice(1), nodeCliIo);
  } else {
    // The secret runtime layer is loaded late to keep sqlite out of the
    // static graph.
    const { secretRuntimeLayer } = await import("../secrets/runtime-layer.ts");
    await runMain((effect) =>
      secrets.runSecretsCli(arguments_.slice(1), nodeCliIo).pipe(
        effect.Effect.provide(secretRuntimeLayer()),
      )
    );
  }
} else if (isHarnessConfigurationCommand(arguments_)) {
  const { runHarnessConfigurationCli } = await import("../harness-configuration/cli.ts");
  await runMain((effect) =>
    effect.Effect.promise(() => runHarnessConfigurationCli(arguments_.slice(1), nodeCliIo))
  );
} else if (isInstallerCommand(arguments_)) {
  const installer = await import("./installer-cli.ts");
  const installerArgv = installerArguments(arguments_);
  if (installer.installerHelpRequested(installerArgv)) {
    // Building the machine layer reads the enrolled credential policy from
    // state.sqlite, and help needs neither.
    installer.writeInstallerHelp(nodeCliIo);
  } else {
    const { runtimeMachineLayer } = await import("./layers.ts");
    await runMain((effect) =>
      installer.runInstallerCli(installerArgv, nodeCliIo).pipe(
        effect.Effect.provide(runtimeMachineLayer()),
      )
    );
  }
// Exposure refusal precedes private dispatch: a positional token is already
// exposed through argv even when `--stdin` or `--help` accompany it.
} else if (isPublicEnrollmentCommand(arguments_)) {
  // The invitation is a single-use secret: refuse it as an argument, where
  // the process listing and shell history would expose it to other local
  // users. The exposed envelope must not be reused over the pipe either: a
  // local observer may have copied it and could win the single-use race.
  await writeUsageFailure(
    "follower enroll no longer accepts the invitation as an argument; treat this envelope as exposed, discard it, issue a fresh invitation, and enroll over the pipe: cat ./canonfig-invite | canonfig follower enroll --stdin --name <name> --profile <id>",
  );
} else if (isPrivateEnrollmentCommand(arguments_)) {
  const [{ evaluateCli, runCli }, { renderUsageFailure }] = await Promise.all([
    import("../cli/cli.ts"),
    import("../cli/render.ts"),
  ]);
  await runMain(({ Effect }) =>
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
        nodeCliIo.writeStderr(renderUsageFailure(error.message, format));
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
              format,
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
    )
  );
} else {
  const { evaluateCli, runCli } = await import("../cli/cli.ts");
  const outcome = evaluateCli(arguments_);

  if (outcome._tag === "Command") {
    const automaticSecretSync = outcome.command._tag === "Synchronize"
      && outcome.command.mode === "apply";
    await runMain((effect) =>
      effect.Effect.promise(() => import("./layers.ts")).pipe(
        effect.Effect.flatMap(({ runtimeLayer }) =>
          runCli(arguments_, nodeCliIo).pipe(
            // Automatic shared-secret synchronization runs only after a
            // successful command. It reads runCli's exit code directly now that
            // there is one, rather than suspending to read the mutable
            // process.exitCode that runCli had just set.
            effect.Effect.tap((exitCode) =>
              automaticSecretSync && exitCode === CliExitCode.success
                ? synchronizeSecretsAfterApply(effect)
                : effect.Effect.void
            ),
            // `source serve` is the one command that outlives its own effect:
            // it returns once the loopback server is listening and the process
            // must then stay up to serve. Waiting on the exit code rather than
            // on the command name keeps a failed serve from blocking forever on
            // a server that never came up.
            effect.Effect.flatMap((exitCode) =>
              outcome.command._tag === "SourceServe"
                  && exitCode === CliExitCode.success
                ? effect.Effect.never
                : effect.Effect.void
            ),
            effect.Effect.provide(runtimeLayer()),
          )
        ),
      )
    );
  } else if (outcome._tag === "InvalidInput") {
    // The same renderer as the in-layer path, so a usage failure caught
    // before the runtime layer is built still honors --json.
    await writeUsageFailure(outcome.message);
  } else {
    // `early` already answered help and --version for these arguments.
    nodeCliIo.writeStdout(`${outcome.text}\n`);
    nodeCliIo.setExitCode(outcome.exitCode);
  }
}
