import { fileURLToPath } from "node:url";

export interface ScheduleCommand {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
}

/**
 * The installed CLI is JavaScript, not a native executable. A native job must
 * name both Node and its entrypoint; neither npm's shim nor /usr/bin/env may
 * choose a different runtime from the scheduler's PATH.
 */
export const scheduleCommand = (executable?: string): ScheduleCommand =>
  executable === undefined
    ? {
      executable: process.execPath,
      arguments: [
        fileURLToPath(new URL("../runtime/main.js", import.meta.url)),
        "sync",
        "--apply",
        "--no-input",
      ],
    }
    : { executable, arguments: ["sync", "--apply", "--no-input"] };
