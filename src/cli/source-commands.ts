import { Context, Data, type Effect } from "effect";

import type {
  FollowerId,
  GroupName,
  ProfileId,
  ProfileRevisionId,
} from "../domain/brand.ts";
import type { DiscoveryFileKind } from "../profile/discovery.ts";
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
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind?: DiscoveryFileKind | undefined;
  }>;
}

export interface SourcePublishInput {
  readonly proposalPath: string;
  readonly profile: ProfileId;
  readonly name: string;
  readonly reviewer: string;
}

export interface SourceServeInput {
  readonly hostname: "127.0.0.1" | "::1";
  readonly port: number;
}

export interface SourceInviteInput {
  readonly endpoint: string;
  readonly expiresInMilliseconds: number;
  readonly groups: ReadonlyArray<GroupName>;
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
