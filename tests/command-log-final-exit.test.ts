import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");
const commandLogModule = pathToFileURL(
  path.resolve(projectRoot, "src/logging/command-log.ts"),
).href;

describe("command log final-exit semantics", () => {
  it("records a later automatic-phase failure instead of an earlier success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "canonfig-final-exit-"));
    const logPath = path.join(root, "canonfig.log");
    try {
      const source = [
        `import { installCommandLog } from ${JSON.stringify(commandLogModule)};`,
        `installCommandLog(["sync", "--apply"], { environment: { CANONFIG_LOG_FILE: ${JSON.stringify(logPath)} } });`,
        "process.exitCode = 0;",
        "await new Promise((resolve) => setTimeout(resolve, 40));",
        "process.exitCode = 6;",
      ].join("\n");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", source],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: process.env,
        },
      );

      expect(result.status, result.stderr).toBe(6);
      const entries = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        // SAFETY: Every line was emitted by createCommandLog as a JSON object.
        .map((line) => JSON.parse(line) as {
          readonly event: string;
          readonly command: string;
          readonly exitCode?: number;
          readonly durationMilliseconds?: number;
        });
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({
        event: "command.completed",
        command: "sync",
        exitCode: 6,
      });
      expect(entries[1]!.durationMilliseconds).toBeGreaterThanOrEqual(30);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
