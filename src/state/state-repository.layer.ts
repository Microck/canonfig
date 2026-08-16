import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  ActionId,
  CertificateFingerprint,
  ContentDigest,
  CredentialReference,
  FollowerId,
  GroupName,
  type ProfileId as ProfileIdType,
  ProfileRevisionId,
  ResourceId,
  RunId,
  type FollowerId as FollowerIdType,
  type ProfileRevisionId as ProfileRevisionIdType,
  type RunId as RunIdType,
} from "../domain/brand.ts";
import { FollowerIdentity, SourceIdentity } from "../domain/identity.ts";
import { ProfileRevision, ProfileRevisionSchema } from "../domain/profile.ts";
import {
  AppliedResourceRecordSchema,
  DriftConflictSchema,
  SynchronizationPlanSchema,
  type DriftConflict,
  type SynchronizationOutcome,
  type SynchronizationPlan,
} from "../domain/synchronization.ts";
import {
  FollowerSynchronizationConfiguration,
} from "../synchronization/follower-sync-config.ts";
import { SyncScheduleSchema } from "../schedule/schedule-manager.types.ts";
import {
  ActionNotInPlanError,
  ActiveRunExistsError,
  EnrollmentStateConflictError,
  FollowerNotFoundError,
  InvalidRunTransitionError,
  RepositoryDecodeError,
  RepositorySqlError,
  RevisionImmutableError,
  RevisionNotFoundError,
  RunNotFoundError,
  type StateRepositoryError,
} from "./state-repository.errors.ts";
import { StateRepository } from "./state-repository.service.ts";
import { stateMigrations } from "./state-schema.ts";
import type {
  ActionJournalRecord,
  CompleteRunInput,
  ConsumeEnrollmentInvitationInput,
  CreateEnrollmentInvitationInput,
  DriftRecord,
  EnrollmentSourceRecord,
  FollowerCredentialRecord,
  JournalActionInput,
  PublishRevisionInput,
  RecordDriftInput,
  RecoveryState,
  RegisterFollowerInput,
  SaveFollowerSynchronizationConfigurationInput,
  StartRunInput,
  StateSnapshot,
  StoredEnrollmentInvitation,
  VerificationEvidence,
} from "./state-repository.types.ts";

const CountRow = Schema.Struct({ count: Schema.Number });
const RevisionJsonRow = Schema.Struct({ revision_json: Schema.String });
const RunStatusRow = Schema.Struct({
  follower_id: Schema.String,
  status: Schema.String,
});
const ActiveRunRow = Schema.Struct({
  id: RunId,
  follower_id: FollowerId,
  revision_id: ProfileRevisionId,
  plan_json: Schema.String,
  started_at: Schema.String,
});
const ActionJournalRow = Schema.Struct({
  action_id: ActionId,
  sequence: Schema.Number,
  state: Schema.Literals(["pending", "running", "succeeded", "failed", "skipped"]),
  recorded_at: Schema.String,
  attempt: Schema.Number,
  verification_json: Schema.NullOr(Schema.String),
  rollback_reference: Schema.NullOr(Schema.String),
});
const DriftRow = Schema.Struct({
  sequence: Schema.Number,
  conflict_json: Schema.String,
  recorded_at: Schema.String,
});
const AppliedResourceRow = Schema.Struct({
  resource_id: ResourceId,
  revision_id: ProfileRevisionId,
  digest: ContentDigest,
  applied_at: Schema.String,
  owned_files_json: Schema.NullOr(Schema.String),
  schedule_json: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  policy: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
  owned_keys_json: Schema.NullOr(Schema.String),
  config_format: Schema.NullOr(Schema.String),
  executable: Schema.NullOr(Schema.Number),
  symlink_target: Schema.NullOr(Schema.String),
});
const OwnedFilesSchema = Schema.Array(Schema.Struct({
  path: Schema.NonEmptyString,
  digest: ContentDigest,
  executable: Schema.optional(Schema.Boolean),
}));
const OwnedKeysSchema = Schema.Array(Schema.NonEmptyString);
const StoredScheduleSchema = SyncScheduleSchema;
const FollowerRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  groups_json: Schema.String,
  revoked: Schema.Number,
  credential_reference: Schema.String,
  enrolled_at: Schema.String,
});
const SourceIdentityRow = Schema.Struct({
  key_id: Schema.String,
  public_key_fingerprint: Schema.String,
});
const EnrollmentSourceRow = Schema.Struct({
  key_id: Schema.String,
  public_key_fingerprint: Schema.String,
  signing_key_reference: CredentialReference,
  tls_key_reference: CredentialReference,
  tls_certificate_reference: CredentialReference,
  tls_fingerprint: CertificateFingerprint,
});
const EnrollmentInvitationRow = Schema.Struct({
  intended_source_fingerprint: CertificateFingerprint,
  tls_fingerprint: CertificateFingerprint,
  endpoint: Schema.String,
  groups_json: Schema.String,
  expires_at: Schema.String,
  used_at: Schema.NullOr(Schema.String),
});
const FollowerCredentialRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  groups_json: Schema.String,
  revoked: Schema.Number,
  credential_reference: CredentialReference,
  enrolled_at: Schema.String,
  credential_digest: ContentDigest,
});
const FollowerSynchronizationConfigurationRow = Schema.Struct({
  configuration_json: Schema.String,
});

const VerificationEvidenceSchema = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "not-run"]),
  method: Schema.NonEmptyString,
  observedDigest: Schema.optional(ContentDigest),
  exitCode: Schema.optional(Schema.Int),
});

const sqlError = (operation: string) => (error: SqlError): RepositorySqlError =>
  new RepositorySqlError({ operation, message: String(error) });

const decodeError = (
  entity: string,
  id: string,
) => (error: Schema.SchemaError): RepositoryDecodeError =>
  new RepositoryDecodeError({ entity, id, message: String(error) });

const decodeRows = <S extends Schema.Constraint>(
  schema: S,
  rows: ReadonlyArray<unknown>,
  entity: string,
  id: string,
): Effect.Effect<ReadonlyArray<S["Type"]>, RepositoryDecodeError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
    Effect.mapError(decodeError(entity, id)),
  );

const parseJson = <S extends Schema.Constraint>(
  schema: S,
  text: string,
  entity: string,
  id: string,
): Effect.Effect<S["Type"], RepositoryDecodeError, S["DecodingServices"]> =>
  Effect.try({
    try: () => JSON.parse(text),
    catch: (error) => new RepositoryDecodeError({
      entity,
      id,
      message: String(error),
    }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) =>
      error instanceof RepositoryDecodeError
        ? error
        : new RepositoryDecodeError({ entity, id, message: String(error) })
    ),
  );

type RepositoryJson =
  | ProfileRevision
  | SynchronizationPlan
  | SynchronizationOutcome
  | DriftConflict
  | VerificationEvidence
  | ReadonlyArray<string>;

const encodeJson = <Value extends RepositoryJson>(value: Value): string =>
  JSON.stringify(value);

const statusCount = Effect.fn("StateRepository.statusCount")(function*(
  sql: SqlClient.SqlClient,
  query: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
  entity: string,
  id: string,
): Effect.fn.Return<number, RepositoryDecodeError | RepositorySqlError> {
  const rows = yield* query.pipe(Effect.mapError(sqlError(`find ${entity}`)));
  const decoded = yield* decodeRows(CountRow, rows, entity, id);
  return decoded[0]?.count ?? 0;
});

const makeRepository = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;

  yield* SqliteMigrator.run({ loader: stateMigrations }).pipe(
    Effect.mapError((error) =>
      new RepositorySqlError({
        operation: "migrate state schema",
        message: String(error),
      })
    ),
  );

  const saveSourceIdentity = Effect.fn("StateRepository.saveSourceIdentity")(
    function*(identity: SourceIdentity): Effect.fn.Return<void, StateRepositoryError> {
      yield* sql`
        INSERT INTO source_identity (singleton, key_id, public_key_fingerprint)
        VALUES (1, ${identity.keyId}, ${identity.publicKeyFingerprint})
        ON CONFLICT(singleton) DO UPDATE SET
          key_id = excluded.key_id,
          public_key_fingerprint = excluded.public_key_fingerprint
      `.pipe(Effect.mapError(sqlError("save source identity")));
    },
  );

  const registerFollower = Effect.fn("StateRepository.registerFollower")(
    function*(input: RegisterFollowerInput): Effect.fn.Return<void, StateRepositoryError> {
      const follower = input.follower;
      yield* sql`
        INSERT INTO followers (
          id,
          name,
          groups_json,
          revoked,
          credential_reference,
          enrolled_at
        ) VALUES (
          ${follower.id},
          ${follower.name},
          ${encodeJson([...follower.groups])},
          ${follower.revoked ? 1 : 0},
          ${follower.credentialReference},
          ${follower.enrolledAt}
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          groups_json = excluded.groups_json,
          revoked = excluded.revoked,
          credential_reference = excluded.credential_reference,
          enrolled_at = excluded.enrolled_at
      `.pipe(Effect.mapError(sqlError("register follower")));
    },
  );

  const saveFollowerSynchronizationConfiguration = Effect.fn(
    "StateRepository.saveFollowerSynchronizationConfiguration",
  )(function*(
    input: SaveFollowerSynchronizationConfigurationInput,
  ): Effect.fn.Return<void, StateRepositoryError> {
    const configuration = yield* Schema.decodeUnknownEffect(
      FollowerSynchronizationConfiguration,
    )(input.configuration).pipe(
      Effect.mapError(
        decodeError(
          "follower synchronization configuration",
          input.configuration.follower.id,
        ),
      ),
    );
    if (
      configuration.follower.credentialReference
        !== configuration.credentialReference
      || configuration.source.signingFingerprint
        !== input.sourceIdentity.publicKeyFingerprint
    ) {
      return yield* new RepositoryDecodeError({
        entity: "follower synchronization configuration",
        id: configuration.follower.id,
        message: "configuration identities or credential references do not match",
      });
    }
    const transaction = Effect.gen(function*() {
      yield* sql`
        INSERT INTO followers (
          id,
          name,
          groups_json,
          revoked,
          credential_reference,
          enrolled_at
        ) VALUES (
          ${configuration.follower.id},
          ${configuration.follower.name},
          ${encodeJson([...configuration.follower.groups])},
          ${configuration.follower.revoked ? 1 : 0},
          ${configuration.credentialReference},
          ${configuration.follower.enrolledAt}
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          groups_json = excluded.groups_json,
          revoked = excluded.revoked,
          credential_reference = excluded.credential_reference,
          enrolled_at = excluded.enrolled_at
      `;
      yield* sql`
        INSERT INTO source_identity (singleton, key_id, public_key_fingerprint)
        VALUES (
          1,
          ${input.sourceIdentity.keyId},
          ${input.sourceIdentity.publicKeyFingerprint}
        )
        ON CONFLICT(singleton) DO UPDATE SET
          key_id = excluded.key_id,
          public_key_fingerprint = excluded.public_key_fingerprint
      `;
      yield* sql`
        INSERT INTO follower_sync_configuration (
          singleton,
          follower_id,
          configuration_json,
          updated_at
        ) VALUES (
          1,
          ${configuration.follower.id},
          ${JSON.stringify(configuration)},
          ${configuration.updatedAt}
        )
        ON CONFLICT(singleton) DO UPDATE SET
          follower_id = excluded.follower_id,
          configuration_json = excluded.configuration_json,
          updated_at = excluded.updated_at
      `;
    });
    yield* sql.withTransaction(transaction).pipe(
      Effect.mapError(sqlError("save follower synchronization configuration")),
    );
  });

  const getFollowerSynchronizationConfiguration = Effect.fn(
    "StateRepository.getFollowerSynchronizationConfiguration",
  )(function*(): Effect.fn.Return<
    FollowerSynchronizationConfiguration | undefined,
    StateRepositoryError
  > {
    const rows = yield* sql`
      SELECT configuration_json
      FROM follower_sync_configuration
      WHERE singleton = 1
    `.pipe(Effect.mapError(sqlError("load follower synchronization configuration")));
    const decoded = yield* decodeRows(
      FollowerSynchronizationConfigurationRow,
      rows,
      "follower synchronization configuration row",
      "1",
    );
    const row = decoded[0];
    if (row === undefined) return undefined;
    return yield* parseJson(
      FollowerSynchronizationConfiguration,
      row.configuration_json,
      "follower synchronization configuration",
      "1",
    );
  });

  const saveEnrollmentSource = Effect.fn("StateRepository.saveEnrollmentSource")(
    function*(source: EnrollmentSourceRecord): Effect.fn.Return<void, StateRepositoryError> {
      const transaction = Effect.gen(function*() {
        yield* sql`
          INSERT INTO source_identity (singleton, key_id, public_key_fingerprint)
          VALUES (
            1,
            ${source.identity.keyId},
            ${source.identity.publicKeyFingerprint}
          )
          ON CONFLICT(singleton) DO UPDATE SET
            key_id = excluded.key_id,
            public_key_fingerprint = excluded.public_key_fingerprint
        `;
        yield* sql`
          INSERT INTO enrollment_source (
            singleton,
            signing_key_reference,
            tls_key_reference,
            tls_certificate_reference,
            tls_fingerprint
          ) VALUES (
            1,
            ${source.signingKeyReference},
            ${source.tlsKeyReference},
            ${source.tlsCertificateReference},
            ${source.tlsFingerprint}
          )
          ON CONFLICT(singleton) DO UPDATE SET
            signing_key_reference = excluded.signing_key_reference,
            tls_key_reference = excluded.tls_key_reference,
            tls_certificate_reference = excluded.tls_certificate_reference,
            tls_fingerprint = excluded.tls_fingerprint
        `;
      });
      yield* sql.withTransaction(transaction).pipe(
        Effect.mapError(sqlError("save enrollment source")),
      );
    },
  );

  const getEnrollmentSource = Effect.fn("StateRepository.getEnrollmentSource")(
    function*(): Effect.fn.Return<EnrollmentSourceRecord | undefined, StateRepositoryError> {
      const rows = yield* sql`
        SELECT
          source_identity.key_id,
          source_identity.public_key_fingerprint,
          enrollment_source.signing_key_reference,
          enrollment_source.tls_key_reference,
          enrollment_source.tls_certificate_reference,
          enrollment_source.tls_fingerprint
        FROM enrollment_source
        INNER JOIN source_identity ON source_identity.singleton = enrollment_source.singleton
        WHERE enrollment_source.singleton = 1
      `.pipe(Effect.mapError(sqlError("load enrollment source")));
      const decoded = yield* decodeRows(
        EnrollmentSourceRow,
        rows,
        "enrollment source",
        "1",
      );
      const row = decoded[0];
      if (row === undefined) return undefined;
      const identity = yield* Schema.decodeUnknownEffect(SourceIdentity)({
        keyId: row.key_id,
        publicKeyFingerprint: row.public_key_fingerprint,
      }).pipe(Effect.mapError(decodeError("source identity", "1")));
      return {
        identity,
        signingKeyReference: row.signing_key_reference,
        tlsKeyReference: row.tls_key_reference,
        tlsCertificateReference: row.tls_certificate_reference,
        tlsFingerprint: row.tls_fingerprint,
      };
    },
  );

  const createEnrollmentInvitation = Effect.fn(
    "StateRepository.createEnrollmentInvitation",
  )(function*(
    input: CreateEnrollmentInvitationInput,
  ): Effect.fn.Return<void, StateRepositoryError> {
    yield* sql`
      INSERT INTO enrollment_invitations (
        code_digest,
        nonce_digest,
        intended_source_fingerprint,
        tls_fingerprint,
        endpoint,
        groups_json,
        expires_at,
        used_at
      ) VALUES (
        ${input.codeDigest},
        ${input.nonceDigest},
        ${input.intendedSourceFingerprint},
        ${input.tlsFingerprint},
        ${input.endpoint},
        ${encodeJson([...input.groups])},
        ${input.expiresAt},
        NULL
      )
    `.pipe(Effect.mapError(sqlError("create enrollment invitation")));
  });

  const findEnrollmentInvitation = Effect.fn(
    "StateRepository.findEnrollmentInvitation",
  )(function*(
    codeDigest: typeof ContentDigest.Type,
  ): Effect.fn.Return<StoredEnrollmentInvitation | undefined, StateRepositoryError> {
    const rows = yield* sql`
      SELECT
        intended_source_fingerprint,
        tls_fingerprint,
        endpoint,
        groups_json,
        expires_at,
        used_at
      FROM enrollment_invitations
      WHERE code_digest = ${codeDigest}
    `.pipe(Effect.mapError(sqlError("find enrollment invitation")));
    const decoded = yield* decodeRows(
      EnrollmentInvitationRow,
      rows,
      "enrollment invitation",
      codeDigest,
    );
    const row = decoded[0];
    if (row === undefined) return undefined;
    const groups = yield* parseJson(
      Schema.Array(GroupName),
      row.groups_json,
      "enrollment invitation groups",
      codeDigest,
    );
    const storedInvitation: StoredEnrollmentInvitation = {
      intendedSourceFingerprint: row.intended_source_fingerprint,
      tlsFingerprint: row.tls_fingerprint,
      endpoint: row.endpoint,
      groups,
      expiresAt: row.expires_at,
    };
    if (row.used_at !== null) {
      return { ...storedInvitation, usedAt: row.used_at };
    }
    return storedInvitation;
  });

  const consumeEnrollmentInvitation = Effect.fn(
    "StateRepository.consumeEnrollmentInvitation",
  )(function*(
    input: ConsumeEnrollmentInvitationInput,
  ): Effect.fn.Return<void, StateRepositoryError> {
    const transaction = Effect.gen(function*() {
      const rows = yield* sql`
        SELECT
          intended_source_fingerprint,
          tls_fingerprint,
          endpoint,
          groups_json,
          expires_at,
          used_at
        FROM enrollment_invitations
        WHERE code_digest = ${input.codeDigest}
      `;
      const invitations = yield* decodeRows(
        EnrollmentInvitationRow,
        rows,
        "enrollment invitation",
        input.codeDigest,
      );
      const invitation = invitations[0];
      if (invitation === undefined) {
        return yield* new EnrollmentStateConflictError({
          reason: "invitation-not-found",
          message: "the invitation is unknown",
        });
      }
      if (invitation.used_at !== null) {
        return yield* new EnrollmentStateConflictError({
          reason: "invitation-used",
          message: "the invitation was already consumed",
        });
      }
      if (Date.parse(invitation.expires_at) <= Date.parse(input.consumedAt)) {
        return yield* new EnrollmentStateConflictError({
          reason: "invitation-expired",
          message: "the invitation has expired",
        });
      }
      if (
        invitation.intended_source_fingerprint !== input.intendedSourceFingerprint
        || invitation.tls_fingerprint !== input.tlsFingerprint
      ) {
        return yield* new EnrollmentStateConflictError({
          reason: "invitation-mismatch",
          message: "the invitation is not valid for this source",
        });
      }
      const nonceRows = yield* sql`
        SELECT count(*) AS count
        FROM enrollment_invitations
        WHERE code_digest = ${input.codeDigest}
          AND nonce_digest = ${input.nonceDigest}
      `;
      const nonceCount = yield* decodeRows(
        CountRow,
        nonceRows,
        "enrollment invitation nonce",
        input.codeDigest,
      );
      if ((nonceCount[0]?.count ?? 0) !== 1) {
        return yield* new EnrollmentStateConflictError({
          reason: "invitation-mismatch",
          message: "the invitation nonce is invalid",
        });
      }
      const identityRows = yield* sql`
        SELECT count(*) AS count FROM followers WHERE id = ${input.follower.id}
      `;
      const identityCount = yield* decodeRows(
        CountRow,
        identityRows,
        "follower identity",
        input.follower.id,
      );
      if ((identityCount[0]?.count ?? 0) !== 0) {
        return yield* new EnrollmentStateConflictError({
          reason: "follower-identity-conflict",
          message: "the follower identity is already enrolled",
        });
      }
      const credentialRows = yield* sql`
        SELECT count(*) AS count
        FROM follower_credentials
        WHERE credential_digest = ${input.credentialDigest}
      `;
      const credentialCount = yield* decodeRows(
        CountRow,
        credentialRows,
        "follower credential",
        input.follower.id,
      );
      if ((credentialCount[0]?.count ?? 0) !== 0) {
        return yield* new EnrollmentStateConflictError({
          reason: "credential-conflict",
          message: "the follower credential is already assigned",
        });
      }
      yield* sql`
        INSERT INTO followers (
          id,
          name,
          groups_json,
          revoked,
          credential_reference,
          enrolled_at
        ) VALUES (
          ${input.follower.id},
          ${input.follower.name},
          ${encodeJson([...input.follower.groups])},
          0,
          ${input.credentialReference},
          ${input.follower.enrolledAt}
        )
      `;
      yield* sql`
        INSERT INTO follower_credentials (
          follower_id,
          credential_digest,
          credential_reference
        ) VALUES (
          ${input.follower.id},
          ${input.credentialDigest},
          ${input.credentialReference}
        )
      `;
      yield* sql`
        UPDATE enrollment_invitations
        SET used_at = ${input.consumedAt}
        WHERE code_digest = ${input.codeDigest} AND used_at IS NULL
      `;
    });
    yield* sql.withTransaction(transaction).pipe(
      Effect.mapError((error) =>
        error instanceof EnrollmentStateConflictError
          ? error
          : error instanceof RepositoryDecodeError
          ? error
          : sqlError("consume enrollment invitation")(error)
      ),
    );
  });

  const decodeFollowerCredential = Effect.fn(
    "StateRepository.decodeFollowerCredential",
  )(function*(
    row: typeof FollowerCredentialRow.Type,
  ): Effect.fn.Return<FollowerCredentialRecord, StateRepositoryError> {
    const groups = yield* parseJson(
      Schema.Array(GroupName),
      row.groups_json,
      "follower groups",
      row.id,
    );
    const follower = yield* Schema.decodeUnknownEffect(FollowerIdentity)({
      id: row.id,
      name: row.name,
      groups,
      revoked: row.revoked === 1,
      credentialReference: row.credential_reference,
      enrolledAt: row.enrolled_at,
    }).pipe(Effect.mapError(decodeError("follower", row.id)));
    return {
      follower,
      credentialDigest: row.credential_digest,
      credentialReference: row.credential_reference,
    };
  });

  const findFollowerCredential = Effect.fn(
    "StateRepository.findFollowerCredential",
  )(function*(
    credentialDigest: typeof ContentDigest.Type,
  ): Effect.fn.Return<FollowerCredentialRecord | undefined, StateRepositoryError> {
    const rows = yield* sql`
      SELECT
        followers.id,
        followers.name,
        followers.groups_json,
        followers.revoked,
        followers.credential_reference,
        followers.enrolled_at,
        follower_credentials.credential_digest
      FROM follower_credentials
      INNER JOIN followers ON followers.id = follower_credentials.follower_id
      WHERE follower_credentials.credential_digest = ${credentialDigest}
    `.pipe(Effect.mapError(sqlError("find follower credential")));
    const decoded = yield* decodeRows(
      FollowerCredentialRow,
      rows,
      "follower credential",
      credentialDigest,
    );
    const row = decoded[0];
    return row === undefined ? undefined : yield* decodeFollowerCredential(row);
  });

  const getFollowerCredential = Effect.fn(
    "StateRepository.getFollowerCredential",
  )(function*(
    follower: FollowerIdType,
  ): Effect.fn.Return<FollowerCredentialRecord, StateRepositoryError> {
    const rows = yield* sql`
      SELECT
        followers.id,
        followers.name,
        followers.groups_json,
        followers.revoked,
        followers.credential_reference,
        followers.enrolled_at,
        follower_credentials.credential_digest
      FROM follower_credentials
      INNER JOIN followers ON followers.id = follower_credentials.follower_id
      WHERE follower_credentials.follower_id = ${follower}
    `.pipe(Effect.mapError(sqlError("get follower credential")));
    const decoded = yield* decodeRows(
      FollowerCredentialRow,
      rows,
      "follower credential",
      follower,
    );
    const row = decoded[0];
    if (row === undefined) return yield* new FollowerNotFoundError({ follower });
    return yield* decodeFollowerCredential(row);
  });

  const revokeFollower = Effect.fn("StateRepository.revokeFollower")(
    function*(follower: FollowerIdType): Effect.fn.Return<void, StateRepositoryError> {
      const count = yield* statusCount(
        sql,
        sql`SELECT count(*) AS count FROM followers WHERE id = ${follower}`,
        "follower",
        follower,
      );
      if (count === 0) return yield* new FollowerNotFoundError({ follower });
      yield* sql`UPDATE followers SET revoked = 1 WHERE id = ${follower}`.pipe(
        Effect.mapError(sqlError("revoke follower")),
      );
    },
  );

  const updateFollowerGroups = Effect.fn("StateRepository.updateFollowerGroups")(
    function*(
      follower: FollowerIdType,
      groups: ReadonlyArray<typeof GroupName.Type>,
    ): Effect.fn.Return<void, StateRepositoryError> {
      const count = yield* statusCount(
        sql,
        sql`SELECT count(*) AS count FROM followers WHERE id = ${follower}`,
        "follower",
        follower,
      );
      if (count === 0) return yield* new FollowerNotFoundError({ follower });
      yield* sql`
        UPDATE followers
        SET groups_json = ${encodeJson([...groups])}
        WHERE id = ${follower}
      `.pipe(Effect.mapError(sqlError("update follower groups")));
    },
  );

  const publishRevision = Effect.fn("StateRepository.publishRevision")(
    function*(input: PublishRevisionInput): Effect.fn.Return<void, StateRepositoryError> {
      const revision = input.revision;
      const encoded = encodeJson(revision);
      const transaction = Effect.gen(function*() {
        const existingRows = yield* sql`
          SELECT revision_json
          FROM profile_revisions
          WHERE id = ${revision.id}
        `;
        const existing = yield* decodeRows(
          RevisionJsonRow,
          existingRows,
          "profile revision row",
          revision.id,
        );
        if (existing.length > 0) {
          const stored = yield* parseJson(
            ProfileRevisionSchema,
            existing[0]!.revision_json,
            "profile revision",
            revision.id,
          );
          if (encodeJson(stored) === encoded) return;
          return yield* new RevisionImmutableError({
            revision: revision.id,
            message: "the revision id already names different immutable content",
          });
        }
        yield* sql`
          INSERT INTO profile_revisions (
            id,
            profile_id,
            sequence,
            canonical_bytes,
            digest,
            signature,
            published_at,
            revision_json
          ) VALUES (
            ${revision.id},
            ${revision.profileId},
            ${revision.sequence},
            ${revision.canonicalBytes},
            ${revision.digest},
            ${revision.signature},
            ${revision.publishedAt},
            ${encoded}
          )
        `;
      });
      yield* sql.withTransaction(transaction).pipe(
        Effect.catchTag("SqlError", (error) =>
          Effect.fail(error.reason._tag === "UniqueViolation"
            ? new RevisionImmutableError({
              revision: revision.id,
              message: `profile sequence is already published: ${error.reason.constraint}`,
            })
            : sqlError("publish profile revision")(error))
        ),
      );
    },
  );

  const getRevision = Effect.fn("StateRepository.getRevision")(
    function*(revision: ProfileRevisionIdType): Effect.fn.Return<ProfileRevision, StateRepositoryError> {
      const rows = yield* sql`
        SELECT revision_json
        FROM profile_revisions
        WHERE id = ${revision}
      `.pipe(Effect.mapError(sqlError("load profile revision")));
      const decoded = yield* decodeRows(
        RevisionJsonRow,
        rows,
        "profile revision row",
        revision,
      );
      const row = decoded[0];
      if (row === undefined) return yield* new RevisionNotFoundError({ revision });
      return yield* parseJson(
        ProfileRevisionSchema,
        row.revision_json,
        "profile revision",
        revision,
      );
    },
  );

  const findRevision = Effect.fn("StateRepository.findRevision")(
    function*(revision: ProfileRevisionIdType): Effect.fn.Return<ProfileRevision | undefined, StateRepositoryError> {
      const rows = yield* sql`
        SELECT revision_json
        FROM profile_revisions
        WHERE id = ${revision}
      `.pipe(Effect.mapError(sqlError("find profile revision")));
      const decoded = yield* decodeRows(
        RevisionJsonRow,
        rows,
        "profile revision row",
        revision,
      );
      const row = decoded[0];
      if (row === undefined) return undefined;
      return yield* parseJson(
        ProfileRevisionSchema,
        row.revision_json,
        "profile revision",
        revision,
      );
    },
  );

  const getLatestRevision = Effect.fn("StateRepository.getLatestRevision")(
    function*(profile: ProfileIdType): Effect.fn.Return<ProfileRevision | undefined, StateRepositoryError> {
      const rows = yield* sql`
        SELECT revision_json
        FROM profile_revisions
        WHERE profile_id = ${profile}
        ORDER BY sequence DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlError("load latest profile revision")));
      const decoded = yield* decodeRows(
        RevisionJsonRow,
        rows,
        "profile revision row",
        profile,
      );
      const row = decoded[0];
      if (row === undefined) return undefined;
      return yield* parseJson(
        ProfileRevisionSchema,
        row.revision_json,
        "profile revision",
        profile,
      );
    },
  );

  const listRevisions = Effect.fn("StateRepository.listRevisions")(
    function*(): Effect.fn.Return<ReadonlyArray<ProfileRevision>, StateRepositoryError> {
      const rows = yield* sql`
        SELECT revision_json
        FROM profile_revisions
        ORDER BY profile_id, sequence
      `.pipe(Effect.mapError(sqlError("list profile revisions")));
      const decoded = yield* decodeRows(
        RevisionJsonRow,
        rows,
        "profile revision row",
        "all",
      );
      const revisions: Array<ProfileRevision> = [];
      for (const row of decoded) {
        revisions.push(yield* parseJson(
          ProfileRevisionSchema,
          row.revision_json,
          "profile revision",
          "all",
        ));
      }
      return revisions;
    },
  );

  const loadAppliedResources = Effect.fn(
    "StateRepository.loadAppliedResources",
  )(function*(
    follower: FollowerIdType,
  ): Effect.fn.Return<
    ReadonlyArray<typeof AppliedResourceRecordSchema.Type>,
    StateRepositoryError
  > {
    const rows = yield* sql`
      SELECT resource_id, revision_id, digest, applied_at, owned_files_json, schedule_json,
        kind, policy, target, owned_keys_json, config_format
        , executable, symlink_target
      FROM applied_resources
      WHERE follower_id = ${follower}
      ORDER BY resource_id
    `.pipe(Effect.mapError(sqlError("load applied resources")));
    const stored = yield* decodeRows(
      AppliedResourceRow,
      rows,
      "applied resources",
      follower,
    );
    return yield* Effect.forEach(stored, (row) =>
      Effect.gen(function*() {
        const ownedFiles = row.owned_files_json === null
          ? undefined
          : yield* parseJson(
            OwnedFilesSchema,
            row.owned_files_json,
            "applied resource owned files",
            row.resource_id,
          );
        const schedule = row.schedule_json === null
          ? undefined
          : yield* parseJson(
            StoredScheduleSchema,
            row.schedule_json,
            "applied resource schedule",
            row.resource_id,
          );
        const ownedKeys = row.owned_keys_json === null
          ? undefined
          : yield* parseJson(
            OwnedKeysSchema,
            row.owned_keys_json,
            "applied resource owned keys",
            row.resource_id,
          );
        return yield* Schema.decodeUnknownEffect(AppliedResourceRecordSchema)({
          resource: row.resource_id,
          revision: row.revision_id,
          digest: row.digest,
          appliedAt: row.applied_at,
          kind: row.kind ?? undefined,
          policy: row.policy ?? undefined,
          target: row.target ?? undefined,
          executable: row.executable === null
            ? undefined
            : row.executable === 1,
          symlinkTo: row.symlink_target ?? undefined,
          ownedFiles,
          ownedKeys,
          configFormat: row.config_format ?? undefined,
          schedule,
        }).pipe(
          Effect.mapError(decodeError("applied resource", row.resource_id)),
        );
      })
    );
  });

  const startRun = Effect.fn("StateRepository.startRun")(
    function*(input: StartRunInput): Effect.fn.Return<void, StateRepositoryError> {
      const transaction = Effect.gen(function*() {
        const followerCount = yield* statusCount(
          sql,
          sql`SELECT COUNT(*) AS count FROM followers WHERE id = ${input.follower}`,
          "follower",
          input.follower,
        );
        if (followerCount === 0) {
          return yield* new FollowerNotFoundError({ follower: input.follower });
        }
        const revisionCount = yield* statusCount(
          sql,
          sql`SELECT COUNT(*) AS count FROM profile_revisions WHERE id = ${input.revision}`,
          "profile revision",
          input.revision,
        );
        if (revisionCount === 0) {
          return yield* new RevisionNotFoundError({ revision: input.revision });
        }
        yield* sql`
          INSERT INTO synchronization_runs (
            id,
            follower_id,
            revision_id,
            status,
            plan_json,
            started_at
          ) VALUES (
            ${input.id},
            ${input.follower},
            ${input.revision},
            'applying',
            ${encodeJson(input.plan)},
            ${input.startedAt}
          )
        `;
        for (let ordinal = 0; ordinal < input.plan.actions.length; ordinal += 1) {
          const action = input.plan.actions[ordinal]!;
          yield* sql`
            INSERT INTO run_actions (run_id, action_id, plan_ordinal)
            VALUES (${input.id}, ${action.id}, ${ordinal})
          `;
          yield* sql`
            INSERT INTO action_journal (
              run_id,
              action_id,
              sequence,
              state,
              recorded_at,
              attempt
            ) VALUES (
              ${input.id},
              ${action.id},
              ${ordinal},
              'pending',
              ${input.startedAt},
              0
            )
          `;
        }
      });
      yield* sql.withTransaction(transaction).pipe(
        Effect.catchTag(
          "SqlError",
          (error): Effect.Effect<
            never,
            ActiveRunExistsError | RepositorySqlError
          > => {
          if (
            error.reason._tag === "UniqueViolation"
            && error.reason.constraint.includes("synchronization_runs.follower_id")
          ) {
            return Effect.fail(new ActiveRunExistsError({ follower: input.follower }));
          }
          return Effect.fail(sqlError("start synchronization run")(error));
          },
        ),
      );
    },
  );

  const loadRunStatus = Effect.fn("StateRepository.loadRunStatus")(
    function*(run: RunIdType): Effect.fn.Return<Schema.Schema.Type<typeof RunStatusRow>, StateRepositoryError> {
      const rows = yield* sql`
        SELECT follower_id, status
        FROM synchronization_runs
        WHERE id = ${run}
      `.pipe(Effect.mapError(sqlError("load synchronization run")));
      const decoded = yield* decodeRows(RunStatusRow, rows, "synchronization run", run);
      const row = decoded[0];
      if (row === undefined) return yield* new RunNotFoundError({ run });
      return row;
    },
  );

  const journalAction = Effect.fn("StateRepository.journalAction")(
    function*(input: JournalActionInput): Effect.fn.Return<void, StateRepositoryError> {
      const transaction = Effect.gen(function*() {
        const run = yield* loadRunStatus(input.run);
        if (run.status !== "applying" && run.status !== "Interrupted") {
          return yield* new InvalidRunTransitionError({
            run: input.run,
            message: `cannot journal an action while run status is ${run.status}`,
          });
        }
        const actionCount = yield* statusCount(
          sql,
          sql`
            SELECT COUNT(*) AS count
            FROM run_actions
            WHERE run_id = ${input.run} AND action_id = ${input.action}
          `,
          "planned action",
          input.action,
        );
        if (actionCount === 0) {
          return yield* new ActionNotInPlanError({
            run: input.run,
            action: input.action,
          });
        }
        const sequenceRows = yield* sql`
          SELECT COALESCE(MAX(sequence), -1) + 1 AS count
          FROM action_journal
          WHERE run_id = ${input.run}
        `;
        const sequences = yield* decodeRows(
          CountRow,
          sequenceRows,
          "action journal sequence",
          input.run,
        );
        const sequence = sequences[0]?.count ?? 0;
        yield* sql`
          INSERT INTO action_journal (
            run_id,
            action_id,
            sequence,
            state,
            recorded_at,
            attempt,
            verification_json,
            rollback_reference
          ) VALUES (
            ${input.run},
            ${input.action},
            ${sequence},
            ${input.state},
            ${input.recordedAt},
            ${input.attempt},
            ${input.verification === undefined ? null : encodeJson(input.verification)},
            ${input.rollbackReference ?? null}
          )
        `;
      });
      yield* sql.withTransaction(transaction).pipe(
        Effect.mapError((error) =>
          "_tag" in error && error._tag !== "SqlError"
            ? error
            : sqlError("journal synchronization action")(error)
        ),
      );
    },
  );

  const recordDrift = Effect.fn("StateRepository.recordDrift")(
    function*(input: RecordDriftInput): Effect.fn.Return<void, StateRepositoryError> {
      const transaction = Effect.gen(function*() {
        yield* loadRunStatus(input.run);
        const sequenceRows = yield* sql`
          SELECT COALESCE(MAX(sequence), -1) + 1 AS count
          FROM drift_records
          WHERE run_id = ${input.run}
        `;
        const sequences = yield* decodeRows(
          CountRow,
          sequenceRows,
          "drift sequence",
          input.run,
        );
        yield* sql`
          INSERT INTO drift_records (
            run_id,
            sequence,
            conflict_json,
            recorded_at
          ) VALUES (
            ${input.run},
            ${sequences[0]?.count ?? 0},
            ${encodeJson(input.conflict)},
            ${input.recordedAt}
          )
        `;
      });
      yield* sql.withTransaction(transaction).pipe(
        Effect.mapError((error) =>
          "_tag" in error && error._tag !== "SqlError"
            ? error
            : sqlError("record follower drift")(error)
        ),
      );
    },
  );

  const completeRun = Effect.fn("StateRepository.completeRun")(
    function*(input: CompleteRunInput): Effect.fn.Return<void, StateRepositoryError> {
      const transaction = Effect.gen(function*() {
        const run = yield* loadRunStatus(input.run);
        if (run.status !== "applying" && run.status !== "Interrupted") {
          return yield* new InvalidRunTransitionError({
            run: input.run,
            message: `run is already ${run.status}`,
          });
        }
        if (input.outcome.run !== input.run) {
          return yield* new InvalidRunTransitionError({
            run: input.run,
            message: `outcome belongs to run ${input.outcome.run}`,
          });
        }
        yield* sql`
          UPDATE synchronization_runs
          SET
            status = ${input.outcome.outcome},
            completed_at = ${input.completedAt},
            outcome_json = ${encodeJson(input.outcome)}
          WHERE id = ${input.run}
        `;
        for (const resource of input.removedResources ?? []) {
          yield* sql`
            DELETE FROM applied_resources
            WHERE follower_id = ${run.follower_id}
              AND resource_id = ${resource}
          `;
        }
        for (const record of input.appliedResources) {
          yield* sql`
            INSERT INTO applied_resources (
              follower_id,
              resource_id,
              revision_id,
              digest,
              applied_at,
              owned_files_json,
              schedule_json,
              kind,
              policy,
              target,
              owned_keys_json,
              config_format,
              executable,
              symlink_target
            ) VALUES (
              ${run.follower_id},
              ${record.resource},
              ${record.revision},
              ${record.digest},
              ${record.appliedAt},
              ${record.ownedFiles === undefined
                ? null
                : encodeJson(JSON.parse(JSON.stringify(record.ownedFiles)))}
              , ${record.schedule === undefined
                ? null
                : encodeJson(JSON.parse(JSON.stringify(record.schedule)))}
              , ${record.kind ?? null}
              , ${record.policy ?? null}
              , ${record.target ?? null}
              , ${record.ownedKeys === undefined
                ? null
                : encodeJson(JSON.parse(JSON.stringify(record.ownedKeys)))}
              , ${record.configFormat ?? null}
              , ${record.executable === undefined
                ? null
                : record.executable ? 1 : 0}
              , ${record.symlinkTo ?? null}
            )
            ON CONFLICT(follower_id, resource_id) DO UPDATE SET
              revision_id = excluded.revision_id,
              digest = excluded.digest,
              applied_at = excluded.applied_at,
              owned_files_json = excluded.owned_files_json
              , schedule_json = excluded.schedule_json
              , kind = excluded.kind
              , policy = excluded.policy
              , target = excluded.target
              , owned_keys_json = excluded.owned_keys_json
              , config_format = excluded.config_format
              , executable = excluded.executable
              , symlink_target = excluded.symlink_target
          `;
        }
      });
      yield* sql.withTransaction(transaction).pipe(
        Effect.mapError((error) =>
          "_tag" in error && error._tag !== "SqlError"
            ? error
            : sqlError("complete synchronization run")(error)
        ),
      );
    },
  );

  const loadRecovery = Effect.fn("StateRepository.loadRecovery")(
    function*(follower: FollowerIdType): Effect.fn.Return<RecoveryState | undefined, StateRepositoryError> {
      const runRows = yield* sql`
        SELECT id, follower_id, revision_id, plan_json, started_at
        FROM synchronization_runs
        WHERE follower_id = ${follower}
          AND status IN ('applying', 'Interrupted')
        ORDER BY started_at DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlError("load active synchronization run")));
      const runs = yield* decodeRows(
        ActiveRunRow,
        runRows,
        "active synchronization run",
        follower,
      );
      const row = runs[0];
      if (row === undefined) return undefined;
      const plan = yield* parseJson(
        SynchronizationPlanSchema,
        row.plan_json,
        "synchronization plan",
        row.id,
      );

      const journalRows = yield* sql`
        SELECT
          action_id,
          sequence,
          state,
          recorded_at,
          attempt,
          verification_json,
          rollback_reference
        FROM action_journal
        WHERE run_id = ${row.id}
        ORDER BY sequence
      `.pipe(Effect.mapError(sqlError("load action journal")));
      const journal = yield* decodeRows(
        ActionJournalRow,
        journalRows,
        "action journal",
        row.id,
      );
      const actions: Array<ActionJournalRecord> = [];
      for (const event of journal) {
        let verification: VerificationEvidence | undefined;
        if (event.verification_json !== null) {
          verification = yield* parseJson(
            VerificationEvidenceSchema,
            event.verification_json,
            "action verification",
            `${row.id}:${event.sequence}`,
          );
        }
        const base = {
          action: event.action_id,
          ordinal: event.sequence,
          state: event.state,
          recordedAt: event.recorded_at,
          attempt: event.attempt,
        };
        const rollbackReference = event.rollback_reference;
        if (verification === undefined) {
          if (rollbackReference === null) {
            actions.push(base);
          } else {
            actions.push({ ...base, rollbackReference });
          }
        } else if (rollbackReference === null) {
          actions.push({ ...base, verification });
        } else {
          actions.push({
            ...base,
            verification,
            rollbackReference,
          });
        }
      }

      const driftRows = yield* sql`
        SELECT sequence, conflict_json, recorded_at
        FROM drift_records
        WHERE run_id = ${row.id}
        ORDER BY sequence
      `.pipe(Effect.mapError(sqlError("load drift records")));
      const encodedDrift = yield* decodeRows(
        DriftRow,
        driftRows,
        "drift records",
        row.id,
      );
      const drift: Array<DriftRecord> = [];
      for (const stored of encodedDrift) {
        const conflict = yield* parseJson(
          DriftConflictSchema,
          stored.conflict_json,
          "drift conflict",
          `${row.id}:${stored.sequence}`,
        );
        drift.push({
          ordinal: stored.sequence,
          conflict,
          recordedAt: stored.recorded_at,
        });
      }

      const appliedResources = yield* loadAppliedResources(follower);

      return {
        run: {
          id: row.id,
          follower: row.follower_id,
          revision: row.revision_id,
          startedAt: row.started_at,
          plan,
        },
        actions,
        drift,
        appliedResources,
      };
    },
  );

  const loadState = Effect.fn("StateRepository.loadState")(
    function*(follower: FollowerIdType): Effect.fn.Return<StateSnapshot, StateRepositoryError> {
      const followerRows = yield* sql`
        SELECT
          id,
          name,
          groups_json,
          revoked,
          credential_reference,
          enrolled_at
        FROM followers
        WHERE id = ${follower}
      `.pipe(Effect.mapError(sqlError("load follower state")));
      const followers = yield* decodeRows(FollowerRow, followerRows, "follower", follower);
      const storedFollower = followers[0];
      if (storedFollower === undefined) {
        return yield* new FollowerNotFoundError({ follower });
      }
      const groups = yield* parseJson(
        Schema.Array(Schema.String),
        storedFollower.groups_json,
        "follower groups",
        follower,
      );
      const decodedFollower = yield* Schema.decodeUnknownEffect(FollowerIdentity)({
        id: storedFollower.id,
        name: storedFollower.name,
        groups,
        revoked: storedFollower.revoked === 1,
        credentialReference: storedFollower.credential_reference,
        enrolledAt: storedFollower.enrolled_at,
      }).pipe(Effect.mapError(decodeError("follower", follower)));

      const identityRows = yield* sql`
        SELECT key_id, public_key_fingerprint
        FROM source_identity
        WHERE singleton = 1
      `.pipe(Effect.mapError(sqlError("load source identity")));
      const identities = yield* decodeRows(
        SourceIdentityRow,
        identityRows,
        "source identity",
        "1",
      );
      const storedIdentity = identities[0];
      const sourceIdentity = storedIdentity === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(SourceIdentity)({
          keyId: storedIdentity.key_id,
          publicKeyFingerprint: storedIdentity.public_key_fingerprint,
        }).pipe(Effect.mapError(decodeError("source identity", "1")));
      const activeRecovery = yield* loadRecovery(follower);
      if (sourceIdentity === undefined && activeRecovery === undefined) {
        return { follower: decodedFollower };
      }
      if (sourceIdentity === undefined) {
        return { follower: decodedFollower, activeRecovery };
      }
      if (activeRecovery === undefined) {
        return { follower: decodedFollower, sourceIdentity };
      }
      return { follower: decodedFollower, sourceIdentity, activeRecovery };
    },
  );

  return StateRepository.of({
    saveSourceIdentity,
    registerFollower,
    saveFollowerSynchronizationConfiguration,
    getFollowerSynchronizationConfiguration,
    saveEnrollmentSource,
    getEnrollmentSource,
    createEnrollmentInvitation,
    findEnrollmentInvitation,
    consumeEnrollmentInvitation,
    findFollowerCredential,
    getFollowerCredential,
    revokeFollower,
    updateFollowerGroups,
    publishRevision,
    getRevision,
    findRevision,
    getLatestRevision,
    listRevisions,
    loadAppliedResources,
    startRun,
    journalAction,
    recordDrift,
    completeRun,
    loadRecovery,
    loadState,
  });
});

export const StateRepositoryLive = Layer.effect(StateRepository, makeRepository);

export const stateRepositoryLayer = (filename: string) =>
  StateRepositoryLive.pipe(
    Layer.provide(SqliteClient.layer({ filename })),
  );
