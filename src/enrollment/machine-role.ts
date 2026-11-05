import { Effect } from "effect";

import type { StateRepositoryError } from "../state/state-repository.errors.ts";
import type { StateRepository } from "../state/state-repository.service.ts";
import { MachineRoleConflictError } from "./enrollment.errors.ts";

/**
 * A machine is either a Source or a Follower, never both (ADR 0003, section
 * 2). One `~/.canonfig/` cannot be the folder a Source authors and publishes
 * and also the read-only mirror of another Source.
 *
 * Each role is one record in the state database: `source init` saves the
 * Source identity, and `follower enroll` saves the follower configuration
 * (pending from the moment the Source accepts the invitation). Commands that
 * act as one role check for the other's record before they change anything.
 */

const oneRoleRule = "a machine is either a Source or a Follower, never both";

/**
 * Refuse `action` (for example "publish a revision") on an enrolled or
 * enrolling Follower, naming the Source it follows and how to leave it.
 */
export const refuseOnFollower = (
  repository: StateRepository["Service"],
  action: string,
): Effect.Effect<void, MachineRoleConflictError | StateRepositoryError> =>
  repository.getFollowerSynchronizationConfiguration().pipe(
    Effect.flatMap((configuration) => {
      if (configuration === undefined) return Effect.void;
      const relation = configuration.enrollmentPending === true ? "is enrolling with" : "follows";
      return Effect.fail(new MachineRoleConflictError({
        message: `this machine ${relation} the Source at ${configuration.source.endpoint} `
          + `(signing key ${configuration.source.signingFingerprint}) as ${configuration.follower.name} `
          + `(${configuration.follower.id}), so it cannot ${action}: ${oneRoleRule}. `
          + "Run 'canonfig follower unenroll' first to make this machine a Source",
      }));
    }),
  );

/**
 * Refuse `action` (for example "enroll as a Follower") on an initialized
 * Source. No command removes the Source role, so the recovery moves the
 * folder aside: that keeps its authored items, Source identity and run
 * journal, which a deletion would lose.
 */
export const refuseOnSource = (
  repository: StateRepository["Service"],
  action: string,
  folder: string,
): Effect.Effect<void, MachineRoleConflictError | StateRepositoryError> =>
  repository.getEnrollmentSource().pipe(
    Effect.flatMap((source) =>
      source === undefined ? Effect.void : Effect.fail(new MachineRoleConflictError({
        message: `this machine is a Source (signing key ${source.identity.publicKeyFingerprint}), `
          + `so it cannot ${action}: ${oneRoleRule}. No command removes the Source role: `
          + "run 'canonfig source service remove' if the Source service is installed, "
          + `move ${folder} aside (it keeps the authored folder, the Source identity and the run journal), `
          + "then try again",
      }))
    ),
  );
