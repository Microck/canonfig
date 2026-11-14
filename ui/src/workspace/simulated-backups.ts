// The demo's Backups page: made-up policies, run history and copies in the shapes /api/backup returns, so the same
// History page renders live and demo data. Changes stay in memory, like the rest of the demo.
import { useState } from "react";
import { Schema } from "effect";
import { GuiBackupStatus, type GuiBackupRequest } from "../../../src/gui/contract/backup";
import { BackupSnapshot } from "../../../src/backup/backup.types";
import type { BackupSlice } from "./workspace-types";

const READY = { loading: false, error: null };
const DAY = 86_400_000;
type Snapshot = typeof BackupSnapshot.Type;
type Status = typeof GuiBackupStatus.Type;

const base = { folder: true, include: [], exclude: [], sourceIdentity: false, sharedSecrets: false, includeCredentials: false, maximumBytes: 50 * 1024 ** 3, maximumFiles: 1_000_000 };
const POLICIES = {
  nightly: { ...base, destination: { kind: "local", path: "/mnt/backup/canonfig" }, harnesses: { mode: "managed", targets: ["codex", "claude-code", "opencode"] }, compression: "balanced",
    passwordReference: "nightly", retention: { last: 5, daily: 7, weekly: 4 }, schedule: { kind: "daily", localTime: "03:00" }, drillSchedule: { kind: "weekly", weekdays: ["Sun"], localTime: "04:00" } },
  github: { ...base, destination: { kind: "git", remote: "git@github.com:maria/canonfig-backup.git" }, harnesses: { mode: "none", targets: [] }, compression: "fast",
    retention: { last: 10, daily: 0, weekly: 0 }, schedule: { kind: "daily", localTime: "09:00" } },
  "drive-full": { ...base, destination: { kind: "rclone", remote: "gdrive:Backups/canonfig" }, harnesses: { mode: "full", targets: ["codex", "claude-code"] }, compression: "max",
    passwordReference: "drive-full", sourceIdentity: true, sharedSecrets: true, retention: { last: 3, daily: 0, weekly: 8 }, schedule: { kind: "weekly", weekdays: ["Sun"], localTime: "02:00" } },
} as const;

/** A hex id unique to (policy, index), standing in for the archive SHA-256. */
const hexId = (policy: string, index: number) => [...`${policy}:${index}`].map((character) => character.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64);

/** One copy a day for daily policies, one a week for weekly ones, counting back from when the demo opened. */
function copies(policy: string, owner: string, count: number, everyDays: number, hour: number, bytes: number, files: number, encrypted: boolean, skipFirst = false): Snapshot[] {
  const today = new Date();
  today.setHours(hour, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => index + (skipFirst ? 1 : 0)).map((index) => Schema.decodeUnknownSync(BackupSnapshot)({
    version: 1, id: hexId(policy, index), archiveSha256: hexId(policy, index), createdAt: new Date(today.getTime() - index * everyDays * DAY).toISOString(),
    policy, owner, compression: "balanced", codec: "zstd", encrypted, parts: [{ sha256: hexId(policy, index), bytes: bytes - index * 61_000 }],
    bytes: bytes - index * 61_000, files: files - index * 3,
  }));
}

function seed(role: "source" | "follower", owner: string) {
  const now = new Date();
  const at = (hour: number, daysAgo = 0) => { const date = new Date(now.getTime() - daysAgo * DAY); date.setHours(hour, 0, 0, 0); return date.toISOString(); };
  const lastSunday = (now.getDay() + 7) % 7 || 7;
  // On a Follower, "nightly" comes from the Source and "laptop-extra" is this machine's own.
  const local = role === "source" ? POLICIES : { "laptop-extra": { ...POLICIES.github, destination: { kind: "local", path: "/Users/maria/Backups/canonfig" } } };
  const declared = role === "source" ? {} : { nightly: POLICIES.nightly };
  const status: Status = Schema.decodeUnknownSync(GuiBackupStatus)({
    local: { version: 1, policies: local, passwords: { nightly: "canonfig-backup-demo-1", "drive-full": "canonfig-backup-demo-2" }, disabled: [], allowCredentials: role === "source" ? ["drive-full"] : [] },
    declared, policies: { ...declared, ...local },
    runs: {
      nightly: { run: { at: at(3), ok: true, bytes: 49_758_568, files: 11_288 }, drill: { at: at(4, lastSunday), ok: true, files: 11_270 } },
      github: { run: { at: at(9), ok: true, bytes: 523_044, files: 182 } },
      "laptop-extra": { run: { at: at(9), ok: true, bytes: 523_044, files: 182 } },
      "drive-full": { run: { at: at(2, lastSunday), ok: false, message: "rclone could not reach gdrive: its sign-in expired. Run rclone config reconnect gdrive:, then back up again." } },
    },
    schedules: [],
  });
  const snapshots: Record<string, Snapshot[]> = {
    nightly: copies("nightly", owner, 14, 1, 3, 49_758_568, 11_288, true),
    github: copies("github", owner, 8, 1, 9, 523_044, 182, false),
    "laptop-extra": copies("laptop-extra", owner, 6, 1, 9, 523_044, 182, false),
    // The newest Sunday run failed, so the copies start a week earlier.
    "drive-full": copies("drive-full", owner, 3, 7, 2, 4_210_000_000, 249_421, true, true),
  };
  return { status, snapshots };
}

/** Each request makes the change `canonfig backup` would, after a short wait for the slower ones. */
export function useSimulatedBackups(role: "source" | "follower", owner: string): BackupSlice {
  const [state, setState] = useState(() => seed(role, owner));
  const [action, setAction] = useState<BackupSlice["action"]>(READY);
  const [listing, setListing] = useState<BackupSlice["listing"]>(null);
  const update = (change: (status: Status, snapshots: Record<string, Snapshot[]>) => { status: Status; snapshots?: Record<string, Snapshot[]> }) =>
    setState((previous) => { const next = change(previous.status, previous.snapshots); return { status: next.status, snapshots: next.snapshots ?? previous.snapshots }; });
  const withRuns = (status: Status, name: string, kind: "run" | "drill", outcome: Status["runs"][string]["run"]) =>
    ({ ...status, runs: { ...status.runs, [name]: { ...status.runs[name], [kind]: outcome } } });

  const run = async (request: GuiBackupRequest): Promise<boolean> => {
    const slow = request.action === "run" || request.action === "drill" || request.action === "restore" || request.action === "list" || request.action === "owners";
    setAction({ loading: true, error: null });
    if (slow) await new Promise((resolve) => window.setTimeout(resolve, request.action === "list" ? 300 : 1200));
    const at = new Date().toISOString();
    switch (request.action) {
      case "configure": update((status) => {
        const policies = { ...status.local.policies, [request.name]: request.policy };
        const allowCredentials = request.allowCredentials ? [...new Set([...status.local.allowCredentials, request.name])] : status.local.allowCredentials;
        return { status: { ...status, local: { ...status.local, policies, allowCredentials }, policies: { ...status.declared, ...policies } } };
      }); break;
      case "password": update((status) => ({ status: Schema.decodeUnknownSync(GuiBackupStatus)({ ...status, local: { ...status.local, passwords: { ...status.local.passwords, [request.name]: `canonfig-backup-demo-${request.name}` } } }) })); break;
      case "enable": case "disable": update((status) => ({ status: { ...status, local: { ...status.local, disabled: request.action === "disable" ? [...status.local.disabled, request.name] : status.local.disabled.filter((name) => name !== request.name) } } })); break;
      case "allow-credentials": case "deny-credentials": update((status) => ({ status: { ...status, local: { ...status.local, allowCredentials: request.action === "allow-credentials" ? [...status.local.allowCredentials, request.name] : status.local.allowCredentials.filter((name) => name !== request.name) } } })); break;
      case "run": {
        // A run succeeds in the demo except the expired cloud sign-in, which fails the same way again.
        if (request.name === "drive-full") { update((status) => ({ status: withRuns(status, request.name, "run", { ...status.runs[request.name]!.run!, at }) })); break; }
        const previous = state.snapshots[request.name] ?? [];
        const latest = previous[0];
        const copy = Schema.decodeUnknownSync(BackupSnapshot)({ ...(latest ?? copies(request.name, owner, 1, 1, new Date().getHours(), 1_812_480, 182, false)[0]), id: hexId(request.name, Date.now()), archiveSha256: hexId(request.name, Date.now()), createdAt: at });
        update((status, snapshots) => ({ status: withRuns(status, request.name, "run", { at, ok: true, bytes: copy.bytes, files: copy.files }), snapshots: { ...snapshots, [request.name]: [copy, ...previous] } }));
        if (listing?.name === request.name && listing.owner === undefined) setListing({ name: request.name, value: { owner, snapshots: [copy, ...previous] } });
        break;
      }
      case "drill": update((status) => ({ status: withRuns(status, request.name, "drill", { at, ok: true, files: state.snapshots[request.name]?.[0]?.files ?? 0 }) })); break;
      case "list": setListing({ name: request.name, owner: request.owner, value: { owner: request.owner ?? owner, snapshots: request.owner === undefined || request.owner === owner ? state.snapshots[request.name] ?? [] : [] } }); break;
      default: break;
    }
    setAction(READY);
    return true;
  };
  return { status: state.status, state: READY, action, listing, report: null, run };
}

