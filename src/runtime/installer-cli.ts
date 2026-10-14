import { Effect, Schema } from "effect";
import type { CliIo } from "../cli/cli.ts";
import { CliExitCode } from "../cli/exit-codes.ts";
import { installerHelp } from "../cli/help.ts";
import { renderCliResult, renderUsageFailure } from "../cli/render.ts";
import { normalizeInstallerMethod } from "../domain/installer-binding.ts";
import { HumanActionRequiredError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  checkInstallerBinding, listInstallerBindings, loadInstallerState,
  removeInstallerBinding, saveInstallerBinding, unboundInstallerRecovery, windowsNodeBinding,
} from "../synchronization/installer-bindings.ts";

/** Help needs no machine layer, and building that layer reads the state database. */
export const installerHelpRequested = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_.some((value) => value === "--help" || value === "-h");

export const writeInstallerHelp = (io: CliIo): void => {
  io.writeStdout(`Installer bindings\n${installerHelp}\n`);
  io.setExitCode(CliExitCode.success);
};

type Command = { readonly kind: "list" }
  | { readonly kind: "check" | "remove"; readonly method: string }
  | { readonly kind: "set"; readonly method: string; readonly executable: string; readonly arguments: ReadonlyArray<string> };

/** Parse the non-secret installer command shape. Exported so documentation
 * examples are checked against the same parser the CLI runs. */
export const parseInstallerArguments = (arguments_: ReadonlyArray<string>): Command => {
  if (arguments_.filter((value) => value === "--json").length > 1) throw new Error("--json may be specified only once");
  const [action, method, ...rest] = arguments_.filter((value) => value !== "--json");
  if (action === "list" && method === undefined) return { kind: "list" };
  if (method === undefined) throw new Error("An installer method is required");
  const normalized = normalizeInstallerMethod(method);
  if ((action === "remove" || action === "check") && rest.length === 0) return { kind: action, method: normalized };
  if (action !== "set") throw new Error("Unknown installer command or extra arguments");
  let executable: string | undefined;
  const prefix: string[] = [];
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("-")) throw new Error("Installer options require an absolute path");
    if (option === "--executable" && executable === undefined) executable = value;
    else if (option === "--arg" && prefix.length === 0) prefix.push(value);
    else throw new Error("Installer set accepts one --executable and at most one --arg");
  }
  if (executable === undefined) throw new Error("Installer set requires --executable");
  return { kind: "set", method: normalized, executable, arguments: prefix };
};

export const runInstallerCli = (
  arguments_: ReadonlyArray<string>, io: CliIo,
): Effect.Effect<void, never, MachineState> => Effect.gen(function*() {
  const format = arguments_.includes("--json") ? "json" : "human";
  if (installerHelpRequested(arguments_)) {
    writeInstallerHelp(io);
    return;
  }
  const parsed = yield* Effect.try({ try: () => parseInstallerArguments(arguments_), catch: (cause) => cause }).pipe(
    Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }),
  );
  if (parsed === undefined) {
    io.writeStderr(renderUsageFailure("Invalid installer command; run canonfig installer --help", format));
    io.setExitCode(CliExitCode.usageOrConfiguration);
    return;
  }
  const operation = Effect.gen(function*() {
    switch (parsed.kind) {
      case "list": {
        const bindings = yield* listInstallerBindings();
        // An unbound npm or pnpm that PATH resolves to a Windows command shim
        // is refused at install time, so the listing names the binding to set.
        const suggestions = (yield* Effect.forEach(
          ["npm", "pnpm"].filter((method) => !bindings.some((binding) => binding.method === method)),
          (method) => Effect.map(windowsNodeBinding(method), (binding) =>
            binding === undefined ? undefined : { method, shim: binding.shim, command: binding.command }),
        )).filter((suggestion) => suggestion !== undefined);
        return suggestions.length === 0 ? { bindings } : { bindings, suggestions };
      }
      case "remove": return { removed: yield* removeInstallerBinding(parsed.method) };
      case "set": return { binding: yield* saveInstallerBinding(parsed.method, parsed.executable, parsed.arguments) };
      case "check": {
        const state = yield* loadInstallerState(parsed.method);
        if (state.status === "removed") return yield* new HumanActionRequiredError({
          action: "configure an installer binding", recovery: "The installer binding was explicitly removed; run installer set with the existing executable and optional JavaScript entrypoint, then retry.",
        });
        if (state.status !== "bound") return yield* new HumanActionRequiredError({
          action: "configure an installer binding", recovery: yield* unboundInstallerRecovery(parsed.method),
        });
        return yield* checkInstallerBinding(state.binding);
      }
    }
  });
  yield* operation.pipe(Effect.match({
    onFailure: (error) => {
      const exitCode = error instanceof HumanActionRequiredError ? CliExitCode.humanActionRequired : CliExitCode.usageOrConfiguration;
      io.writeStderr(renderCliResult({ command: `installer.${parsed.kind}`, exitCode,
        message: error instanceof HumanActionRequiredError ? error.recovery : "Installer binding operation failed; inspect local executable and Canonfig directory access." }, format));
      io.setExitCode(exitCode);
    },
    onSuccess: (data) => {
      io.writeStdout(renderCliResult({ command: `installer.${parsed.kind}`, exitCode: CliExitCode.success,
        message: `installer.${parsed.kind} completed`, data: Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(JSON.stringify(data))) }, format));
      io.setExitCode(CliExitCode.success);
    },
  }));
});
