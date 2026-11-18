import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { Effect, Schema } from "effect";

import { IssueReportingPreference } from "../domain/issue-reporting.ts";
import { assertNoSymlinkPathComponents, atomicWrite } from "../skills/filesystem.ts";
import { withRunLock } from "../synchronization/run-lock.ts";

const exec = promisify(execFile);
const machineCommandOptions = { encoding: "utf8", timeout: 5000, windowsHide: true } as const;
const PreferenceRecord = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)),
  preference: IssueReportingPreference,
});
type PreferenceRecord = typeof PreferenceRecord.Type;
const decodePreference = Schema.decodeUnknownSync(Schema.fromJsonString(PreferenceRecord), {
  onExcessProperty: "error",
});

export const issueReportingPreferenceError = "Cannot access the automatic issue reporting preference. Check this machine’s identity and access to ~/.canonfig-issue-reporting/.";
export const issueReportingPreferenceBusy = "Issue reporting has another operation in progress. Retry the change in a moment.";
export const issueReportingPreferenceChanged = "The automatic reporting preference changed during opt-in. Check its status before trying again.";

async function platformMachineId(): Promise<string | undefined> {
  switch (process.platform) {
    case "linux":
      return (await readFile("/etc/machine-id", "utf8")).trim();
    case "darwin": {
      const { stdout } = await exec("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], machineCommandOptions);
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(stdout)?.[1];
    }
    case "win32": {
      const registry = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
      const { stdout } = await exec(registry, [
        "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64",
      ], machineCommandOptions);
      return /\bMachineGuid\s+REG_SZ\s+(\S+)/u.exec(stdout)?.[1];
    }
    default:
      return undefined;
  }
}

/** Hash the machine ID so it never appears in the preference or on the wire. */
export function issueReportingPath(home: string, platform: NodeJS.Platform, machineId: string): string {
  const key = createHash("sha256").update(`canonfig-issue-reporting:${platform}:${machineId.toLowerCase()}`).digest("hex");
  return join(home, ".canonfig-issue-reporting", `${key}.json`);
}

let machinePath: string | undefined;

async function preferencePath(): Promise<string> {
  if (machinePath !== undefined) return machinePath;
  const machineId = await platformMachineId();
  if (!machineId || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(machineId)) {
    throw new Error(issueReportingPreferenceError);
  }
  machinePath = issueReportingPath(homedir(), process.platform, machineId);
  return machinePath;
}

const absent: PreferenceRecord = { revision: "absent", preference: { status: "ask" } };

async function readPreference(path: string): Promise<PreferenceRecord> {
  try {
    await assertNoSymlinkPathComponents(homedir(), dirname(path));
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024
      || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))) {
      throw new Error(issueReportingPreferenceError);
    }
    return decodePreference(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return absent;
    throw error;
  }
}

export async function readIssueReportingSnapshot() {
  return readPreference(await preferencePath());
}

export async function readIssueReportingPreference(): Promise<IssueReportingPreference> {
  return (await readIssueReportingSnapshot()).preference;
}

type Enabled = Extract<IssueReportingPreference, { status: "enabled" }>;
type Disabled = Extract<IssueReportingPreference, { status: "disabled" }>;

async function withPreferenceLock<A>(operation: string, run: (path: string) => Promise<A>): Promise<A> {
  const path = await preferencePath();
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await assertNoSymlinkPathComponents(homedir(), dirname(path));
  return Effect.runPromise(withRunLock(path, operation, Effect.tryPromise(() => run(path))));
}

export function writeIssueReportingPreference(
  change: { preference: Enabled; expectedRevision: string } | { preference: Disabled },
): Promise<IssueReportingPreference | undefined> {
  return withPreferenceLock("change automatic issue reporting", async (path) => {
    if ("expectedRevision" in change && (await readPreference(path)).revision !== change.expectedRevision) return undefined;
    const record = { revision: randomUUID(), preference: change.preference };
    await atomicWrite(path, `${JSON.stringify(record)}\n`, 0o600, homedir());
    return change.preference;
  });
}

/** Start under the preference lock. The returned handle is awaited outside the lock. */
export function startApprovedIssueSubmission<A>(
  revision: string, signal: AbortSignal, start: () => Promise<A>,
): Promise<{ completion: Promise<A> } | undefined> {
  return withPreferenceLock("start an automatic issue report", async (path) => {
    const current = await readPreference(path);
    if (signal.aborted || current.revision !== revision || current.preference.status !== "enabled") return undefined;
    return { completion: start() };
  });
}
