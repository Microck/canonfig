import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Effect, Exit, Redacted, Schema } from "effect";
import { CredentialReference } from "../domain/brand.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { ArchiveFile } from "../projection/archive.ts";
import { SecretNameSchema } from "../secrets/secret-store.ts";
import { stateFormatVersion } from "../state/state-schema.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { BackupError, backupWork, missingBackupFile } from "./backup-config.ts";
import { BackupIoError, readBackupMetadata } from "./backup-io.ts";
import type { BackupPolicy } from "./backup.types.ts";

const Credential = Schema.Struct({ reference: CredentialReference, value: Schema.String });
const SecretEntry = Schema.Struct({ name: SecretNameSchema, reference: CredentialReference, origin: Schema.Literals(["local", "source"]) });
const SecretManifest = Schema.Struct({ schemaVersion: Schema.Literal(1), secrets: Schema.Array(SecretEntry), retiredReferences: Schema.Array(CredentialReference) });
const Recovery = Schema.Struct({
  version: Schema.Literal(1), stateFormat: Schema.Literal(stateFormatVersion),
  source: Schema.Boolean, credentials: Schema.Array(Credential), secrets: Schema.optional(SecretManifest),
});
export type Recovery = typeof Recovery.Type;
const SourceReferences = Schema.Struct({ signing_key_reference: CredentialReference, tls_key_reference: CredentialReference, tls_certificate_reference: CredentialReference });
const ReferenceRow = Schema.Struct({ credential_reference: CredentialReference });
const jsonFile = (path: string, value: Recovery): ArchiveFile => ({ path, content: Buffer.from(`${JSON.stringify(value)}\n`), mode: 0o600 });

/**
 * The snapshot retains publications and the follower registry, not in-flight work tied to the old machine.
 * archive_events stays: it is an append-only history whose delete trigger fires even with foreign keys off.
 */
const clearMachineWork = (database: DatabaseSync): void => {
  database.exec(`PRAGMA foreign_keys = OFF;
    DELETE FROM mcp_qualification_receipts; DELETE FROM action_journal; DELETE FROM run_actions;
    DELETE FROM drift_records; DELETE FROM deployment_receipts; DELETE FROM applied_resources;
    DELETE FROM harness_takeovers; DELETE FROM local_revisions; DELETE FROM synchronization_runs;
    DELETE FROM scheduled_invocations; DELETE FROM follower_sync_configuration;
    DELETE FROM enrollment_invitations; DELETE FROM pending_enrollments; DELETE FROM enrollment_credential_retirements;
    DELETE FROM follower_credentials WHERE follower_id IN (SELECT id FROM followers WHERE revoked = 1);
    PRAGMA foreign_keys = ON;`);
};

export const captureRecovery = (input: { readonly policy: BackupPolicy; readonly folder: string; readonly statePath: string; readonly scratch: string }) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const references = new Set<CredentialReference>();
  let sourceDatabase: string | undefined;
  if (input.policy.sourceIdentity) {
    sourceDatabase = join(input.scratch, "source-state.sqlite");
    const output = sourceDatabase;
    const source = yield* backupWork("Capture Source identity", async () => {
      if ((await lstat(input.statePath)).size > input.policy.maximumBytes) throw new BackupIoError("BACKUP_INVALID", "Source state exceeds maximumBytes");
      const live = new DatabaseSync(input.statePath, { readOnly: true });
      try { await backup(live, output); } finally { live.close(); }
      const snapshot = new DatabaseSync(output, { enableForeignKeyConstraints: true });
      try {
        const identity = snapshot.prepare("SELECT singleton FROM enrollment_source WHERE singleton = 1").get();
        if (identity === undefined) throw new BackupIoError("BACKUP_INVALID", "Source identity was selected on a machine that is not a Source");
        clearMachineWork(snapshot);
        const keys = Schema.decodeUnknownSync(SourceReferences)(snapshot.prepare("SELECT signing_key_reference, tls_key_reference, tls_certificate_reference FROM enrollment_source WHERE singleton = 1").get());
        const followers = Schema.decodeUnknownSync(Schema.Array(ReferenceRow))(snapshot.prepare("SELECT credential_reference FROM follower_credentials").all());
        return [...Object.values(keys), ...followers.map(row => row.credential_reference)];
      } finally { snapshot.close(); }
    });
    for (const reference of source) references.add(reference);
  }
  const readSecrets = Effect.gen(function*() {
    const secrets = yield* backupWork("Read shared-secret recovery references", async () => {
      try {
        await lstat(join(input.folder, "secrets-transaction.json"));
        throw new BackupIoError("BACKUP_CONFLICT", "A shared-secret transaction needs recovery before it can be backed up. Run canonfig secrets list first.");
      } catch (cause) { if (!missingBackupFile(cause)) throw cause; }
      try { return await readBackupMetadata(join(input.folder, "secrets.json"), SecretManifest); }
      catch (cause) { if (missingBackupFile(cause)) return { schemaVersion: 1 as const, secrets: [], retiredReferences: [] }; throw cause; }
    });
    const credentials = yield* Effect.forEach(secrets.secrets, secret => machine.loadCredential({ reference: secret.reference }).pipe(
      Effect.map(value => ({ reference: secret.reference, value: Redacted.value(value) })),
      Effect.mapError(() => new BackupError({ code: "BACKUP_CREDENTIAL_REQUIRED", message: "A selected shared secret could not be read. Unlock the local credential store before backing up." })),
    ));
    return { secrets: { ...secrets, retiredReferences: [] }, credentials };
  });
  const shared = input.policy.sharedSecrets
    ? yield* withRunLock(join(input.folder, "secrets.json"), "back up shared secrets", readSecrets)
    : undefined;
  const credentials = yield* Effect.forEach(references, reference => machine.loadCredential({ reference }).pipe(
    Effect.map(value => ({ reference, value: Redacted.value(value) })),
    Effect.mapError(() => new BackupError({ code: "BACKUP_CREDENTIAL_REQUIRED", message: "A Source identity credential could not be read. Unlock the local credential store before backing up." })),
  ));
  const recovery: Recovery = { version: 1, stateFormat: stateFormatVersion, source: input.policy.sourceIdentity,
    credentials: [...credentials, ...shared?.credentials ?? []], secrets: shared?.secrets };
  return { sourceDatabase, files: input.policy.sourceIdentity || input.policy.sharedSecrets ? [jsonFile("recovery/credentials.json", recovery)] : [] };
});

/** Recovery values stay in bounded memory, never in an extracted credential file. */
export const readRecovery = async (content: AsyncIterable<Uint8Array>): Promise<Recovery> => {
  const chunks: Array<Uint8Array> = [];
  let bytes = 0;
  for await (const chunk of content) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Recovery credentials exceed the metadata limit");
    chunks.push(chunk);
  }
  return Schema.decodeUnknownSync(Recovery)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
};

/** Own only newly generated native references; rollback and drills remove them, never an existing credential. */
export const withRecoveryCredentials = <A, E, R>(
  input: { readonly recovery: Recovery | undefined; readonly recoverCredentials: boolean; readonly keep: boolean },
  use: (references: ReadonlyMap<string, CredentialReference>) => Effect.Effect<A, E, R>,
) => Effect.gen(function*() {
  const recovery = input.recovery;
  if (recovery === undefined) return yield* use(new Map());
  if (!input.recoverCredentials) return yield* new BackupError({ code: "BACKUP_INVALID", message: "This snapshot contains recovery credentials. Use --recover-credentials to import them into the native secure store." });
  const machine = yield* MachineState;
  const unavailable = () => new BackupError({ code: "BACKUP_CREDENTIAL_REQUIRED", message: "Recovery requires an unlocked native secure credential store. Unlock or configure it, then run restore again; no credentials were written to files." });
  const capability = yield* machine.credentialCapability().pipe(Effect.mapError(unavailable));
  if (capability.kind !== "secure-noninteractive") return yield* unavailable();
  if (new Set(recovery.credentials.map(credential => credential.reference)).size !== recovery.credentials.length) {
    return yield* new BackupError({ code: "BACKUP_VERIFY_FAILED", message: "Recovery contains a duplicate credential reference" });
  }
  return yield* Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const created: Array<CredentialReference> = [];
    const references = new Map<string, CredentialReference>();
    const outcome = yield* Effect.exit(restore(Effect.gen(function*() {
      for (const credential of recovery.credentials) {
        const reference = yield* machine.storeCredential({ name: `canonfig-recovery-${randomUUID()}`, value: Redacted.make(credential.value),
          beforeStore: reference => Effect.sync(() => { created.push(reference); }),
        }).pipe(Effect.mapError(unavailable));
        references.set(credential.reference, reference);
      }
      return yield* use(references);
    })));
    if (!input.keep || Exit.isFailure(outcome)) {
      const removed = yield* Effect.forEach(created, reference => Effect.exit(machine.removeCredential(reference)));
      if (removed.some(Exit.isFailure)) return yield* new BackupError({ code: "BACKUP_CREDENTIAL_REQUIRED", message: `Recovery could not remove its new native credentials. Unlock the secure store and remove these references before trying again: ${created.join(", ")}` });
    }
    if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
    return outcome.value;
  }));
});

/** Publish only remapped native references alongside the recovered Source state and secret manifest. */
export const restoreRecovery = async (input: {
  readonly extracted: string; readonly home: string; readonly recovery: Recovery | undefined;
  readonly references: ReadonlyMap<string, CredentialReference>;
}): Promise<{ readonly source: boolean; readonly secrets: number }> => {
  const recovery = input.recovery;
  if (recovery === undefined) return { source: false, secrets: 0 };
  const folder = join(input.home, ".canonfig");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const references = input.references;
  const referenceFor = (reference: string): string => {
    const restored = references.get(reference);
    if (restored === undefined) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Recovery is missing a required credential");
    return restored;
  };
  if (recovery.source) {
    const output = join(folder, "state.sqlite");
    await copyFile(join(input.extracted, "recovery", "source-state.sqlite"), output, constants.COPYFILE_EXCL);
    const database = new DatabaseSync(output);
    try {
      database.exec("PRAGMA trusted_schema = OFF; BEGIN IMMEDIATE");
      const keys = Schema.decodeUnknownSync(SourceReferences)(database.prepare("SELECT signing_key_reference, tls_key_reference, tls_certificate_reference FROM enrollment_source WHERE singleton = 1").get());
      database.prepare("UPDATE enrollment_source SET signing_key_reference = ?, tls_key_reference = ?, tls_certificate_reference = ?, credential_namespace = NULL WHERE singleton = 1")
        .run(referenceFor(keys.signing_key_reference), referenceFor(keys.tls_key_reference), referenceFor(keys.tls_certificate_reference));
      for (const [previous, next] of references) {
        database.prepare("UPDATE followers SET credential_reference = ? WHERE credential_reference = ?").run(next, previous);
        database.prepare("UPDATE follower_credentials SET credential_reference = ? WHERE credential_reference = ?").run(next, previous);
      }
      database.exec("COMMIT");
    } finally { database.close(); }
  }
  if (recovery.secrets !== undefined) {
    const manifest = { ...recovery.secrets, secrets: recovery.secrets.secrets.map(secret => ({ ...secret, reference: referenceFor(secret.reference) })) };
    await writeFile(join(folder, "secrets.json"), `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
  }
  return { source: recovery.source, secrets: recovery.secrets?.secrets.length ?? 0 };
};
