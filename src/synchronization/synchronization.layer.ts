import { Clock, Effect, Layer, Option } from "effect";
import type { ActionId } from "../domain/brand.ts";
import { sha256Hex } from "../profile/profile-codec.ts";
import { AgentResolution } from "../agent/agent-resolution.service.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { InvalidRunTransitionError } from "../state/state-repository.errors.ts";
import {
  cleanupRollbackSnapshots,
  executeSynchronizationPlan,
  executionFollower,
  executionRevision,
  preflightDisk,
  preflightPathLengths,
  withRollbackOutcome,
} from "./executor.ts";
import { recoverSynchronizationPlan } from "./recovery.ts";
import { RollbackCleanupError } from "./synchronization.errors.ts";
import { Synchronization } from "./synchronization.service.ts";

const makeSynchronization = Effect.gen(function*() {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const agentResolution = Option.getOrUndefined(
    yield* Effect.serviceOption(AgentResolution),
  );

  return Synchronization.of({
    run: (input) =>
      Effect.gen(function*() {
        const follower = yield* executionFollower(input);
        const revision = yield* executionRevision(input);
        const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();

        // A run that cannot fit, or that names a path this machine cannot
        // take, is refused before it exists. Measuring after startRun left an
        // open run the operator never knowingly started, and every later
        // apply demanded `canonfig recover` for it.
        yield* preflightPathLengths(input.plan.actions, input.revision.desired).pipe(
          Effect.provideService(MachineState, machine),
        );
        yield* preflightDisk(input).pipe(Effect.provideService(MachineState, machine));

        // Persist cleanup locations before the first snapshot write. Pending
        // references locate interrupted preparation; recovery must not restore
        // them until a later running event confirms a completed snapshot.
        const directories = yield* machine.userDirectories();
        const pendingRollbackReferences = new Map<ActionId, string>();
        for (const action of input.plan.actions) {
          const location = yield* machine.normalizePath({
            path: `canonfig/rollback/${input.id}/${sha256Hex(action.id)}.json`,
            base: directories.cache,
          });
          pendingRollbackReferences.set(action.id, location.absolute);
        }

        // startRun atomically persists the full plan and all pending actions.
        // The preflight above only measures; no MachineState mutation is
        // reachable before this succeeds.
        const existing = yield* repository.loadRecovery(follower);
        if (existing?.run.id === input.id && existing.run.lifecycle._tag === "Preparing") {
          yield* repository.beginRun(input.id);
        } else {
          yield* repository.startRun({
            id: input.id,
            follower,
            revision,
            plan: input.plan,
            startedAt,
            pendingRollbackReferences,
          });
        }

        const result = yield* executeSynchronizationPlan({
          ...input,
          agentResolution: input.agentResolution ?? agentResolution,
        }).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
          Effect.catch((error) =>
            Effect.succeed({
              outcome: withRollbackOutcome({
                outcome: "Failed",
                run: input.id,
                reason: String(error).slice(0, 2048),
              }, { _tag: "Complete" }),
              appliedResources: [],
              removedResources: [],
              rollback: { _tag: "Complete" as const },
            })
          ),
        );
        const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* repository.completeRun({
          run: input.id,
          completedAt,
          outcome: result.outcome,
          appliedResources: result.appliedResources,
          removedResources: result.removedResources,
        });
        if (result.outcome.outcome !== "Interrupted") {
          yield* cleanupRollbackSnapshots(
            input.id, input.plan.actions.map((action) => action.id),
            result.rollback._tag === "Incomplete" ? input.plan.actions.map((action) => action.id) : [],
            [...pendingRollbackReferences.values()],
          ).pipe(
            Effect.provideService(MachineState, machine),
            Effect.mapError((error) => new RollbackCleanupError({
              run: input.id,
              outcome: result.outcome.outcome,
              message: String(error),
            })),
          );
          if (!("origin" in input.revision) && result.rollback._tag === "Complete") yield* repository.finalizeRun(input.id, new Date(yield* Clock.currentTimeMillis).toISOString());
        }
        return result.outcome;
      }).pipe(
        Effect.onInterrupt(() => Effect.void),
      ),
    recover: (input) =>
      Effect.gen(function*() {
        const recovery = yield* repository.loadRecovery(input.follower);
        if (recovery?.run.lifecycle._tag === "Abandoning") return yield* new InvalidRunTransitionError({
          run: recovery.run.id, message: "abandonment must finish through the projection recovery controller",
        });
        if (recovery?.run.lifecycle._tag === "Preparing") {
          const outcome = { outcome: "Failed" as const, run: recovery.run.id,
            reason: "run preparation was interrupted before any managed target was written; run synchronization again" };
          yield* repository.completeRun({ run: recovery.run.id, completedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            outcome, appliedResources: [] });
          if (!("origin" in input.revision)) yield* repository.finalizeRun(recovery.run.id, new Date(yield* Clock.currentTimeMillis).toISOString());
          return outcome;
        }
        if (recovery?.run.lifecycle._tag === "Finalizing"
          && recovery.run.lifecycle.outcome.outcome === "Failed" && recovery.run.lifecycle.outcome.rollbackIncomplete === true) {
          yield* repository.beginRun(recovery.run.id);
        } else if (recovery?.run.lifecycle._tag === "Finalizing") {
          const outcome = recovery.run.lifecycle.outcome;
          yield* cleanupRollbackSnapshots(recovery.run.id, recovery.run.plan.actions.map((action) => action.id), [],
            recovery.actions.flatMap((event) => event.rollbackReference === undefined ? [] : [event.rollbackReference])).pipe(
            Effect.provideService(MachineState, machine),
            Effect.mapError((error) => new RollbackCleanupError({ run: recovery.run.id, outcome: outcome.outcome, message: String(error) })),
          );
          if (!("origin" in input.revision)) yield* repository.finalizeRun(recovery.run.id, new Date(yield* Clock.currentTimeMillis).toISOString());
          return outcome;
        }
        const result = yield* recoverSynchronizationPlan({
          ...input,
          agentResolution: input.agentResolution ?? agentResolution,
        }).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
        );
        yield* repository.completeRun({
          run: result.outcome.run,
          completedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          outcome: result.outcome,
          appliedResources: result.appliedResources,
          removedResources: result.removedResources,
        });
        if (result.outcome.outcome !== "Interrupted") {
          yield* cleanupRollbackSnapshots(
            result.outcome.run,
            recovery?.run.plan.actions.map((action) => action.id) ?? [],
            result.rollback._tag === "Incomplete" ? recovery?.run.plan.actions.map((action) => action.id) ?? [] : [],
            recovery?.actions.flatMap((action) => action.rollbackReference === undefined ? [] : [action.rollbackReference]) ?? [],
          ).pipe(
            Effect.provideService(MachineState, machine),
            Effect.mapError((error) => new RollbackCleanupError({
              run: result.outcome.run,
              outcome: result.outcome.outcome,
              message: String(error),
            })),
          );
          if (!("origin" in input.revision) && result.rollback._tag === "Complete") yield* repository.finalizeRun(result.outcome.run, new Date(yield* Clock.currentTimeMillis).toISOString());
        }
        return result.outcome;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function*() {
            const recovery = yield* repository.loadRecovery(input.follower);
            if (recovery === undefined) return;
            yield* repository.completeRun({
              run: recovery.run.id,
              completedAt: new Date(
                yield* Clock.currentTimeMillis,
              ).toISOString(),
              outcome: {
                outcome: "Interrupted",
                run: recovery.run.id,
                completedActions: recovery.actions
                  .filter((event) =>
                    event.state === "succeeded" || event.state === "blocked"
                  )
                  .map((event) => event.action),
              },
              appliedResources: [],
            });
          }).pipe(Effect.ignore)
        ),
      ),
  });
});

export const SynchronizationLive = Layer.effect(
  Synchronization,
  makeSynchronization,
);

export const synchronizationLayer = SynchronizationLive;
