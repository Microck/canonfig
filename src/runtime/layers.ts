import { backupCommand } from "../backup/backup.ts";
import { reconcileBackupSchedules } from "../backup/backup-schedule.ts";
import { runtimeCredentialPolicy } from "./credential-policy.ts";
import { runtimeStateLayer } from "./state-layer.ts";
import {
  createPrivateKey,
  randomUUID,
  createPublicKey,
  sign as signPayload,
  verify as verifyPayload,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Effect, Layer, Option, Redacted, Schema } from "effect";

import { ProfileId, SourceSignature } from "../domain/brand.ts";
import { guiQueriesLayer } from "../gui/queries.ts";
import { localProjectionFollower } from "../domain/synchronization.ts";
import { AgentResolutionWithSecretsLive } from "../agent/agent-resolution.layer.ts";
import { AgentResolution } from "../agent/agent-resolution.service.ts";
import { EnrollmentLive } from "../enrollment/enrollment.layer.ts";
import { Enrollment } from "../enrollment/enrollment.service.ts";
import {
  authenticateFollower,
  cancelFollowerEnrollment,
  enrollFollower,
  finalizeFollowerEnrollment,
  listRevisions,
  queryFollowerLifecycle,
  revokeFollowerEnrollment,
} from "../enrollment/follower-client.ts";
import {
  deliverInvitationEnvelope,
  readInvitationEnvelope,
} from "../enrollment/invitation-envelope.ts";
import { refuseOnFollower, refuseOnSource } from "../state/machine-role.ts";
import { TunnelLive } from "../enrollment/tunnel.layer.ts";
import { Tunnel } from "../enrollment/tunnel.service.ts";
import {
  tunnelCarriesSource,
  withManagedTunnel,
} from "../enrollment/tunnel-supervision.ts";
import { startSourceServer } from "../enrollment/source-server.ts";
import { sourceServiceLayer } from "../source-service/source-service.layer.ts";
import { SourceService } from "../source-service/source-service.service.ts";
import { CredentialStorageError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { linuxMachineStateLayer } from "../machine/linux.layer.ts";
import { macosMachineStateLayer } from "../machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../machine/windows.layer.ts";
import { nativeSecretStoreLayer } from "../secrets/native-secret-store.ts";
import { clearTransferredSecrets } from "../secrets/secret-store.ts";
import { synchronizeSharedSecrets } from "../secrets/secret-client.ts";
import { secretFailureCategory } from "../secrets/cli.ts";
import { ProfileCatalog } from "../profile/profile-catalog.service.ts";
import {
  InvalidPublicationResourcesError,
  PublicationSigningError,
} from "../profile/profile-catalog.errors.ts";
import { scanFolder } from "../profile/discovery.ts";
import {
  makePublication,
  type ProfileRevisionSigner,
} from "../profile/publication.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import {
  desiredScheduleInput,
  type ResolvedScheduleInput,
  scheduleAvailableDetail,
  syncScheduleFromDefault,
  unmanagedScheduleDetail,
} from "../schedule/schedule-manager.types.ts";
import { scheduleManagerLayer, validateSchedule } from "../schedule/schedule-manager.layer.ts";
import { describeUnattendedRuns, currentScheduleFires } from "./readiness.ts";
import { setupCommandsLayer } from "../setup/setup.layer.ts";
import { MachineRoleConflictError } from "../state/state-repository.errors.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { SynchronizationLive } from "../synchronization/synchronization.layer.ts";
import { Synchronization } from "../synchronization/synchronization.service.ts";
import { runLockHolder, withRunLock } from "../synchronization/run-lock.ts";
import {
  followerConvergence,
  openRunReport,
} from "../synchronization/run-status.ts";
import {
  defaultScheduledInvocation,
  FollowerConfigurationFields,
} from "../synchronization/follower-sync-config.ts";
import type { FollowerSynchronizationConfiguration } from
  "../synchronization/follower-sync-config.ts";
import {
  appliedFileChanges,
  clientReviewSteps,
} from "../synchronization/client-review.ts";
import {
  abandonFollowerRun,
  recoverFollower,
  synchronizeFollower,
} from "../synchronization/follower-orchestration.ts";
import {
  abandonLocal,
  harnessesLocal,
  hasOpenLocalRun,
  importLocal,
  overlaysLocal,
  recoverLocal,
  restoreLocal,
  synchronizeLocal,
} from "../projection/sync.ts";
import { exportFolder, type ArchiveSigner } from "../projection/archive.ts";
import { authoredEntries } from "../projection/folder.ts";
import {
  FollowerCommands,
  type FollowerCommandsService,
} from "../cli/follower-commands.ts";
import {
  describeRuntimeError,
  type TaggedRuntimeError,
} from "../cli/failure-taxonomy.ts";
import {
  CliCommandFailure,
  SourceCommands,
  type CliPayload,
  type SourceCommandsService,
} from "../cli/source-commands.ts";
import type { CliFailureCategory } from "../cli/exit-codes.ts";
import {
  doctorFailureCategory,
  runDoctorProbes,
  type DoctorAgentConfiguration,
  type DoctorSourceConfiguration,
} from "./doctor.ts";

export interface RuntimeLayerOptions {
  readonly statePath?: string | undefined;
  readonly doctorSource?: DoctorSourceConfiguration | undefined;
  readonly doctorAgent?: DoctorAgentConfiguration | undefined;
}

const doctorSourceFromEnvironment = (): DoctorSourceConfiguration | undefined => {
  const endpoint = process.env.CANONFIG_SOURCE_ENDPOINT;
  const tlsFingerprint = process.env.CANONFIG_SOURCE_TLS_FINGERPRINT;
  const credentialReference = process.env.CANONFIG_SOURCE_CREDENTIAL_REFERENCE;
  if (
    endpoint === undefined
    && tlsFingerprint === undefined
    && credentialReference === undefined
  ) return undefined;
  return {
    endpoint: endpoint ?? "",
    tlsFingerprint: tlsFingerprint ?? "",
    credentialReference: credentialReference ?? "",
  };
};

const doctorAgentFromEnvironment = (): DoctorAgentConfiguration | undefined => {
  const adapter = process.env.CANONFIG_AGENT_ADAPTER;
  const executable = process.env.CANONFIG_AGENT_EXECUTABLE;
  if (adapter === undefined && executable === undefined) return undefined;
  return {
    adapter: adapter ?? "",
    executable: executable ?? "",
  };
};

const payload = <Value>(value: Value): CliPayload =>
  Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify(value)),
  );

/**
 * Turns a leaf error into the terminal CLI failure, classified by the failure
 * taxonomy rather than by matching words in the error's type name.
 *
 * `category` overrides the taxonomy's default for the leaf errors whose meaning
 * depends on where they were raised: a process timeout is transport while
 * fetching from the Source Machine and an apply failure while running an
 * installer, and only the caller knows which.
 */
const commandFailure = (
  error: TaggedRuntimeError,
  category?: CliFailureCategory,
): CliCommandFailure => {
  const described = describeRuntimeError(error);
  return new CliCommandFailure({
    category: category ?? described.category,
    message: described.message,
  });
};

/**
 * Every problem a profile contract or publication found, as operator text
 * from the failure taxonomy, bounded so a large invalid profile still reads.
 */
const profileProblems = (errors: ReadonlyArray<TaggedRuntimeError>): string => {
  const shown = errors.slice(0, 5).map((error) => describeRuntimeError(error).message);
  const hidden = errors.length - shown.length;
  return hidden > 0 ? `${shown.join("; ")}; and ${hidden} more` : shown.join("; ");
};

/** A publication whose resources fail the profile contract, one line per problem. */
const invalidResourcesFailure = (
  errors: ReadonlyArray<TaggedRuntimeError>,
): CliCommandFailure =>
  new CliCommandFailure({
    category: "usage-or-configuration",
    message: `the profile cannot be published: ${profileProblems(errors)}`,
  });

const mapFailure = <Success, Failure extends TaggedRuntimeError, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, CliCommandFailure, Requirements> =>
  effect.pipe(Effect.mapError(commandFailure));
const rollbackRecoveryDetail = "follower replacement rollback is pending; both credentials are retained. Bring the previous Source online, then retry the same `canonfig follower enroll --stdin --name <name> --replace` command with its invitation";


/** Keep the existing CLI evidence shape as a view of the canonical SQL records. */
const readScheduleFires = (repository: StateRepository["Service"]) =>
  Effect.gen(function*() {
    const invocations = yield* mapFailure(repository.listScheduledInvocations());
    return invocations.map((invocation) => ({
      id: invocation.id, generation: invocation.generation, startedAt: invocation.startedAt,
      at: invocation._tag === "Running" ? invocation.startedAt : invocation.at,
      outcome: invocation._tag === "Running" ? "started" : invocation._tag === "Completed" ? "completed" : "failed",
      reason: invocation._tag === "Failed" ? invocation.reason : undefined,
    }));
  });

/** The part of a failed run's details that names why the run failed. */
const FailedRunDetails = Schema.Struct({
  outcome: Schema.Struct({ reason: Schema.String }),
});

/**
 * Why an unattended run failed, as the fire record keeps it. A scheduled run
 * has no terminal and launchd discards its stderr, so this is the only place
 * status and doctor can learn the reason from.
 */
const fireFailureReason = (failure: CliCommandFailure): string => {
  const runReason = Option.match(
    Schema.decodeUnknownOption(FailedRunDetails)(failure.details),
    {
      onNone: () => "",
      onSome: (details) => `: ${details.outcome.reason}`,
    },
  );
  return `${failure.category}: ${failure.message}${runReason}`.slice(0, 2048);
};

/** Why this follower has no native job, and what to run to get one. */
const unscheduledDetail = (
  configuration: FollowerSynchronizationConfiguration | undefined,
): string => {
  if (configuration === undefined) return "no follower is enrolled; enroll and apply a profile before selecting a schedule";
  if (configuration.lifecycle._tag !== "Active") return "follower enrollment is pending; finish or resume enrollment before selecting a schedule";
  if (configuration.scheduleOverride?.kind === "disabled") {
    return "scheduled synchronization is off on this follower (`canonfig schedule remove`); run `canonfig schedule set` to turn it on";
  }
  return configuration?.scheduleDefault === undefined
    ? "no schedule is selected; run `canonfig schedule set <calendar>` to schedule synchronization"
    : scheduleAvailableDetail(configuration.scheduleDefault);
};

const persistScheduleOverride = (
  repository: StateRepository["Service"],
  scheduleOverride: FollowerSynchronizationConfiguration["scheduleOverride"],
): Effect.Effect<void, CliCommandFailure> =>
  mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
    Effect.flatMap((configuration) => {
      const unavailable = () => scheduleOverride?.kind === "disabled" ? Effect.void
        : Effect.fail(new CliCommandFailure({
          category: "usage-or-configuration",
          message: "canonfig schedule set needs an enrolled follower; enroll, then apply the selected profile first",
        }));
      if (configuration === undefined) return unavailable();
      if (configuration.lifecycle._tag !== "Active" && scheduleOverride?.kind !== "disabled") {
        return Effect.fail(new CliCommandFailure({
          category: "usage-or-configuration",
          message: "follower enrollment is pending; finish or resume enrollment before selecting a schedule",
        }));
      }
      return mapFailure(repository.loadState(configuration.follower.id)).pipe(
        Effect.flatMap((state) =>
          state.sourceIdentity === undefined ? unavailable() : mapFailure(
            repository.saveFollowerSynchronizationConfiguration({
              expectedConfiguration: configuration,
              sourceIdentity: state.sourceIdentity,
              configuration: {
                ...configuration,
                scheduleOverride,
                updatedAt: new Date().toISOString(),
              },
            }),
          )
        ),
      );
    }),
  );

/**
 * What this follower's native job should be, or undefined when it should have
 * none. See `desiredScheduleInput`: `schedule status`, doctor, and the
 * post-apply reconciler share it, so none of them compares the installed job
 * against a built-in constant or against a different notion of drift.
 */
const finalizedScheduleInput = (configuration: FollowerSynchronizationConfiguration | undefined): ResolvedScheduleInput | undefined =>
  (configuration !== undefined && configuration.lifecycle._tag !== "Active") ? undefined
    : desiredScheduleInput(configuration?.scheduleOverride, configuration?.scheduleDefault);

const effectiveScheduleInput = (
  repository: StateRepository["Service"],
): Effect.Effect<ResolvedScheduleInput | undefined, CliCommandFailure> =>
  mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
    Effect.map(finalizedScheduleInput),
  );

/** How the Source can run unattended; appended where its keys are unreachable. */
const supervisedSourceModes =
  "Unlock the Source credential store in the session that runs the service, then supervise it with `canonfig source service install`. "
  + "Linux linger (`loginctl enable-linger <user>`) extends the user manager lifecycle to boot and logout, but does not unlock an encrypted login keyring. Verify `canonfig source service status` reports `serving: true` in the intended mode";

/** Source commands; `folder` is the Canonical Folder that holds the state database. */
const sourceCommandsLayer = (folder: string): Layer.Layer<
  SourceCommands,
  never,
  Enrollment | MachineState | ProfileCatalog | StateRepository | SourceService
> => Layer.effect(
  SourceCommands,
  Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    const machine = yield* MachineState;
    const profiles = yield* ProfileCatalog;
    const repository = yield* StateRepository;
    const sourceService = yield* SourceService;
    const sourceIdentity = enrollment.source().pipe(
      Effect.map((material) => ({
        tlsFingerprint: material.tlsFingerprint,
        sourceFingerprint: material.source.publicKeyFingerprint,
      })),
    );
    // A Follower's folder is its Source's mirror, so every Source command
    // that would scan, publish, serve or hand out access stops here before it
    // touches anything. `source init` is refused in Enrollment.initializeSource,
    // which a Source setup's apply reaches too. `service status` and
    // `service remove` stay available: they only report or clean up.
    const asSource = (
      action: string,
      effect: Effect.Effect<CliPayload, CliCommandFailure>,
    ): Effect.Effect<CliPayload, CliCommandFailure> =>
      mapFailure(refuseOnFollower(repository, action)).pipe(Effect.andThen(effect));

    const service: SourceCommandsService = {
      initialize: () => mapFailure(enrollment.initializeSource()).pipe(Effect.map(payload)),
      scan: (input) =>
        asSource("scan its folder for tools", mapFailure(profiles.scan({ folder, write: input.write })).pipe(Effect.map(payload))),
      publish: (input) =>
        asSource("publish a revision", profiles.publish({ folder, reviewer: input.reviewer, publishedAt: new Date().toISOString() }).pipe(
          Effect.mapError((error) =>
            error instanceof InvalidPublicationResourcesError
              ? invalidResourcesFailure(error.errors)
              : commandFailure(error)
          ),
          Effect.map(payload),
        )),
      serve: (input) =>
        asSource("serve as a Source", mapFailure(startSourceServer(input).pipe(
          Effect.provideService(Enrollment, enrollment),
          Effect.provideService(MachineState, machine),
          // A Source whose keys sit in a store this session cannot reach
          // (no user session bus, a locked Keychain) is told how it can run
          // unattended, next to the store's own recovery text.
          Effect.mapError((error) => {
            const cause: unknown = error;
            return cause instanceof CredentialStorageError
              ? new CredentialStorageError({
                operation: cause.operation,
                reference: cause.reference,
                message: `${cause.message}. ${supervisedSourceModes}`,
              })
              : error;
          }),
        )).pipe(
          Effect.map((handle) => payload({
            endpoint: handle.endpoint,
            fingerprint: handle.fingerprint,
          })),
        )),
      installService: (input) =>
        asSource("install the Source service", Effect.gen(function*() {
          const identity = yield* sourceIdentity.pipe(
            Effect.mapError((error) => {
              const failure = commandFailure(error);
              return new CliCommandFailure({
                category: failure.category,
                message:
                  `the Source service serves this machine's Source identity, which is unavailable: ${failure.message}. Run \`canonfig source init\` first if this machine is not a Source yet`,
              });
            }),
          );
          return payload(yield* mapFailure(sourceService.install(input, identity)));
        })),
      serviceStatus: () =>
        Effect.gen(function*() {
          const identity = yield* sourceIdentity.pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          const status = yield* mapFailure(sourceService.status(identity));
          if (status.state === "running" || status.state === "not-installed") {
            return payload(status);
          }
          return yield* new CliCommandFailure({
            category: status.state === "drifted" ? "conflict-or-drift" : "human-action-required",
            message: status.detail,
            details: payload(status),
          });
        }),
      removeService: () => mapFailure(sourceService.remove()).pipe(Effect.map(payload)),
      invite: (input) =>
        asSource("invite followers", Effect.gen(function*() {
          const grant = yield* mapFailure(enrollment.createInvitation(input));
          const outputPath = yield* mapFailure(deliverInvitationEnvelope({
            grant,
            path: input.outputPath,
            timeoutMilliseconds: input.timeoutMilliseconds,
          }).pipe(
            Effect.catch((deliveryError) =>
              enrollment.removeInvitation(grant.code).pipe(
                Effect.flatMap(() => Effect.fail(deliveryError)),
              )
            ),
          ));
          return payload({
            outputPath,
            endpoint: grant.endpoint,
            expiresAt: grant.expiresAt,
            groups: grant.groups,
          });
        })),
      revoke: (follower) =>
        asSource("revoke followers", mapFailure(enrollment.revokeFollower(follower)).pipe(
          Effect.as(payload({ follower, revoked: true })),
        )),
      listProfiles: () =>
        mapFailure(repository.listRevisions()).pipe(
          Effect.map((revisions) => payload({
            revisions: revisions.map((revision) => ({
              id: revision.id,
              profileId: revision.profileId,
              sequence: revision.sequence,
              digest: revision.digest,
              publishedAt: revision.publishedAt,
            })),
          })),
        ),
      inspectProfile: (revision) =>
        mapFailure(profiles.getRevision(revision)).pipe(Effect.map(payload)),
    };
    return SourceCommands.of(service);
  }),
);

/**
 * The Source's signing key as a signer. The key is checked against the
 * recorded Source identity: a key another state directory stored under an
 * earlier release's account-global name must never sign for this Source. A
 * local store failure or mismatch keeps its own category and text. Profile
 * Revisions and `canonfig export` manifests are both signed through it.
 */
const loadSourceSigner = (enrollment: Enrollment["Service"]) =>
  Effect.gen(function*() {
    const credentials = yield* enrollment.sourceCredentials().pipe(
      Effect.mapError((error) =>
        error._tag === "CredentialStorageError" || error._tag === "SourceCredentialMismatchError"
          ? error
          : new PublicationSigningError({
            operation: "sign",
            reason: error.message,
          })
      ),
    );
    const material = credentials.material;
    const encodedKey = credentials.signingPrivateKey;
    const privateKey = yield* Effect.try({
      try: () => createPrivateKey(Redacted.value(encodedKey)),
      catch: (error) =>
        new PublicationSigningError({
          operation: "sign",
          reason: String(error),
        }),
    });
    const publicKey = createPublicKey(privateKey);
    const signer: ProfileRevisionSigner = {
      keyId: material.source.keyId,
      sign: (value) =>
        Effect.try({
          try: () => Schema.decodeUnknownSync(SourceSignature)(
            `ed25519:${signPayload(
              null,
              Buffer.from(value),
              privateKey,
            ).toString("base64url")}`,
          ),
          catch: (error) =>
            new PublicationSigningError({
              operation: "sign",
              reason: String(error),
            }),
        }),
      verify: (value, signature) =>
        Effect.try({
          try: () =>
            signature.startsWith("ed25519:")
            && verifyPayload(
              null,
              Buffer.from(value),
              publicKey,
              Buffer.from(signature.slice("ed25519:".length), "base64url"),
            ),
          catch: (error) =>
            new PublicationSigningError({
              operation: "verify",
              reason: String(error),
            }),
        }),
    };
    // sourceCredentials proved the key hashes to this fingerprint.
    const archiveSigner: ArchiveSigner = {
      fingerprint: material.source.publicKeyFingerprint,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      sign: signer.sign,
    };
    return { signer, archiveSigner };
  });

const runtimeProfileCatalogLayer: Layer.Layer<
  ProfileCatalog,
  never,
  Enrollment | StateRepository
> = Layer.effect(
  ProfileCatalog,
  Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    const repository = yield* StateRepository;
    return ProfileCatalog.of({
      scan: scanFolder,
      publish: (input) =>
        Effect.gen(function*() {
          const { signer } = yield* loadSourceSigner(enrollment);
          return yield* makePublication(signer, repository).publish(input);
        }),
      getRevision: repository.getRevision,
    });
  }),
);

/**
 * Agent policy belongs to an enrolled Follower Machine: only follower runs
 * call an agent, and they read the policy from the follower configuration.
 * A Source or an unenrolled machine has no policy to read or set.
 */
const agentPolicyRequiresFollower = () => new CliCommandFailure({
  category: "usage-or-configuration",
  message: "agent policy is set on each Follower Machine; this machine is not an enrolled Follower Machine",
});

const followerCommandsLayer = (
  statePath: string,
  doctorSource: DoctorSourceConfiguration | undefined,
  doctorAgent: DoctorAgentConfiguration | undefined,
): Layer.Layer<
  FollowerCommands,
  never,
  Enrollment | MachineState | ScheduleManager | StateRepository
  | Synchronization | AgentResolution | Tunnel
> => Layer.effect(
  FollowerCommands,
  Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    const machine = yield* MachineState;
    const schedules = yield* ScheduleManager;
    const repository = yield* StateRepository;
    const synchronization = yield* Synchronization;
    const agentResolution = yield* AgentResolution;
    const tunnel = yield* Tunnel;
    const withEnrollmentLock = <A>(operation: Effect.Effect<A, CliCommandFailure>) =>
      withRunLock(statePath, "change follower enrollment", operation).pipe(
        Effect.mapError((error) => error instanceof CliCommandFailure ? error : commandFailure(error)),
      );
    const recoverStagedCredentials = Effect.gen(function*() {
      yield* mapFailure(repository.recoverEnrollmentCredentialStaging());
      for (const retiring of yield* mapFailure(repository.listEnrollmentCredentialRetirements())) {
        yield* mapFailure(machine.removeCredential(retiring.credentialReference));
        yield* mapFailure(repository.completeEnrollmentCredentialRetirement(retiring.credentialReference));
      }
    });
    const finishEnrollment = Effect.fn("Follower.finishEnrollment")(function*(
      initial: FollowerSynchronizationConfiguration,
    ) {
      if (initial.lifecycle._tag === "Unenrolling") return yield* new CliCommandFailure({
        category: "human-action-required",
        message: "follower unenrollment has started; run `canonfig follower unenroll` to finish it before enrolling again",
      });
      const state = yield* mapFailure(repository.loadState(initial.follower.id));
      if (state.sourceIdentity === undefined) return yield* new CliCommandFailure({
        category: "usage-or-configuration", message: "follower source identity is not configured",
      });
      const sourceIdentity = state.sourceIdentity;
      const save = (previous: FollowerSynchronizationConfiguration, lifecycle: FollowerSynchronizationConfiguration["lifecycle"]) => {
        const next = { ...previous, lifecycle, updatedAt: new Date().toISOString() };
        return mapFailure(repository.saveFollowerSynchronizationConfiguration({
          sourceIdentity,
          expectedConfiguration: previous,
          configuration: next,
        })).pipe(Effect.as(next));
      };
      let configuration = initial;
      if (configuration.lifecycle._tag === "Finalizing") {
        const finalization = yield* finalizeFollowerEnrollment({
          endpoint: configuration.source.endpoint,
          tlsFingerprint: configuration.source.tlsFingerprint,
          credentialReference: configuration.credentialReference,
        }).pipe(Effect.provideService(MachineState, machine), Effect.result);
        if (finalization._tag === "Failure") {
          const previous = configuration.lifecycle.previous;
          if (finalization.failure._tag !== "InvalidFollowerCredentialError") {
            return yield* mapFailure(Effect.fail(finalization.failure));
          }
          if (previous === undefined) {
            yield* mapFailure(repository.removeFollowerSynchronizationConfiguration(configuration));
            yield* recoverStagedCredentials;
            return yield* new CliCommandFailure({
              category: "human-action-required",
              message: "the Source discarded the pending enrollment; enroll again with a new invitation",
            });
          }
          configuration = yield* save(configuration, { _tag: "RollbackPending", previous });
        } else {
        configuration = yield* save(configuration, configuration.lifecycle.previous === undefined
          ? { _tag: "Active" }
          : {
            _tag: "RetiringPrevious", previous: configuration.lifecycle.previous,
            cleanup: { _tag: configuration.lifecycle.previous.follower.id === configuration.follower.id ? "RemoveLocal" : "RevokeRemote" },
          });
        }
      }
      if (configuration.lifecycle._tag === "RollbackPending") {
        const previous = configuration.lifecycle.previous;
        // Never guess that the old authority still works after the candidate
        // disappears. An offline check leaves both credentials durably owned.
        yield* mapFailure(authenticateFollower({
          endpoint: previous.source.endpoint, tlsFingerprint: previous.source.tlsFingerprint,
          credentialReference: previous.credentialReference,
        }).pipe(Effect.provideService(MachineState, machine))).pipe(
          Effect.mapError((error) => new CliCommandFailure({
            category: error.category,
            message: `${rollbackRecoveryDetail}. ${error.message}`,
          })),
        );
        const restored: FollowerSynchronizationConfiguration = {
          ...Schema.decodeUnknownSync(FollowerConfigurationFields)(previous),
          lifecycle: { _tag: "Active" }, updatedAt: new Date().toISOString(),
        };
        yield* mapFailure(repository.saveFollowerSynchronizationConfiguration({
          expectedConfiguration: configuration, configuration: restored, sourceIdentity: previous.sourceIdentity,
        }));
        yield* recoverStagedCredentials;
        return { _tag: "Restored" as const, configuration: restored, source: previous.sourceIdentity };
      }
      if (configuration.lifecycle._tag === "RetiringPrevious") {
        const previous = configuration.lifecycle.previous;
        if (configuration.lifecycle.cleanup._tag === "RevokeRemote") {
          yield* mapFailure(revokeFollowerEnrollment({
            endpoint: previous.source.endpoint, tlsFingerprint: previous.source.tlsFingerprint,
            credentialReference: previous.credentialReference,
          }).pipe(Effect.provideService(MachineState, machine)));
          configuration = yield* save(configuration, {
            _tag: "RetiringPrevious", previous, cleanup: { _tag: "RemoveLocal" },
          });
        }
        yield* mapFailure(machine.removeCredential(previous.credentialReference));
        configuration = yield* save(configuration, { _tag: "Active" });
      }
      return { _tag: "Finished" as const, configuration, source: state.sourceIdentity };
    });
    const outcomePayload = <Value extends {
      readonly outcome?: {
        readonly outcome: string;
      } | undefined;
    }>(value: Value) => {
      const outcome = value.outcome?.outcome;
      if (outcome === "HumanActionRequired") {
        return Effect.fail(new CliCommandFailure({
          category: "human-action-required",
          message: "synchronization requires human action",
          details: payload(value),
        }));
      }
      if (outcome === "FollowerDrift") {
        return Effect.fail(new CliCommandFailure({
          category: "conflict-or-drift",
          message: "follower drift conflicts with the selected revision",
          details: payload(value),
        }));
      }
      if (outcome === "Failed" || outcome === "Interrupted") {
        return Effect.fail(new CliCommandFailure({
          category: "verification-or-apply-failure",
          message: outcome === "Interrupted"
            ? "synchronization was interrupted"
            : "synchronization failed",
          details: payload(value),
        }));
      }
      return Effect.succeed(payload(value));
    };

    const completionReceipt = (
      configuration: FollowerSynchronizationConfiguration,
    ) =>
      Effect.gen(function*() {
        const deployment = yield* mapFailure(
          repository.latestDeploymentReceipt(configuration.follower.id),
        );
        if (deployment === undefined) {
          const notReached = (detail: string) => ({
            status: "not-reached" as const,
            detail,
          });
          return {
            published: notReached("no completed synchronization run"),
            applied: notReached("no completed synchronization run"),
            clientLoaded: notReached("no completed synchronization run"),
            scheduled: notReached("first apply has not completed"),
            independentlyVerified: notReached("no completed synchronization run"),
            mcpQualifications: [],
            secondRunNoOp: false,
          };
        }
        const [revision, approval, runEvidence, applied] = yield* Effect.all([
          mapFailure(repository.findRevision(deployment.revision)),
          mapFailure(repository.loadRevisionApproval(deployment.revision)),
          mapFailure(repository.loadRunEvidence(deployment.run)),
          mapFailure(repository.loadAppliedResources(configuration.follower.id)),
        ]);
        const pendingClientSteps = clientReviewSteps(appliedFileChanges(applied));
        const stage = (
          verified: boolean,
          detail: string,
        ) => ({
          status: verified ? "verified" as const : "not-verified" as const,
          detail,
        });
        const qualifiedClientMethods = runEvidence?.mcpQualifications
          .filter((receipt) =>
            receipt.stages.some((stage) =>
              stage.stage === "client-loaded" && stage.status === "passed"
            )
          )
          .map((receipt) => `mcp-qualification:${receipt.target}`) ?? [];
        const clientMethods = [
          ...(runEvidence?.passedVerificationMethods
            .filter((method) => method.startsWith("client-load:")) ?? []),
          ...qualifiedClientMethods,
        ];
        const scheduleInput = finalizedScheduleInput(configuration);
        const fires = yield* readScheduleFires(repository);
        const scheduled = scheduleInput === undefined
          ? { status: "not-selected" as const, detail: unscheduledDetail(configuration) }
          : yield* schedules.status(scheduleInput).pipe(
            Effect.match({
              onFailure: (error) => ({
                status: "not-verified" as const,
                detail: error.message,
              }),
              onSuccess: (status) => {
                const runs = describeUnattendedRuns(currentScheduleFires(status, fires));
                const verified = status.state === "current" && status.bindingUsable === true && runs.completed;
                return {
                  status: verified ? "verified" as const : "pending" as const,
                  detail: status.state === "current"
                    ? `native schedule is current; ${runs.text}`
                    : `native schedule is ${status.state}: ${status.detail}`,
                };
              },
            }),
          );
        const allVerificationsPassed = runEvidence !== undefined
          && runEvidence.outcome === "Converged"
          && runEvidence.verifiedActions === runEvidence.passedVerifications
          && runEvidence.mcpQualifications.every((receipt) => receipt.ready);
        const approvalBound = revision !== undefined
          && approval?.revisionDigest === revision.digest;
        return {
          run: deployment.run,
          revision: deployment.revision,
          published: stage(
            revision !== undefined,
            revision === undefined
              ? "the applied revision is not stored locally"
              : approval !== undefined && approvalBound
              ? `signed revision is stored with approval ${approval.proposalDigest}`
              : "signed revision is stored; publication approval is held by the Source",
          ),
          applied: stage(
            deployment.outcome === "Converged",
            `deployment receipt outcome is ${deployment.outcome}`,
          ),
          clientLoaded: stage(
            clientMethods.length > 0,
            clientMethods.length > 0
              ? `client loading verified by ${clientMethods.join(", ")}`
              : pendingClientSteps.length === 0
              ? "the revision declared no successful client-load verification"
              : `the revision declared no successful client-load verification; check each client yourself: ${pendingClientSteps.map((step) => `${step.summary} for ${step.target}`).join("; ")}`,
          ),
          scheduled,
          independentlyVerified: stage(
            allVerificationsPassed,
            runEvidence === undefined
              ? "completed-run verification evidence is unavailable"
              : `${runEvidence.passedVerifications}/${runEvidence.verifiedActions} journaled verifications passed`,
          ),
          mcpQualifications: runEvidence?.mcpQualifications ?? [],
          secondRunNoOp: runEvidence?.mutatingActions === 0,
          build: {
            packageVersion: deployment.packageVersion,
            identity: deployment.buildIdentity,
            stateFormat: deployment.stateFormat,
          },
        };
      });

    const service: FollowerCommandsService = {
      backup: request => mapFailure(backupCommand({ statePath,
        sourceSigner: loadSourceSigner(enrollment).pipe(Effect.map(({ archiveSigner }) => archiveSigner)),
        environment: name => process.env[name],
      }, request).pipe(
        Effect.provideService(StateRepository, repository), Effect.provideService(MachineState, machine),
        Effect.provideService(Synchronization, synchronization),
      )).pipe(Effect.map(payload)),
      enroll: (input) =>
        Effect.gen(function*() {
            // A Source's folder is what it authors and publishes; enrolling
            // would turn it into another Source's mirror. Checked before the
            // invitation is used, so it stays valid for another machine.
            yield* mapFailure(refuseOnSource(repository, "enroll as a Follower", dirname(statePath)));
            // This machine's own projection becomes the follower's at
            // enrollment (adoptLocalProjection below), so an unfinished
            // local run has to be resolved first.
            if ((yield* mapFailure(repository.loadOpenRunIdentity(localProjectionFollower))) !== undefined) {
              return yield* new CliCommandFailure({
                category: "conflict-or-drift",
                message: "this machine has an unfinished local sync; run 'canonfig recover' or 'canonfig abandon', then enroll",
              });
            }
            let existing = yield* mapFailure(
              repository.getFollowerSynchronizationConfiguration(),
            );
            yield* recoverStagedCredentials;
            if (existing !== undefined && existing.lifecycle._tag !== "Active") {
              const finished = yield* finishEnrollment(existing);
              if (finished._tag === "Finished") {
                const adopted = yield* mapFailure(repository.adoptLocalProjection(existing.follower.id));
                return payload({
                  follower: finished.configuration.follower, profile: finished.configuration.profile,
                  source: finished.source, resumed: true, adoptedLocalRecords: adopted,
                });
              }
              existing = finished.configuration;
            }
            // A completed enrollment is a singleton. Enrolling a different
            // name over it silently left the previous identity's Applied
            // Resource Records orphaned in the database under an id nothing
            // used, and its credential in the store, so taking a new identity
            // has to be asked for.
            //
            // Re-enrolling under the same name is credential rotation, which is
            // a supported flow: the identity is unchanged, so there is nothing
            // to orphan.
            if (
              existing !== undefined
              && existing.lifecycle._tag === "Active"
              && existing.follower.name !== input.followerName
            ) {
              if (!input.replace) {
                return yield* new CliCommandFailure({
                  category: "conflict-or-drift",
                  message:
                    `this machine is already enrolled as ${existing.follower.name} (${existing.follower.id}); pass --replace to enroll it as ${input.followerName} instead`,
                });
              }
              // Replacing is explicit. The superseded identity is revoked on
              // its Source and its credential removed once the new identity
              // is enrolled, so a failed replacement keeps the working one.
            }
            // A follower's authoring entries are the Source's mirror. Items
            // this machine authored there itself would block its first sync
            // as drift, so the machine moves them into local/ (or removes
            // them) before it enrolls. A completed enrollment already holds
            // its mirror there, so rotation and --replace skip the check.
            if (existing === undefined) {
              const folder = dirname(statePath);
              const authored = yield* Effect.tryPromise({
                try: () => authoredEntries(folder),
                catch: (cause) => new CliCommandFailure({
                  category: "usage-or-configuration",
                  message: `${folder} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
              });
              if (authored.length > 0) {
                return yield* new CliCommandFailure({
                  category: "usage-or-configuration",
                  message:
                    `${folder} already holds authored items (${authored.join(", ")}), where a follower keeps its Source's mirror; move what this machine should keep into ${join(folder, "local")} (rules, skills, agents and commands as files, MCP servers and settings in local.jsonc) or remove them, then enroll again`,
                });
              }
            }

            const prepared = yield* mapFailure(enrollFollower({
              ...input,
              finalize: false,
              beforeStoreCredential: (reference) => repository.stageEnrollmentCredential(reference).pipe(
                Effect.mapError(() => new CredentialStorageError({
                  operation: "stage follower credential", reference: "follower credential",
                  message: "credential ownership could not be recorded; no credential was written",
                })),
              ),
            }).pipe(Effect.provideService(MachineState, machine)));
            const follower = {
              ...prepared.follower,
              credentialReference: prepared.credentialReference,
            };
            const authorizedProfiles = prepared.authorizedProfiles
              ?? (yield* mapFailure(listRevisions({
                endpoint: input.invitation.endpoint,
                tlsFingerprint: prepared.tlsFingerprint,
                sourceFingerprint: prepared.source.publicKeyFingerprint,
                credentialReference: prepared.credentialReference,
                timeoutMilliseconds:
                  input.timeoutMilliseconds ?? defaultScheduledInvocation.timeoutMilliseconds,
              }).pipe(Effect.provideService(MachineState, machine)))).revisions;
            // One Source publishes one Machine Profile: the follower follows
            // whichever profile its authorized revisions name.
            const profiles = [...new Set(authorizedProfiles.map((revision) => revision.profileId))];
            if (profiles.length !== 1) {
              yield* cancelFollowerEnrollment({
                endpoint: input.invitation.endpoint,
                tlsFingerprint: prepared.tlsFingerprint,
                credentialReference: prepared.credentialReference,
              }).pipe(
                Effect.provideService(MachineState, machine),
                Effect.ignore,
              );
              return yield* new CliCommandFailure({
                category: "usage-or-configuration",
                message: profiles.length === 0
                  ? "the Source has no revision this follower may sync; run 'canonfig source publish' on the Source first"
                  : `the Source publishes more than one profile (${profiles.join(", ")}); a Source publishes one`,
              });
            }
            const profile = Schema.decodeUnknownSync(ProfileId)(profiles[0]);
            const source = prepared.source;
            const capability = yield* mapFailure(machine.credentialCapability());
            const enrolledCredentialPolicy:
              FollowerSynchronizationConfiguration["credentialPolicy"] =
                capability.kind === "local-file"
                  // MachinePath is a struct, not a string: take its absolute
                  // path rather than stringifying the object.
                  ? { kind: "local-file", path: capability.path.absolute }
                  : { kind: "secure-store" };
            // Same identity again (a new invitation for the same name) is a
            // credential rotation: the follower-owned settings stay. A new
            // identity starts from defaults, and the reply lists every
            // setting that was reset.
            const previous = existing !== undefined && existing.lifecycle._tag === "Active"
              ? existing
              : undefined;
            const previousSource = previous === undefined ? undefined
              : (yield* mapFailure(repository.loadState(previous.follower.id))).sourceIdentity;
            if (previous !== undefined && previousSource === undefined) return yield* new CliCommandFailure({
              category: "usage-or-configuration", message: "the previous follower Source identity is unavailable",
            });
            const rotated = previous !== undefined && previous.follower.id === follower.id;
            const resets = previous === undefined || rotated
              ? []
              : [
                ...(previous.agentPolicy === "deterministic-only"
                  ? []
                  : [`agent policy ${previous.agentPolicy} reset to deterministic-only`]),
                ...(previous.agentHarness === undefined
                  ? []
                  : [`agent harness ${previous.agentHarness.kind} removed with its ${previous.agentHarness.secretBindings?.length ?? 0} secret bindings`]),
                ...(previous.scheduleOverride === undefined
                  ? []
                  : [`schedule choice ${previous.scheduleOverride.kind} removed`]),
              ];
            const kept = rotated
              ? {
                agentPolicy: previous.agentPolicy,
                agentHarness: previous.agentHarness,
                scheduleOverride: previous.scheduleOverride,
                scheduleDefault: previous.scheduleDefault,
                localExecution: previous.localExecution,
              }
              : {};
            const configuration: FollowerSynchronizationConfiguration = {
              schemaVersion: 1 as const,
              follower,
              profile,
              source: {
                endpoint: input.invitation.endpoint,
                tlsFingerprint: prepared.tlsFingerprint,
                signingFingerprint: prepared.source.publicKeyFingerprint,
              },
              credentialReference: prepared.credentialReference,
              cacheDirectory: join(dirname(statePath), "cache"),
              stateLocation: statePath,
              agentPolicy: "deterministic-only" as const,
              // Record how this machine keeps its credential, so a later run
              // does not have to rediscover it from the environment.
              credentialPolicy: enrolledCredentialPolicy,
              lifecycle: { _tag: "Finalizing", previous: previous === undefined || previousSource === undefined
                ? undefined : { ...Schema.decodeUnknownSync(FollowerConfigurationFields)(previous), sourceIdentity: previousSource } },
              scheduledInvocation: {
                ...defaultScheduledInvocation,
                timeoutMilliseconds: input.timeoutMilliseconds
                  ?? (rotated ? previous?.scheduledInvocation.timeoutMilliseconds : undefined)
                  ?? defaultScheduledInvocation.timeoutMilliseconds,
              },
              updatedAt: new Date().toISOString(),
              ...kept,
            };
            const stateIdentity = source;
            const saved = yield* repository.saveFollowerSynchronizationConfiguration({
              sourceIdentity: stateIdentity,
              expectedConfiguration: existing,
              configuration,
            }).pipe(
              Effect.match({
                onSuccess: () => ({ ok: true as const }),
                onFailure: (error) => ({ ok: false as const, error }),
              }),
            );
            if (!saved.ok) {
              const cancelled = yield* cancelFollowerEnrollment({
                endpoint: input.invitation.endpoint,
                tlsFingerprint: prepared.tlsFingerprint,
                credentialReference: prepared.credentialReference,
              }).pipe(
                Effect.provideService(MachineState, machine),
                Effect.match({ onSuccess: () => true, onFailure: () => false }),
              );
              // This machine became a Source after the early check passed
              // (a concurrent `source init`): the save refused under the
              // write lock, and the invitation is spent on the Source.
              if (saved.error instanceof MachineRoleConflictError) {
                return yield* new CliCommandFailure({
                  category: "usage-or-configuration",
                  message: cancelled
                    ? `${saved.error.message}. The Source had already accepted the invitation; the enrollment was cancelled there, so ask it for a new invitation`
                    : `${saved.error.message}. The Source had already accepted the invitation and the enrollment could not be cancelled there; run \`canonfig source revoke ${prepared.follower.id}\` on the Source`,
                });
              }
              return yield* mapFailure(Effect.fail(saved.error));
            }
            const finished = yield* finishEnrollment(configuration);
            if (finished._tag === "Restored") return yield* new CliCommandFailure({
              category: "human-action-required",
              message: "the Source discarded the replacement; the previous enrollment was authenticated and restored. Retry the same enrollment command with its invitation",
            });
            const previousIdentity = previous === undefined ? undefined : rotated
              ? { follower: previous.follower.id, credentialRemoved: true }
              : { follower: previous.follower.id, credentialRemoved: true, revoked: true, detail: "revoked on its Source" };
            // The harness surfaces this machine projected from its own
            // folder now belong to the follower's runs, which update them
            // under the same three-way rule.
            const adopted = yield* mapFailure(repository.adoptLocalProjection(follower.id));
            return payload({
              follower,
              profile,
              source: prepared.source,
              rotated,
              resets,
              previousIdentity,
              adoptedLocalRecords: adopted,
            });
          }).pipe(withEnrollmentLock),
      unenroll: () =>
        Effect.gen(function*() {
          let configuration = yield* mapFailure(
            repository.getFollowerSynchronizationConfiguration(),
          );
          if (configuration === undefined) {
            return payload({
              unenrolled: false,
              detail: "this machine is not enrolled; nothing was removed",
            });
          }
          yield* recoverStagedCredentials;
          if (configuration.lifecycle._tag !== "Unenrolling") {
            const state = yield* mapFailure(repository.loadState(configuration.follower.id));
            if (state.sourceIdentity === undefined) return yield* new CliCommandFailure({
              category: "usage-or-configuration", message: "follower source identity is not configured",
            });
            const next = {
              ...configuration,
              lifecycle: {
                _tag: "Unenrolling" as const,
                previous: "previous" in configuration.lifecycle ? configuration.lifecycle.previous : undefined,
              },
              updatedAt: new Date().toISOString(),
            };
            yield* mapFailure(repository.saveFollowerSynchronizationConfiguration({
              sourceIdentity: state.sourceIdentity, expectedConfiguration: configuration, configuration: next,
            }));
            configuration = next;
          }
          if (configuration.lifecycle._tag === "Unenrolling" && configuration.lifecycle.previous !== undefined) {
            const previous = configuration.lifecycle.previous;
            yield* revokeFollowerEnrollment({
              endpoint: previous.source.endpoint, tlsFingerprint: previous.source.tlsFingerprint,
              credentialReference: previous.credentialReference,
            }).pipe(Effect.provideService(MachineState, machine), Effect.ignore);
            yield* mapFailure(machine.removeCredential(previous.credentialReference));
          }
          const follower = configuration.follower.id;
          // Revoke on the Source first, while the credential still exists.
          // An unreachable Source does not keep the machine enrolled: the
          // reply says so and names the command to run there.
          const authority = {
            endpoint: configuration.source.endpoint,
            tlsFingerprint: configuration.source.tlsFingerprint,
            credentialReference: configuration.credentialReference,
          };
          const source = yield* revokeFollowerEnrollment(authority).pipe(
            Effect.provideService(MachineState, machine),
            Effect.catchTag("InvalidFollowerCredentialError", () =>
              cancelFollowerEnrollment(authority).pipe(Effect.provideService(MachineState, machine))),
            Effect.match({
              onSuccess: () => ({ revoked: true, detail: "revoked on the Source" }),
              onFailure: (error) => ({
                revoked: false,
                detail: `${error.message}; revoke it on the Source with \`canonfig source revoke ${follower}\``,
              }),
            }),
          );
          yield* mapFailure(machine.removeCredential(configuration.credentialReference));
          const secrets = yield* clearTransferredSecrets().pipe(
            Effect.provideService(MachineState, machine),
            Effect.match({
              onSuccess: (names) => ({ removed: names, detail: undefined }),
              onFailure: (error) => ({ removed: [], detail: error.message }),
            }),
          );
          yield* mapFailure(repository.removeFollowerSynchronizationConfiguration(configuration));
          return payload({
            unenrolled: true,
            follower,
            sourceRevoked: source.revoked,
            sourceDetail: source.detail,
            credentialRemoved: true,
            removedSecrets: secrets.removed,
            secretsDetail: secrets.detail,
            note:
              "files Canonfig applied stay in place; a native schedule, if installed, still starts `canonfig sync`: remove it with `canonfig schedule remove`",
          });
        }).pipe(withEnrollmentLock),
      synchronize: (input) => {
        // Only the rendered native job passes --scheduled, so the fire
        // record is evidence the real scheduler started this process.
        const scheduled = input.scheduled === true;
        const invocation = { id: randomUUID(), startedAt: new Date().toISOString() };
        const installedGeneration = scheduled ? schedules.status().pipe(
          Effect.map((status) => status.generation),
          Effect.catch(() => Effect.succeed(undefined)),
        ) : Effect.succeed(undefined);
        const projection = {
          noBackup: input.noBackup === true,
          reviewLocal: input.reviewLocal === true,
          environment: (name: string) => process.env[name],
        };
        const follower: Effect.Effect<CliPayload, CliCommandFailure> = mapFailure(synchronizeFollower(
            statePath,
            input.mode,
            projection,
            undefined,
            scheduled || input.noInput,
          ).pipe(
            Effect.provideService(StateRepository, repository),
            Effect.provideService(MachineState, machine),
            Effect.provideService(Synchronization, synchronization),
            Effect.provideService(AgentResolution, agentResolution),
            Effect.provideService(ScheduleManager, schedules),
          )).pipe(Effect.flatMap(outcomePayload));
        // The Source and unenrolled machines project their own folder.
        const local: Effect.Effect<CliPayload, CliCommandFailure> = mapFailure(synchronizeLocal(statePath, input.mode, projection).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
          Effect.provideService(Synchronization, synchronization),
        )).pipe(Effect.flatMap(outcomePayload));
        const run: Effect.Effect<CliPayload, CliCommandFailure> = mapFailure(
          repository.getFollowerSynchronizationConfiguration(),
        ).pipe(Effect.flatMap((configuration) => configuration === undefined ? local : follower));
        return installedGeneration.pipe(Effect.flatMap((generation) => {
          const identity = { ...invocation, generation };
          const start = scheduled
            ? mapFailure(repository.transitionScheduledInvocation({ ...identity, _tag: "Running" }))
            : Effect.void;
          return start.pipe(Effect.andThen(Effect.gen(function*() {
            // A scheduled run restarts a down managed tunnel once, and a
            // transport failure while the tunnel is down reports the tunnel.
            const result = yield* repository.getFollowerSynchronizationConfiguration().pipe(
              Effect.catch(() => Effect.succeed(undefined)),
              Effect.flatMap((configuration) =>
                withManagedTunnel(
                  {
                    stateDirectory: join(dirname(statePath), "tunnel"),
                    sourceEndpoint: configuration?.source.endpoint,
                    restart: scheduled,
                  },
                  (failure: CliCommandFailure) => failure.category === "transport",
                  run,
                )
              ),
              Effect.provideService(Tunnel, tunnel),
              Effect.catchTag("TunnelDownError", (error) => Effect.fail(commandFailure(error))),
              // Retain completed file-run evidence if shared-secret refresh fails.
              Effect.tap((result) => input.mode === "apply" ? synchronizeSharedSecrets().pipe(
              Effect.provideService(MachineState, machine),
              Effect.provideService(StateRepository, repository),
              Effect.mapError((error) => new CliCommandFailure({
                category: secretFailureCategory(error),
                message: `File synchronization completed, but shared-secret synchronization failed: ${error.message}`,
                details: result,
              })),
            ) : Effect.void), Effect.tap((completed) => input.mode === "apply" ? reconcileBackupSchedules(dirname(statePath)).pipe(
              Effect.provideService(MachineState, machine),
              Effect.mapError((error) => new CliCommandFailure({ category: commandFailure(error).category,
                message: `File synchronization completed, but backup schedule reconciliation failed: ${commandFailure(error).message}`, details: completed })),
            ) : Effect.void), Effect.catch((error) => {
              const failed = scheduled ? mapFailure(repository.transitionScheduledInvocation({
                ...identity, _tag: "Failed", at: new Date().toISOString(), reason: fireFailureReason(error),
              })) : Effect.void;
              return failed.pipe(Effect.andThen(Effect.fail(error)));
            }));
            if (scheduled) yield* mapFailure(repository.transitionScheduledInvocation({
              ...identity, _tag: "Completed", at: new Date().toISOString(),
            }));
            return result;
          })));
        }));
      },
      // An open local projection run is resolved before any follower run.
      abandon: () =>
        mapFailure(Effect.gen(function*() {
          return (yield* hasOpenLocalRun)
            ? yield* abandonLocal(statePath)
            : yield* abandonFollowerRun(statePath);
        }).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
        )).pipe(Effect.map(payload)),
      recover: () =>
        mapFailure(Effect.gen(function*() {
          return (yield* hasOpenLocalRun)
            ? yield* recoverLocal(statePath)
            : yield* recoverFollower(statePath);
        }).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
          Effect.provideService(Synchronization, synchronization),
          Effect.provideService(ScheduleManager, schedules),
        )).pipe(Effect.flatMap(outcomePayload)),
      // A restore belongs to whoever projected the surfaces: the follower
      // identity once enrolled (enrollment re-keys local records), else this
      // machine's local projection.
      restore: (input) =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) =>
            mapFailure(restoreLocal(statePath, input.snapshot, configuration?.follower.id ?? localProjectionFollower).pipe(
              Effect.provideService(StateRepository, repository),
              Effect.provideService(MachineState, machine),
              Effect.provideService(Synchronization, synchronization),
            ))
          ),
          Effect.flatMap(outcomePayload),
        ),
      exportArchive: (input) =>
        mapFailure(exportFolder({
          folder: dirname(statePath),
          output: input.output,
          cwd: process.cwd(),
          includeHarnesses: input.includeHarnesses,
          force: input.force,
          now: new Date(),
          sourceSigner: loadSourceSigner(enrollment).pipe(Effect.map(({ archiveSigner }) => archiveSigner)),
        }).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
        )).pipe(Effect.map(payload)),
      importArchive: (input) =>
        mapFailure(importLocal(statePath, resolve(input.archive), input.dryRun ? "plan" : "apply", input.replace, input.expectKey).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
          Effect.provideService(Synchronization, synchronization),
        )).pipe(Effect.flatMap(outcomePayload)),
      harnesses: (input) =>
        mapFailure(harnessesLocal(statePath, (name) => process.env[name], input.change).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
        )).pipe(Effect.map(payload)),
      overlays: (input) =>
        mapFailure(overlaysLocal(statePath, (name) => process.env[name], input.change).pipe(
          Effect.provideService(MachineState, machine),
        )).pipe(Effect.map(payload)),
      status: (follower) =>
        follower === undefined
          ? mapFailure(
            repository.getFollowerSynchronizationConfiguration(),
          ).pipe(
            Effect.flatMap((configuration) =>
              Effect.gen(function*() {
                const machineRole = yield* mapFailure(
                  enrollment.source().pipe(
                    Effect.map((source) => ({
                      role: "source" as const,
                      sourceFingerprint: source.source.publicKeyFingerprint,
                      tlsFingerprint: source.tlsFingerprint,
                    })),
                    Effect.catchTag("SourceNotInitializedError", () =>
                      Effect.succeed({ role: "unconfigured" as const })),
                  ),
                );
                const tunnelReport = yield* mapFailure(tunnel.tunnelStatus({
                  stateDirectory: join(dirname(statePath), "tunnel"),
                }));
                if (configuration === undefined) {
                  const notReached = (detail: string) => ({
                    reached: false,
                    detail,
                  });
                  return {
                    machineRole,
                    lifecycle: {
                      discovered: notReached("no Source endpoint is configured"),
                      selected: notReached("no profile is selected"),
                      reachable: notReached("no Source endpoint is configured"),
                      enrolled: notReached("this machine is not enrolled"),
                      converged: notReached("enrollment is required before convergence"),
                    },
                    tunnel: tunnelReport,
                  };
                }
                const [state, appliedResources] = yield* Effect.all([
                  mapFailure(repository.loadState(configuration.follower.id)),
                  mapFailure(repository.loadAppliedResources(configuration.follower.id)),
                ]);
                const revisions = [...new Set(
                  appliedResources.map((resource) => resource.revision),
                )];
                const lifecycle = yield* queryFollowerLifecycle({
                  endpoint: configuration.source.endpoint,
                  tlsFingerprint: configuration.source.tlsFingerprint,
                  sourceFingerprint: configuration.source.signingFingerprint,
                  credentialReference: configuration.credentialReference,
                  timeoutMilliseconds:
                    configuration.scheduledInvocation.timeoutMilliseconds,
                  profile: configuration.profile,
                  appliedRevisions: revisions,
                }).pipe(Effect.provideService(MachineState, machine));
                const receipt = yield* completionReceipt(configuration);
                const deployment = yield* mapFailure(
                  repository.latestDeploymentReceipt(configuration.follower.id),
                );
                const openRun = state.activeRecovery === undefined
                  ? undefined
                  : openRunReport(state.activeRecovery, yield* runLockHolder(statePath));
                return {
                  machineRole: {
                    role: "follower" as const,
                    follower: configuration.follower.id,
                    sourceFingerprint: configuration.source.signingFingerprint,
                    tlsFingerprint: configuration.source.tlsFingerprint,
                  },
                  ...state,
                  enrollmentLifecycle: configuration.lifecycle._tag,
                  enrollmentRecovery: configuration.lifecycle._tag === "RollbackPending" ? rollbackRecoveryDetail : undefined,
                  activeRecovery: openRun,
                  lifecycle: {
                    ...lifecycle,
                    enrolled: configuration.lifecycle._tag === "RollbackPending"
                      ? { reached: false, detail: rollbackRecoveryDetail } : lifecycle.enrolled,
                    converged: followerConvergence(
                      lifecycle.converged,
                      openRun,
                      deployment?.outcome,
                    ),
                  },
                  tunnel: tunnelReport,
                  completionReceipt: receipt,
                };
              })
            ),
            Effect.map(payload),
          )
          : mapFailure(repository.loadState(follower)).pipe(
            Effect.flatMap((state) =>
              mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
                Effect.flatMap((configuration) =>
                  Effect.gen(function*() {
                    const receipt = configuration?.follower.id === follower
                      ? yield* completionReceipt(configuration)
                      : undefined;
                    const base = {
                      ...state,
                      activeRecovery: state.activeRecovery === undefined
                        ? undefined
                        : openRunReport(state.activeRecovery, yield* runLockHolder(statePath)),
                    };
                    return receipt === undefined
                      ? base
                      : { ...base, completionReceipt: receipt };
                  })
                ),
              )
            ),
            Effect.map(payload),
          ),
      setAgentPolicy: (policy) =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) => {
            if (configuration === undefined) return Effect.fail(agentPolicyRequiresFollower());
            return mapFailure(repository.loadState(configuration.follower.id)).pipe(
              Effect.flatMap((state) =>
                state.sourceIdentity === undefined
                  ? Effect.fail(new CliCommandFailure({
                    category: "usage-or-configuration",
                    message: "follower source identity is not configured",
                  }))
                  : mapFailure(
                    repository.saveFollowerSynchronizationConfiguration({
                      sourceIdentity: state.sourceIdentity,
                      expectedConfiguration: configuration,
                      configuration: {
                        ...configuration,
                        agentPolicy: policy,
                        updatedAt: new Date().toISOString(),
                      },
                    }),
                  )
              ),
              Effect.as(payload(policy)),
            );
          }),
        ),
      getAgentPolicy: () =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) =>
            configuration === undefined
              ? Effect.fail(agentPolicyRequiresFollower())
              : Effect.succeed(configuration.agentPolicy)
          ),
          Effect.map(payload),
        ),
      // A shell expands `--allow-path ~/x` before Canonfig sees it, but a
      // quoted `~` or a relative path arrives as written. Each path is stored
      // resolved the way this machine resolves profile targets, so the bounds
      // hold the same absolute paths a synchronization run gives Agent Tasks.
      setAgentHarness: (requested) =>
        Effect.forEach(requested.allowedPaths, (path) => mapFailure(machine.normalizePath({ path }))).pipe(
          Effect.map((paths) => ({ ...requested, allowedPaths: paths.map((path) => path.absolute) })),
          Effect.flatMap((agentHarness) =>
            mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
              Effect.flatMap((configuration) => {
                if (configuration === undefined) {
                  return Effect.fail(new CliCommandFailure({
                    category: "usage-or-configuration",
                    message: "follower synchronization configuration is not enrolled",
                  }));
                }
                return mapFailure(repository.loadState(configuration.follower.id)).pipe(
                  Effect.flatMap((state) =>
                    state.sourceIdentity === undefined
                      ? Effect.fail(new CliCommandFailure({
                        category: "usage-or-configuration",
                        message: "follower source identity is not configured",
                      }))
                      : mapFailure(
                        repository.saveFollowerSynchronizationConfiguration({
                          sourceIdentity: state.sourceIdentity,
                          expectedConfiguration: configuration,
                          configuration: {
                            ...configuration,
                            agentHarness,
                            updatedAt: new Date().toISOString(),
                          },
                        }),
                      )
                  ),
                  Effect.as(payload(agentHarness)),
                );
              }),
            )
          ),
        ),
      getAgentHarness: () =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) =>
            configuration?.agentHarness === undefined
              ? Effect.fail(new CliCommandFailure({
                category: "usage-or-configuration",
                message: "agent harness is not configured",
              }))
              : Effect.succeed(configuration.agentHarness)
          ),
          Effect.map(payload),
        ),
      setSchedule: (input) =>
        // Record the decision before installing it, so the schedule survives
        // the next apply and `schedule status` compares against it rather than
        // against a built-in default.
        "profileDefault" in input
          ? mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
            Effect.flatMap((configuration) =>
              (configuration !== undefined && configuration.lifecycle._tag !== "Active")
                ? Effect.fail(new CliCommandFailure({ category: "usage-or-configuration",
                  message: "follower enrollment is pending; finish or resume enrollment before selecting a schedule" }))
                : configuration?.scheduleDefault === undefined
                ? Effect.fail(new CliCommandFailure({
                  category: "usage-or-configuration",
                  message: configuration === undefined
                    ? "canonfig schedule set --default needs an enrolled follower; enroll, then apply the selected profile first"
                    : "the selected profile declares no scheduleDefault (or no revision has been applied yet); run `canonfig sync --apply`, or choose a calendar with `canonfig schedule set <calendar>`",
                }))
                : mapFailure(validateSchedule(syncScheduleFromDefault(configuration.scheduleDefault))).pipe(
                  Effect.flatMap((schedule) => persistScheduleOverride(repository, { kind: "inherit" }).pipe(
                    Effect.andThen(mapFailure(schedules.update({ schedule }))),
                    Effect.map(payload),
                  )),
                )
            ),
          )
          : mapFailure(validateSchedule(input.schedule)).pipe(
            Effect.flatMap((schedule) => persistScheduleOverride(repository, {
              kind: "schedule", schedule, executable: input.executable,
            }).pipe(
              Effect.andThen(mapFailure(schedules.update({ ...input, schedule }))),
              Effect.map(payload),
            )),
          ),
      scheduleStatus: () =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) => {
            if ((configuration !== undefined && configuration.lifecycle._tag !== "Active")) return Effect.succeed(payload({
              state: "enrollment-pending",
              detail: `${unscheduledDetail(configuration)}. A native job may remain installed; remove it with \`canonfig schedule remove\` if it is no longer wanted`,
            }));
            const input = finalizedScheduleInput(configuration);
            if (input === undefined) {
              // No decision; a job an earlier release installed may still run.
              return mapFailure(schedules.status()).pipe(
                Effect.map((native) =>
                  payload(native.state === "not-installed"
                    ? { state: "not-selected", detail: unscheduledDetail(configuration) }
                    : { state: "unmanaged", detail: configuration === undefined || configuration.lifecycle._tag !== "Active"
                      ? `${unscheduledDetail(configuration)}. A native job remains installed; remove it with \`canonfig schedule remove\` if it is no longer wanted`
                      : unmanagedScheduleDetail, nativeState: native.state })
                ),
              );
            }
            return readScheduleFires(repository).pipe(Effect.flatMap((fires) => mapFailure(schedules.status(input)).pipe(
              Effect.map((status) =>
                payload({
                  ...status,
                  lastFire: currentScheduleFires(status, fires).at(-1),
                  unattendedRuns: describeUnattendedRuns(currentScheduleFires(status, fires)).text,
                })
              ),
            )));
          }),
        ),
      removeSchedule: () =>
        persistScheduleOverride(repository, { kind: "disabled" }).pipe(
          Effect.andThen(mapFailure(schedules.remove())),
          Effect.map(payload),
        ),
      startTunnel: (input) =>
        Effect.gen(function*() {
          const invitation = yield* mapFailure(readInvitationEnvelope({
            path: input.invitationPath,
          }));
          const sshHostKey = yield* Effect.tryPromise({
            try: async () => (await readFile(input.sshHostKeyPath, "utf8")).trim(),
            catch: () =>
              new CliCommandFailure({
                category: "usage-or-configuration",
                message: "the pinned SSH host key file could not be read",
              }),
          });
          let endpoint: URL;
          try {
            endpoint = new URL(invitation.endpoint);
          } catch {
            return yield* new CliCommandFailure({
              category: "usage-or-configuration",
              message: "the invitation Source endpoint is invalid",
            });
          }
          const remoteHost = endpoint.hostname.replaceAll("[", "").replaceAll("]", "");
          if (remoteHost !== "127.0.0.1" && remoteHost !== "::1") {
            return yield* new CliCommandFailure({
              category: "usage-or-configuration",
              message: "the invitation Source endpoint is not loopback-only",
            });
          }
          const report = yield* mapFailure(tunnel.startTunnel({
            sshHost: input.sshHost,
            sshPort: input.sshPort,
            sshUser: input.sshUser,
            sshHostKey,
            localHost: input.localHost,
            localPort: input.localPort,
            remoteHost,
            remotePort: endpoint.port === "" ? 443 : Number(endpoint.port),
            tlsFingerprint: invitation.tlsFingerprint,
            sourceFingerprint: invitation.sourceFingerprint,
            stateDirectory: join(dirname(statePath), "tunnel"),
            sshExecutable: input.sshExecutable,
            sshArguments: input.sshArguments,
            timeoutMilliseconds: input.timeoutMilliseconds,
          }));
          return payload(report);
        }),
      restartTunnel: (input) =>
        mapFailure(tunnel.restartTunnel({
          stateDirectory: join(dirname(statePath), "tunnel"),
          timeoutMilliseconds: input.timeoutMilliseconds,
        })).pipe(Effect.map(payload)),
      tunnelStatus: () =>
        mapFailure(tunnel.tunnelStatus({
          stateDirectory: join(dirname(statePath), "tunnel"),
        })).pipe(Effect.map(payload)),
      stopTunnel: (input) =>
        mapFailure(tunnel.stopTunnel({
          stateDirectory: join(dirname(statePath), "tunnel"),
          forget: input.forget,
        })).pipe(Effect.map(payload)),
      doctor: (input) =>
        // Probe the configuration a run would actually use: the agent policy
        // and harness live in the follower configuration, so a machine
        // without one has no agent policy to check.
        Effect.all([
          mapFailure(repository.getFollowerSynchronizationConfiguration()),
          effectiveScheduleInput(repository),
          readScheduleFires(repository),
          tunnel.tunnelStatus({ stateDirectory: join(dirname(statePath), "tunnel") }).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        ]).pipe(
          Effect.flatMap(([configuration, schedule, fires, tunnelReport]) => {
            const source = configuration === undefined
              ? doctorSource
              : {
                endpoint: configuration.source.endpoint,
                tlsFingerprint: configuration.source.tlsFingerprint,
                credentialReference: configuration.credentialReference,
              };
            return runDoctorProbes({
              ...input,
              statePath,
              environment: (name) => process.env[name],
              agentPolicy: configuration?.agentPolicy,
              schedule,
              fires,
              unscheduledDetail: unscheduledDetail(configuration),
              source,
              tunnel: tunnelReport !== undefined
                  && tunnelCarriesSource(tunnelReport, source?.endpoint)
                ? tunnelReport
                : undefined,
              agent: configuration?.agentHarness === undefined
                ? doctorAgent
                : {
                  adapter: configuration.agentHarness.kind,
                  executable: configuration.agentHarness.executable,
                },
            }).pipe(Effect.map((report) => configuration?.lifecycle._tag !== "RollbackPending" ? report : {
              ...report,
              status: report.status === "healthy" ? "degraded" as const : report.status,
              probes: report.probes.map((probe) => probe.name !== "source" ? probe : {
                ...probe,
                status: probe.status === "pass" ? "warning" as const : probe.status,
                message: `${rollbackRecoveryDetail}. ${probe.message}`,
                details: { ...probe.details, enrollmentLifecycle: "RollbackPending", recovery: rollbackRecoveryDetail },
              }),
            }));
          }),
        ).pipe(
          Effect.provideService(MachineState, machine),
          Effect.provideService(ScheduleManager, schedules),
          Effect.provideService(StateRepository, repository),
          Effect.flatMap((report) => {
            const category = doctorFailureCategory(report);
            return category === undefined
              ? Effect.succeed(payload(report))
              : Effect.fail(new CliCommandFailure({
                category,
                message: "one or more doctor probes failed",
                details: payload(report),
              }));
          }),
        ),
    };
    return FollowerCommands.of(service);
  }),
);

const machineLayer = (statePath: string): Layer.Layer<MachineState> => {
  // The enrolled policy wins: it is what a scheduled run has to rely on.
  const credentialPolicy = runtimeCredentialPolicy(statePath);
  const base = (() => {
    switch (process.platform) {
      case "darwin":
        return macosMachineStateLayer({ credentialPolicy });
      case "win32":
        return windowsMachineStateLayer({ credentialPolicy });
      default:
        return linuxMachineStateLayer({ credentialPolicy });
    }
  })();
  // Every runtime consumer must understand the references written by the
  // shared-secret CLI. On macOS this also keeps credential values off argv by
  // using the versioned keychain-hex codec for enrollment and secret bindings.
  return nativeSecretStoreLayer(base);
};

/**
 * The machine alone, for commands that only touch this machine's filesystem and
 * bounded processes. Building the full runtime layer would open the state
 * database and the source and follower command graphs for no reason.
 */
export const runtimeMachineLayer = (
  options: RuntimeLayerOptions = {},
): Layer.Layer<MachineState> =>
  machineLayer(options.statePath ?? join(homedir(), ".canonfig", "state.sqlite"));

export const runtimeLayer = (
  options: RuntimeLayerOptions = {},
  machine: Layer.Layer<MachineState> = runtimeMachineLayer(options),
) => {
  const root = join(homedir(), ".canonfig");
  const statePath = options.statePath ?? join(root, "state.sqlite");
  const state = runtimeStateLayer(statePath);
  const enrollment = EnrollmentLive.pipe(Layer.provide(Layer.merge(state, machine)));
  const profiles = runtimeProfileCatalogLayer.pipe(
    Layer.provide(Layer.mergeAll(state, machine, enrollment)),
  );
  const schedule = scheduleManagerLayer.pipe(Layer.provide(machine));
  const tunnel = TunnelLive;
  const sourceService = sourceServiceLayer({ stateDirectory: dirname(statePath) }).pipe(
    Layer.provide(machine),
  );
  const synchronization = SynchronizationLive.pipe(
    Layer.provide(Layer.merge(state, machine)),
  );
  const agentResolution = AgentResolutionWithSecretsLive.pipe(Layer.provide(machine));
  const setup = setupCommandsLayer(statePath).pipe(
    Layer.provide(Layer.mergeAll(machine, enrollment, state)),
  );
  const dependencies = Layer.mergeAll(
    state,
    machine,
    enrollment,
    profiles,
    schedule,
    synchronization,
    tunnel,
    agentResolution,
    sourceService,
  );
  return Layer.mergeAll(
    machine,
    state,
    guiQueriesLayer(dirname(statePath)).pipe(Layer.provide(state)),
    sourceCommandsLayer(dirname(statePath)).pipe(Layer.provide(dependencies)),
    followerCommandsLayer(
      statePath,
      options.doctorSource ?? doctorSourceFromEnvironment(),
      options.doctorAgent ?? doctorAgentFromEnvironment(),
    ).pipe(
      Layer.provide(dependencies),
    ),
    setup,
  );
};
