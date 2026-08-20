export const CliExitCode = {
  success: 0,
  internal: 1,
  usageOrConfiguration: 2,
  humanActionRequired: 3,
  conflictOrDrift: 4,
  authenticationOrRevocation: 5,
  transport: 6,
  verificationOrApplyFailure: 7,
} as const;

export type CliExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];

export type CliFailureCategory =
  | "usage-or-configuration"
  | "human-action-required"
  | "conflict-or-drift"
  | "authentication-or-revocation"
  | "transport"
  | "verification-or-apply-failure"
  | "internal";

export const exitCodeForFailure = (
  category: CliFailureCategory,
): CliExitCode => {
  switch (category) {
    case "usage-or-configuration":
      return CliExitCode.usageOrConfiguration;
    case "human-action-required":
      return CliExitCode.humanActionRequired;
    case "conflict-or-drift":
      return CliExitCode.conflictOrDrift;
    case "authentication-or-revocation":
      return CliExitCode.authenticationOrRevocation;
    case "transport":
      return CliExitCode.transport;
    case "verification-or-apply-failure":
      return CliExitCode.verificationOrApplyFailure;
    case "internal":
      return CliExitCode.internal;
  }
};
