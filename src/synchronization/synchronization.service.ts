import { Context, type Effect } from "effect";

import type { SynchronizationOutcome } from "../domain/synchronization.ts";
import type { StateRepositoryError } from "../state/state-repository.errors.ts";
import type {
  SynchronizationExecutionInputError,
  SynchronizationPlanningError,
  SynchronizationRecoveryError,
} from "./synchronization.errors.ts";
import { planSynchronization } from "./planner.ts";
import type {
  PlannedSynchronization,
  SynchronizationPlannerInput,
  SynchronizationRecoveryInput,
  SynchronizationRunInput,
} from "./synchronization.types.ts";

/** Pure synchronization planning boundary. C6 owns all execution side effects. */
export class SynchronizationPlanner extends Context.Service<SynchronizationPlanner, {
  readonly plan: (
    input: SynchronizationPlannerInput,
  ) => Effect.Effect<PlannedSynchronization, SynchronizationPlanningError>;
}>()("canonfig/synchronization/SynchronizationPlanner") {}

export const synchronizationPlannerService = {
  plan: planSynchronization,
} satisfies SynchronizationPlanner["Service"];

/** Apply and crash-recovery boundary for recorded synchronization plans. */
export class Synchronization extends Context.Service<Synchronization, {
  readonly run: (
    input: SynchronizationRunInput,
  ) => Effect.Effect<
    SynchronizationOutcome,
    StateRepositoryError | SynchronizationExecutionInputError
  >;
  readonly recover: (
    input: SynchronizationRecoveryInput,
  ) => Effect.Effect<
    SynchronizationOutcome,
    StateRepositoryError | SynchronizationRecoveryError
  >;
}>()("canonfig/synchronization/Synchronization") {}
