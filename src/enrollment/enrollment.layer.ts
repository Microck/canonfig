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
import type { KeyObject } from "node:crypto";

import { Effect, Layer, Redacted, Schema } from "effect";

import {
  CertificateFingerprint,
  ContentDigest,
  BlobId,
  CredentialReference,
  FollowerId,
  GroupName,
  InvitationCode,
  ProfileRevisionId,
  Timestamp,
} from "../domain/brand.ts";
import { FollowerIdentity, SourceIdentity } from "../domain/identity.ts";
import {
  PublishedMachineProfileSchema,
  type ProfileRevision,
  type PublishedResource,
} from "../domain/profile.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  CredentialStorageError,
  credentialFailureDetail,
} from "../machine/machine-state.errors.ts";
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
  SourceCredentialMismatchError,
  SourceNotInitializedError,
  LegacyRevisionFormatError,
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
  SourceCredentials,
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
import {
  isLegacyRevision,
  legacySignedResources,
  legacyStoredResources,
  LegacyRevisionFormatIssue,
  projectLegacyProfile,
} from "../profile/legacy-revision.ts";

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

type AuthorizableResource = Pick<PublishedResource, "id" | "groups" | "dependsOn">;

const resourceIsAuthorized = (
  resource: AuthorizableResource,
  groups: ReadonlySet<string>,
): boolean =>
  resource.groups === undefined
  || resource.groups.length === 0
  || resource.groups.some((group) => groups.has(group));

const visibleResources = <Resource extends AuthorizableResource>(
  resources: ReadonlyArray<Resource>,
  groups: ReadonlySet<string>,
): ReadonlyArray<Resource> => {
  const visibleIds = new Set(
    resources
      .filter((resource) => resourceIsAuthorized(resource, groups))
      .map((resource) => resource.id),
  );
  // Authorization is a projection of the signed revision, not a dependency
  // rewrite. Remove every dependent whose complete dependency closure is not
  // visible, including transitive dependents. This deliberately fails closed
  // instead of allowing a follower to plan against an incomplete resource
  // graph.
  let changed = true;
  while (changed) {
    changed = false;
    for (const resource of resources) {
      if (
        visibleIds.has(resource.id)
        && resource.dependsOn.some((dependency) => !visibleIds.has(dependency))
      ) {
        visibleIds.delete(resource.id);
        changed = true;
      }
    }
  }
  return resources.filter((resource) => visibleIds.has(resource.id));
};

/** The visible resources, with group references narrowed to the follower's. */
const authorizedResources = <Resource extends AuthorizableResource>(
  resources: ReadonlyArray<Resource>,
  groups: ReadonlySet<string>,
): ReadonlyArray<Resource> =>
  visibleResources(resources, groups).map((resource) =>
    resource.groups === undefined
      ? resource
      : { ...resource, groups: resource.groups.filter((group) => groups.has(group)) }
  );

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

type PublishedMachineProfile = Schema.Schema.Type<typeof PublishedMachineProfileSchema>;

const verifyRevisionSignature = (
  signature: string,
  payload: string,
  publicKey: KeyObject,
): void => {
  if (
    !signature.startsWith("ed25519:")
    || !verify(
      null,
      Buffer.from(payload),
      publicKey,
      Buffer.from(signature.slice("ed25519:".length), "base64url"),
    )
  ) {
    throw new Error("source signature mismatch");
  }
};

/**
 * The payload a legacy revision was signed over. It has the shape of
 * `revisionSigningPayload`, with the resource index taken from the signed
 * profile, so the schedule items this release leaves out of the stored
 * metadata still count toward the signature.
 */
const legacyRevisionPayload = (
  revision: ProfileRevision,
  signingKeyId: string,
): string => canonicalJson(asJson({
  id: revision.id,
  profileId: revision.profileId,
  sequence: revision.sequence,
  canonicalBytes: revision.canonicalBytes,
  digest: revision.digest,
  publishedAt: revision.publishedAt,
  resources: legacySignedResources(revision.canonicalBytes),
  groups: revision.groups,
  signingKeyId,
}));

const verifyProfileMetadata = (
  revision: ProfileRevision,
  profile: PublishedMachineProfile,
): void => {
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
};

const integrityFailure = (revision: ProfileRevision) => (cause: unknown) =>
  new TransportIntegrityError({
    artifact: revision.id,
    message: cause instanceof Error
      ? cause.message
      : "revision validation failed",
  });

/**
 * A revision an earlier release published is verified exactly as that release
 * verified it, then projected into this release's transport shape. Anything
 * the projection cannot represent is refused by name, not served altered.
 */
const validateLegacyRevision = (
  revision: ProfileRevision,
  signingKeyId: string,
  publicKey: KeyObject,
): Effect.Effect<PublishedMachineProfile, TransportIntegrityError | LegacyRevisionFormatError> =>
  Effect.try({
    try: () => {
      if (sha256Hex(revision.canonicalBytes) !== revision.digest) {
        throw new Error("canonical content digest mismatch");
      }
      if (
        canonicalJson(legacyStoredResources(revision.canonicalBytes))
          !== canonicalJson(asJson(revision.resources))
      ) {
        throw new Error("revision resource metadata mismatch");
      }
      verifyRevisionSignature(
        revision.signature,
        legacyRevisionPayload(revision, signingKeyId),
        publicKey,
      );
    },
    catch: integrityFailure(revision),
  }).pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => projectLegacyProfile(revision.canonicalBytes),
        catch: (cause) =>
          cause instanceof LegacyRevisionFormatIssue
            ? new LegacyRevisionFormatError({
              message:
                `revision ${revision.id} was published by a canonfig release before 3.2.1 and this release cannot serve it: ${cause.message}. publish the profile again with 'canonfig source publish' on the Source Machine`,
            })
            : integrityFailure(revision)(cause),
      })
    ),
    Effect.tap(({ notices }) =>
      Effect.forEach(notices, (notice) =>
        Effect.logWarning(`revision ${revision.id}: ${notice}`), { discard: true })
    ),
    Effect.map(({ profile }) => profile),
    Effect.tap((profile) =>
      Effect.try({
        try: () => verifyProfileMetadata(revision, profile),
        catch: integrityFailure(revision),
      })
    ),
  );

const validateRevision = (
  revision: ProfileRevision,
  signingKeyId: string,
  publicKey: KeyObject,
): Effect.Effect<PublishedMachineProfile, TransportIntegrityError | LegacyRevisionFormatError> =>
  isLegacyRevision(revision)
    ? validateLegacyRevision(revision, signingKeyId, publicKey)
    : Effect.try({
      try: () => {
        if (sha256Hex(revision.canonicalBytes) !== revision.digest) {
          throw new Error("canonical content digest mismatch");
        }
        const profile = decode(PublishedMachineProfileSchema)(
          JSON.parse(revision.canonicalBytes),
        );
        verifyProfileMetadata(revision, profile);
        const expectedResources = profile.resources.map(({ verify: _, ...resource }) =>
          resource
        );
        if (
          canonicalJson(asJson(expectedResources))
          !== canonicalJson(asJson(revision.resources))
        ) {
          throw new Error("revision resource metadata mismatch");
        }
        verifyRevisionSignature(
          revision.signature,
          revisionPayload(revision, signingKeyId),
          publicKey,
        );
        return profile;
      },
      catch: integrityFailure(revision),
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

interface SourceSecrets {
  readonly signingPrivateKey: Redacted.Redacted<string>;
  readonly tlsPrivateKey: Redacted.Redacted<string>;
  readonly tlsCertificate: Redacted.Redacted<string>;
}

/**
 * Why stored Source secrets do not belong to the recorded identity, or
 * undefined when they do: the signing key must hash to the Source identity's
 * fingerprint, the certificate to the recorded TLS fingerprint, and the TLS
 * key must be the certificate's key.
 */
const sourceSecretsMismatch = (
  material: SourceEnrollmentMaterial,
  secrets: SourceSecrets,
): string | undefined => {
  try {
    const signingFingerprint = sha256BytesHex(
      createPublicKey(createPrivateKey(Redacted.value(secrets.signingPrivateKey))).export({
        type: "spki",
        format: "der",
      }),
    );
    if (String(signingFingerprint) !== String(material.source.publicKeyFingerprint)) {
      return `the stored signing key has fingerprint ${signingFingerprint}, but this Source's identity is ${material.source.publicKeyFingerprint}`;
    }
    const certificate = new X509Certificate(Redacted.value(secrets.tlsCertificate));
    const tlsFingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
    if (tlsFingerprint !== String(material.tlsFingerprint)) {
      return `the stored TLS certificate has fingerprint ${tlsFingerprint}, but this Source records ${material.tlsFingerprint}`;
    }
    if (!certificate.checkPrivateKey(createPrivateKey(Redacted.value(secrets.tlsPrivateKey)))) {
      return "the stored TLS private key does not belong to this Source's certificate";
    }
    return undefined;
  } catch {
    return "the stored Source credentials are not a valid signing key, TLS key and certificate";
  }
};

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
  // A follower the Source Machine has never enrolled is not a credential
  // problem: reporting one sent the operator looking for a revoked or corrupt
  // credential when they had simply named an id that does not exist.
  if (error instanceof FollowerNotFoundError) return error;
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
  // A pending enrollment has not issued an active follower credential. Any
  // process restart makes its remote outcome ambiguous, so fail closed by
  // discarding the pending marker; the invitation remains unconsumed and can
  // be safely retried because no active follower identity was issued. The
  // Source-side credential that enrollment stored goes with it.
  yield* Effect.gen(function*() {
    const abandoned = yield* repository.listPendingEnrollments();
    for (const pending of abandoned) {
      yield* repository.cancelPendingEnrollment({ credentialDigest: pending.credentialDigest });
      yield* machine.removeCredential(pending.credentialReference).pipe(Effect.ignore);
    }
  }).pipe(Effect.ignore);
  const maximumRevisionValidationCacheEntries = 1024;
  const validatedRevisionCache = new Map<
    string,
    PublishedMachineProfile
  >();
  let cachedSigningKeys:
    | {
      readonly cacheKey: string;
      readonly value: {
        readonly material: SourceEnrollmentMaterial;
        readonly privateKey: ReturnType<typeof createPrivateKey>;
        readonly publicKey: ReturnType<typeof createPublicKey>;
        readonly publicPem: string;
      };
    }
    | undefined;

  const cacheSet = <Value>(
    cache: Map<string, Value>,
    key: string,
    value: Value,
    maximumEntries: number,
  ): void => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maximumEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const cachedRevision = Effect.fn("Enrollment.cachedRevision")(function*(
    revision: ProfileRevision,
    signingKeyId: string,
    signingKeyVersion: string,
    publicKey: ReturnType<typeof createPublicKey>,
  ) {
    const revisionVersion = sha256Hex(canonicalJson(asJson(revision)));
    const cacheKey = [
      revision.id,
      revisionVersion,
      signingKeyId,
      signingKeyVersion,
    ].join("\0");
    const cached = validatedRevisionCache.get(cacheKey);
    if (cached !== undefined) {
      cacheSet(
        validatedRevisionCache,
        cacheKey,
        cached,
        maximumRevisionValidationCacheEntries,
      );
      return cached;
    }
    const profile = yield* validateRevision(revision, signingKeyId, publicKey);
    cacheSet(
      validatedRevisionCache,
      cacheKey,
      profile,
      maximumRevisionValidationCacheEntries,
    );
    return profile;
  });

  /**
   * Store the Source's three items under one state directory's credential
   * namespace, so two Canonfig state directories of the same OS account never
   * share, and so never overwrite, each other's Source identity. Items already
   * written are removed when a later one fails.
   */
  const storeSourceSecrets = Effect.fn("Enrollment.storeSourceSecrets")(function*(
    namespace: string,
    secrets: SourceSecrets,
  ) {
    const written: Array<typeof CredentialReference.Type> = [];
    const store = (name: string, label: string, value: Redacted.Redacted<string>) =>
      machine.storeCredential({ name: `${name}:${namespace}`, value }).pipe(
        Effect.tap((reference) => Effect.sync(() => written.push(reference))),
        Effect.mapError((error) =>
          new CredentialStorageError({
            operation: "store credential",
            reference: label,
            message: `the ${label} could not be stored in this machine's credential store: ${credentialFailureDetail(error)}`,
          })
        ),
      );
    return yield* Effect.all({
      signingKeyReference: store("canonfig-source-signing-key", "source signing key", secrets.signingPrivateKey),
      tlsKeyReference: store("canonfig-source-tls-key", "source TLS key", secrets.tlsPrivateKey),
      tlsCertificateReference: store(
        "canonfig-source-tls-certificate",
        "source TLS certificate",
        secrets.tlsCertificate,
      ),
    }).pipe(
      Effect.tapError(() =>
        Effect.forEach(written, (reference) => machine.removeCredential(reference).pipe(Effect.ignore), {
          discard: true,
        })
      ),
    );
  });

  const removeSourceSecrets = (material: SourceEnrollmentMaterial) =>
    Effect.forEach(
      [material.signingKeyReference, material.tlsKeyReference, material.tlsCertificateReference],
      (reference) => machine.removeCredential(reference).pipe(Effect.ignore),
      { discard: true },
    );

  const sourceCredentials = Effect.fn("Enrollment.sourceCredentials")(function*(): Effect.fn.Return<
    SourceCredentials,
    EnrollmentError
  > {
    const record = yield* repository.getEnrollmentSource().pipe(
      Effect.mapError(repositoryError("load source identity")),
    );
    if (record === undefined) {
      return yield* new SourceNotInitializedError({ operation: "load source credentials" });
    }
    const material = sourceMaterial(record);
    const load = (reference: typeof CredentialReference.Type, label: string) =>
      machine.loadCredential({ reference }).pipe(
        Effect.mapError((error) =>
          new CredentialStorageError({
            operation: "load credential",
            reference: label,
            message: `the ${label} could not be read from this machine's credential store: ${credentialFailureDetail(error)}`,
          })
        ),
      );
    const secrets = yield* Effect.all({
      signingPrivateKey: load(material.signingKeyReference, "source signing key"),
      tlsPrivateKey: load(material.tlsKeyReference, "source TLS key"),
      tlsCertificate: load(material.tlsCertificateReference, "source TLS certificate"),
    });
    const mismatch = sourceSecretsMismatch(material, secrets);
    if (mismatch !== undefined) {
      const cause = record.credentialNamespace === undefined
        ? "An earlier release kept Source credentials under account-global names, and another Canonfig state directory of this OS account has since replaced them"
        : "The native credential store no longer holds this Source's own credentials";
      return yield* new SourceCredentialMismatchError({
        message: `${cause}: ${mismatch}. They were not used, so nothing was signed or served as another Source. This Source's keys cannot be recovered from the store: move this state directory aside, run \`canonfig source init\` to create a new Source identity, then enroll its followers again with new invitations.`,
      });
    }
    if (record.credentialNamespace !== undefined) return { material, ...secrets };
    // The legacy account-global items match this Source's fingerprints, so
    // they are its own: copy them under this state directory's namespace and
    // record the new references. The legacy items stay in place; another
    // state directory restored from a copy of this one may still name them.
    const namespace = randomBytes(16).toString("hex");
    const references = yield* storeSourceSecrets(namespace, secrets);
    const migrated: EnrollmentSourceRecord = {
      ...record,
      ...references,
      credentialNamespace: namespace,
    };
    const current = yield* repository.getEnrollmentSource().pipe(
      Effect.mapError(repositoryError("load source identity")),
      Effect.tapError(() => removeSourceSecrets(sourceMaterial(migrated))),
    );
    if (current?.credentialNamespace !== undefined) {
      // A concurrent process migrated first; keep its copy.
      yield* removeSourceSecrets(sourceMaterial(migrated));
      return { material: sourceMaterial(current), ...secrets };
    }
    yield* repository.saveEnrollmentSource(migrated).pipe(
      Effect.mapError(repositoryError("migrate source credentials")),
      Effect.tapError(() => removeSourceSecrets(sourceMaterial(migrated))),
    );
    return { material: sourceMaterial(migrated), ...secrets };
  });

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
    // An initialized Source is never replaced. Re-running init confirms that
    // the native store still holds this Source's own credentials (moving
    // legacy account-global items under this state directory's namespace).
    if (existing !== undefined) return (yield* sourceCredentials()).material;

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
        // Loaded here, not statically: selfsigned pulls ~200 X.509/ASN.1
        // modules that every other command (status, sync) would compile at
        // start for nothing; only `source init` generates a certificate.
        const { generate } = await import("selfsigned");
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

    const credentialNamespace = randomBytes(16).toString("hex");
    const references = yield* storeSourceSecrets(credentialNamespace, {
      signingPrivateKey: Redacted.make(generated.signingPrivateKey),
      tlsPrivateKey: Redacted.make(generated.tlsPrivateKey),
      tlsCertificate: Redacted.make(generated.tlsCertificate),
    });
    const identity = decode(SourceIdentity)({
      keyId: `ed25519:${generated.signingFingerprint}`,
      publicKeyFingerprint: generated.signingFingerprint,
    });
    const record: EnrollmentSourceRecord = {
      identity,
      ...references,
      tlsFingerprint: generated.tlsFingerprint,
      credentialNamespace,
    };
    yield* repository.saveEnrollmentSource(record).pipe(
      Effect.mapError(repositoryError("save source identity")),
      Effect.tapError(() => removeSourceSecrets(sourceMaterial(record))),
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

  const removeInvitation = Effect.fn("Enrollment.removeInvitation")(function*(
    code: string,
  ): Effect.fn.Return<void, EnrollmentError> {
    yield* repository.removeEnrollmentInvitation(sha256(code)).pipe(
      Effect.mapError(repositoryError("remove invitation")),
    );
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
    // Enrolling an already active name with a new invitation rotates that
    // identity's credential: the previous credential stays valid until the
    // follower finalizes, then finalizeFollower retires it.
    const existingCredential = yield* repository.getFollowerCredential(followerId).pipe(
      Effect.match({
        onFailure: (error) => ({ found: false as const, error }),
        onSuccess: (record) => ({ found: true as const, record }),
      }),
    );
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
    const credentialReference = yield* machine.storeCredential({
      name: `canonfig-source-follower-${followerId}-${randomUUID()}`,
      value: Redacted.make(credential),
    }).pipe(
      Effect.mapError((error) =>
        new CredentialStorageError({
          operation: "store credential",
          reference: "follower credential",
          message: `the Source could not store the new follower credential: ${credentialFailureDetail(error)}`,
        })
      )
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
    // Everything after this point is a read: a failure below leaves the
    // pending enrollment for the follower to finalize or cancel, and cancel
    // removes the credential stored above.
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
    // Read the credential this finalization replaces before the rotation
    // overwrites the record, so it can be retired afterwards.
    const previous = yield* repository.getFollowerCredential(pendingEnrollment.follower).pipe(
      Effect.map((record) => record.credentialReference),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    yield* repository.finalizeEnrollment({
      follower: pendingEnrollment.follower,
      credentialDigest,
      credentialReference: pendingEnrollment.credentialReference,
    }).pipe(Effect.mapError(repositoryError("finalize follower enrollment")));
    if (previous !== undefined && previous !== pendingEnrollment.credentialReference) {
      yield* machine.removeCredential(previous).pipe(Effect.ignore);
    }
  });

  /** A cancelled or abandoned enrollment removes the credential it stored. */
  const cancelPendingEnrollment = Effect.fn(
    "Enrollment.cancelPendingEnrollment",
  )(function*(credential: string) {
    const credentialDigest = sha256(credential);
    const pending = (yield* repository.listPendingEnrollments().pipe(
      Effect.mapError(repositoryError("find pending enrollment")),
    )).find((entry) => entry.credentialDigest === credentialDigest);
    yield* repository.cancelPendingEnrollment({ credentialDigest }).pipe(
      Effect.mapError(repositoryError("cancel pending enrollment")),
    );
    if (pending !== undefined) {
      yield* machine.removeCredential(pending.credentialReference).pipe(Effect.ignore);
    }
  });

  /**
   * Revocation also retires the Source's stored copy of the follower
   * credential: authentication uses only its digest, so nothing needs the
   * plaintext once the identity is revoked.
   */
  const revokeAndRetire = Effect.fn("Enrollment.revokeAndRetire")(function*(
    follower: typeof FollowerId.Type,
  ) {
    const stored = yield* repository.getFollowerCredential(follower).pipe(
      Effect.mapError(repositoryError("revoke follower")),
    );
    yield* repository.revokeFollower(follower).pipe(
      Effect.mapError(repositoryError("revoke follower")),
    );
    yield* machine.removeCredential(stored.credentialReference).pipe(Effect.ignore);
  });

  const revokeAuthenticatedFollower = Effect.fn(
    "Enrollment.revokeAuthenticatedFollower",
  )(function*(credential: string) {
    const authenticated = yield* authenticate(credential);
    yield* revokeAndRetire(authenticated.follower.id);
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
    const cacheKeyOf = (material: SourceEnrollmentMaterial) =>
      [
        material.source.keyId,
        material.source.publicKeyFingerprint,
        material.signingKeyReference,
      ].join("\0");
    const current = yield* source();
    if (cachedSigningKeys?.cacheKey === cacheKeyOf(current)) {
      return cachedSigningKeys.value;
    }
    // sourceCredentials already proved the key hashes to the Source identity.
    const credentials = yield* sourceCredentials();
    const privateKey = createPrivateKey(Redacted.value(credentials.signingPrivateKey));
    const publicKey = createPublicKey(privateKey);
    const value = {
      material: credentials.material,
      privateKey,
      publicKey,
      publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    cachedSigningKeys = { cacheKey: cacheKeyOf(credentials.material), value };
    return value;
  });

  const authorizedRevisions = Effect.fn("Enrollment.authorizedRevisions")(
    function*(credential: string) {
      const authenticated = yield* authenticate(credential);
      const revisions = yield* repository.listRevisions().pipe(
        Effect.mapError(repositoryError("list authorized revisions")),
      );
      return {
        revisions,
        groups: new Set<string>(authenticated.follower.groups),
      };
    },
  );

  const listAuthorizedRevisions = Effect.fn(
    "Enrollment.listAuthorizedRevisions",
  )(function*(credential: string) {
    const { revisions } = yield* authorizedRevisions(credential);
    return {
      revisions: revisions.map((revision) => ({
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
    const { revisions, groups } = yield* authorizedRevisions(credential);
    const revision = revisions.find((candidate) => candidate.id === revisionId);
    if (revision === undefined) {
      return yield* new TransportResourceNotFoundError({
        resource: "revision",
      });
    }
    const keys = yield* signingKeys();
    // The validated profile, not the stored index, is what followers apply:
    // for a revision an earlier release published it is the projection into
    // this release's transport shape.
    const profile = yield* cachedRevision(
      revision,
      keys.material.source.keyId,
      keys.material.source.publicKeyFingerprint,
      keys.publicKey,
    );
    const resources = decode(Schema.Array(TransportPublishedResourceSchema))(
      authorizedResources(profile.resources, groups),
    );
    const unsigned = {
      id: revision.id,
      profileId: revision.profileId,
      sequence: revision.sequence,
      digest: decode(ContentDigest)(revision.digest),
      publishedAt: revision.publishedAt,
      resources,
      scheduleDefault: profile.scheduleDefault,
      signingKeyId: keys.material.source.keyId,
      signingPublicKey: keys.publicPem,
      sourceSignature: revision.signature,
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

  const getAuthorizedBlobRange = Effect.fn("Enrollment.getAuthorizedBlobRange")(
    function*(credential: string, input: {
      readonly revisionId: string;
      readonly blobId: typeof BlobId.Type;
      readonly offset: number;
      readonly maximumBytes: number;
    }) {
      const authenticated = yield* authenticate(credential);
      const groups = new Set<string>(authenticated.follower.groups);
      const revisionId = decode(ProfileRevisionId)(input.revisionId);
      const revisions = yield* repository.listRevisions().pipe(
        Effect.mapError(repositoryError("list authorized blob revisions")),
      );
      const revision = revisions.find((candidate) => candidate.id === revisionId);
      if (revision === undefined) {
        return yield* new TransportResourceNotFoundError({ resource: "blob" });
      }
      const keys = yield* signingKeys();
      const profile = yield* cachedRevision(
        revision,
        keys.material.source.keyId,
        keys.material.source.publicKeyFingerprint,
        keys.publicKey,
      );
      const authorized = visibleResources(profile.resources, groups).some((candidate) =>
        candidate.blobs.includes(input.blobId)
      );
      if (!authorized) {
        return yield* new TransportResourceNotFoundError({ resource: "blob" });
      }
      const range = yield* repository.readResourceBlobRange({
        blob: input.blobId,
        offset: input.offset,
        maximumBytes: input.maximumBytes,
      }).pipe(Effect.mapError(repositoryError("read authorized blob range")));
      if (range === undefined) {
        return yield* new TransportResourceNotFoundError({ resource: "blob" });
      }
      return range;
    },
  );

  const revokeFollower = Effect.fn("Enrollment.revokeFollower")(function*(
    follower: typeof FollowerId.Type,
  ) {
    yield* revokeAndRetire(follower);
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
    sourceCredentials,
    createInvitation,
    removeInvitation,
    enrollFollower,
    finalizeFollower,
    cancelPendingEnrollment,
    revokeAuthenticatedFollower,
    authenticate,
    listAuthorizedRevisions,
    getAuthorizedRevision,
    getAuthorizedBlobRange,
    revokeFollower,
    updateFollowerGroups,
    getFollower,
  });
});

export const EnrollmentLive = Layer.effect(Enrollment, makeEnrollment);
