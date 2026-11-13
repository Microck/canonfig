import { randomUUID } from "node:crypto";

import { Effect, Redacted } from "effect";

import { credentialFailureDetail } from "../machine/machine-state.errors.ts";
import type { MachineState } from "../machine/machine-state.service.ts";
import type { CredentialStorageCapability } from "../machine/machine-state.types.ts";
import type { ScheduleStatus } from "../schedule/schedule-manager.types.ts";
import type { DoctorProbe } from "./doctor.ts";

const credentialProbeValue = "canonfig credential storage probe";

/**
 * Store, read back, and delete a fixed non-secret value under a unique name,
 * through the same MachineState calls that store real keys and credentials.
 * The item is removed whatever happens after it was stored; no existing
 * credential is read or touched. Fails with the reason access is not proven.
 * Setup runs it before creating a Source, and doctor runs it whenever the
 * provider is merely present (Secret Service, Credential Manager).
 */
export const proveCredentialStorage = (
  machine: MachineState["Service"],
): Effect.Effect<void, string> =>
  Effect.acquireUseRelease(
    machine.storeCredential({
      name: `canonfig-probe:${randomUUID()}`,
      value: Redacted.make(credentialProbeValue),
    }).pipe(Effect.mapError((cause) => `store: ${credentialFailureDetail(cause)}`)),
    (reference) =>
      machine.loadCredential({ reference }).pipe(
        Effect.mapError((cause) => `read-back: ${credentialFailureDetail(cause)}`),
        Effect.flatMap((loaded) =>
          Redacted.value(loaded) === credentialProbeValue
            ? Effect.void
            : Effect.fail("read-back: the provider returned different bytes than were stored")
        ),
      ),
    (reference) => machine.removeCredential(reference).pipe(Effect.ignore),
  );

/**
 * Presence is not permission: a provider that is only present passes once a
 * disposable write in this session proved it (`session-probe`). The caller
 * runs `proveCredentialStorage` and passes its failure as `probeFailure`.
 */
export const credentialReadiness = (
  capability: CredentialStorageCapability,
  probeFailure?: string,
): DoctorProbe => {
  switch (capability.kind) {
    case "secure-noninteractive": {
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
      // One readable sentence with what to do; the provider's raw error goes to `details.reason`.
      const recovery = "Canonfig could not save a test value in this machine's credential store. Start and unlock "
        + "this user's keyring, then run the checks again.";
      return {
        name: "credentials",
        status: "warning",
        message: recovery,
        details: {
          kind: capability.kind,
          provider: capability.provider,
          verification: "session-probe-failed",
          writeAccessVerified: false,
          unattendedAccessVerified: false,
          reason: probeFailure ?? "the test write was not attempted",
          recovery,
        },
      };
    }
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
        // The probe name already says this is credential storage; the recovery says what is missing and what to do.
        message: capability.recovery,
        details: {
          kind: capability.kind,
          verification: "not-verified",
          recovery: capability.recovery,
        },
      };
  }
};

export interface ScheduleFireEvidence {
  readonly generation?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly at: string;
  /** `started`, then `completed` or `failed`; a trailing `started` never finished. */
  readonly outcome: string;
  /** Why a `failed` run failed: its failure category and message. */
  readonly reason?: string | undefined;
}

/** Historical or unbound receipts cannot prove that this installation fired. */
export const currentScheduleFires = (
  status: Pick<ScheduleStatus, "generation" | "installedAt">,
  fires: ReadonlyArray<ScheduleFireEvidence>,
): ReadonlyArray<ScheduleFireEvidence> => {
  if (status.generation === undefined || status.installedAt === undefined) return [];
  const installedAt = Date.parse(status.installedAt);
  if (!Number.isFinite(installedAt)) return [];
  return fires.filter((fire) => fire.generation === status.generation && fire.startedAt !== undefined
    && Date.parse(fire.startedAt) > installedAt).sort((left, right) =>
      (left.startedAt ?? left.at).localeCompare(right.startedAt ?? right.at));
};

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
  const ordered = [...fires].sort((left, right) =>
    (left.startedAt ?? left.at).localeCompare(right.startedAt ?? right.at));
  const latest = ordered.at(-1);
  if (latest === undefined) {
    return { completed: false, text: "the native scheduler has not been observed starting a run yet" };
  }
  if (latest.outcome === "completed") {
    return { completed: true, text: `the last unattended run completed at ${latest.at}` };
  }
  const lastCompleted = ordered.filter((fire) => fire.outcome === "completed").at(-1);
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
  const matchingFires = currentScheduleFires(status, fires);
  const lastFire = matchingFires.at(-1);
  const nextRun: Record<string, string> = {};
  if (status.nextRun !== undefined) nextRun.nextRun = status.nextRun;
  const details = {
    state: status.state,
    platform: status.platform,
    mechanism: status.definition.mechanism,
    timezone: status.timezone,
    ...nextRun,
    definitionVerified: status.state === "current" && status.bindingUsable === true,
    bindingUsable: status.bindingUsable ?? "unverified",
    scheduledExecutionVerified: status.state === "current" && status.bindingUsable === true && lastFire !== undefined,
    ...lastFireDetails(lastFire),
  };
  if (status.state !== "current" || status.bindingUsable === false) {
    // Binding-only drift is advisory only after checking the installed files.
    // A deleted runtime cannot launch a scheduled run to repair itself.
    return status.state === "drifted" && status.drift === "binding" && status.bindingUsable === true
      ? { name: "scheduler", status: "warning", message: status.detail, details }
      : {
        name: "scheduler",
        status: "fail",
        category: "verification-or-apply-failure",
        message: status.bindingUsable === false
          ? `installed scheduler runtime or entrypoint is unavailable: ${status.detail}`
          : `requested scheduler definition is ${status.state}: ${status.detail}`,
        details,
      };
  }
  if (status.bindingUsable === undefined) return {
    name: "scheduler", status: "warning",
    message: `scheduler binding remains unverified: ${[status.detail, ...status.warnings].join("; ")}`,
    details,
  };
  const runs = describeUnattendedRuns(matchingFires);
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
