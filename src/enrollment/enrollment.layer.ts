import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";

import { Effect, Layer, Redacted, Schema } from "effect";
import { generate } from "selfsigned";

import {
  CertificateFingerprint,
  ContentDigest,
  CredentialReference,
  FollowerId,
  GroupName,
  InvitationCode,
  Timestamp,
} from "../domain/brand.ts";
import { FollowerIdentity, SourceIdentity } from "../domain/identity.ts";
import {
  MachineProfileSchema,
  type ProfileRevision,
  type PublishedResource,
} from "../domain/profile.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  EnrollmentStateConflictError,
  FollowerNotFoundError,
  type StateRepositoryError,
} from "../state/state-repository.errors.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import type { EnrollmentSourceRecord } from "../state/state-repository.types.ts";
import {
  DuplicateFollowerIdentityError,
  EnrollmentConfigurationError,
  EnrollmentFingerprintMismatchError,
  EnrollmentSourceMismatchError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationReplayError,
  InvalidFollowerCredentialError,
  RevokedFollowerCredentialError,
  SourceNotInitializedError,
  TransportIntegrityError,
  TransportResourceNotFoundError,
  type EnrollmentError,
} from "./enrollment.errors.ts";
import { Enrollment } from "./enrollment.service.ts";
import { TransportPublishedResourceSchema } from "./enrollment.types.ts";
import type {
  CreateInvitationInput,
  EnrollFollowerRequest,
  EnrollmentInvitationGrant,
  RevisionMetadata,
  SourceEnrollmentMaterial,
} from "./enrollment.types.ts";
import {
  canonicalJson,
  digestOf,
  sha256BytesHex,
  sha256Hex,
  type JsonValue,
} from "../profile/profile-codec.ts";
import { revisionSigningPayload } from "../profile/publication.ts";

const decode = Schema.decodeUnknownSync;
const maximumInvitationLifetimeMilliseconds = 24 * 60 * 60 * 1000;

const sha256 = (value: string | Uint8Array): typeof ContentDigest.Type =>
  decode(ContentDigest)(createHash("sha256").update(value).digest("hex"));

const certificateFingerprint = (certificate: string) =>
  decode(CertificateFingerprint)(
    new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase(),
  );

const asJson = <Value>(value: Value): JsonValue =>
  decode(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

const resourceIsAuthorized = (
  resource: PublishedResource,
  groups: ReadonlySet<string>,
): boolean =>
  resource.groups === undefined
  || resource.groups.length === 0
  || resource.groups.some((group) => groups.has(group));

const revisionPayload = (
  revision: ProfileRevision,
  signingKeyId: string,
): string => revisionSigningPayload({
  id: revision.id,
  profileId: revision.profileId,
  sequence: revision.sequence,
  canonicalBytes: revision.canonicalBytes,
  digest: revision.digest,
  publishedAt: revision.publishedAt,
  resources: revision.resources,
  groups: revision.groups,
  scheduleDefault: revision.scheduleDefault,
  signingKeyId,
});

const validateRevision = (
  revision: ProfileRevision,
  signingKeyId: string,
  publicKey: ReturnType<typeof createPublicKey>,
): Effect.Effect<void, TransportIntegrityError> =>
  Effect.try({
    try: () => {
      if (sha256Hex(revision.canonicalBytes) !== revision.digest) {
        throw new Error("canonical content digest mismatch");
      }
      const profile = decode(MachineProfileSchema)(
        JSON.parse(revision.canonicalBytes),
      );
      if (profile.id !== revision.profileId) {
        throw new Error("profile identity mismatch");
      }
      if (
        revision.scheduleDefault !== undefined
        && canonicalJson(asJson(revision.scheduleDefault))
          !== canonicalJson(asJson(profile.scheduleDefault))
      ) {
        throw new Error("revision schedule default metadata mismatch");
      }
      const expectedResources = profile.resources.map((resource) => {
        const base = {
          id: resource.id,
          kind: resource.kind,
          policy: resource.policy,
          target: resource.target,
          dependsOn: resource.dependsOn ?? [],
          blobs: [digestOf(asJson(resource.spec))],
        };
        return resource.groups === undefined
          ? base
          : { ...base, groups: resource.groups };
      });
      if (
        canonicalJson(asJson(expectedResources))
        !== canonicalJson(asJson(revision.resources))
      ) {
        throw new Error("revision resource metadata mismatch");
      }
      const encodedSignature = revision.signature.slice("ed25519:".length);
      if (
        !revision.signature.startsWith("ed25519:")
        || !verify(
          null,
          Buffer.from(revisionPayload(revision, signingKeyId)),
          publicKey,
          Buffer.from(encodedSignature, "base64url"),
        )
      ) {
        throw new Error("source signature mismatch");
      }
    },
    catch: (cause) =>
      new TransportIntegrityError({
        artifact: revision.id,
        message: cause instanceof Error
          ? cause.message
          : "revision validation failed",
      }),
  });

const sourceMaterial = (
  record: EnrollmentSourceRecord,
): SourceEnrollmentMaterial => ({
  source: record.identity,
  signingKeyReference: record.signingKeyReference,
  tlsKeyReference: record.tlsKeyReference,
  tlsCertificateReference: record.tlsCertificateReference,
  tlsFingerprint: record.tlsFingerprint,
});

const repositoryError = (
  operation: string,
) => (error: StateRepositoryError): EnrollmentError => {
  if (error instanceof EnrollmentStateConflictError) {
    switch (error.reason) {
      case "invitation-not-found":
        return new InvitationNotFoundError({ message: "the invitation is unknown" });
      case "invitation-used":
        return new InvitationReplayError({ message: "the invitation was already used" });
      case "invitation-expired":
        return new InvitationExpiredError({ message: "the invitation has expired" });
      case "invitation-mismatch":
        return new EnrollmentSourceMismatchError({
          message: "the invitation does not match this source",
        });
      case "follower-identity-conflict":
      case "credential-conflict":
        return new DuplicateFollowerIdentityError({
          message: "the follower identity is already enrolled",
        });
    }
  }
  if (error instanceof FollowerNotFoundError) {
    return new InvalidFollowerCredentialError({
      message: "the follower credential is invalid",
    });
  }
  return new EnrollmentConfigurationError({
    operation,
    message: "durable enrollment state is unavailable",
  });
};

const validateEndpoint = (
  endpoint: string,
): Effect.Effect<string, EnrollmentConfigurationError> =>
  Effect.try({
    try: () => {
      const parsed = new URL(endpoint);
      const loopback = parsed.hostname === "127.0.0.1"
        || parsed.hostname === "[::1]"
        || parsed.hostname === "::1";
      if (
        parsed.protocol !== "https:"
        || !loopback
        || parsed.username !== ""
        || parsed.password !== ""
      ) {
        throw new Error("invalid loopback HTTPS endpoint");
      }
      return parsed.origin;
    },
    catch: () =>
      new EnrollmentConfigurationError({
        operation: "create invitation",
        message: "the endpoint must be a loopback HTTPS origin",
      }),
  });

const makeEnrollment = Effect.gen(function*() {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;

  const source = Effect.fn("Enrollment.source")(function*() {
    const stored = yield* repository.getEnrollmentSource().pipe(
      Effect.mapError(repositoryError("load source identity")),
    );
    if (stored === undefined) {
      return yield* new SourceNotInitializedError({ operation: "load source identity" });
    }
    return sourceMaterial(stored);
  });

  const initializeSource = Effect.fn("Enrollment.initializeSource")(function*() {
    const existing = yield* repository.getEnrollmentSource().pipe(
      Effect.mapError(repositoryError("load source identity")),
    );
    if (existing !== undefined) return sourceMaterial(existing);

    const generated = yield* Effect.tryPromise({
      try: async () => {
        const signing = generateKeyPairSync("ed25519");
        const signingPrivateKey = signing.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }).toString();
        const signingPublicDer = signing.publicKey.export({
          type: "spki",
          format: "der",
        });
        const certificate = await generate(
          [{ name: "commonName", value: "canonfig-loopback" }],
          {
            algorithm: "sha256",
            keyType: "ec",
            curve: "P-256",
            extensions: [
              { name: "basicConstraints", cA: false },
              { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
              { name: "extKeyUsage", serverAuth: true },
              {
                name: "subjectAltName",
                altNames: [
                  { type: 7, ip: "127.0.0.1" },
                  { type: 7, ip: "::1" },
                ],
              },
            ],
          },
        );
        return {
          signingPrivateKey,
          signingFingerprint: sha256(signingPublicDer),
          tlsPrivateKey: certificate.private,
          tlsCertificate: certificate.cert,
          tlsFingerprint: certificateFingerprint(certificate.cert),
        };
      },
      catch: () =>
        new EnrollmentConfigurationError({
          operation: "generate source identity",
          message: "source cryptographic material could not be generated",
        }),
    });

    const signingKeyReference = yield* machine.storeCredential({
      name: "canonfig-source-signing-key",
      value: Redacted.make(generated.signingPrivateKey),
    }).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "store source signing key",
          message: "secure credential storage is unavailable",
        })
      ),
    );
    const tlsKeyReference = yield* machine.storeCredential({
      name: "canonfig-source-tls-key",
      value: Redacted.make(generated.tlsPrivateKey),
    }).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "store source TLS key",
          message: "secure credential storage is unavailable",
        })
      ),
    );
    const tlsCertificateReference = yield* machine.storeCredential({
      name: "canonfig-source-tls-certificate",
      value: Redacted.make(generated.tlsCertificate),
    }).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "store source TLS certificate",
          message: "secure credential storage is unavailable",
        })
      ),
    );
    const identity = decode(SourceIdentity)({
      keyId: `ed25519:${generated.signingFingerprint}`,
      publicKeyFingerprint: generated.signingFingerprint,
    });
    const record: EnrollmentSourceRecord = {
      identity,
      signingKeyReference,
      tlsKeyReference,
      tlsCertificateReference,
      tlsFingerprint: generated.tlsFingerprint,
    };
    yield* repository.saveEnrollmentSource(record).pipe(
      Effect.mapError(repositoryError("save source identity")),
    );
    return sourceMaterial(record);
  });

  const createInvitation = Effect.fn("Enrollment.createInvitation")(function*(
    input: CreateInvitationInput,
  ): Effect.fn.Return<EnrollmentInvitationGrant, EnrollmentError> {
    const material = yield* source();
    const endpoint = yield* validateEndpoint(input.endpoint);
    if (
      !Number.isSafeInteger(input.expiresInMilliseconds)
      || input.expiresInMilliseconds <= 0
      || input.expiresInMilliseconds > maximumInvitationLifetimeMilliseconds
    ) {
      return yield* new EnrollmentConfigurationError({
        operation: "create invitation",
        message: "invitation lifetime must be between 1 ms and 24 hours",
      });
    }
    const groups = yield* Schema.decodeUnknownEffect(
      Schema.Array(GroupName),
    )(input.groups ?? []).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "create invitation",
          message: "invitation groups are invalid",
        })
      ),
    );
    const uniqueGroups = [...new Set(groups)];
    const code = decode(InvitationCode)(randomBytes(32).toString("base64url"));
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = decode(Timestamp)(
      new Date(Date.now() + input.expiresInMilliseconds).toISOString(),
    );
    yield* repository.createEnrollmentInvitation({
      codeDigest: sha256(code),
      nonceDigest: sha256(nonce),
      intendedSourceFingerprint: material.source.publicKeyFingerprint,
      tlsFingerprint: material.tlsFingerprint,
      endpoint,
      groups: uniqueGroups,
      expiresAt,
    }).pipe(Effect.mapError(repositoryError("create invitation")));
    return {
      code,
      nonce,
      endpoint,
      sourceFingerprint: material.source.publicKeyFingerprint,
      tlsFingerprint: material.tlsFingerprint,
      groups: uniqueGroups,
      expiresAt,
    };
  });

  const enrollFollower = Effect.fn("Enrollment.enrollFollower")(function*(
    request: EnrollFollowerRequest,
  ) {
    const material = yield* source();
    if (request.sourceFingerprint !== material.source.publicKeyFingerprint) {
      return yield* new EnrollmentSourceMismatchError({
        message: "the invitation targets a different source identity",
      });
    }
    if (request.tlsFingerprint !== material.tlsFingerprint) {
      return yield* new EnrollmentFingerprintMismatchError({
        message: "the pinned TLS fingerprint does not match this source",
      });
    }
    const invitation = yield* repository.findEnrollmentInvitation(
      sha256(request.code),
    ).pipe(Effect.mapError(repositoryError("find invitation")));
    if (invitation === undefined) {
      return yield* new InvitationNotFoundError({ message: "the invitation is unknown" });
    }
    if (invitation.usedAt !== undefined) {
      return yield* new InvitationReplayError({ message: "the invitation was already used" });
    }
    if (Date.parse(invitation.expiresAt) <= Date.now()) {
      return yield* new InvitationExpiredError({ message: "the invitation has expired" });
    }
    const normalizedName = request.followerName.trim().normalize("NFC");
    if (
      normalizedName.length === 0
      || normalizedName.length > 128
      || /\p{Cc}/u.test(normalizedName)
    ) {
      return yield* new EnrollmentConfigurationError({
        operation: "enroll follower",
        message: "follower name is invalid",
      });
    }
    const followerId = decode(FollowerId)(
      `follower-${sha256(`${material.source.publicKeyFingerprint}\0${normalizedName}`).slice(0, 32)}`,
    );
    // Reject a duplicate identity before touching credential storage: the
    // credential key is deterministic per follower identity, so storing first
    // would overwrite and then delete an already enrolled follower's secret.
    const existingCredential = yield* repository.getFollowerCredential(followerId).pipe(
      Effect.match({
        onFailure: (error) => ({ found: false as const, error }),
        onSuccess: (record) => ({ found: true as const, record }),
      }),
    );
    if (existingCredential.found && !existingCredential.record.follower.revoked) {
      return yield* new DuplicateFollowerIdentityError({
        message: "the follower identity is already enrolled",
      });
    }
    if (
      !existingCredential.found
      && !(existingCredential.error instanceof FollowerNotFoundError)
    ) {
      return yield* new EnrollmentConfigurationError({
        operation: "enroll follower",
        message: "durable enrollment state is unavailable",
      });
    }
    const credential = randomBytes(32).toString("base64url");
    const previousCredentialReference = existingCredential.found
      ? existingCredential.record.credentialReference
      : undefined;
    const credentialReference = yield* machine.storeCredential({
      name: `canonfig-source-follower-${followerId}-${randomUUID()}`,
      value: Redacted.make(credential),
    }).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "store follower credential",
          message: "secure credential storage is unavailable",
        })
      ),
    );
    const enrolledAt = decode(Timestamp)(new Date().toISOString());
    const follower = decode(FollowerIdentity)({
      id: followerId,
      name: normalizedName,
      groups: invitation.groups,
      revoked: false,
      credentialReference,
      enrolledAt,
    });
    const pendingEnrollments = yield* repository.listPendingEnrollments().pipe(
      Effect.mapError(repositoryError("load pending enrollment")),
    );
    const pending = pendingEnrollments.find(
      (entry) => entry.codeDigest === sha256(request.code),
    );
    if (pending !== undefined) {
      if (pending.follower !== follower.id) {
        return yield* new InvitationReplayError({
          message: "the invitation was already used",
        });
      }
      // A process may have returned the prepared response before the follower
      // persisted its local configuration. Re-prepare the same one-time
      // invitation instead of leaving a retry permanently blocked.
      yield* repository.cancelPendingEnrollment({
        credentialDigest: pending.credentialDigest,
      }).pipe(Effect.mapError(repositoryError("replace pending enrollment")));
      yield* machine.removeCredential(pending.credentialReference).pipe(Effect.ignore);
    }
    yield* repository.consumeEnrollmentInvitation({
      codeDigest: sha256(request.code),
      nonceDigest: sha256(request.nonce),
      intendedSourceFingerprint: request.sourceFingerprint,
      tlsFingerprint: request.tlsFingerprint,
      follower,
      credentialDigest: sha256(credential),
      credentialReference: decode(CredentialReference)(credentialReference),
      consumedAt: enrolledAt,
    }).pipe(
      Effect.mapError(repositoryError("consume invitation")),
      Effect.tapError(() => machine.removeCredential(credentialReference).pipe(Effect.ignore)),
    );
    if (
      previousCredentialReference !== undefined
      && previousCredentialReference !== credentialReference
    ) {
      yield* machine.removeCredential(previousCredentialReference).pipe(Effect.ignore);
    }
    const authorizedProfiles = yield* repository.listRevisions().pipe(
      Effect.mapError(repositoryError("list authorized profiles")),
      Effect.map((revisions) => revisions.map((revision) => ({
        id: revision.id,
        profileId: revision.profileId,
        sequence: revision.sequence,
        digest: decode(ContentDigest)(revision.digest),
        publishedAt: revision.publishedAt,
      }))),
    );
    return {
      follower,
      credential,
      source: material.source,
      tlsFingerprint: material.tlsFingerprint,
      authorizedProfiles,
    };
  });

  const finalizeFollower = Effect.fn("Enrollment.finalizeFollower")(function*(
    credential: string,
  ) {
    const credentialDigest = sha256(credential);
    const pending = yield* repository.listPendingEnrollments().pipe(
      Effect.mapError(repositoryError("find pending enrollment")),
    );
    const pendingEnrollment = pending.find(
      (entry) => entry.credentialDigest === credentialDigest,
    );
    if (pendingEnrollment === undefined) {
      const stored = yield* repository.findFollowerCredential(credentialDigest).pipe(
        Effect.mapError(repositoryError("finalize follower enrollment")),
      );
      if (stored === undefined || stored.follower.revoked) {
        return yield* new InvalidFollowerCredentialError({
          message: "the follower credential is invalid",
        });
      }
      return;
    }
    yield* repository.finalizeEnrollment({
      follower: pendingEnrollment.follower,
      credentialDigest,
      credentialReference: pendingEnrollment.credentialReference,
    }).pipe(Effect.mapError(repositoryError("finalize follower enrollment")));
  });

  const cancelPendingEnrollment = Effect.fn(
    "Enrollment.cancelPendingEnrollment",
  )(function*(credential: string) {
    yield* repository.cancelPendingEnrollment({
      credentialDigest: sha256(credential),
    }).pipe(Effect.mapError(repositoryError("cancel pending enrollment")));
  });

  const revokeAuthenticatedFollower = Effect.fn(
    "Enrollment.revokeAuthenticatedFollower",
  )(function*(credential: string) {
    const authenticated = yield* authenticate(credential);
    yield* repository.revokeFollower(authenticated.follower.id).pipe(
      Effect.mapError(repositoryError("revoke follower")),
    );
  });

  const authenticate = Effect.fn("Enrollment.authenticate")(function*(
    credential: string,
  ) {
    if (credential.length < 32 || credential.length > 512) {
      return yield* new InvalidFollowerCredentialError({
        message: "the follower credential is invalid",
      });
    }
    const stored = yield* repository.findFollowerCredential(sha256(credential)).pipe(
      Effect.mapError(repositoryError("authenticate follower")),
    );
    if (stored === undefined) {
      return yield* new InvalidFollowerCredentialError({
        message: "the follower credential is invalid",
      });
    }
    if (stored.follower.revoked) {
      return yield* new RevokedFollowerCredentialError({
        message: "the follower credential has been revoked",
      });
    }
    return { follower: stored.follower };
  });

  const signingKeys = Effect.fn("Enrollment.signingKeys")(function*() {
    const material = yield* source();
    const stored = yield* machine.loadCredential({
      reference: material.signingKeyReference,
    }).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "load source signing key",
          message: "source signing credentials are unavailable",
        })
      ),
    );
    const privateKey = yield* Effect.try({
      try: () => createPrivateKey(Redacted.value(stored)),
      catch: () =>
        new EnrollmentConfigurationError({
          operation: "decode source signing key",
          message: "source signing credentials are invalid",
        }),
    });
    const publicKey = createPublicKey(privateKey);
    const fingerprint = sha256BytesHex(publicKey.export({
      type: "spki",
      format: "der",
    }));
    if (String(fingerprint) !== String(material.source.publicKeyFingerprint)) {
      return yield* new TransportIntegrityError({
        artifact: "source-signing-key",
        message: "source signing key fingerprint mismatch",
      });
    }
    return {
      material,
      privateKey,
      publicKey,
      publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  });

  const authorizedRevisions = Effect.fn("Enrollment.authorizedRevisions")(
    function*(credential: string) {
      const authenticated = yield* authenticate(credential);
      const revisions = yield* repository.listRevisions().pipe(
        Effect.mapError(repositoryError("list authorized revisions")),
      );
      const groups = new Set<string>(authenticated.follower.groups);
      return revisions
        .map((revision) => {
          const visibleIds = new Set(
            revision.resources
              .filter((resource) => resourceIsAuthorized(resource, groups))
              .map((resource) => resource.id),
          );
          // Authorization is a projection of the signed revision, not a
          // dependency rewrite. Remove every dependent whose complete
          // dependency closure is not visible, including transitive
          // dependents. This deliberately fails closed instead of allowing a
          // follower to plan against an incomplete resource graph.
          let changed = true;
          while (changed) {
            changed = false;
            for (const resource of revision.resources) {
              if (
                visibleIds.has(resource.id)
                && resource.dependsOn.some((dependency) =>
                  !visibleIds.has(dependency)
                )
              ) {
                visibleIds.delete(resource.id);
                changed = true;
              }
            }
          }
          const resources = revision.resources
            .filter((resource) => visibleIds.has(resource.id))
            .map((resource) => {
              const base = {
                ...resource,
                dependsOn: resource.dependsOn.filter((dependency) =>
                  visibleIds.has(dependency)
                ),
              };
              if (resource.groups === undefined) return base;
              return {
                ...base,
                groups: resource.groups.filter((group) => groups.has(group)),
              };
            });
          return { revision, resources };
        });
    },
  );

  const listAuthorizedRevisions = Effect.fn(
    "Enrollment.listAuthorizedRevisions",
  )(function*(credential: string) {
    const revisions = yield* authorizedRevisions(credential);
    return {
      revisions: revisions.map(({ revision }) => ({
        id: revision.id,
        profileId: revision.profileId,
        sequence: revision.sequence,
        digest: decode(ContentDigest)(revision.digest),
        publishedAt: revision.publishedAt,
      })),
    };
  });

  const getAuthorizedRevision = Effect.fn(
    "Enrollment.getAuthorizedRevision",
  )(function*(credential: string, revisionId: string) {
    const revisions = yield* authorizedRevisions(credential);
    const selected = revisions.find(({ revision }) => revision.id === revisionId);
    if (selected === undefined) {
      return yield* new TransportResourceNotFoundError({
        resource: "revision",
      });
    }
    const keys = yield* signingKeys();
    yield* validateRevision(
      selected.revision,
      keys.material.source.keyId,
      keys.publicKey,
    );
    const profile = decode(MachineProfileSchema)(
      JSON.parse(selected.revision.canonicalBytes),
    );
    const authoredById = new Map(profile.resources.map((resource) => [
      resource.id,
      resource,
    ]));
    const resources = decode(Schema.Array(TransportPublishedResourceSchema))(
      selected.resources.map((resource) => {
        const authored = authoredById.get(resource.id);
        if (authored === undefined) {
          throw new TransportIntegrityError({
            artifact: resource.id,
            message: "authorized resource has no canonical verification contract",
          });
        }
        return { ...resource, verify: authored.verify };
      }),
    );
    const unsigned = {
      id: selected.revision.id,
      profileId: selected.revision.profileId,
      sequence: selected.revision.sequence,
      digest: decode(ContentDigest)(selected.revision.digest),
      publishedAt: selected.revision.publishedAt,
      resources,
      scheduleDefault: profile.scheduleDefault,
      signingKeyId: keys.material.source.keyId,
      signingPublicKey: keys.publicPem,
      sourceSignature: selected.revision.signature,
    };
    const metadataDigest = digestOf(asJson(unsigned));
    const signature = `ed25519:${
      sign(
        null,
        Buffer.from(canonicalJson(asJson({ ...unsigned, metadataDigest }))),
        keys.privateKey,
      ).toString("base64url")
    }`;
    const metadata: RevisionMetadata = {
      ...unsigned,
      metadataDigest,
      signature,
    };
    return metadata;
  });

  const getAuthorizedBlob = Effect.fn("Enrollment.getAuthorizedBlob")(
    function*(credential: string, blobId: string) {
      const revisions = yield* authorizedRevisions(credential);
      for (const { revision, resources } of revisions) {
        const keys = yield* signingKeys();
        yield* validateRevision(
          revision,
          keys.material.source.keyId,
          keys.publicKey,
        );
        const profile = decode(MachineProfileSchema)(
          JSON.parse(revision.canonicalBytes),
        );
        for (const resource of resources) {
          if (!resource.blobs.some((blob) => blob === blobId)) continue;
          const authored = profile.resources.find((item) => item.id === resource.id);
          if (authored === undefined) {
            return yield* new TransportIntegrityError({
              artifact: blobId,
              message: "authorized blob has no canonical resource",
            });
          }
          const bytes = Buffer.from(canonicalJson(asJson(authored.spec)));
          if (sha256BytesHex(bytes) !== blobId) {
            return yield* new TransportIntegrityError({
              artifact: blobId,
              message: "canonical blob digest mismatch",
            });
          }
          return bytes;
        }
      }
      return yield* new TransportResourceNotFoundError({ resource: "blob" });
    },
  );

  const revokeFollower = Effect.fn("Enrollment.revokeFollower")(function*(
    follower: typeof FollowerId.Type,
  ) {
    yield* repository.revokeFollower(follower).pipe(
      Effect.mapError(repositoryError("revoke follower")),
    );
  });

  const updateFollowerGroups = Effect.fn("Enrollment.updateFollowerGroups")(function*(
    follower: typeof FollowerId.Type,
    groups: ReadonlyArray<typeof GroupName.Type>,
  ) {
    const validated = yield* Schema.decodeUnknownEffect(Schema.Array(GroupName))(groups).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "update follower groups",
          message: "follower groups are invalid",
        })
      ),
    );
    yield* repository.updateFollowerGroups(follower, [...new Set(validated)]).pipe(
      Effect.mapError(repositoryError("update follower groups")),
    );
  });

  const getFollower = Effect.fn("Enrollment.getFollower")(function*(
    follower: typeof FollowerId.Type,
  ) {
    const stored = yield* repository.getFollowerCredential(follower).pipe(
      Effect.mapError(repositoryError("get follower")),
    );
    return stored.follower;
  });

  return Enrollment.of({
    initializeSource,
    source,
    createInvitation,
    enrollFollower,
    finalizeFollower,
    cancelPendingEnrollment,
    revokeAuthenticatedFollower,
    authenticate,
    listAuthorizedRevisions,
    getAuthorizedRevision,
    getAuthorizedBlob,
    revokeFollower,
    updateFollowerGroups,
    getFollower,
  });
});

export const EnrollmentLive = Layer.effect(Enrollment, makeEnrollment);
