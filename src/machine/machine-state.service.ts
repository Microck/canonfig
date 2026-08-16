import { Context, type Effect, type Redacted } from "effect";

import type {
  CredentialReference,
} from "../domain/brand.ts";
import type { MachineStateError } from "./machine-state.errors.ts";
import type {
  AtomicWriteInput,
  CredentialStorageCapability,
  DigestFileInput,
  DiscoveredExecutable,
  EnsureDirectoryInput,
  ExecutableQuery,
  FileDigest,
  FilePermissions,
  LoadCredentialInput,
  MachinePath,
  NormalizePathInput,
  ProcessInvocation,
  ProcessResult,
  ReadFileInput,
  RemoveFileInput,
  RenderedSchedulerJob,
  SchedulerInspection,
  SchedulerJob,
  SetPermissionsInput,
  StoreCredentialInput,
  SymlinkInput,
  UserDirectories,
} from "./machine-state.types.ts";

export class MachineState extends Context.Service<MachineState, {
  readonly normalizePath: (
    input: NormalizePathInput,
  ) => Effect.Effect<MachinePath, MachineStateError>;
  readonly userDirectories: () => Effect.Effect<UserDirectories, MachineStateError>;
  readonly ensureDirectory: (
    input: EnsureDirectoryInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly atomicWrite: (
    input: AtomicWriteInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly readFile: (
    input: ReadFileInput,
  ) => Effect.Effect<Uint8Array, MachineStateError>;
  readonly removeFile: (
    input: RemoveFileInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly replaceSymlink: (
    input: SymlinkInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly readSymlink: (
    path: MachinePath,
  ) => Effect.Effect<MachinePath, MachineStateError>;
  readonly setPermissions: (
    input: SetPermissionsInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly permissions: (
    path: MachinePath,
  ) => Effect.Effect<FilePermissions, MachineStateError>;
  readonly findExecutable: (
    query: ExecutableQuery,
  ) => Effect.Effect<DiscoveredExecutable, MachineStateError>;
  readonly runProcess: (
    invocation: ProcessInvocation,
  ) => Effect.Effect<ProcessResult, MachineStateError>;
  readonly digestFile: (
    input: DigestFileInput,
  ) => Effect.Effect<FileDigest, MachineStateError>;
  readonly credentialCapability: (
  ) => Effect.Effect<CredentialStorageCapability, MachineStateError>;
  readonly storeCredential: (
    input: StoreCredentialInput,
  ) => Effect.Effect<CredentialReference, MachineStateError>;
  readonly loadCredential: (
    input: LoadCredentialInput,
  ) => Effect.Effect<Redacted.Redacted<string>, MachineStateError>;
  readonly removeCredential: (
    reference: CredentialReference,
  ) => Effect.Effect<void, MachineStateError>;
  readonly renderSchedulerJob: (
    job: SchedulerJob,
  ) => Effect.Effect<RenderedSchedulerJob, MachineStateError>;
  readonly inspectSchedulerJob: (
    expected: RenderedSchedulerJob,
  ) => Effect.Effect<SchedulerInspection, MachineStateError>;
  readonly installSchedulerJob: (
    definition: RenderedSchedulerJob,
  ) => Effect.Effect<void, MachineStateError>;
  readonly removeSchedulerJob: (
    definition: RenderedSchedulerJob,
  ) => Effect.Effect<void, MachineStateError>;
}>()("canonfig/machine/MachineState") {}
