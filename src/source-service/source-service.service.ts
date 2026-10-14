import { Context, type Effect } from "effect";

import type { SourceServiceError } from "./source-service.errors.ts";
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
  ) => Effect.Effect<SourceServiceChange, SourceServiceError>;
  /** What the manager reports and whether the endpoint serves `identity`. */
  readonly status: (
    identity: SourceServiceIdentity | undefined,
  ) => Effect.Effect<SourceServiceStatus, SourceServiceError>;
  readonly remove: () => Effect.Effect<SourceServiceRemoval, SourceServiceError>;
}>()("canonfig/source-service/SourceService") {}
