import {
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
  verify as verifyPayload,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer, Option, Redacted, Schema, SchemaIssue } from "effect";

import { SourceSignature } from "../domain/brand.ts";
import { configPathIssue } from "../domain/config-path.ts";
import { AgentPolicy } from "../domain/identity.ts";
import { AgentResolutionWithSecretsLive } from "../agent/agent-resolution.layer.ts";
import { AgentResolution } from "../agent/agent-resolution.service.ts";
import { EnrollmentLive } from "../enrollment/enrollment.layer.ts";
import { Enrollment } from "../enrollment/enrollment.service.ts";
import {
  cancelFollowerEnrollment,
  enrollFollower,
  getRevisionMetadata,
  finalizeFollowerEnrollment,
  listRevisions,
  queryFollowerLifecycle,
  revokeFollowerEnrollment,
} from "../enrollment/follower-client.ts";
import {
  deliverInvitationEnvelope,
  readInvitationEnvelope,
} from "../enrollment/invitation-envelope.ts";
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
import {
  decodeMachineProfileJsonc,
  ProfileContractError,
  type MachineProfile,
} from "../domain/profile.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { CredentialPolicy } from "../machine/machine-state.types.ts";
import { linuxMachineStateLayer } from "../machine/linux.layer.ts";
import { macosMachineStateLayer } from "../machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../machine/windows.layer.ts";
import { nativeSecretStoreLayer } from "../secrets/native-secret-store.ts";
import { clearTransferredSecrets } from "../secrets/secret-store.ts";
import { ProfileCatalog } from "../profile/profile-catalog.service.ts";
import {
  InvalidPublicationResourcesError,
  PublicationSigningError,
} from "../profile/profile-catalog.errors.ts";
import { profileContentDigests } from "../profile/compiler.ts";
import {
  scanDiscovery,
  type DiscoveryScanResult,
} from "../profile/discovery.ts";
import { InexactJsonNumberError, jsonPathText } from "../profile/profile-codec.ts";
import {
  acceptPublicationProposal,
  makePublication,
  resolveResourceSources,
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
import { describeUnattendedRuns } from "./readiness.ts";
import { scheduleManagerLayer } from "../schedule/schedule-manager.layer.ts";
import { setupCommandsLayer } from "../setup/setup.layer.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { stateRepositoryLayer } from "../state/state-repository.layer.ts";
import { SynchronizationLive } from "../synchronization/synchronization.layer.ts";
import { Synchronization } from "../synchronization/synchronization.service.ts";
import { runLockHolder } from "../synchronization/run-lock.ts";
import {
  followerConvergence,
  openRunReport,
} from "../synchronization/run-status.ts";
import {
  defaultScheduledInvocation,
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
import type { LocalOverlayInput } from "../cli/follower-commands.ts";
import {
  doctorFailureCategory,
  runDoctorProbes,
  type DoctorAgentConfiguration,
  type DoctorSourceConfiguration,
} from "./doctor.ts";

export interface RuntimeLayerOptions {
  readonly statePath?: string | undefined;
  readonly policyPath?: string | undefined;
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

const emptyDiscoveryProposal: DiscoveryScanResult = {
  resources: [],
  tools: [],
  skills: [],
  evidence: [],
  agentTasks: [],
  scannedPaths: [],
};

const isSymbol = Schema.is(Schema.Symbol);

/** Render typed schema structure and trusted expectations, never reported input. */
const schemaDiagnostic = (cause: Schema.SchemaError): string | undefined => {
  const problems: Array<{ readonly path: ReadonlyArray<PropertyKey>; readonly reason: string }> = [];
  const visit = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): void => {
    switch (issue._tag) {
      case "Pointer":
        return visit(issue.issue, [...path, ...issue.path]);
      case "Encoding":
        return visit(issue.issue, path);
      case "Composite":
      case "AnyOf":
        for (const child of issue.issues) visit(child, path);
        if (issue.issues.length === 0) problems.push({ path, reason: "Expected a matching schema" });
        return;
      case "Filter":
        if (issue.issue._tag !== "InvalidValue") return visit(issue.issue, path);
        problems.push({
          path,
          reason: SchemaIssue.defaultLeafHook(new SchemaIssue.InvalidValue({
            expected: issue.issue.annotations?.expected ?? issue.filter.annotations?.expected,
          })),
        });
        return;
      case "InvalidType":
        problems.push({ path, reason: SchemaIssue.defaultLeafHook(new SchemaIssue.InvalidType(issue.ast)) });
        return;
      case "InvalidValue":
        problems.push({
          path,
          reason: SchemaIssue.defaultLeafHook(new SchemaIssue.InvalidValue({ expected: issue.annotations?.expected })),
        });
        return;
      case "MissingKey":
        problems.push({ path, reason: "missing required field" });
        return;
      case "UnexpectedKey":
        problems.push({ path, reason: "unexpected field" });
        return;
      case "OneOf":
        problems.push({ path, reason: "Expected exactly one matching schema" });
        return;
      case "Forbidden":
        problems.push({ path, reason: "schema operation is unavailable" });
    }
  };
  visit(cause.issue, []);
  if (problems.length === 0) return undefined;
  return problems.sort((left, right) => right.path.length - left.path.length).slice(0, 5)
    .map(({ path, reason }) =>
      `${jsonPathText("profile", path.map((key) => isSymbol(key) ? "[symbol]" : key))}: ${reason}`
    ).join("; ").slice(0, 300);
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

/**
 * Build the failure for an unreadable or invalid authored profile file. The
 * underlying complaint is included in sanitized form so operators can fix
 * their authoring without trial and error. Raw parser messages are never
 * echoed: a JSON syntax error quotes the offending source text, which may be
 * profile content, so it is replaced with a static diagnostic. Contract
 * errors render through the failure taxonomy, which names resources and
 * paths but not values. Schema errors render typed paths and expected values
 * from the schema; reported input and custom issue messages are never rendered.
 */
export const profileFileFailure = (cause: unknown): CliCommandFailure => {
  if (cause instanceof SyntaxError) {
    return new CliCommandFailure({
      category: "usage-or-configuration",
      message: "authored profile file is malformed or invalid: profile is not valid JSONC",
    });
  }
  if (cause instanceof ProfileContractError) {
    return new CliCommandFailure({
      category: "usage-or-configuration",
      message: `authored profile file is malformed or invalid: ${profileProblems(cause.errors)}`,
    });
  }
  if (cause instanceof InexactJsonNumberError) {
    return new CliCommandFailure({
      category: "usage-or-configuration",
      message: `authored profile file is malformed or invalid: ${cause.message}`,
    });
  }
  if (cause instanceof Error) {
    const detail = cause instanceof Schema.SchemaError
      ? schemaDiagnostic(cause) ?? "profile validation failed"
      : "profile validation failed";
    return new CliCommandFailure({
      category: "usage-or-configuration",
      message: `authored profile file is malformed or invalid: ${detail}`,
    });
  }
  return new CliCommandFailure({
    category: "usage-or-configuration",
    message: "authored profile file is malformed or invalid: unknown validation failure",
  });
};

const readAuthoredProfile = (
  path: string,
): Effect.Effect<MachineProfile, CliCommandFailure> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new CliCommandFailure({
      category: "usage-or-configuration",
      message: `authored profile file ${path} could not be read: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => decodeMachineProfileJsonc(text),
        catch: (cause) => profileFileFailure(cause),
      })
    ),
  );

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

/**
 * The follower's own decision about the native synchronization job, written to
 * its configuration so it outlives a run.
 *
 * A no-op on a machine that is not enrolled: there is nowhere durable to record
 * it, and the schedule commands still act on the native job directly.
 */
export interface ScheduleFireRecord {
  readonly at: string;
  readonly outcome: string;
  /** For `failed`: the failure category, message, and run reason, bounded. */
  readonly reason?: string | undefined;
}

export const scheduleFirePath = (statePath: string): string =>
  join(dirname(statePath), "schedule-fires.json");

const readScheduleFires = (statePath: string): ReadonlyArray<ScheduleFireRecord> => {
  try {
    // SAFETY: only this process family writes the file, with this exact shape.
    const parsed = JSON.parse(readFileSync(scheduleFirePath(statePath), "utf8")) as {
      fires?: ReadonlyArray<ScheduleFireRecord>;
    };
    return Array.isArray(parsed.fires) ? parsed.fires : [];
  } catch {
    return [];
  }
};

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

const recordScheduleFire = (
  statePath: string,
  outcome: string,
  reason?: string,
): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: async () => {
      const path = scheduleFirePath(statePath);
      // JSON.stringify omits `reason` when it is undefined.
      const fires = [...readScheduleFires(statePath).slice(-9), {
        at: new Date().toISOString(),
        outcome,
        reason,
      }];
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({ schema: "canonfig.schedule-fire/v1", fires }, null, 2)}\n`,
      );
    },
    catch: () => undefined,
  }).pipe(Effect.ignore);

/** Why this follower has no native job, and what to run to get one. */
const unscheduledDetail = (
  configuration: FollowerSynchronizationConfiguration | undefined,
): string => {
  if (configuration?.scheduleOverride?.kind === "disabled") {
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
      if (configuration === undefined) return Effect.void;
      return mapFailure(repository.loadState(configuration.follower.id)).pipe(
        Effect.flatMap((state) =>
          state.sourceIdentity === undefined ? Effect.void : mapFailure(
            repository.saveFollowerSynchronizationConfiguration({
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
const effectiveScheduleInput = (
  repository: StateRepository["Service"],
): Effect.Effect<ResolvedScheduleInput | undefined, CliCommandFailure> =>
  mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
    Effect.map((configuration) =>
      desiredScheduleInput(
        configuration?.scheduleOverride,
        configuration?.scheduleDefault,
      )
    ),
  );

/** How the Source can run unattended; appended where its keys are unreachable. */
const supervisedSourceModes =
  "Unlock the Source credential store in the session that runs the service, then supervise it with `canonfig source service install`. "
  + "Linux linger (`loginctl enable-linger <user>`) extends the user manager lifecycle to boot and logout, but does not unlock an encrypted login keyring. Verify `canonfig source service status` reports `serving: true` in the intended mode";

const sourceCommandsLayer: Layer.Layer<
  SourceCommands,
  never,
  Enrollment | MachineState | ProfileCatalog | StateRepository | SourceService
> = Layer.effect(
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

    const service: SourceCommandsService = {
      initialize: () => mapFailure(enrollment.initializeSource()).pipe(Effect.map(payload)),
      scan: (input) => mapFailure(profiles.scan(input)).pipe(Effect.map(payload)),
      publish: (input) =>
        Effect.gen(function*() {
          const authored = input.profilePath === undefined
            ? undefined
            : yield* readAuthoredProfile(input.profilePath);
          const proposal = input.proposalPath === undefined
            ? emptyDiscoveryProposal
            : yield* mapFailure(profiles.scan({
              files: [{ path: input.proposalPath }],
            }));
          if (authored === undefined && (input.profile === undefined || input.name === undefined)) {
            return yield* new CliCommandFailure({
              category: "usage-or-configuration",
              message: "source publish requires profile metadata or an authored profile file",
            });
          }
          if (
            authored !== undefined
            && input.profile !== undefined
            && input.profile !== authored.id
          ) {
            return yield* new CliCommandFailure({
              category: "usage-or-configuration",
              message: "authored profile id conflicts with --profile",
            });
          }
          if (
            authored !== undefined
            && input.name !== undefined
            && input.name !== authored.name
          ) {
            return yield* new CliCommandFailure({
              category: "usage-or-configuration",
              message: "authored profile name conflicts with --name",
            });
          }
          const profile = authored === undefined
            ? {
              id: input.profile!,
              name: input.name!,
            }
            : {
              id: authored.id,
              name: authored.name,
              groups: authored.groups,
              resources: authored.resources,
              scheduleDefault: authored.scheduleDefault,
              directory: dirname(input.profilePath!),
            };
          const now = new Date().toISOString();
          const revision = yield* profiles.publish({
            proposal,
            profile,
            review: acceptPublicationProposal(proposal, input.reviewer, now),
            publishedAt: now,
            allowEmpty: input.allowEmpty,
          }).pipe(
            Effect.mapError((error) =>
              error instanceof InvalidPublicationResourcesError
                ? invalidResourcesFailure(error.errors)
                : commandFailure(error)
            ),
          );
          return payload(revision);
        }),
      digest: (input) =>
        Effect.gen(function*() {
          const authored = yield* readAuthoredProfile(input.profilePath);
          if (
            input.resource !== undefined
            && !authored.resources.some((resource) => resource.id === input.resource)
          ) {
            return yield* new CliCommandFailure({
              category: "usage-or-configuration",
              message: `profile ${authored.id} in ${input.profilePath} declares no resource ${input.resource}`,
            });
          }
          const resources = yield* mapFailure(resolveResourceSources(
            authored.resources,
            dirname(input.profilePath),
          ));
          const digests = yield* Effect.try({
            try: () => profileContentDigests({ ...authored, resources }),
            catch: (cause) =>
              cause instanceof ProfileContractError
                ? invalidResourcesFailure(cause.errors)
                : new CliCommandFailure({
                  category: "internal",
                  message: `resource digests could not be computed: ${String(cause)}`,
                }),
          });
          const selected = digests.filter((entry) =>
            input.resource === undefined || entry.id === input.resource
          );
          if (input.resource !== undefined && selected.length === 0) {
            return yield* new CliCommandFailure({
              category: "usage-or-configuration",
              message: `resource ${input.resource} has no content digest; only file, directory, config, and skill resources carry one`,
            });
          }
          return payload({
            profile: authored.id,
            resources: selected.map((entry) => ({
              id: entry.id,
              kind: entry.kind,
              verify: entry.verifyMethod,
              digest: entry.computedDigest,
              // `payload` drops both fields when no digest was declared.
              declaredDigest: entry.declaredDigest,
              matches: entry.declaredDigest === undefined
                ? undefined
                : entry.declaredDigest === entry.computedDigest,
            })),
          });
        }),
      serve: (input) =>
        mapFailure(startSourceServer(input).pipe(
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
        ),
      installService: (input) =>
        Effect.gen(function*() {
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
        }),
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
        Effect.gen(function*() {
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
        }),
      revoke: (follower) =>
        mapFailure(enrollment.revokeFollower(follower)).pipe(
          Effect.as(payload({ follower, revoked: true })),
        ),
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
      scan: scanDiscovery,
      publish: (input) =>
        Effect.gen(function*() {
          // The signing key is checked against the recorded Source identity:
          // a key another state directory stored under an earlier release's
          // account-global name must never sign this Source's revisions. A
          // local store failure or mismatch keeps its own category and text.
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
          return yield* makePublication(signer, repository).publish(input);
        }),
      getRevision: repository.getRevision,
    });
  }),
);

interface PolicyFile {
  readonly get: () => Effect.Effect<typeof AgentPolicy.Type, CliCommandFailure>;
  readonly set: (
    policy: typeof AgentPolicy.Type,
  ) => Effect.Effect<typeof AgentPolicy.Type, CliCommandFailure>;
}

const policyFile = (
  path: string,
): PolicyFile => ({
  get: () =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () => new CliCommandFailure({
        category: "usage-or-configuration",
        message: "agent policy is not configured",
      }),
    }).pipe(
      Effect.flatMap((text) => {
        let decodedJson: unknown;
        try {
          decodedJson = JSON.parse(text);
        } catch {
          return Effect.fail(new CliCommandFailure({
            category: "usage-or-configuration",
            message: "agent policy configuration is malformed",
          }));
        }
        const decoded = Schema.decodeUnknownOption(
          Schema.Struct({ policy: AgentPolicy }),
        )(decodedJson);
        return Option.isSome(decoded)
          ? Effect.succeed(decoded.value.policy)
          : Effect.fail(new CliCommandFailure({
            category: "usage-or-configuration",
            message: "agent policy configuration is invalid",
          }));
      }),
    ),
  set: (policy) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, `${JSON.stringify({ policy })}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        return policy;
      },
      catch: () => new CliCommandFailure({
        category: "usage-or-configuration",
        message: "agent policy configuration could not be written",
      }),
    }),
});

const followerCommandsLayer = (
  statePath: string,
  policyPath: string,
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
    const policies = policyFile(policyPath);
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

    const authorizedOverlayResource = (
      configuration: FollowerSynchronizationConfiguration,
      resourceId: string,
    ) =>
      Effect.gen(function*() {
        const revisions = yield* listRevisions({
          endpoint: configuration.source.endpoint,
          tlsFingerprint: configuration.source.tlsFingerprint,
          sourceFingerprint: configuration.source.signingFingerprint,
          credentialReference: configuration.credentialReference,
          timeoutMilliseconds: configuration.scheduledInvocation.timeoutMilliseconds,
        }).pipe(
          Effect.provideService(MachineState, machine),
          Effect.mapError(commandFailure),
        );
        const revision = revisions.revisions
          .filter((candidate) => candidate.profileId === configuration.selectedProfile)
          .sort((left, right) => right.sequence - left.sequence)[0];
        if (revision === undefined) {
          return yield* new CliCommandFailure({
            category: "usage-or-configuration",
            message: `selected profile ${configuration.selectedProfile} has no authorized revision`,
          });
        }
        const metadata = yield* getRevisionMetadata({
          endpoint: configuration.source.endpoint,
          tlsFingerprint: configuration.source.tlsFingerprint,
          sourceFingerprint: configuration.source.signingFingerprint,
          credentialReference: configuration.credentialReference,
          revisionId: revision.id,
          timeoutMilliseconds: configuration.scheduledInvocation.timeoutMilliseconds,
        }).pipe(
          Effect.provideService(MachineState, machine),
          Effect.mapError(commandFailure),
        );
        const resource = metadata.resources.find((candidate) =>
          candidate.id === resourceId
        );
        if (resource === undefined) {
          return yield* new CliCommandFailure({
            category: "usage-or-configuration",
            message: `resource ${resourceId} is not authorized in the selected profile`,
          });
        }
        if (resource.kind !== "config" || resource.policy !== "merge") {
          return yield* new CliCommandFailure({
            category: "usage-or-configuration",
            message: `resource ${resourceId} does not support Local Overlay ownership`,
          });
        }
        return resource;
      });

    const normalizedOverlay = (
      configuration: FollowerSynchronizationConfiguration,
      input: LocalOverlayInput,
    ) =>
      Effect.gen(function*() {
        const resource = yield* authorizedOverlayResource(configuration, input.resource);
        const canonicalTarget = yield* machine.normalizePath({ path: resource.target }).pipe(
          Effect.mapError(commandFailure),
        );
        const requestedTarget = yield* machine.normalizePath({ path: input.target }).pipe(
          Effect.mapError(commandFailure),
        );
        if (
          canonicalTarget.platform !== requestedTarget.platform
          || canonicalTarget.absolute !== requestedTarget.absolute
        ) {
          return yield* new CliCommandFailure({
            category: "usage-or-configuration",
            message: `overlay target must match the authorized target for resource ${input.resource}`,
          });
        }
        const keys = [...new Set(input.keys.map((key) => key.trim()))].sort();
        if (
          keys.length === 0
          || keys.some((key) =>
            key.length === 0
            || key !== key.trim()
            || configPathIssue(key) !== undefined
            || /\p{Cc}/u.test(key)
          )
        ) {
          return yield* new CliCommandFailure({
            category: "usage-or-configuration",
            message: "Local Overlay keys must be non-empty normalized config paths",
          });
        }
        return {
          resource: resource.id,
          target: canonicalTarget.absolute,
          keys,
        };
      });

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
        const scheduleInput = desiredScheduleInput(
          configuration.scheduleOverride,
          configuration.scheduleDefault,
        );
        const scheduled = scheduleInput === undefined
          ? { status: "not-selected" as const, detail: unscheduledDetail(configuration) }
          : yield* schedules.status(scheduleInput).pipe(
            Effect.match({
              onFailure: (error) => ({
                status: "not-verified" as const,
                detail: error.message,
              }),
              onSuccess: (status) => {
                const runs = describeUnattendedRuns(readScheduleFires(statePath));
                const verified = status.state === "current" && runs.completed;
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
      enroll: (input) =>
        input.selectedProfile === undefined
          ? Effect.fail(new CliCommandFailure({
            category: "usage-or-configuration",
            message: "follower enrollment requires an explicit --profile",
          }))
          : Effect.gen(function*() {
            const selectedProfile = input.selectedProfile;
            if (selectedProfile === undefined) {
              return yield* new CliCommandFailure({
                category: "usage-or-configuration",
                message: "follower enrollment requires an explicit --profile",
              });
            }
            const existing = yield* mapFailure(
              repository.getFollowerSynchronizationConfiguration(),
            );
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
              && existing.enrollmentPending !== true
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
            if (existing?.enrollmentPending === true) {
              const resumed = yield* finalizeFollowerEnrollment({
                endpoint: existing.source.endpoint,
                tlsFingerprint: existing.source.tlsFingerprint,
                credentialReference: existing.credentialReference,
              }).pipe(
                Effect.provideService(MachineState, machine),
                Effect.match({
                  onSuccess: () => ({ ok: true as const }),
                  onFailure: (error) => ({ ok: false as const, error }),
                }),
              );
              if (!resumed.ok) {
                const tag = resumed.error._tag ?? "";
                if (tag !== "InvalidFollowerCredentialError") {
                  return yield* mapFailure(Effect.fail(resumed.error));
                }
                // The source restarted after the prepare phase and discarded
                // its ambiguous marker. Discard the local half as well; the
                // invitation can now be safely retried.
                yield* machine.removeCredential(existing.credentialReference).pipe(
                  Effect.ignore,
                );
              } else {
                const state = yield* mapFailure(
                  repository.loadState(existing.follower.id),
                );
                if (state.sourceIdentity === undefined) {
                  return yield* new CliCommandFailure({
                    category: "usage-or-configuration",
                    message: "follower source identity is not configured",
                  });
                }
                yield* mapFailure(repository.saveFollowerSynchronizationConfiguration({
                  sourceIdentity: state.sourceIdentity,
                  configuration: {
                    ...existing,
                    enrollmentPending: undefined,
                    updatedAt: new Date().toISOString(),
                  },
                }));
                return payload({
                  follower: existing.follower,
                  selectedProfile: existing.selectedProfile,
                  source: state.sourceIdentity,
                  resumed: true,
                });
              }
            }

            const prepared = yield* mapFailure(enrollFollower({
              ...input,
              finalize: false,
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
            if (!authorizedProfiles.some((revision) =>
              revision.profileId === selectedProfile
            )) {
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
                message:
                  `profile ${selectedProfile} has no authorized revision`,
              });
            }
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
            const previous = existing !== undefined && existing.enrollmentPending !== true
              ? existing
              : undefined;
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
                ...((previous.localOverlay?.length ?? 0) === 0
                  ? []
                  : [`${previous.localOverlay?.length ?? 0} local overlay entries removed`]),
              ];
            const kept = rotated
              ? {
                agentPolicy: previous.agentPolicy,
                agentHarness: previous.agentHarness,
                scheduleOverride: previous.scheduleOverride,
                scheduleDefault: previous.scheduleDefault,
                localOverlay: previous.localOverlay,
                localExecution: previous.localExecution,
              }
              : {};
            const configuration = {
              schemaVersion: 1 as const,
              follower,
              selectedProfile,
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
              enrollmentPending: true as const,
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
            const saved = yield* mapFailure(
              repository.saveFollowerSynchronizationConfiguration({
                sourceIdentity: stateIdentity,
                configuration,
              }),
            ).pipe(
              Effect.match({
                onSuccess: () => ({ ok: true as const }),
                onFailure: (error) => ({ ok: false as const, error }),
              }),
            );
            if (!saved.ok) {
              yield* cancelFollowerEnrollment({
                endpoint: input.invitation.endpoint,
                tlsFingerprint: prepared.tlsFingerprint,
                credentialReference: prepared.credentialReference,
              }).pipe(
                Effect.provideService(MachineState, machine),
                Effect.ignore,
              );
              return yield* saved.error;
            }
            const finalized = yield* finalizeFollowerEnrollment({
              endpoint: input.invitation.endpoint,
              tlsFingerprint: prepared.tlsFingerprint,
              credentialReference: prepared.credentialReference,
            }).pipe(
              Effect.provideService(MachineState, machine),
              Effect.match({
                onSuccess: () => ({ ok: true as const }),
                onFailure: (error) => ({ ok: false as const, error }),
              }),
            );
            if (!finalized.ok) return yield* mapFailure(Effect.fail(finalized.error));
            const cleared = yield* mapFailure(
              repository.saveFollowerSynchronizationConfiguration({
                sourceIdentity: source,
                configuration: {
                  ...configuration,
                  enrollmentPending: undefined,
                  updatedAt: new Date().toISOString(),
                },
              }),
            ).pipe(
              Effect.match({
                onSuccess: () => ({ ok: true as const }),
                onFailure: (error) => ({ ok: false as const, error }),
              }),
            );
            if (!cleared.ok) return yield* cleared.error;
            // Retire what the new enrollment superseded. A rotation's previous
            // credential no longer authenticates, so only the local item goes;
            // a replaced identity is also revoked on its Source.
            const previousIdentity = previous === undefined
              || previous.credentialReference === prepared.credentialReference
              ? undefined
              : rotated
              ? yield* machine.removeCredential(previous.credentialReference).pipe(
                Effect.match({
                  onSuccess: () => ({ follower: previous.follower.id, credentialRemoved: true }),
                  onFailure: () => ({ follower: previous.follower.id, credentialRemoved: false }),
                }),
              )
              : yield* revokeFollowerEnrollment({
                endpoint: previous.source.endpoint,
                tlsFingerprint: previous.source.tlsFingerprint,
                credentialReference: previous.credentialReference,
              }).pipe(
                Effect.provideService(MachineState, machine),
                Effect.match({
                  onSuccess: () => ({ follower: previous.follower.id, revoked: true, detail: "revoked on its Source" }),
                  onFailure: (error) => ({
                    follower: previous.follower.id,
                    revoked: false,
                    detail: `${error.message}; revoke it on its Source with \`canonfig source revoke ${previous.follower.id}\``,
                  }),
                }),
                Effect.tap(() => machine.removeCredential(previous.credentialReference).pipe(Effect.ignore)),
              );
            return payload({
              follower,
              selectedProfile,
              source: prepared.source,
              rotated,
              resets,
              previousIdentity,
            });
          }),
      unenroll: () =>
        Effect.gen(function*() {
          const configuration = yield* mapFailure(
            repository.getFollowerSynchronizationConfiguration(),
          );
          if (configuration === undefined) {
            return payload({
              unenrolled: false,
              detail: "this machine is not enrolled; nothing was removed",
            });
          }
          const follower = configuration.follower.id;
          // Revoke on the Source first, while the credential still exists.
          // An unreachable Source does not keep the machine enrolled: the
          // reply says so and names the command to run there.
          const source = yield* revokeFollowerEnrollment({
            endpoint: configuration.source.endpoint,
            tlsFingerprint: configuration.source.tlsFingerprint,
            credentialReference: configuration.credentialReference,
          }).pipe(
            Effect.provideService(MachineState, machine),
            Effect.match({
              onSuccess: () => ({ revoked: true, detail: "revoked on the Source" }),
              onFailure: (error) => ({
                revoked: false,
                detail: `${error.message}; revoke it on the Source with \`canonfig source revoke ${follower}\``,
              }),
            }),
          );
          yield* machine.removeCredential(configuration.credentialReference).pipe(Effect.ignore);
          const stillStored = yield* machine.loadCredential({
            reference: configuration.credentialReference,
          }).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
          if (stillStored) {
            // Keep the record that names the item, so a retry can remove it.
            return yield* new CliCommandFailure({
              category: "human-action-required",
              message:
                "the follower credential could not be removed from this machine's credential store; unlock the store for this session and run `canonfig follower unenroll` again",
            });
          }
          const secrets = yield* clearTransferredSecrets().pipe(
            Effect.provideService(MachineState, machine),
            Effect.match({
              onSuccess: (names) => ({ removed: names, detail: undefined }),
              onFailure: (error) => ({ removed: [], detail: error.message }),
            }),
          );
          yield* mapFailure(repository.removeFollowerSynchronizationConfiguration());
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
        }),
      synchronize: (input) => {
        // Only the rendered native job passes --scheduled, so the fire
        // record is evidence the real scheduler started this process.
        const scheduled = input.scheduled === true;
        const record = (outcome: string, reason?: string) =>
          scheduled ? recordScheduleFire(statePath, outcome, reason) : Effect.void;
        const run: Effect.Effect<CliPayload, CliCommandFailure> = mapFailure(synchronizeFollower(
          statePath,
          input.mode,
          undefined,
          scheduled || input.noInput,
        ).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
          Effect.provideService(Synchronization, synchronization),
          Effect.provideService(AgentResolution, agentResolution),
          Effect.provideService(ScheduleManager, schedules),
        )).pipe(Effect.flatMap(outcomePayload));
        return record("started").pipe(
          // A scheduled run restarts a down managed tunnel once, and a
          // transport failure while the tunnel is down reports the tunnel.
          Effect.andThen(repository.getFollowerSynchronizationConfiguration().pipe(
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
          )),
          Effect.flatMap((result) =>
            record("completed").pipe(Effect.as(result))
          ),
          Effect.catch((error) =>
            record("failed", fireFailureReason(error)).pipe(Effect.flatMap(() => Effect.fail(error)))
          ),
        );
      },
      abandon: () =>
        mapFailure(abandonFollowerRun(statePath).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
        )).pipe(Effect.map(payload)),
      recover: () =>
        mapFailure(recoverFollower(statePath).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
          Effect.provideService(Synchronization, synchronization),
          Effect.provideService(ScheduleManager, schedules),
        )).pipe(Effect.flatMap(outcomePayload)),
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
                  selectedProfile: configuration.selectedProfile,
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
                  activeRecovery: openRun,
                  localOverlay: configuration.localOverlay ?? [],
                  lifecycle: {
                    ...lifecycle,
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
                      localOverlay: configuration?.follower.id === follower
                        ? configuration.localOverlay ?? []
                        : [],
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
      setLocalOverlay: (input) =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) =>
            configuration === undefined
              ? Effect.fail(new CliCommandFailure({
                category: "usage-or-configuration",
                message: "follower synchronization configuration is not enrolled",
              }))
              : normalizedOverlay(configuration, input).pipe(
                Effect.flatMap((entry) =>
                  mapFailure(repository.saveLocalOverlay({
                    entry,
                    updatedAt: new Date().toISOString(),
                  })).pipe(Effect.as(entry))
                ),
                Effect.map((entry) => payload({ ...entry, saved: true })),
              )
          ),
        ),
      listLocalOverlays: () =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) =>
            configuration === undefined
              ? Effect.fail(new CliCommandFailure({
                category: "usage-or-configuration",
                message: "follower synchronization configuration is not enrolled",
              }))
              : mapFailure(repository.listLocalOverlays())
          ),
          Effect.map((overlays) => payload({
            overlays: overlays.map((overlay) => ({
              resource: overlay.resource,
              target: overlay.target,
              keys: overlay.keys,
            })),
          })),
        ),
      removeLocalOverlay: (resource) =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) =>
            configuration === undefined
              ? Effect.fail(new CliCommandFailure({
                category: "usage-or-configuration",
                message: "follower synchronization configuration is not enrolled",
              }))
              : mapFailure(repository.removeLocalOverlay({
                resource,
                updatedAt: new Date().toISOString(),
              })),
          ),
          Effect.map(() => payload({ resource, removed: true })),
        ),
      setAgentPolicy: (policy) =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) => {
            if (configuration === undefined) {
              return policies.set(policy).pipe(Effect.map(payload));
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
              ? policies.get()
              : Effect.succeed(configuration.agentPolicy)
          ),
          Effect.map(payload),
        ),
      setAgentHarness: (agentHarness) =>
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
      selectProfile: (profile) =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) => {
            if (configuration === undefined) {
              return Effect.fail(new CliCommandFailure({
                category: "usage-or-configuration",
                message: "follower synchronization configuration is not enrolled",
              }));
            }
            return mapFailure(listRevisions({
              endpoint: configuration.source.endpoint,
              tlsFingerprint: configuration.source.tlsFingerprint,
              sourceFingerprint: configuration.source.signingFingerprint,
              credentialReference: configuration.credentialReference,
              timeoutMilliseconds:
                configuration.scheduledInvocation.timeoutMilliseconds,
            }).pipe(Effect.provideService(MachineState, machine))).pipe(
              Effect.flatMap((revisions) =>
                revisions.revisions.some((revision) =>
                    revision.profileId === profile
                  )
                  ? mapFailure(repository.loadState(configuration.follower.id))
                  : Effect.fail(new CliCommandFailure({
                    category: "usage-or-configuration",
                    message: `profile ${profile} has no authorized revision`,
                  }))
              ),
              Effect.flatMap((state) =>
                state.sourceIdentity === undefined
                  ? Effect.fail(new CliCommandFailure({
                    category: "usage-or-configuration",
                    message: "follower source identity is not configured",
                  }))
                  : mapFailure(
                    repository.saveFollowerSynchronizationConfiguration({
                      sourceIdentity: state.sourceIdentity,
                      configuration: {
                        ...configuration,
                        selectedProfile: profile,
                        updatedAt: new Date().toISOString(),
                      },
                    }),
                  )
              ),
              Effect.as(payload({ selectedProfile: profile })),
            );
          }),
        ),
      setSchedule: (input) =>
        // Record the decision before installing it, so the schedule survives
        // the next apply and `schedule status` compares against it rather than
        // against a built-in default.
        "profileDefault" in input
          ? mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
            Effect.flatMap((configuration) =>
              configuration?.scheduleDefault === undefined
                ? Effect.fail(new CliCommandFailure({
                  category: "usage-or-configuration",
                  message: configuration === undefined
                    ? "canonfig schedule set --default needs an enrolled follower; enroll, then apply the selected profile first"
                    : "the selected profile declares no scheduleDefault (or no revision has been applied yet); run `canonfig sync --apply`, or choose a calendar with `canonfig schedule set <calendar>`",
                }))
                : persistScheduleOverride(repository, { kind: "inherit" }).pipe(
                  Effect.andThen(mapFailure(schedules.update({
                    schedule: syncScheduleFromDefault(configuration.scheduleDefault),
                  }))),
                  Effect.map(payload),
                )
            ),
          )
          : persistScheduleOverride(repository, {
            kind: "schedule",
            schedule: input.schedule,
            executable: input.executable,
          }).pipe(
            Effect.andThen(mapFailure(schedules.update(input))),
            Effect.map(payload),
          ),
      scheduleStatus: () =>
        mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
          Effect.flatMap((configuration) => {
            const input = desiredScheduleInput(
              configuration?.scheduleOverride,
              configuration?.scheduleDefault,
            );
            if (input === undefined) {
              // No decision; a job an earlier release installed may still run.
              return mapFailure(schedules.status()).pipe(
                Effect.map((native) =>
                  payload(native.state === "not-installed"
                    ? { state: "not-selected", detail: unscheduledDetail(configuration) }
                    : { state: "unmanaged", detail: unmanagedScheduleDetail, nativeState: native.state })
                ),
              );
            }
            const fires = readScheduleFires(statePath);
            return mapFailure(schedules.status(input)).pipe(
              Effect.map((status) =>
                payload({
                  ...status,
                  lastFire: fires.at(-1),
                  unattendedRuns: describeUnattendedRuns(fires).text,
                })
              ),
            );
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
        // Probe the configuration a run would actually use. Enrollment moves
        // the agent policy and harness into the follower configuration and
        // stops writing the policy file, so reading that file reported an
        // enrolled follower as unconfigured.
        Effect.all([
          mapFailure(repository.getFollowerSynchronizationConfiguration()),
          effectiveScheduleInput(repository),
          tunnel.tunnelStatus({ stateDirectory: join(dirname(statePath), "tunnel") }).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        ]).pipe(
          Effect.flatMap(([configuration, schedule, tunnelReport]) => {
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
              policyPath,
              agentPolicy: configuration?.agentPolicy,
              schedule,
              fires: readScheduleFires(statePath),
              unscheduledDetail: configuration === undefined
                ? undefined
                : unscheduledDetail(configuration),
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
            });
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

const credentialPolicyFromEnvironment = (): CredentialPolicy | undefined => {
  const root = process.env.CANONFIG_LOCAL_CREDENTIAL_ROOT;
  return root === undefined
    ? undefined
    : { kind: "local-file", path: root };
};

/**
 * The credential policy this follower enrolled under, read from its own state.
 *
 * The policy used to be selected only by `CANONFIG_LOCAL_CREDENTIAL_ROOT` in
 * the environment, and a native scheduled job carries no environment, so a
 * follower enrolled under the local-file policy had no credential during a
 * scheduled run and every fire failed. The enrolled configuration is the
 * authority; the environment variable is enrollment input, not a runtime one.
 *
 * Read directly rather than through StateRepository because the machine layer
 * is built before that service exists, and this is one row of one table.
 */
const enrolledCredentialPolicy = (
  statePath: string,
): CredentialPolicy | undefined => {
  try {
    const database = new DatabaseSync(statePath, { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT configuration_json FROM follower_sync_configuration WHERE singleton = 1",
        )
        .get();
      const parsedRow = Schema.decodeUnknownOption(
        Schema.Struct({ configuration_json: Schema.String }),
      )(row);
      if (Option.isNone(parsedRow)) return undefined;
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({
          credentialPolicy: Schema.optional(Schema.Union([
            Schema.Struct({ kind: Schema.Literal("secure-store") }),
            Schema.Struct({
              kind: Schema.Literal("local-file"),
              path: Schema.NonEmptyString,
            }),
          ])),
        }),
      )(JSON.parse(parsedRow.value.configuration_json));
      return Option.isNone(decoded) ? undefined : decoded.value.credentialPolicy;
    } finally {
      database.close();
    }
  } catch {
    // No state yet, an unreadable database, or a schema older than the field.
    // Enrollment is what records the policy, so an unenrolled machine falls
    // back to the environment below.
    return undefined;
  }
};

const machineLayer = (statePath: string): Layer.Layer<MachineState> => {
  // The enrolled policy wins: it is what a scheduled run has to rely on.
  const credentialPolicy = enrolledCredentialPolicy(statePath)
    ?? credentialPolicyFromEnvironment();
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
) => {
  const root = join(homedir(), ".canonfig");
  const statePath = options.statePath ?? join(root, "state.sqlite");
  const state = Layer.unwrap(
    Effect.promise(() => mkdir(dirname(statePath), { recursive: true, mode: 0o700 })).pipe(
      Effect.as(stateRepositoryLayer(statePath)),
    ),
  );
  const machine = machineLayer(statePath);
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
    Layer.provide(Layer.merge(machine, enrollment)),
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
    sourceCommandsLayer.pipe(Layer.provide(dependencies)),
    followerCommandsLayer(
      statePath,
      options.policyPath ?? join(root, "policy.json"),
      options.doctorSource ?? doctorSourceFromEnvironment(),
      options.doctorAgent ?? doctorAgentFromEnvironment(),
    ).pipe(
      Layer.provide(dependencies),
    ),
    setup,
  );
};
