import type { CredentialStorageCapability } from "../machine/machine-state.types.ts";
import type { ScheduleStatus } from "../schedule/schedule-manager.types.ts";
import type { DoctorProbe } from "./doctor.ts";

/** Presence is not permission: never turn an executable check into a vault test. */
export const credentialReadiness = (capability: CredentialStorageCapability): DoctorProbe => {
  switch (capability.kind) {
    case "secure-noninteractive":
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
        details: { kind: capability.kind, verification: "provider-presence" },
      };
  }
};

/** A requested job must exist and match; even then its execution is unproven. */
export const scheduledDefinitionReadiness = (status: ScheduleStatus): DoctorProbe => ({
  name: "scheduler",
  status: status.state === "current" ? "pass" : "fail",
  ...(status.state === "current" ? {} : { category: "verification-or-apply-failure" as const }),
  message: status.state === "current"
    ? "scheduler definition is current; scheduled execution is not verified"
    : `requested scheduler definition is ${status.state}`,
  details: {
    state: status.state,
    platform: status.platform,
    mechanism: status.definition.mechanism,
    definitionVerified: status.state === "current",
    scheduledExecutionVerified: false,
  },
});
