import { withRunLock } from "../synchronization/run-lock.ts";
import { RunLockHeldError } from "../synchronization/synchronization.errors.ts";
import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";

import { Effect, Redacted, Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

import { CredentialReference } from "../domain/brand.ts";
import { credentialFailureDetail, UnconfirmedPublicationError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";

export const SECRET_SHARE_GROUP = "canonfig:secrets";
export const maximumSharedSecrets = 128;
export const maximumSecretBytes = 16 * 1024;
export const maximumSharedSecretPayloadBytes = 1024 * 1024;
const maximumManifestBytes = 256 * 1024;

export const SecretNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);

const SecretValueSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumSecretBytes),
  Schema.isPattern(/^[^\0]*$/u),
);

const SecretOriginSchema = Schema.Literals(["local", "source"]);

const SecretManifestEntrySchema = Schema.Struct({
  name: SecretNameSchema,
  reference: CredentialReference,
  origin: SecretOriginSchema,
});

const SecretManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  secrets: Schema.Array(SecretManifestEntrySchema),
  retiredReferences: Schema.Array(CredentialReference),
});

const SecretTransaction = Schema.Union([
  Schema.TaggedStruct("Preparing", {
    previous: SecretManifestSchema, created: Schema.Array(CredentialReference),
  }),
  Schema.TaggedStruct("Storing", {
    previous: SecretManifestSchema, created: Schema.Array(CredentialReference), credentialName: Schema.String,
  }),
  Schema.TaggedStruct("Publishing", {
    previous: SecretManifestSchema, created: Schema.Array(CredentialReference), next: SecretManifestSchema,
  }),
  Schema.TaggedStruct("PublishedUnconfirmed", {
    previous: SecretManifestSchema, created: Schema.Array(CredentialReference), next: SecretManifestSchema,
  }),
  Schema.TaggedStruct("Committed", { next: SecretManifestSchema }),
]);
type SecretTransaction = typeof SecretTransaction.Type;
const secretTransitions = {
  Preparing: ["Storing", "Publishing"], Storing: ["Preparing"],
  Publishing: ["PublishedUnconfirmed", "Committed"], PublishedUnconfirmed: [], Committed: [],
} satisfies Record<SecretTransaction["_tag"], ReadonlyArray<SecretTransaction["_tag"]>>;

export const TransferredSecretsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  secrets: Schema.Array(Schema.Struct({
    name: SecretNameSchema,
    value: SecretValueSchema,
  })),
});

export type TransferredSecrets = typeof TransferredSecretsSchema.Type;
export type SecretOrigin = typeof SecretOriginSchema.Type;
export interface SharedSecretSummary {
  readonly name: string;
  readonly origin: SecretOrigin;
}

type SecretManifest = typeof SecretManifestSchema.Type;
type SecretManifestEntry = typeof SecretManifestEntrySchema.Type;
type CredentialReferenceValue = typeof CredentialReference.Type;
interface SecretValue {
  readonly name: string;
  readonly value: string;
}

export class SecretTransferError extends TaggedError<SecretTransferError>()(
  "SecretTransferError",
  {
    category: Schema.Literals([
      "usage",
      "storage",
      "authentication",
      "transport",
      "state",
    ]),
    operation: Schema.String,
    message: Schema.String,
    publication: Schema.optionalKey(Schema.Literals(["not-published", "published-unconfirmed"])),
  },
) {}

const secretError = (
  category: SecretTransferError["category"],
  operation: string,
  message: string,
): SecretTransferError => new SecretTransferError({ category, operation, message });

interface SecretPaths {
  readonly directory: MachinePath;
  readonly manifest: MachinePath;
  readonly transaction: MachinePath;
}

export const requireSecureStorage = (
  operation: string,
): Effect.Effect<void, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const capability = yield* machine.credentialCapability().pipe(
      Effect.mapError((error) =>
        secretError(
          "storage",
          operation,
          `the platform credential-store capability could not be determined: ${credentialFailureDetail(error)}`,
        )
      ),
    );
    if (capability.kind === "secure-noninteractive") return;
    const recovery = capability.kind === "unavailable"
      ? capability.recovery
      : "configure the native platform credential store; local-file credential mode is not allowed for shared secrets";
    return yield* secretError(
      "storage",
      operation,
      `shared secrets require secure noninteractive credential storage: ${recovery}`,
    );
  });

const secretPaths = (): Effect.Effect<
  SecretPaths,
  SecretTransferError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories().pipe(
      Effect.mapError(() =>
        secretError("state", "resolve secret storage", "user directories are unavailable")
      ),
    );
    const directory = yield* machine.normalizePath({
      path: ".canonfig",
      base: directories.home,
    }).pipe(
      Effect.mapError(() =>
        secretError("state", "resolve secret storage", "the Canonfig data directory is unavailable")
      ),
    );
    const manifest = yield* machine.normalizePath({
      path: "secrets.json",
      base: directory,
    }).pipe(
      Effect.mapError(() =>
        secretError("state", "resolve secret storage", "the secret manifest path is unavailable")
      ),
    );
    const transaction = yield* machine.normalizePath({ path: "secrets-transaction.json", base: directory }).pipe(
      Effect.mapError(() => secretError("state", "resolve secret storage", "the secret transaction path is unavailable")),
    );
    return { directory, manifest, transaction };
  });

const pathExists = (
  path: string,
): Effect.Effect<boolean, SecretTransferError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await access(path);
        return true;
      } catch (cause) {
        if (
          cause instanceof Error
          && "code" in cause
          && String(cause.code) === "ENOENT"
        ) return false;
        throw cause;
      }
    },
    catch: () =>
      secretError("state", "inspect secret manifest", "the secret manifest cannot be inspected"),
  });

const validateUniqueNames = (
  names: ReadonlyArray<string>,
  operation: string,
): Effect.Effect<void, SecretTransferError> => {
  if (names.length > maximumSharedSecrets) {
    return Effect.fail(secretError(
      "usage",
      operation,
      `at most ${maximumSharedSecrets} secrets can be synchronized`,
    ));
  }
  if (new Set(names).size !== names.length) {
    return Effect.fail(secretError(
      "usage",
      operation,
      "secret names must be unique",
    ));
  }
  return Effect.void;
};

const uniqueReferences = (
  references: ReadonlyArray<CredentialReferenceValue>,
): ReadonlyArray<CredentialReferenceValue> =>
  [...new Map(references.map((reference) => [String(reference), reference])).values()];

const validatePayloadBudget = (
  secrets: ReadonlyArray<SecretValue>,
  category: SecretTransferError["category"],
  operation: string,
): Effect.Effect<void, SecretTransferError> => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    secrets,
  })).byteLength;
  return bytes <= maximumSharedSecretPayloadBytes
    ? Effect.void
    : Effect.fail(secretError(
      category,
      operation,
      `the encoded shared-secret payload must not exceed ${maximumSharedSecretPayloadBytes} bytes`,
    ));
};

const readManifest = (): Effect.Effect<
  SecretManifest,
  SecretTransferError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const paths = yield* secretPaths();
    if (!(yield* pathExists(paths.manifest.absolute))) {
      return { schemaVersion: 1, secrets: [], retiredReferences: [] };
    }
    const bytes = yield* machine.readFile({
      path: paths.manifest,
      maximumBytes: maximumManifestBytes,
    }).pipe(
      Effect.mapError(() =>
        secretError("state", "read secret manifest", "the secret manifest cannot be read safely")
      ),
    );
    const manifest = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(SecretManifestSchema)(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ),
      // Name the file and the shape it must have so the owner can repair it; there is no automatic migration.
      // Never echo parser or schema messages: they can quote file content, which may include a credential.
      catch: (cause) =>
        // TextDecoder rejects invalid UTF-8 with a TypeError; JSON.parse rejects bad syntax with a SyntaxError.
        secretError("state", "read secret manifest", cause instanceof SyntaxError || cause instanceof TypeError
          ? `\`${paths.manifest.absolute}\` is not valid JSON`
          : `\`${paths.manifest.absolute}\` does not match the secret manifest format: it needs \`schemaVersion\` 1, a \`secrets\` list and a \`retiredReferences\` list`),
    });
    yield* validateUniqueNames(
      manifest.secrets.map((secret) => secret.name),
      "read secret manifest",
    ).pipe(
      Effect.mapError(() =>
        secretError("state", "read secret manifest", "the secret manifest is invalid")
      ),
    );
    const active = new Set(manifest.secrets.map(entry => String(entry.reference)));
    if (manifest.retiredReferences.some(reference => active.has(String(reference)))) {
      return yield* secretError("state", "read secret manifest", "the secret manifest marks an active credential for retirement; preserve secrets.json and inspect its references before retrying");
    }
    return {
      ...manifest,
      retiredReferences: uniqueReferences(manifest.retiredReferences),
    };
  });

const writeManifest = (
  secrets: ReadonlyArray<SecretManifestEntry>,
  retiredReferences: ReadonlyArray<CredentialReferenceValue> = [],
): Effect.Effect<void, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    yield* validateUniqueNames(
      secrets.map((secret) => secret.name),
      "write secret manifest",
    );
    const activeReferences = new Set(secrets.map((secret) => String(secret.reference)));
    const retired = uniqueReferences(retiredReferences).filter((reference) =>
      !activeReferences.has(String(reference))
    );
    const paths = yield* secretPaths();
    yield* machine.ensureDirectory({ path: paths.directory, mode: 0o700 }).pipe(
      Effect.mapError(() =>
        secretError("storage", "write secret manifest", "the Canonfig data directory cannot be secured")
      ),
    );
    const manifest: SecretManifest = {
      schemaVersion: 1,
      secrets: [...secrets].sort((left, right) => left.name.localeCompare(right.name)),
      retiredReferences: retired,
    };
    const content = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    if (content.byteLength > maximumManifestBytes) {
      return yield* secretError(
        "storage",
        "write secret manifest",
        "the secret manifest exceeds its size limit",
      );
    }
    yield* machine.atomicWrite({
      path: paths.manifest,
      content,
      mode: 0o600,
    }).pipe(
      Effect.mapError((error) => new SecretTransferError({
        category: "storage", operation: "write secret manifest",
        publication: error instanceof UnconfirmedPublicationError ? "published-unconfirmed" : "not-published",
        message: error instanceof UnconfirmedPublicationError
          ? "the secret manifest was published but could not be confirmed; active credentials and transaction evidence were retained, retry to inspect and recover"
          : "the secret manifest cannot be written safely",
      })),
    );
  });

const removeRetiredReferences = (
  secrets: ReadonlyArray<SecretManifestEntry>,
  references: ReadonlyArray<CredentialReferenceValue>,
  operation: string,
): Effect.Effect<void, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const pending = uniqueReferences(references);
    if (pending.length === 0) return;
    const failed: CredentialReferenceValue[] = [];
    let firstFailure: string | undefined;
    for (const reference of pending) {
      const removed = yield* machine.removeCredential(reference).pipe(
        Effect.match({
          onFailure: (error) => {
            firstFailure ??= credentialFailureDetail(error);
            return false;
          },
          onSuccess: () => true,
        }),
      );
      if (!removed) failed.push(reference);
    }
    yield* writeManifest(secrets, failed);
    if (failed.length > 0) {
      return yield* secretError(
        "storage",
        operation,
        `obsolete secret credentials remain queued for automatic removal: ${firstFailure}`,
      );
    }
  });

export const decodeSecretName = (
  name: string,
): Effect.Effect<string, SecretTransferError> =>
  Schema.decodeUnknownEffect(SecretNameSchema)(name).pipe(
    Effect.mapError(() =>
      secretError(
        "usage",
        "validate secret name",
        "secret names must be 1-128 portable characters",
      )
    ),
  );

const decodeValue = (
  value: string,
): Effect.Effect<string, SecretTransferError> =>
  Schema.decodeUnknownEffect(SecretValueSchema)(value).pipe(
    Effect.flatMap((decoded) =>
      new TextEncoder().encode(decoded).byteLength <= maximumSecretBytes
        ? Effect.succeed(decoded)
        : Effect.fail(secretError(
          "usage",
          "validate secret value",
          `secret values must contain 1-${maximumSecretBytes} UTF-8 bytes and no NUL bytes`,
        ))
    ),
    Effect.mapError(() =>
      secretError(
        "usage",
        "validate secret value",
        `secret values must contain 1-${maximumSecretBytes} UTF-8 bytes and no NUL bytes`,
      )
    ),
  );

const storeValue = (
  credentialName: string,
  value: string,
): Effect.Effect<CredentialReferenceValue, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.storeCredential({ name: credentialName, value: Redacted.make(value) }).pipe(
      Effect.mapError((error) => secretError("storage", "store secret",
        `secure credential storage is unavailable: ${credentialFailureDetail(error)}`)),
    );
  });

const loadSecretValues = (
  entries: ReadonlyArray<SecretManifestEntry>,
  operation: string,
): Effect.Effect<ReadonlyArray<SecretValue>, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* Effect.forEach(entries, (secret) =>
      machine.loadCredential({ reference: secret.reference }).pipe(
        Effect.map((value) => ({
          name: secret.name,
          value: Redacted.value(value),
        })),
        Effect.mapError((error) =>
          secretError(
            "storage",
            operation,
            `the shared secret ${secret.name} could not be loaded from secure credential storage: ${credentialFailureDetail(error)}`,
          )
        ),
      ));
  });

const writeSecretTransaction = (state: SecretTransaction) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const paths = yield* secretPaths();
  yield* machine.atomicWrite({ path: paths.transaction, mode: 0o600,
    content: new TextEncoder().encode(JSON.stringify({ version: 1, state }) + "\n"),
  }).pipe(Effect.mapError(() => secretError("storage", "record secret transaction",
    "secret transaction ownership could not be recorded; preserve secrets-transaction.json before retrying")));
});

const clearSecretTransaction = () => Effect.gen(function*() {
  const paths = yield* secretPaths();
  yield* Effect.tryPromise({
    try: () => unlink(paths.transaction.absolute),
    catch: () => secretError("storage", "finish secret transaction", "secret transaction cleanup could not be confirmed; retry to recover"),
  });
});

/** Called only under the manifest lock. The current manifest owns active
 * references even when the previous writer never confirmed its publication. */
const recoverSecretTransaction = () => Effect.gen(function*() {
  const machine = yield* MachineState;
  const paths = yield* secretPaths();
  if (!(yield* pathExists(paths.transaction.absolute))) return;
  const bytes = yield* machine.readFile({ path: paths.transaction, maximumBytes: maximumManifestBytes * 3 }).pipe(
    Effect.mapError(() => secretError("state", "recover secret transaction", "the secret transaction cannot be read safely; preserve it and inspect the native credential store")),
  );
  const { state } = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Literal(1), state: SecretTransaction }))(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    catch: () => secretError("state", "recover secret transaction", "the secret transaction is invalid; preserve secrets.json and secrets-transaction.json and inspect the native credential store before retrying"),
  });
  if (state._tag === "Storing") {
    return yield* secretError("state", "recover secret transaction",
      `a credential write was interrupted for native item ${state.credentialName}; inspect that item and every created reference listed in secrets-transaction.json in the platform credential store. Remove only unreferenced items, then remove secrets-transaction.json and retry. Existing active manifest entries were not changed`);
  }
  if (state._tag !== "Preparing" && !(yield* pathExists(paths.manifest.absolute))) {
    return yield* secretError("state", "recover secret transaction",
      "the secret manifest disappeared during publication; preserve secrets-transaction.json and all native credentials. Inspect the journal's previous and next manifests, restore the intended secrets.json, then retry. No credentials were deleted");
  }
  const current = yield* readManifest();
  const active = new Set(current.secrets.map(entry => String(entry.reference)));
  const created = state._tag === "Committed" ? [] : state.created;
  const retiring = uniqueReferences([...current.retiredReferences, ...created])
    .filter(reference => !active.has(String(reference)));
  yield* writeManifest(current.secrets, retiring);
  yield* removeRetiredReferences(current.secrets, retiring, "clean retired secrets");
  yield* clearSecretTransaction();
});

const secretTransaction = (previous: SecretManifest) => {
  let state: SecretTransaction = { _tag: "Preparing", previous, created: [] };
  const transition = (next: SecretTransaction) => Effect.gen(function*() {
    const allowed: ReadonlyArray<SecretTransaction["_tag"]> = secretTransitions[state._tag];
    if (!allowed.includes(next._tag)) {
      return yield* secretError("state", "transition secret transaction", `illegal secret transaction transition ${state._tag} -> ${next._tag}`);
    }
    // Ownership changes only after its durable record succeeds.
    yield* writeSecretTransaction(next);
    state = next;
  });
  return {
    store: (name: string, value: string) => Effect.gen(function*() {
      if (state._tag !== "Preparing") return yield* secretError("state", "store secret", "secret transaction is not preparing");
      const created = state.created;
      const credentialName = `canonfig-shared-secret:${name}:${randomUUID()}`;
      yield* transition({ _tag: "Storing", previous, created, credentialName });
      const reference = yield* storeValue(credentialName, value);
      yield* transition({ _tag: "Preparing", previous, created: [...created, reference] });
      return reference;
    }),
    publish: (secrets: ReadonlyArray<SecretManifestEntry>, retiredReferences: ReadonlyArray<CredentialReferenceValue>, operation: string) => Effect.gen(function*() {
      if (state._tag !== "Preparing") return yield* secretError("state", "publish secrets", "secret transaction is not preparing");
      const created = state.created;
      const next: SecretManifest = { schemaVersion: 1, secrets, retiredReferences };
      yield* transition({ _tag: "Publishing", previous, next, created });
      yield* writeManifest(secrets, retiredReferences).pipe(Effect.tapError(error =>
        error.publication === "published-unconfirmed"
          ? transition({ _tag: "PublishedUnconfirmed", previous, next, created })
          : Effect.void));
      yield* transition({ _tag: "Committed", next });
      yield* removeRetiredReferences(secrets, retiredReferences, operation);
      yield* clearSecretTransaction();
    }),
  };
};
export const listSecrets = (): Effect.Effect<
  ReadonlyArray<SharedSecretSummary>,
  SecretTransferError,
  MachineState
> =>
  readManifest().pipe(
    Effect.map((manifest) =>
      manifest.secrets.map(({ name, origin }) => ({ name, origin }))
    ),
  );

/**
 * Resolve a shared secret name to its current native credential reference.
 * Rotation replaces the reference behind the name, so launchers that bind by
 * name keep working while direct reference holders must re-resolve.
 */
export const findSecretReference = (
  name: string,
): Effect.Effect<
  CredentialReferenceValue | undefined,
  SecretTransferError,
  MachineState
> =>
  readManifest().pipe(
    Effect.map((manifest) =>
      manifest.secrets.find((secret) => secret.name === name)?.reference
    ),
  );

/** Cross-process exclusion covers ownership reads, credential writes, manifest
 * replacement and retired-reference cleanup as one operation. Contention is a
 * retryable storage failure, never permission to commit a stale manifest. */
const withManifestLock = <A>(
  operation: string,
  effect: Effect.Effect<A, SecretTransferError, MachineState>,
): Effect.Effect<A, SecretTransferError, MachineState> => Effect.gen(function*() {
  const machine = yield* MachineState;
  const paths = yield* secretPaths();
  yield* machine.ensureDirectory({ path: paths.directory, mode: 0o700 }).pipe(
    Effect.mapError(() => secretError("storage", operation, "the Canonfig data directory cannot be secured")),
  );
  return yield* withRunLock(paths.manifest.absolute, operation, recoverSecretTransaction().pipe(Effect.andThen(effect))).pipe(
    Effect.mapError((error) => error instanceof SecretTransferError ? error : secretError(
      "storage", operation,
      error instanceof RunLockHeldError
        ? "Another secret operation is in progress. Wait for it to finish, then retry; no secret changes were made by this attempt."
        : "The secret manifest lock could not be acquired safely. Check the Canonfig data directory and retry.",
    )),
  );
});

export const storeSecret = (
  name: string,
  value: string,
  origin: SecretOrigin = "local",
): Effect.Effect<SharedSecretSummary, SecretTransferError, MachineState> =>
  withManifestLock("store secret", Effect.gen(function*() {
    yield* requireSecureStorage("store secret");
    const validName = yield* decodeSecretName(name);
    const validValue = yield* decodeValue(value);
    const current = yield* readManifest();
    const previous = current.secrets.find((secret) => secret.name === validName);
    if (origin === "local" && previous?.origin === "source") {
      return yield* secretError(
        "usage",
        "store secret",
        `Secret ${validName} is Source-owned. Update it on the Source, or use a different local name; it has not been changed.`,
      );
    }
    if (origin === "local") {
      const retained = current.secrets.filter((secret) =>
        secret.origin === "local" && secret.name !== validName
      );
      const values = yield* loadSecretValues(retained, "measure shared secrets");
      yield* validatePayloadBudget(
        [...values, { name: validName, value: validValue }],
        "usage",
        "store secret",
      );
    }
    const transaction = secretTransaction(current);
    const reference = yield* transaction.store(validName, validValue);
    const next = [
      ...current.secrets.filter((secret) => secret.name !== validName),
      { name: validName, reference, origin },
    ];
    const retired = [
      ...current.retiredReferences,
      ...(previous === undefined ? [] : [previous.reference]),
    ];
    yield* transaction.publish(next, retired, "replace secret");
    return { name: validName, origin };
  }));

export const removeSecret = (
  name: string,
): Effect.Effect<boolean, SecretTransferError, MachineState> =>
  withManifestLock("remove secret", Effect.gen(function*() {
    const validName = yield* decodeSecretName(name);
    const current = yield* readManifest();
    const existing = current.secrets.find((secret) => secret.name === validName);
    if (existing === undefined) return false;
    const next = current.secrets.filter((secret) => secret.name !== validName);
    const retired = [
      ...current.retiredReferences,
      existing.reference,
    ];
    const transaction = secretTransaction(current);
    yield* transaction.publish(next, retired, "remove secret");
    return true;
  }));

export const clearTransferredSecrets = (): Effect.Effect<
  ReadonlyArray<string>,
  SecretTransferError,
  MachineState
> =>
  withManifestLock("clear transferred secrets", Effect.gen(function*() {
    const current = yield* readManifest();
    const local = current.secrets.filter((secret) => secret.origin === "local");
    const source = current.secrets.filter((secret) => secret.origin === "source");
    const retired = [
      ...current.retiredReferences,
      ...source.map((secret) => secret.reference),
    ];
    if (source.length === 0 && retired.length === 0) return [];
    const transaction = secretTransaction(current);
    yield* transaction.publish(local, retired, "clear transferred secrets");
    return source.map((secret) => secret.name);
  }));

export const loadSharedSecrets = (): Effect.Effect<
  TransferredSecrets,
  SecretTransferError,
  MachineState
> =>
  withManifestLock("load shared secrets", Effect.gen(function*() {
    yield* requireSecureStorage("load shared secrets");
    const manifest = yield* readManifest();
    yield* removeRetiredReferences(
      manifest.secrets,
      manifest.retiredReferences,
      "clean retired secrets",
    );
    const shared = manifest.secrets.filter((secret) => secret.origin === "local");
    const secrets = yield* loadSecretValues(shared, "load shared secrets");
    yield* validatePayloadBudget(secrets, "storage", "load shared secrets");
    return { schemaVersion: 1, secrets };
  }));

export const applyTransferredSecrets = (
  payload: TransferredSecrets,
): Effect.Effect<ReadonlyArray<string>, SecretTransferError, MachineState> =>
  withManifestLock("apply transferred secrets", Effect.gen(function*() {
    yield* requireSecureStorage("apply transferred secrets");
    const incoming = yield* Effect.forEach(payload.secrets, (secret) =>
      Effect.all({
        name: decodeSecretName(secret.name),
        value: decodeValue(secret.value),
      }).pipe(
        Effect.mapError(() =>
          secretError("transport", "decode shared secrets", "the source returned invalid secret data")
        ),
      ));
    yield* validateUniqueNames(
      incoming.map((secret) => secret.name),
      "decode shared secrets",
    ).pipe(
      Effect.mapError(() =>
        secretError("transport", "decode shared secrets", "the source returned invalid secret data")
      ),
    );
    yield* validatePayloadBudget(
      incoming,
      "transport",
      "decode shared secrets",
    );
    const current = yield* readManifest();
    yield* removeRetiredReferences(
      current.secrets,
      current.retiredReferences,
      "clean retired secrets",
    );
    const incomingNames = new Set(incoming.map((secret) => secret.name));
    const conflicting = current.secrets.filter((secret) =>
      secret.origin === "local" && incomingNames.has(secret.name)
    );
    if (conflicting.length > 0) {
      return yield* secretError(
        "usage",
        "apply transferred secrets",
        `source-owned secrets conflict with locally owned names: ${
          conflicting.map((secret) => secret.name).sort().join(", ")
        }. To accept the Source-owned values, deliberately remove each conflicting local entry with canonfig secrets remove <name>, then retry secrets sync.`,
      );
    }
    const preserved = current.secrets.filter((secret) => secret.origin === "local");
    const replaced = current.secrets.filter((secret) => secret.origin === "source");
    const created: SecretManifestEntry[] = [];
    const transaction = secretTransaction(current);
    for (const secret of incoming) {
      const reference = yield* transaction.store(secret.name, secret.value);
      created.push({
        name: secret.name,
        reference,
        origin: "source",
      });
    }
    const next = [...preserved, ...created];
    const retired = replaced.map((secret) => secret.reference);
    yield* transaction.publish(next, retired, "replace shared secrets");
    return created.map((secret) => secret.name);
  }));
