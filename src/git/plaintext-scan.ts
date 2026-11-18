import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";
import { localGitEnvironment } from "./git-transport.ts";
import { probeBackupTool, runBackupTool } from "./tool-process.ts";

export const findGitleaks = Effect.gen(function*() {
  const machine = yield* MachineState;
  return (yield* machine.findExecutable({ name: "gitleaks" })).path.absolute;
});

type ScanTarget =
  | { readonly kind: "dir"; readonly directory: string }
  | { readonly kind: "git"; readonly repository: string; readonly tip: string };

const Findings = Schema.Array(Schema.Struct({ RuleID: Schema.String }));

/** Neither authored configuration nor inline allow comments can suppress a finding. */
export const scanPlaintextGit = async (input: {
  readonly executable: string; readonly scratch: string; readonly signal: AbortSignal; readonly target: ScanTarget;
}): Promise<string | undefined> => {
  const { scratch, signal, executable, target } = input;
  const config = join(scratch, "gitleaks.toml");
  const ignore = join(scratch, "gitleaks.ignore");
  await writeFile(config, "[extend]\nuseDefault = true\n", { flag: "wx", mode: 0o600 });
  await writeFile(ignore, "", { flag: "wx", mode: 0o600 });
  const environment = Object.fromEntries(Object.entries(localGitEnvironment()).filter(([name]) => !/^GITLEAKS_/iu.test(name)));
  const options = ["--config", config, "--gitleaks-ignore-path", ignore, "--ignore-gitleaks-allow",
    "--redact=100", "--no-banner", "--no-color", "--max-decode-depth", "3"];
  if (target.kind === "dir") {
    await runBackupTool(executable, ["dir", target.directory, ...options], { cwd: scratch, signal, environment });
    return undefined;
  }
  // Scan the whole ancestry, including secrets removed by a later commit in the backlog.
  const report = join(scratch, "findings.json");
  const scanned = await probeBackupTool(executable, [
    "git", ...options, "--exit-code=42", "--report-format=json", "--report-path", report,
    `--log-opts=--root --full-history --no-ext-diff --no-textconv --no-renames --text --no-color ${target.tip} --`,
    target.repository,
  ], { cwd: scratch, signal, environment, timeoutMilliseconds: 120_000 });
  if (scanned.ok) return undefined;
  if (scanned.code !== 42 || (await stat(report)).size > 16 * 1024 * 1024) return "gitleaks could not complete the scan";
  const findings = Schema.decodeUnknownSync(Findings)(JSON.parse(await readFile(report, "utf8")));
  const rules = [...new Set(findings.map(({ RuleID }) => RuleID).filter(id => /^[a-z0-9-]{1,80}$/u.test(id)))];
  return `gitleaks found ${findings.length} potential secrets${rules.length === 0 ? "" : ` (${rules.sort().join(", ")})`}`;
};
