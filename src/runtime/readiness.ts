import type { CredentialStorageCapability } from "../machine/machine-state.types.ts";
import type { ScheduleStatus } from "../schedule/schedule-manager.types.ts";
import type { DoctorProbe } from "./doctor.ts";

export interface CredentialAccessEvidence {
  /**
   * The enrolled follower credential was read from the native store by this
   * process, which proves read access from the current session.
   */
  readonly enrolledCredentialLoaded: boolean;
}

/** Presence is not permission: never turn an executable check into a vault test. */
export const credentialReadiness = (
  capability: CredentialStorageCapability,
  evidence: CredentialAccessEvidence = { enrolledCredentialLoaded: false },
): DoctorProbe => {
  switch (capability.kind) {
    case "secure-noninteractive":
      if (capability.verification === "session-probe") {
        return {
          name: "credentials",
          status: "pass",
          message: "native credential provider verified with a disposable write probe in this session",
          details: {
            kind: capability.kind,
            provider: capability.provider,
            verification: "session-probe",
            writeAccessVerified: true,
            unattendedAccessVerified: true,
          },
        };
      }
      if (evidence.enrolledCredentialLoaded) {
        return {
          name: "credentials",
          status: "pass",
          message: "native credential provider returned the enrolled follower credential in this session; write access is not verified",
          details: {
            kind: capability.kind,
            provider: capability.provider,
            verification: "credential-load",
            readAccessVerified: true,
            writeAccessVerified: false,
            unattendedAccessVerified: false,
          },
        };
      }
      return {
        name: "credentials",
        status: "warning",
        message: "native credential provider is present; write and unattended access are not verified",
        details: {
          kind: capability.kind,
          provider: capability.provider,
          verification: "provider-presence",
          writeAccessVerified: false,
          unattendedAccessVerified: false,
        },
      };
    case "local-file":
      return {
        name: "credentials",
        status: "warning",
        message: "credential storage uses an explicitly configured local file",
        details: { kind: capability.kind, verification: "configuration" },
      };
    case "unavailable":
      return {
        name: "credentials",
        status: "warning",
        message: `noninteractive credential storage is unavailable: ${capability.recovery}`,
        details: {
          kind: capability.kind,
          verification: "not-verified",
          recovery: capability.recovery,
        },
      };
  }
};

export interface ScheduleFireEvidence {
  readonly at: string;
  /** `started`, then `completed` or `failed`; a trailing `started` never finished. */
  readonly outcome: string;
  /** Why a `failed` run failed: its failure category and message. */
  readonly reason?: string | undefined;
}

/** The last unattended run in words, and whether it completed. */
export interface UnattendedRunSummary {
  readonly completed: boolean;
  readonly text: string;
}

/**
 * The last unattended run in words: its outcome and failure reason, and the
 * last one that completed. A failed run is not the absence of runs, and the
 * receipt used to say "no completed unattended run" after earlier successes.
 */
export const describeUnattendedRuns = (
  fires: ReadonlyArray<ScheduleFireEvidence>,
): UnattendedRunSummary => {
  const latest = fires.at(-1);
  if (latest === undefined) {
    return { completed: false, text: "the native scheduler has not been observed starting a run yet" };
  }
  if (latest.outcome === "completed") {
    return { completed: true, text: `the last unattended run completed at ${latest.at}` };
  }
  const lastCompleted = fires.filter((fire) => fire.outcome === "completed").at(-1);
  const previous = lastCompleted === undefined
    ? "no unattended run has completed yet"
    : `the last completed one was at ${lastCompleted.at}`;
  const text = latest.outcome === "failed"
    ? `the last unattended run failed at ${latest.at}: ${latest.reason ?? "no reason was recorded"}; ${previous}`
    : `an unattended run started at ${latest.at} and recorded no outcome (still running, or killed); ${previous}`;
  return { completed: false, text };
};

/** The probe details a recorded fire contributes; none without one. */
const lastFireDetails = (lastFire: ScheduleFireEvidence | undefined) => {
  const details: Record<string, string> = {};
  if (lastFire === undefined) return details;
  details.lastFiredAt = lastFire.at;
  details.lastFiredOutcome = lastFire.outcome;
  if (lastFire.reason !== undefined) details.lastFiredReason = lastFire.reason;
  return details;
};

/**
 * A rendered definition proves intent, not execution: only recorded evidence
 * that the native scheduler actually started the job marks the schedule as
 * verified. A green renderer check alone stays at warning, and so does a job
 * whose last unattended run failed or that cannot run while logged out.
 */
export const scheduledDefinitionReadiness = (
  status: ScheduleStatus,
  fires: ReadonlyArray<ScheduleFireEvidence> = [],
): DoctorProbe => {
  const lastFire = fires.at(-1);
  const nextRun: Record<string, string> = {};
  if (status.nextRun !== undefined) nextRun.nextRun = status.nextRun;
  const details = {
    state: status.state,
    platform: status.platform,
    mechanism: status.definition.mechanism,
    timezone: status.timezone,
    ...nextRun,
    definitionVerified: status.state === "current",
    scheduledExecutionVerified: status.state === "current" && lastFire !== undefined,
    ...lastFireDetails(lastFire),
  };
  if (status.state !== "current") {
    // A job rendered by another Canonfig build (an upgrade) keeps firing on
    // the same calendar until the next apply re-renders it: not a failure.
    return status.state === "drifted" && status.drift === "binding"
      ? { name: "scheduler", status: "warning", message: status.detail, details }
      : {
        name: "scheduler",
        status: "fail",
        category: "verification-or-apply-failure",
        message: `requested scheduler definition is ${status.state}: ${status.detail}`,
        details,
      };
  }
  const runs = describeUnattendedRuns(fires);
  const problems = [...(runs.completed ? [] : [runs.text]), ...status.warnings];
  return problems.length === 0
    ? {
      name: "scheduler",
      status: "pass",
      message: `scheduler definition is current and the native scheduler has fired it; ${runs.text}`,
      details,
    }
    : {
      name: "scheduler",
      status: "warning",
      message: `scheduler definition is current; ${problems.join("; ")}`,
      details,
    };
};
