import { Effect } from "effect";

import type { FollowerSynchronizationConfiguration } from "../synchronization/follower-sync-config.ts";
import { MachineRoleConflictError, type StateRepositoryError } from "./state-repository.errors.ts";
import type { StateRepository } from "./state-repository.service.ts";

/**
 * A machine is either a Source or a Follower, never both (ADR 0003, section
 * 2). One `~/.canonfig/` cannot be the folder a Source authors and publishes
 * and also the read-only mirror of another Source.
 *
 * Each role is one record in the state database: `source init` saves the
 * Source identity (`enrollment_source`), and `follower enroll` saves the
 * follower configuration, pending from the moment the Source accepts the
 * invitation. The repository's save of each record refuses inside its write
 * transaction while the other exists, so two concurrent commands cannot both
 * succeed. Commands also check up front with `refuseOnFollower` and
 * `refuseOnSource`, which refuse before any side effect and name the action.
 */

const oneRoleRule = "a machine is either a Source or a Follower, never both";

/** Why an enrolled or enrolling Follower cannot `action`, and how it leaves that role. */
export const followerRoleConflict = (
  configuration: FollowerSynchronizationConfiguration,
  action: string,
): MachineRoleConflictError => {
  const relation = configuration.enrollmentPending === true ? "is enrolling with" : "follows";
  return new MachineRoleConflictError({
    message: `this machine ${relation} the Source at ${configuration.source.endpoint} `
      + `(signing key ${configuration.source.signingFingerprint}) as ${configuration.follower.name} `
      + `(${configuration.follower.id}), so it cannot ${action}: ${oneRoleRule}. `
      + "Run 'canonfig follower unenroll' first to make this machine a Source",
  });
};

/**
 * Why a Source cannot `action`. No command removes the Source role, so the
 * recovery moves `folder` aside: that keeps its authored items, Source
 * identity and run journal, which a deletion would lose.
 */
export const sourceRoleConflict = (
  signingFingerprint: string,
  action: string,
  folder: string,
): MachineRoleConflictError =>
  new MachineRoleConflictError({
    message: `this machine is a Source (signing key ${signingFingerprint}), `
      + `so it cannot ${action}: ${oneRoleRule}. No command removes the Source role: `
      + "run 'canonfig source service remove' if the Source service is installed, "
      + `move ${folder} aside (it keeps the authored folder, the Source identity and the run journal), `
      + "then try again",
  });

/** Refuse `action` (for example "publish a revision") on an enrolled or enrolling Follower. */
export const refuseOnFollower = (
  repository: StateRepository["Service"],
  action: string,
): Effect.Effect<void, StateRepositoryError> =>
  repository.getFollowerSynchronizationConfiguration().pipe(
    Effect.flatMap((configuration) =>
      configuration === undefined ? Effect.void : Effect.fail(followerRoleConflict(configuration, action))
    ),
  );

/** Refuse `action` (for example "enroll as a Follower") on an initialized Source whose state lives in `folder`. */
export const refuseOnSource = (
  repository: StateRepository["Service"],
  action: string,
  folder: string,
): Effect.Effect<void, StateRepositoryError> =>
  repository.getEnrollmentSource().pipe(
    Effect.flatMap((source) =>
      source === undefined
        ? Effect.void
        : Effect.fail(sourceRoleConflict(source.identity.publicKeyFingerprint, action, folder))
    ),
  );
