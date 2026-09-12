import type { CredentialStorageCapability } from "../machine/machine-state.types.ts";
import type { ScheduleStatus } from "../schedule/schedule-manager.types.ts";
import type { DoctorProbe } from "./doctor.ts";

/** Presence is not permission: never turn an executable check into a vault test. */
export const credentialReadiness = (capability: CredentialStorageCapability): DoctorProbe => {
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
        message: "noninteractive credential storage is unavailable",
        details: { kind: capability.kind, verification: "not-verified" },
      };
  }
};

export interface ScheduleFireEvidence {
  readonly at: string;
  readonly outcome: string;
}

/**
 * A rendered definition proves intent, not execution: only recorded evidence
 * that the native scheduler actually started the job marks the schedule as
 * verified. A green renderer check alone stays at warning.
 */
export const scheduledDefinitionReadiness = (
  status: ScheduleStatus,
  lastFire?: ScheduleFireEvidence | undefined,
): DoctorProbe => {
  const details = {
    state: status.state,
    platform: status.platform,
    mechanism: status.definition.mechanism,
    definitionVerified: status.state === "current",
    scheduledExecutionVerified: status.state === "current" && lastFire !== undefined,
  };
  if (status.state !== "current") {
    return {
      name: "scheduler",
      status: "fail",
      category: "verification-or-apply-failure",
      message: `requested scheduler definition is ${status.state}`,
      details,
    };
  }
  if (lastFire === undefined) {
    return {
      name: "scheduler",
      status: "warning",
      message: "scheduler definition is current; the native scheduler has not been observed firing it yet",
      details,
    };
  }
  return {
    name: "scheduler",
    status: "pass",
    message: "scheduler definition is current and the native scheduler has fired it",
    details: {
      ...details,
      scheduledExecutionVerified: true,
      lastFiredAt: lastFire.at,
      lastFiredOutcome: lastFire.outcome,
    },
  };
