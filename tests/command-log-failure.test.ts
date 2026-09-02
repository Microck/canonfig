import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCommandLog,
  type CommandLogFileOperations,
} from "../src/logging/command-log.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeEntrypoint = path.resolve(projectRoot, "src/runtime/main.ts");

type ThrowingOperation =
  | "ensureDirectory"
  | "ensureFile"
  | "restrictPosixAccess"
  | "append";

const throwingOperations = (
  operation: ThrowingOperation,
): CommandLogFileOperations => ({
  platform: "linux",
  ensureDirectory: () => {
    if (operation === "ensureDirectory") throw new Error("injected directory failure");
  },
  ensureFile: () => {
    if (operation === "ensureFile") throw new Error("injected file failure");
  },
  restrictWindowsAccess: () => true,
  restrictPosixAccess: () => {
    if (operation === "restrictPosixAccess") throw new Error("injected permission failure");
  },
  append: () => {
    if (operation === "append") throw new Error("injected append failure");
  },
});

describe("command logging failure isolation", () => {
  for (const operation of [
    "ensureDirectory",
    "ensureFile",
    "restrictPosixAccess",
    "append",
  ] as const) {
    it(`ignores ${operation} failures during start and completion`, () => {
      expect(() => {
        const log = createCommandLog(["status"], {
          environment: { CANONFIG_LOG_FILE: "/tmp/canonfig.log" },
          fileOperations: throwingOperations(operation),
        });
        log.complete(0);
      }).not.toThrow();
    });
  }

  it("fails closed when the Windows ACL cannot be restricted", () => {
    let appended = false;
    const operations: CommandLogFileOperations = {
      platform: "win32",
      ensureDirectory: () => undefined,
      ensureFile: () => undefined,
      restrictWindowsAccess: () => false,
      restrictPosixAccess: () => undefined,
      append: () => {
        appended = true;
      },
    };

    expect(() => {
      const log = createCommandLog(["status"], {
        environment: { CANONFIG_LOG_FILE: "C:\\canonfig.log" },
        fileOperations: operations,
      });
      log.complete(0);
    }).not.toThrow();
    expect(appended).toBe(false);
  });

  it("keeps shipped command output and exit status unchanged when logging fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "canonfig-log-failure-"));
    try {
      const packageDocument = JSON.parse(
        await readFile(path.join(projectRoot, "package.json"), "utf8"),
      ) as { readonly version: string };
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", runtimeEntrypoint, "--version"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            // An existing directory cannot be opened as the append-only log file.
            CANONFIG_LOG_FILE: root,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(packageDocument.version);
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
