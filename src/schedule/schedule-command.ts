import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ScheduleCommand {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
}

const cellarRuntime = /^(?<prefix>.*)\/Cellar\/(?<formula>[^/]+)\/[^/]+\/(?<rest>.+)$/u;

/**
 * The Node binary a native job should name so it survives a runtime upgrade.
 *
 * `process.execPath` is the resolved binary, which under Homebrew is the
 * versioned `…/Cellar/node@24/24.16.0/bin/node`: `brew upgrade` deletes that
 * directory and every scheduled run would fail to start. Homebrew keeps a
 * stable `…/opt/<formula>` symlink to the current keg; it is used when it
 * resolves to the running binary right now, and the running path otherwise.
 */
export const stableRuntimeExecutable = (
  executable: string = process.execPath,
  resolve: (path: string) => string = realpathSync,
): string => {
  const cellar = cellarRuntime.exec(executable)?.groups;
  if (cellar === undefined) return executable;
  const stable = `${cellar.prefix}/opt/${cellar.formula}/${cellar.rest}`;
  try {
    return resolve(stable) === resolve(executable) ? stable : executable;
  } catch {
    return executable;
  }
};

/**
 * The installed CLI is JavaScript, not a native executable. A native job must
 * name both Node and its entrypoint; neither npm's shim nor /usr/bin/env may
 * choose a different runtime from the scheduler's PATH.
 */
export const scheduleCommand = (executable?: string): ScheduleCommand => {
  // --scheduled keys the fire evidence: only the rendered native job passes
  // it, so a manual --no-input cannot fabricate a scheduler fire.
  const arguments_ = ["sync", "--apply", "--no-input", "--scheduled"];
  return executable === undefined
    ? {
      executable: stableRuntimeExecutable(),
      arguments: [
        fileURLToPath(new URL("../runtime/main.js", import.meta.url)),
        ...arguments_,
      ],
    }
    : { executable, arguments: arguments_ };
};
