import { Effect } from "effect";

import type { FollowerId } from "../domain/brand.ts";
import { buildIdentity } from "../runtime/build-identity.ts";
import { UpgradeGateError, type StateRepositoryError } from "../state/state-repository.errors.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { stateFormatVersion } from "../state/state-schema.ts";

// Its own module, shared by follower and local projection runs: the gate
// needs the state schema, which loads SQLite, and run-lock.ts must stay free
// of that because `canonfig secrets --help` imports the lock.

/**
 * An upgrade must not change executable or state underneath a run that an
 * earlier build left unfinished: that run can only be finished or recovered
 * by the build that created it, because the journal and codec behavior of a
 * foreign build are unknown. The operator can accept the upgrade explicitly,
 * which is the migration path.
 */
export const assertUpgradeGate = Effect.fn(
  "FollowerOrchestration.upgradeGate",
)(function*(follower: FollowerId): Effect.fn.Return<void, UpgradeGateError | StateRepositoryError, StateRepository> {
  const repository = yield* StateRepository;
  const open = yield* repository.loadOpenRunIdentity(follower);
  if (open === undefined) return;
  // A run created before builds recorded their identity has no receipt-era
  // evidence; it is grandfathered rather than stranded by this upgrade.
  const compatible = open.creatingIdentity === null
    || open.stateFormat === null
    || (
      open.creatingIdentity === buildIdentity.sourceDigest
      && open.stateFormat === stateFormatVersion
    );
  if (compatible || process.env.CANONFIG_ACCEPT_FOREIGN_BUILD === "1") return;
  return yield* new UpgradeGateError({
    run: open.run,
    creatingVersion: open.creatingVersion,
    creatingIdentity: open.creatingIdentity,
    creatingStateFormat: open.stateFormat,
    currentVersion: buildIdentity.packageVersion,
    currentIdentity: buildIdentity.sourceDigest,
    currentStateFormat: stateFormatVersion,
  });
});
