import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FleetDirective, FleetUpdate, type FleetReport, type FleetStart, SignedFleetDirective } from "../domain/fleet-update.ts";
import { ProfileRevisionId } from "../domain/brand.ts";
import { asJson, canonicalJson } from "../profile/profile-codec.ts";
import type { StateRepository } from "../state/state-repository.service.ts";
import { stateFormatVersion } from "../state/state-schema.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { buildIdentity } from "../runtime/build-identity.ts";
import { verifyFleetRelease, type FleetReleaseVerifier } from "../runtime/fleet-release.ts";
import { regular } from "../runtime/self-update/coordination.ts";
import { syncDirectory } from "../runtime/self-update/core.ts";
import { EnrollmentConfigurationError, type EnrollmentError } from "./enrollment.errors.ts";
import type { AuthenticatedFollower, SourceCredentials } from "./enrollment.types.ts";

export const fleetPath = (state: string): string => `${state}.fleet-update.json`;
const maximumAdmissionAge = 60 * 60 * 1000;

export function readFleetUpdate(state: string): FleetUpdate | null {
  const path = fleetPath(state);
  regular(path);
  if (!existsSync(path)) return null;
  if (statSync(path).size > 1_048_576) throw new Error("Fleet Update state exceeds 1 MiB");
  return Schema.decodeUnknownSync(Schema.fromJsonString(FleetUpdate), { onExcessProperty: "error" })(readFileSync(path, "utf8"));
}
export function writeFleetRecord<Value>(path: string, value: Value): void {
  regular(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  const fd = openSync(temporary, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

export function verifyFleetDirective(signed: SignedFleetDirective, follower: string, fingerprint: string, now = Date.now()): FleetDirective {
  const directive = signed.directive;
  const key = createPublicKey(signed.publicKey);
  const digest = createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
  if (key.asymmetricKeyType !== "ed25519" || digest !== fingerprint || directive.source !== fingerprint
    || directive.follower !== follower || !signed.signature.startsWith("ed25519:")
    || !verify(null, Buffer.from(canonicalJson(asJson(directive))), key, Buffer.from(signed.signature.slice(8), "base64url"))) {
    throw new Error("Fleet Update directive signature or enrollment identity is invalid");
  }
  const expiry = Date.parse(directive.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + maximumAdmissionAge) throw new Error("Fleet Update directive is expired or has an invalid lifetime");
  return directive;
}

export interface FleetSource {
  readonly fleetStatus: () => Effect.Effect<FleetUpdate | null, EnrollmentError>;
  readonly startFleetUpdate: (input: FleetStart) => Effect.Effect<FleetUpdate, EnrollmentError>;
  readonly stopFleetUpdate: (apply: boolean) => Effect.Effect<FleetUpdate | null, EnrollmentError>;
  readonly pollFleetUpdate: (credential: string) => Effect.Effect<{ directive: SignedFleetDirective | null }, EnrollmentError>;
  readonly reportFleetUpdate: (credential: string, report: FleetReport) => Effect.Effect<void, EnrollmentError>;
}
interface FleetSourceDependencies {
  readonly repository: StateRepository["Service"];
  readonly credentials: () => Effect.Effect<SourceCredentials, EnrollmentError>;
  readonly authenticate: (credential: string) => Effect.Effect<AuthenticatedFollower, EnrollmentError>;
  readonly release?: FleetReleaseVerifier;
}
const failure = (error: { readonly message: string }): EnrollmentConfigurationError => new EnrollmentConfigurationError({
  operation: "Fleet Update", message: error.message,
});

/** The same persisted lock serializes CLI, GUI and authenticated follower reports. */
export function fleetSource(dependencies: FleetSourceDependencies): FleetSource {
  const { repository, credentials, authenticate } = dependencies;
  const operation = <A, E extends { readonly message: string }>(program: Effect.Effect<A, E>) => program.pipe(Effect.mapError(failure));
  const mutate = <A, E extends { readonly message: string }>(use: (state: string) => Effect.Effect<A, E>) => operation(Effect.gen(function*() {
    const state = yield* repository.databaseFile();
    return yield* withRunLock(`${state}.fleet`, "change Fleet Update", use(state));
  }));
  const read = (state: string) => Effect.try({ try: () => readFleetUpdate(state), catch: (cause) => failure({ message: String(cause) }) });
  const write = (state: string, rollout: FleetUpdate) => Effect.try({
    try: () => writeFleetRecord(fleetPath(state), rollout), catch: (cause) => failure({ message: String(cause) }),
  });
  const fleetStatus = () => operation(Effect.gen(function*() { return yield* read(yield* repository.databaseFile()); }));
  return {
    fleetStatus,
    startFleetUpdate: (input) => operation(Effect.gen(function*() {
      const keys = yield* credentials();
      const roster = (yield* repository.listEnrollmentFollowers()).filter((follower) => !follower.revoked && !follower.pending);
      const canary = roster.find((follower) => follower.id === input.canary);
      if (canary === undefined) return yield* failure({ message: "Choose an active enrolled follower as the canary" });
      const state = yield* repository.databaseFile();
      const cache = join(dirname(state), ".fleet-provenance");
      const release = yield* Effect.tryPromise({
        try: (signal) => {
          mkdirSync(cache, { recursive: true, mode: 0o700 });
          return (dependencies.release ?? verifyFleetRelease)(buildIdentity.packageVersion, cache, signal);
        }, catch: (cause) => failure({ message: `Cannot authorize this release: ${String(cause)}` }),
      });
      return yield* mutate((path) => Effect.gen(function*() {
        const previous = yield* read(path);
        if (previous?.status === "running") return yield* failure({ message: "A Fleet Update is running. Stop it before starting another." });
        const ordered = [canary, ...roster.filter((follower) => follower.id !== canary.id).sort((a, b) => a.id.localeCompare(b.id))];
        const rollout: FleetUpdate = {
          schema: "canonfig.fleet-update/v1", id: randomUUID(), sequence: (previous?.sequence ?? 0) + 1,
          source: keys.material.source.publicKeyFingerprint, version: release.version, integrity: release.integrity,
          stateFormat: stateFormatVersion, startedAt: new Date().toISOString(), status: "running",
          followers: ordered.map((follower) => ({ id: follower.id, name: follower.name, status: "queued", version: null,
            detail: "Waiting for the follower's next sync and local update opt-in", attempt: null, admittedAt: null, health: null })),
        };
        if (input.apply) yield* write(path, rollout);
        return rollout;
      }));
    })),
    stopFleetUpdate: (apply) => mutate((path) => Effect.gen(function*() {
      const rollout = yield* read(path);
      if (rollout === null || rollout.status !== "running") return rollout;
      const stopped: FleetUpdate = { ...rollout, status: "stopped" };
      if (apply) yield* write(path, stopped);
      return stopped;
    })),
    pollFleetUpdate: (credential) => Effect.gen(function*() {
      const authenticated = yield* authenticate(credential);
      const keys = yield* credentials();
      return yield* mutate((path) => Effect.gen(function*() {
        const rollout = yield* read(path);
        if (rollout === null || rollout.status !== "running") return { directive: null };
        if (rollout.version !== buildIdentity.packageVersion || rollout.source !== keys.material.source.publicKeyFingerprint) {
          yield* write(path, { ...rollout, status: "halted" });
          return { directive: null };
        }
        const active = rollout.followers.find((follower) => follower.status !== "healthy");
        if (active === undefined || active.id !== authenticated.follower.id) return { directive: null };
        if (active.status === "updating" && active.admittedAt !== null && Date.now() - Date.parse(active.admittedAt) >= maximumAdmissionAge) {
          yield* write(path, { ...rollout, status: "halted", followers: rollout.followers.map((follower) => follower.id === active.id
            ? { ...follower, status: "failed", detail: "No health report arrived within one hour; inspect the follower before retrying" } : follower) });
          return { directive: null };
        }
        const attempt = active.attempt ?? randomUUID();
        const admittedAt = active.status === "updating" ? active.admittedAt! : new Date().toISOString();
        const directive: FleetDirective = {
          schema: "canonfig.fleet-directive/v1", rollout: rollout.id, sequence: rollout.sequence,
          follower: active.id, source: rollout.source, version: rollout.version, integrity: rollout.integrity,
          stateFormat: rollout.stateFormat, attempt, expiresAt: new Date(Date.parse(admittedAt) + maximumAdmissionAge).toISOString(),
        };
        yield* write(path, { ...rollout, followers: rollout.followers.map((follower) => follower.id === active.id
          ? { ...follower, attempt, admittedAt, status: "updating", detail: "Admitted; awaiting verified activation and Convergence" } : follower) });
        const privateKey = createPrivateKey(Redacted.value(keys.signingPrivateKey));
        return { directive: {
          directive, publicKey: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
          signature: `ed25519:${sign(null, Buffer.from(canonicalJson(asJson(directive))), privateKey).toString("base64url")}`,
        } };
      }));
    }),
    reportFleetUpdate: (credential, report) => Effect.gen(function*() {
      const authenticated = yield* authenticate(credential);
      yield* mutate((path) => Effect.gen(function*() {
        const rollout = yield* read(path);
        const active = rollout?.followers.find((follower) => follower.id === authenticated.follower.id);
        if (rollout === null || rollout.id !== report.rollout || active === undefined || active.attempt !== report.attempt) {
          return yield* failure({ message: "Fleet Update report does not match an admitted attempt" });
        }
        if (active.status === "healthy" && report.status === "healthy") return;
        if (rollout.status !== "running" || (active.status !== "updating" && active.status !== "deferred")) {
          return yield* failure({ message: "Fleet Update is no longer accepting health reports" });
        }
        if (report.status === "healthy") {
          const health = report.health;
          if (health === null || report.version !== rollout.version || health.version !== rollout.version
            || !Number.isFinite(Date.parse(health.recordedAt)) || Date.parse(health.recordedAt) < Date.parse(active.admittedAt!)
            || Date.parse(health.recordedAt) > Date.now() + 300_000) return yield* failure({ message: "Fleet Update health lacks a fresh Converged run at the target version" });
          const revision = yield* Schema.decodeUnknownEffect(ProfileRevisionId)(health.revision).pipe(Effect.mapError(failure));
          if ((yield* repository.findRevision(revision)) === undefined) return yield* failure({ message: "Fleet Update health names an unpublished revision" });
        }
        const followers = rollout.followers.map((follower) => follower.id === active.id
          ? { ...follower, status: report.status, version: report.version, detail: report.detail, health: report.health } : follower);
        yield* write(path, { ...rollout, followers, status: report.status === "failed" ? "halted"
          : followers.every((follower) => follower.status === "healthy") ? "complete" : "running" });
      }));
    }),
  };
}
