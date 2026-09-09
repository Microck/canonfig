import { Effect, Schema } from "effect";
import type { CliIo } from "../cli/cli.ts";
import { CliExitCode } from "../cli/exit-codes.ts";
import { renderCliResult, renderUsageFailure } from "../cli/render.ts";
import { normalizeInstallerMethod } from "../domain/installer-binding.ts";
import { HumanActionRequiredError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  checkInstallerBinding, listInstallerBindings, loadInstallerBinding,
  removeInstallerBinding, saveInstallerBinding,
} from "../synchronization/installer-bindings.ts";

export const installerHelp = [
  "  installer list",
  "  installer set <method> --executable <absolute-path> [--arg <absolute-entrypoint>]",
  "  installer check <method>",
  "  installer remove <method>",
].join("\n");

export const isInstallerCommand = (arguments_: ReadonlyArray<string>): boolean => arguments_[0] === "installer";

type Command = { readonly kind: "list" }
  | { readonly kind: "check" | "remove"; readonly method: string }
  | { readonly kind: "set"; readonly method: string; readonly executable: string; readonly arguments: ReadonlyArray<string> };

const parse = (arguments_: ReadonlyArray<string>): Command => {
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
  if (arguments_.some((value) => value === "--help" || value === "-h")) {
    io.writeStdout(`Installer bindings\n${installerHelp}\n`);
    io.setExitCode(CliExitCode.success);
    return;
  }
  const parsed = yield* Effect.try({ try: () => parse(arguments_), catch: (cause) => cause }).pipe(
    Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }),
  );
  if (parsed === undefined) {
    io.writeStderr(renderUsageFailure("Invalid installer command; run canonfig installer --help", format));
    io.setExitCode(CliExitCode.usageOrConfiguration);
    return;
  }
  const operation = Effect.gen(function*() {
    switch (parsed.kind) {
      case "list": return { bindings: yield* listInstallerBindings() };
      case "remove": return { removed: yield* removeInstallerBinding(parsed.method) };
      case "set": return { binding: yield* saveInstallerBinding(parsed.method, parsed.executable, parsed.arguments) };
      case "check": {
        const binding = yield* loadInstallerBinding(parsed.method);
        if (binding === undefined) return yield* new HumanActionRequiredError({
          action: "configure an installer binding", recovery: "Run installer set with the existing executable and optional JavaScript entrypoint, then retry.",
        });
        return yield* checkInstallerBinding(binding);
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
