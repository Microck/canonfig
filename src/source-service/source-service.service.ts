import { Context, type Effect } from "effect";

import type { NativeServiceError } from "../machine/native-service.ts";
import type {
  SourceServiceChange,
  SourceServiceIdentity,
  SourceServiceInput,
  SourceServiceRemoval,
  SourceServiceStatus,
} from "./source-service.types.ts";

/**
 * Supervised Source mode: `canonfig source serve` run by the native user
 * service manager (systemd user unit, launchd agent, Task Scheduler logon
 * task) instead of a terminal that has to stay open.
 */
export class SourceService extends Context.Service<SourceService, {
  /** Install or update the service, start it, and verify it serves `identity`. */
  readonly install: (
    input: SourceServiceInput,
    identity: SourceServiceIdentity,
  ) => Effect.Effect<SourceServiceChange, NativeServiceError>;
  /** What the manager reports and whether the endpoint serves `identity`. */
  readonly status: (
    identity: SourceServiceIdentity | undefined,
  ) => Effect.Effect<SourceServiceStatus, NativeServiceError>;
  readonly remove: () => Effect.Effect<SourceServiceRemoval, NativeServiceError>;
}>()("canonfig/source-service/SourceService") {}
