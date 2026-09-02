import { describe, expect, it } from "vitest";

import {
  createCommandLog,
  type CommandLogFileOperations,
} from "../src/logging/command-log.ts";

const loggedCommand = (arguments_: ReadonlyArray<string>): string => {
  const commands: string[] = [];
  const operations: CommandLogFileOperations = {
    platform: "linux",
    ensureDirectory: () => undefined,
    ensureFile: () => undefined,
    restrictWindowsAccess: () => true,
    restrictPosixAccess: () => undefined,
    append: (_path, content) => {
      // SAFETY: The capture receives only command-log JSON object entries.
      const entry = JSON.parse(content) as { readonly command: string };
      commands.push(entry.command);
    },
  };
  const log = createCommandLog(arguments_, {
    environment: { CANONFIG_LOG_FILE: "/tmp/canonfig.log" },
    fileOperations: operations,
  });
  log.complete(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  return commands[0]!;
};

describe("command log help normalization", () => {
  it.each([
    [["harness"], "harness.help"],
    [["harness", "help"], "harness.help"],
    [["harness", "--json"], "harness.help"],
    [["secrets"], "secrets.help"],
    [["secrets", "help"], "secrets.help"],
    [["secrets", "--help"], "help"],
    [["harness", "--help"], "help"],
    [["secrets", "--version"], "version"],
    [["harness", "--version"], "version"],
    [["source", "--help"], "help"],
    [["follower", "enroll", "-h"], "help"],
    [["--json", "--help"], "help"],
    [["--json", "harness", "--help"], "help"],
    [["--json", "secrets", "--version"], "version"],
    [["--json", "source", "init"], "source.init"],
    [["source", "init", "--version"], "version"],
  ] as const)("normalizes %j as %s", (arguments_, expected) => {
    expect(loggedCommand(arguments_)).toBe(expected);
  });
});
