import type { ProfileChangeProposal, ProfileResourceInput } from "../domain/profile.ts";
import type {
  AgentTask,
  ExecutableAuthorization,
} from "../domain/synchronization.ts";
import type { DiscoveryEvidenceRecord } from "../domain/profile.ts";

export type AgentPolicy =
  | "deterministic-only"
  | "agent-propose"
  | "agent-apply";

export type SupportedHarness = "codex" | "claude" | "gemini";

export interface AgentHarnessConfiguration {
  readonly harness: SupportedHarness;
  readonly executable: string;
  readonly arguments?: ReadonlyArray<string> | undefined;
  readonly environment?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }> | undefined;
  readonly maximumInputBytes: number;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly allowedExecutables: ReadonlyArray<string>;
  readonly executableAuthorizations?: ReadonlyArray<ExecutableAuthorization> | undefined;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly allowedCapabilities: ReadonlyArray<
    "elevation" | "login" | "restart" | "reboot"
  >;
}

export interface AgentTaskDocument {
  readonly schema: "canonfig.agent-task/v1";
  readonly task: AgentTask;
  readonly responseContract: {
    readonly format: "json";
    readonly actions: ReadonlyArray<"process">;
    readonly selfReportIsProof: false;
  };
}

export interface ProposedProcessAction {
  readonly kind: "process";
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly workingDirectory?: string | undefined;
  readonly paths: ReadonlyArray<string>;
  readonly origins: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<
    "elevation" | "login" | "restart" | "reboot"
  >;
  /**
   * Filled only after bounded pip requirement/constraint authorization.
   * The executor rechecks these exact file identities and digests immediately
   * before spawning the package manager.
   */
  readonly pipRequirementFiles?: ReadonlyArray<PipRequirementFileAuthorization>
    | undefined;
}

export interface PipRequirementFileAuthorization {
  readonly path: string;
  readonly canonicalPath: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
  };
  readonly digest: string;
}

export interface AgentActionProposal {
  readonly summary: string;
  readonly actions: ReadonlyArray<ProposedProcessAction>;
}

export interface CapturedProcess {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerificationEvidence {
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly matched: boolean;
}

export type AgentResolutionOutcome =
  | {
    readonly outcome: "deterministic-only";
    readonly task: AgentTask;
    readonly reason: string;
  }
  | {
    readonly outcome: "proposed";
    readonly task: AgentTask;
    readonly proposal: AgentActionProposal;
    readonly harness: CapturedProcess;
  }
  | {
    readonly outcome: "applied";
    readonly task: AgentTask;
    readonly proposal: AgentActionProposal;
    readonly harness: CapturedProcess;
    readonly executions: ReadonlyArray<CapturedProcess>;
    readonly verification: VerificationEvidence;
  };

export interface AgentResolutionInput {
  readonly policy: AgentPolicy;
  readonly task: AgentTask;
  readonly harness: AgentHarnessConfiguration;
  readonly secrets?: ReadonlyArray<string> | undefined;
  readonly scheduled?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ControlledProcessInput {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly workingDirectory?: string | undefined;
  readonly environment?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }> | undefined;
  readonly environmentUnset?: ReadonlyArray<string> | undefined;
  readonly environmentUnsetPrefixes?: ReadonlyArray<string> | undefined;
  readonly packageRegistryOrigin?: string | undefined;
  readonly packageRegistryScopes?: ReadonlyArray<string> | undefined;
  /**
   * Set only by AgentResolution after bounded requirement-file authorization.
   * The low-level executor otherwise rejects pip include files fail-closed.
   */
  readonly pipRequirementFiles?: ReadonlyArray<PipRequirementFileAuthorization>
    | undefined;
  readonly standardInput?: Uint8Array | undefined;
  readonly timeoutMilliseconds: number;
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly secrets: ReadonlyArray<string>;
  readonly signal?: AbortSignal | undefined;
}

export interface SourceDiscoveryResolution {
  readonly reason: string;
  readonly additions: ReadonlyArray<ProfileResourceInput>;
  readonly modifications: ReadonlyArray<ProfileResourceInput>;
  readonly removals: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<DiscoveryEvidenceRecord>;
}

/**
 * Agent-originated discovery changes are deliberately pending review and carry
 * no publication operation. Publication remains an explicit ProfileCatalog act.
 */
export interface ReviewedProfileChangeProposal {
  readonly reviewStatus: "pending";
  readonly proposal: ProfileChangeProposal;
}
