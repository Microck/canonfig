import {
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
  verify as verifyPayload,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer, Option, Redacted, Schema } from "effect";

import { SourceSignature } from "../domain/brand.ts";
import { AgentPolicy } from "../domain/identity.ts";
import { AgentResolutionLive } from "../agent/agent-resolution.layer.ts";
import { AgentResolution } from "../agent/agent-resolution.service.ts";
import { EnrollmentLive } from "../enrollment/enrollment.layer.ts";
import { Enrollment } from "../enrollment/enrollment.service.ts";
import {
  cancelFollowerEnrollment,
  enrollFollower,
  getRevisionMetadata,
  finalizeFollowerEnrollment,
  listRevisions,
} from "../enrollment/follower-client.ts";
import { startSourceServer } from "../enrollment/source-server.ts";
import {
  decodeMachineProfileJsonc,
  type MachineProfile,
} from "../domain/profile.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { CredentialPolicy } from "../machine/machine-state.types.ts";
import { linuxMachineStateLayer } from "../machine/linux.layer.ts";
import { macosMachineStateLayer } from "../machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../machine/windows.layer.ts";
import { ProfileCatalog } from "../profile/profile-catalog.service.ts";
import {
  PublicationSigningError,
} from "../profile/profile-catalog.errors.ts";
import {
  scanDiscovery,
  type DiscoveryScanResult,
} from "../profile/discovery.ts";
import {
  acceptPublicationProposal,
  makePublication,
  type ProfileRevisionSigner,
} from "../profile/publication.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import { scheduleManagerLayer } from "../schedule/schedule-manager.layer.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { stateRepositoryLayer } from "../state/state-repository.layer.ts";
import { SynchronizationLive } from "../synchronization/synchronization.layer.ts";
import { Synchronization } from "../synchronization/synchronization.service.ts";
import {
  defaultScheduledInvocation,
} from "../synchronization/follower-sync-config.ts";
import type { FollowerSynchronizationConfiguration } from
  "../synchronization/follower-sync-config.ts";
import {
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

const readAuthoredProfile = (
  path: string,
): Effect.Effect<MachineProfile, CliCommandFailure> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => new CliCommandFailure({
      category: "usage-or-configuration",
      message: "authored profile file could not be read",
    }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => decodeMachineProfileJsonc(text),
        catch: () => new CliCommandFailure({
          category: "usage-or-configuration",
          message: "authored profile file is malformed or invalid",
        }),
      })
    ),
  );

const mapFailure = <Success, Failure extends TaggedRuntimeError, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, CliCommandFailure, Requirements> =>
  effect.pipe(Effect.mapError(commandFailure));

const sourceCommandsLayer: Layer.Layer<
  SourceCommands,
  never,
  Enrollment | MachineState | ProfileCatalog | StateRepository
> = Layer.effect(
  SourceCommands,
  Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    const machine = yield* MachineState;
    const profiles = yield* ProfileCatalog;
    const repository = yield* StateRepository;

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
            };
          const now = new Date().toISOString();
          const revision = yield* mapFailure(profiles.publish({
            proposal,
            profile,
            review: acceptPublicationProposal(proposal, input.reviewer, now),
            publishedAt: now,
          }));
          return payload(revision);
        }),
      serve: (input) =>
        mapFailure(startSourceServer(input).pipe(
          Effect.provideService(Enrollment, enrollment),
          Effect.provideService(MachineState, machine),
        )).pipe(
          Effect.map((handle) => payload({
            endpoint: handle.endpoint,
            fingerprint: handle.fingerprint,
          })),
        ),
      invite: (input) =>
        mapFailure(enrollment.createInvitation(input)).pipe(
          Effect.map((grant) => payload({
            invite: Buffer.from(JSON.stringify(grant)).toString("base64url"),
            endpoint: grant.endpoint,
            expiresAt: grant.expiresAt,
            groups: grant.groups,
          })),
        ),
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
  Enrollment | MachineState | StateRepository
> = Layer.effect(
  ProfileCatalog,
  Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    const machine = yield* MachineState;
    const repository = yield* StateRepository;
    return ProfileCatalog.of({
      scan: scanDiscovery,
      publish: (input) =>
        Effect.gen(function*() {
          const material = yield* enrollment.source().pipe(
            Effect.mapError((error) =>
              new PublicationSigningError({
                operation: "sign",
                reason: error.message,
              })
            ),
          );
          const encodedKey = yield* machine.loadCredential({
            reference: material.signingKeyReference,
          }).pipe(
            Effect.mapError((error) =>
              new PublicationSigningError({
                operation: "sign",
                reason: error.message,
              })
            ),
          );
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
  MachineState | ScheduleManager | StateRepository | Synchronization
  | AgentResolution
> => Layer.effect(
  FollowerCommands,
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const schedules = yield* ScheduleManager;
    const repository = yield* StateRepository;
    const synchronization = yield* Synchronization;
    const agentResolution = yield* AgentResolution;
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
            || key.includes("\0")
            || key.split(".").some((segment) => segment.length === 0)
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
                  defaultScheduledInvocation.timeoutMilliseconds,
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
              enrollmentPending: true as const,
              scheduledInvocation: defaultScheduledInvocation,
              updatedAt: new Date().toISOString(),
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
            return payload({
              follower,
              selectedProfile,
              source: prepared.source,
            });
          }),
      synchronize: (input) =>
        mapFailure(synchronizeFollower(
          statePath,
          input.mode,
          undefined,
          input.noInput,
        ).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
          Effect.provideService(Synchronization, synchronization),
          Effect.provideService(AgentResolution, agentResolution),
          Effect.provideService(ScheduleManager, schedules),
        )).pipe(Effect.flatMap(outcomePayload)),
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
              configuration === undefined
                ? Effect.fail(new CliCommandFailure({
                  category: "usage-or-configuration",
                  message: "follower synchronization configuration is not enrolled",
                }))
                : mapFailure(repository.loadState(configuration.follower.id)).pipe(
                  Effect.map((state) => ({
                    ...state,
                    localOverlay: configuration.localOverlay ?? [],
                  })),
                )
            ),
            Effect.map(payload),
          )
          : mapFailure(repository.loadState(follower)).pipe(
            Effect.flatMap((state) =>
              mapFailure(repository.getFollowerSynchronizationConfiguration()).pipe(
                Effect.map((configuration) => ({
                  ...state,
                  localOverlay: configuration?.follower.id === follower
                    ? configuration.localOverlay ?? []
                    : [],
                })),
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
        mapFailure(schedules.update(input)).pipe(Effect.map(payload)),
      scheduleStatus: () =>
        mapFailure(schedules.status()).pipe(Effect.map(payload)),
      removeSchedule: () =>
        mapFailure(schedules.remove()).pipe(Effect.map(payload)),
      doctor: (input) =>
        runDoctorProbes({
          ...input,
          statePath,
          policyPath,
          source: doctorSource,
          agent: doctorAgent,
        }).pipe(
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

const machineLayer = (): Layer.Layer<MachineState> => {
  const credentialPolicy = credentialPolicyFromEnvironment();
  switch (process.platform) {
    case "darwin":
      return macosMachineStateLayer({ credentialPolicy });
    case "win32":
      return windowsMachineStateLayer({ credentialPolicy });
    default:
      return linuxMachineStateLayer({ credentialPolicy });
  }
};

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
  const machine = machineLayer();
  const enrollment = EnrollmentLive.pipe(Layer.provide(Layer.merge(state, machine)));
  const profiles = runtimeProfileCatalogLayer.pipe(
    Layer.provide(Layer.mergeAll(state, machine, enrollment)),
  );
  const schedule = scheduleManagerLayer.pipe(Layer.provide(machine));
  const synchronization = SynchronizationLive.pipe(
    Layer.provide(Layer.merge(state, machine)),
  );
  const dependencies = Layer.mergeAll(
    state,
    machine,
    enrollment,
    profiles,
    schedule,
    synchronization,
    AgentResolutionLive,
  );
  return Layer.merge(
    sourceCommandsLayer.pipe(Layer.provide(dependencies)),
    followerCommandsLayer(
      statePath,
      options.policyPath ?? join(root, "policy.json"),
      options.doctorSource ?? doctorSourceFromEnvironment(),
      options.doctorAgent ?? doctorAgentFromEnvironment(),
    ).pipe(
      Layer.provide(dependencies),
    ),
  );
};
