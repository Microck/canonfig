import { Context, Data, type Effect } from "effect";

import type {
  FollowerId,
  GroupName,
  ProfileRevisionId,
} from "../domain/brand.ts";
import type { CliFailureCategory } from "./exit-codes.ts";

export type CliPayload =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CliPayload>
  | { readonly [key: string]: CliPayload | undefined };

export class CliCommandFailure extends Data.TaggedError(
  "CliCommandFailure",
)<{
  readonly category: CliFailureCategory;
  readonly message: string;
  readonly details?: CliPayload | undefined;
}> {}

export interface SourceScanInput {
  /** Insert the reviewed `tools` entries into `canonfig.jsonc`. */
  readonly write: boolean;
}

export interface SourcePublishInput {
  readonly reviewer: string;
}

export interface SourceServeInput {
  readonly hostname: "127.0.0.1" | "::1" | "tailnet";
  readonly port: number;
}

export interface SourceInviteInput {
  readonly endpoint: string;
  readonly expiresInMilliseconds: number;
  readonly groups: ReadonlyArray<GroupName>;
  readonly outputPath: string;
  readonly timeoutMilliseconds: number;
}

export interface SourceCommandsService {
  readonly initialize: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly scan: (
    input: SourceScanInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly publish: (
    input: SourcePublishInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly serve: (
    input: SourceServeInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  /** Supervised Source: install `source serve` as a native user service. */
  readonly installService: (
    input: SourceServeInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly serviceStatus: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly removeService: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly invite: (
    input: SourceInviteInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly revoke: (
    follower: FollowerId,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly listProfiles: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly inspectProfile: (
    revision: ProfileRevisionId,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
}

export class SourceCommands extends Context.Service<
  SourceCommands,
  SourceCommandsService
>()("canonfig/cli/SourceCommands") {}
