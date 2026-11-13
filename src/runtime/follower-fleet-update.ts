import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";
import { CliCommandFailure } from "../cli/source-commands.ts";
import { FleetReport, SignedFleetDirective } from "../domain/fleet-update.ts";
import { ProfileRevisionId } from "../domain/brand.ts";
import { verifyFleetDirective, writeFleetRecord } from "../enrollment/fleet-update.ts";
import { requestFleetUpdate } from "../enrollment/follower-client.ts";
import type { FollowerTransportInput } from "../enrollment/enrollment.types.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { stateFormatVersion } from "../state/state-schema.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { buildIdentity } from "./build-identity.ts";
import { downloadFleetRelease, verifyFleetRelease, type FleetReleaseVerifier } from "./fleet-release.ts";
import { regular, updateDirectory, type ManagedCommandLease } from "./self-update/coordination.ts";
import { assertNoUnfinishedRun, update } from "./self-update/core.ts";

const FollowerFleetRecord = Schema.Struct({
  signed: SignedFleetDirective, startedAt: Schema.String,
  report: Schema.NullOr(FleetReport), reported: Schema.Boolean,
});
const AppliedRevisionOrigin = Schema.fromJsonString(Schema.Struct({ sourceRevision: ProfileRevisionId }));
type FollowerFleetRecord = typeof FollowerFleetRecord.Type;
export const followerFleetPath = (state: string) => `${state}.fleet-follower.json`;
export function readFollowerFleet(state: string): FollowerFleetRecord | null {
  const path = followerFleetPath(state);
  regular(path);
  return existsSync(path) ? Schema.decodeUnknownSync(Schema.fromJsonString(FollowerFleetRecord), { onExcessProperty: "error" })(readFileSync(path, "utf8")) : null;
}
const fleetFailure = (cause: unknown) => new CliCommandFailure({
  category: "human-action-required", message: cause instanceof Error ? cause.message : String(cause),
});

/** Runs only at a mutating CLI sync boundary, never in a resident follower worker. */
export const prepareFleetSync = Effect.fn("Fleet.prepareSync")(function*(
  root: string, lease: ManagedCommandLease,
  release: FleetReleaseVerifier = verifyFleetRelease,
  download: typeof downloadFleetRelease = downloadFleetRelease,
) {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const configuration = yield* repository.getFollowerSynchronizationConfiguration().pipe(Effect.mapError(fleetFailure));
  if (configuration === undefined || configuration.lifecycle._tag !== "Active") return false;
  const directory = updateDirectory(root);
  const state = configuration.stateLocation;
  const transport: FollowerTransportInput = {
    endpoint: configuration.source.endpoint, tlsFingerprint: configuration.source.tlsFingerprint,
    sourceFingerprint: configuration.source.signingFingerprint, credentialReference: configuration.credentialReference,
    timeoutMilliseconds: configuration.scheduledInvocation.timeoutMilliseconds,
  };
  const request = (report?: FleetReport) => Effect.runPromise(requestFleetUpdate(transport, report).pipe(Effect.provideService(MachineState, machine)));
  const polled = yield* Effect.tryPromise({ try: () => request(), catch: fleetFailure });
  if (polled.directive === null) return false;
  const signed = polled.directive;
  const directive = yield* Effect.try({
    try: () => verifyFleetDirective(signed, configuration.follower.id, configuration.source.signingFingerprint), catch: fleetFailure,
  });
  const report = (status: FleetReport["status"], detail: string): FleetReport => ({
    rollout: directive.rollout, attempt: directive.attempt, version: buildIdentity.packageVersion,
    status, detail: detail.slice(0, 1024), health: null,
  });
  return yield* withRunLock(state, "activate Fleet Update", Effect.tryPromise({
    try: async (signal) => {
      const previous = readFollowerFleet(state);
      if (previous?.signed.directive.source === directive.source) {
        const earlier = previous.signed.directive;
        if (directive.sequence < earlier.sequence || (directive.sequence === earlier.sequence
          && (directive.rollout !== earlier.rollout || directive.version !== earlier.version || directive.integrity !== earlier.integrity))) {
          throw new Error("Fleet Update replay or changed immutable release refused");
        }
        if (earlier.rollout === directive.rollout && previous.report !== null && previous.report.status !== "deferred") {
          if (!previous.reported) {
            await request(previous.report);
            writeFleetRecord(followerFleetPath(state), { ...previous, reported: true });
          }
          return false;
        }
      }
      const record: FollowerFleetRecord = { signed, startedAt: new Date().toISOString(), report: null, reported: false };
      const persistReport = async (value: FleetReport) => {
        writeFleetRecord(followerFleetPath(state), { ...record, report: value });
        await request(value);
        writeFleetRecord(followerFleetPath(state), { ...record, report: value, reported: true });
      };
      try { assertNoUnfinishedRun(state); }
      catch (cause) {
        const deferred = report("deferred", `Finish or abandon the active Synchronization Run before updating: ${String(cause)}`);
        await persistReport(deferred);
        throw new Error(deferred.detail);
      }
      writeFleetRecord(followerFleetPath(state), record);
      try {
        if (directive.stateFormat !== stateFormatVersion) throw new Error("Fleet Update requires the same state format; use the documented manual recovery procedure");
        if (directive.version === buildIdentity.packageVersion) return false;
        const result = await lease.selfUpdate(() => update(root, true, {
          version: directive.version, stateFormat: directive.stateFormat,
          prepare: async (stage, abort) => {
            const verified = await release(directive.version, join(directory, "provenance"), abort);
            if (verified.version !== directive.version || verified.integrity !== directive.integrity) throw new Error("Source release integrity does not match the independently verified official package");
            return download(verified, stage, abort);
          },
          confirmAdmission: async () => {
            const current = (await request()).directive;
            if (current === null) throw new Error("The Source stopped this Fleet Update before activation");
            const admission = verifyFleetDirective(current, configuration.follower.id, configuration.source.signingFingerprint);
            if (admission.rollout !== directive.rollout || admission.attempt !== directive.attempt
              || admission.version !== directive.version || admission.integrity !== directive.integrity) throw new Error("Fleet Update admission changed during staging");
          },
        }, undefined, signal), (result) => result.status !== "updated");
        if (result.status === "deferred") {
          await persistReport(report("deferred", result.detail));
          return false;
        }
        return result.status === "updated";
      } catch (cause) {
        await persistReport(report("failed", String(cause)));
        throw cause;
      }
    }, catch: fleetFailure,
  })).pipe(Effect.catchTag("RunLockHeldError", (error) => Effect.tryPromise({
    try: async () => { await request(report("deferred", error.message)); throw new Error("Fleet Update deferred: another Synchronization Run is active"); },
    catch: fleetFailure,
  })), Effect.mapError(fleetFailure));
});

/** Only a fresh receipt from this exact package can advance the Source's rollout. */
export const finishFleetSync = Effect.fn("Fleet.finishSync")(function*(succeeded: boolean) {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const state = yield* repository.databaseFile().pipe(Effect.mapError(fleetFailure));
  const record = yield* Effect.try({ try: () => readFollowerFleet(state), catch: fleetFailure });
  if (record === null || record.report !== null) return;
  const configuration = yield* repository.getFollowerSynchronizationConfiguration().pipe(Effect.mapError(fleetFailure));
  if (configuration === undefined || configuration.source.signingFingerprint !== record.signed.directive.source) return;
  const receipt = yield* repository.latestDeploymentReceipt(configuration.follower.id).pipe(Effect.mapError(fleetFailure));
  // Projection receipts name a follower-specific view. Its stored lineage names
  // the publication the Source can validate, without guessing from the view ID.
  const applied = receipt === undefined ? undefined : yield* repository.findRevision(receipt.revision).pipe(Effect.mapError(fleetFailure));
  const origin = applied === undefined ? undefined : yield* Effect.try({
    try: () => Schema.decodeUnknownSync(AppliedRevisionOrigin)(applied.canonicalBytes), catch: fleetFailure,
  });
  const directive = record.signed.directive;
  const healthy = succeeded && receipt !== undefined && origin !== undefined && receipt.outcome === "Converged"
    && receipt.packageVersion === directive.version && receipt.stateFormat === directive.stateFormat
    && Date.parse(receipt.recordedAt) >= Date.parse(record.startedAt);
  const report: FleetReport = {
    rollout: directive.rollout, attempt: directive.attempt, version: buildIdentity.packageVersion,
    status: healthy ? "healthy" : "failed", detail: healthy ? "Exact release activated and a fresh Synchronization Run Converged" : "Post-update Synchronization Run did not prove Convergence; rollout halted. Inspect status before manual rollback.",
    health: healthy ? { run: receipt.run, revision: origin.sourceRevision, version: receipt.packageVersion, outcome: "Converged", recordedAt: receipt.recordedAt } : null,
  };
  yield* Effect.try({ try: () => writeFleetRecord(followerFleetPath(state), { ...record, report }), catch: fleetFailure });
  yield* requestFleetUpdate({
    endpoint: configuration.source.endpoint, tlsFingerprint: configuration.source.tlsFingerprint,
    sourceFingerprint: configuration.source.signingFingerprint, credentialReference: configuration.credentialReference,
    timeoutMilliseconds: configuration.scheduledInvocation.timeoutMilliseconds,
  }, report).pipe(Effect.provideService(MachineState, machine), Effect.mapError(fleetFailure));
  yield* Effect.try({ try: () => writeFleetRecord(followerFleetPath(state), { ...record, report, reported: true }), catch: fleetFailure });
  if (!healthy && succeeded) return yield* fleetFailure("Fleet Update health failed: no fresh Converged receipt from the target release");
});

/** Reload the activated tree, preserving the original sync's IO, arguments and exit status. */
export const restartFleetSync = (root: string, args: readonly string[]) => Effect.tryPromise({
  try: (signal) => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "dist/runtime/main.js"), ...args], { stdio: "inherit", signal });
    child.once("error", reject);
    child.once("exit", (code, termination) => resolve(code ?? (termination === "SIGINT" ? 130 : 143)));
  }), catch: fleetFailure,
});
