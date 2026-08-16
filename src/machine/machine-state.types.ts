import type { Effect, Redacted } from "effect";

import type {
  ContentDigest,
  CredentialReference,
} from "../domain/brand.ts";
import type { MachineStateError } from "./machine-state.errors.ts";

export type MachinePlatform = "linux" | "macos" | "windows";

export interface MachinePath {
  readonly platform: MachinePlatform;
  readonly absolute: string;
}

export interface NormalizePathInput {
  readonly path: string;
  readonly base?: MachinePath | undefined;
}

export interface UserDirectories {
  readonly home: MachinePath;
  readonly config: MachinePath;
  readonly data: MachinePath;
  readonly cache: MachinePath;
}

export interface EnsureDirectoryInput {
  readonly path: MachinePath;
  readonly mode?: number | undefined;
}

export interface AtomicWriteInput {
  readonly path: MachinePath;
  readonly content: Uint8Array;
  readonly mode?: number | undefined;
}

export interface ReadFileInput {
  readonly path: MachinePath;
  readonly maximumBytes: number;
}

export interface RemoveFileInput {
  readonly path: MachinePath;
}

export interface SymlinkInput {
  readonly path: MachinePath;
  readonly target: MachinePath;
}

export interface FilePermissions {
  readonly mode: number;
  readonly executableByOwner: boolean;
}

export interface SetPermissionsInput {
  readonly path: MachinePath;
  readonly mode: number;
}

export interface ExecutableQuery {
  readonly name: string;
  readonly searchPath?: ReadonlyArray<MachinePath> | undefined;
}

export interface DiscoveredExecutable {
  readonly name: string;
  readonly path: MachinePath;
}

export interface ProcessEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

export interface ProcessInvocation {
  readonly executable: MachinePath;
  readonly arguments: ReadonlyArray<string>;
  readonly workingDirectory?: MachinePath | undefined;
  readonly environment?: ReadonlyArray<ProcessEnvironmentEntry> | undefined;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly standardOutput: Uint8Array;
  readonly standardError: Uint8Array;
}

export interface DigestFileInput {
  readonly path: MachinePath;
  readonly maximumBytes?: number | undefined;
}

export type CredentialStorageCapability =
  | {
    readonly kind: "secure-noninteractive";
    readonly provider: "secret-service" | "keychain" | "credential-manager";
  }
  | {
    readonly kind: "local-file";
    readonly path: MachinePath;
  }
  | {
    readonly kind: "unavailable";
    readonly recovery: string;
  };

export type CredentialPolicy =
  | { readonly kind: "secure-store" }
  | { readonly kind: "local-file"; readonly path: string };

export interface StoreCredentialInput {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

export interface LoadCredentialInput {
  readonly reference: CredentialReference;
}

export type SchedulerCalendar =
  | {
    readonly kind: "daily";
    readonly localTime: string;
    readonly timezone?: string | undefined;
  }
  | {
    readonly kind: "weekly";
    readonly weekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
    readonly localTime: string;
    readonly timezone?: string | undefined;
  }
  | { readonly kind: "systemd-on-calendar"; readonly expression: string };

export interface SchedulerJob {
  readonly name: string;
  readonly description: string;
  readonly executable: MachinePath;
  readonly arguments: ReadonlyArray<string>;
  readonly calendar: SchedulerCalendar;
}

export interface RenderedSchedulerJob {
  readonly platform: MachinePlatform;
  readonly mechanism: "systemd-user-timer" | "launchd-user-agent" | "task-scheduler";
  readonly serviceName: string;
  readonly service: string;
  readonly schedule: string;
}

export interface SchedulerInspection {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly matches: boolean;
}

export interface SchedulerBackend {
  readonly inspect: (
    expected: RenderedSchedulerJob,
  ) => Effect.Effect<SchedulerInspection, MachineStateError>;
  readonly install: (
    definition: RenderedSchedulerJob,
  ) => Effect.Effect<void, MachineStateError>;
  readonly remove: (
    definition: RenderedSchedulerJob,
  ) => Effect.Effect<void, MachineStateError>;
}

export interface LinuxMachineStateOptions {
  readonly credentialPolicy?: CredentialPolicy | undefined;
  readonly environment?: ReadonlyArray<ProcessEnvironmentEntry> | undefined;
  readonly schedulerBackend?: SchedulerBackend | undefined;
}

export interface FileDigest {
  readonly algorithm: "sha256";
  readonly value: ContentDigest;
}
