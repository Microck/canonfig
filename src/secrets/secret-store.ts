import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";

import { Effect, Redacted, Schema } from "effect";

import { CredentialReference } from "../domain/brand.ts";
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
  retiredReferences: Schema.optional(Schema.Array(CredentialReference)),
});

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

export class SecretTransferError extends Schema.TaggedError<SecretTransferError>()(
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
}

export const requireSecureStorage = (
  operation: string,
): Effect.Effect<void, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const capability = yield* machine.credentialCapability().pipe(
      Effect.mapError(() =>
        secretError(
          "storage",
          operation,
          "the platform credential-store capability could not be determined",
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
    return { directory, manifest };
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
      catch: () =>
        secretError("state", "read secret manifest", "the secret manifest is invalid"),
    });
    yield* validateUniqueNames(
      manifest.secrets.map((secret) => secret.name),
      "read secret manifest",
    ).pipe(
      Effect.mapError(() =>
        secretError("state", "read secret manifest", "the secret manifest is invalid")
      ),
    );
    return {
      ...manifest,
      retiredReferences: uniqueReferences(manifest.retiredReferences ?? []),
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
    const manifest: SecretManifest = retired.length === 0
      ? {
        schemaVersion: 1,
        secrets: [...secrets].sort((left, right) => left.name.localeCompare(right.name)),
      }
      : {
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
      Effect.mapError(() =>
        secretError("storage", "write secret manifest", "the secret manifest cannot be written safely")
      ),
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
    for (const reference of pending) {
      const removed = yield* machine.removeCredential(reference).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      );
      if (!removed) failed.push(reference);
    }
    yield* writeManifest(secrets, failed);
    if (failed.length > 0) {
      return yield* secretError(
        "storage",
        operation,
        "obsolete secret credentials remain queued for automatic removal",
      );
    }
  });

const decodeName = (
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
  name: string,
  value: string,
): Effect.Effect<
  CredentialReferenceValue,
  SecretTransferError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.storeCredential({
      name: `canonfig-shared-secret:${name}:${randomUUID()}`,
      value: Redacted.make(value),
    }).pipe(
      Effect.mapError(() =>
        secretError("storage", "store secret", "secure credential storage is unavailable")
      ),
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
        Effect.mapError(() =>
          secretError("storage", operation, "a shared credential is unavailable")
        ),
      ));
  });

const cleanupReferences = (
  references: ReadonlyArray<CredentialReferenceValue>,
): Effect.Effect<void, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    yield* Effect.forEach(
      references,
      (reference) => machine.removeCredential(reference).pipe(Effect.ignore),
      { discard: true },
    );
  });

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

export const storeSecret = (
  name: string,
  value: string,
  origin: SecretOrigin = "local",
): Effect.Effect<SharedSecretSummary, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    yield* requireSecureStorage("store secret");
    const validName = yield* decodeName(name);
    const validValue = yield* decodeValue(value);
    const current = yield* readManifest();
    const previous = current.secrets.find((secret) => secret.name === validName);
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
    const reference = yield* storeValue(validName, validValue);
    const next = [
      ...current.secrets.filter((secret) => secret.name !== validName),
      { name: validName, reference, origin },
    ];
    const retired = [
      ...(current.retiredReferences ?? []),
      ...(previous === undefined ? [] : [previous.reference]),
    ];
    yield* writeManifest(next, retired).pipe(
      Effect.tapError(() => cleanupReferences([reference])),
    );
    yield* removeRetiredReferences(next, retired, "replace secret");
    return { name: validName, origin };
  });

export const removeSecret = (
  name: string,
): Effect.Effect<boolean, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const validName = yield* decodeName(name);
    const current = yield* readManifest();
    const existing = current.secrets.find((secret) => secret.name === validName);
    if (existing === undefined) return false;
    const next = current.secrets.filter((secret) => secret.name !== validName);
    const retired = [
      ...(current.retiredReferences ?? []),
      existing.reference,
    ];
    yield* writeManifest(next, retired);
    yield* removeRetiredReferences(next, retired, "remove secret");
    return true;
  });

export const clearTransferredSecrets = (): Effect.Effect<
  ReadonlyArray<string>,
  SecretTransferError,
  MachineState
> =>
  Effect.gen(function*() {
    const current = yield* readManifest();
    const local = current.secrets.filter((secret) => secret.origin === "local");
    const source = current.secrets.filter((secret) => secret.origin === "source");
    const retired = [
      ...(current.retiredReferences ?? []),
      ...source.map((secret) => secret.reference),
    ];
    if (source.length === 0 && retired.length === 0) return [];
    yield* writeManifest(local, retired);
    yield* removeRetiredReferences(
      local,
      retired,
      "clear transferred secrets",
    );
    return source.map((secret) => secret.name);
  });

export const loadSharedSecrets = (): Effect.Effect<
  TransferredSecrets,
  SecretTransferError,
  MachineState
> =>
  Effect.gen(function*() {
    yield* requireSecureStorage("load shared secrets");
    const manifest = yield* readManifest();
    yield* removeRetiredReferences(
      manifest.secrets,
      manifest.retiredReferences ?? [],
      "clean retired secrets",
    );
    const shared = manifest.secrets.filter((secret) => secret.origin === "local");
    const secrets = yield* loadSecretValues(shared, "load shared secrets");
    yield* validatePayloadBudget(secrets, "storage", "load shared secrets");
    return { schemaVersion: 1, secrets };
  });

export const applyTransferredSecrets = (
  payload: TransferredSecrets,
): Effect.Effect<ReadonlyArray<string>, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    yield* requireSecureStorage("apply transferred secrets");
    const incoming = yield* Effect.forEach(payload.secrets, (secret) =>
      Effect.all({
        name: decodeName(secret.name),
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
      current.retiredReferences ?? [],
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
        }`,
      );
    }
    const preserved = current.secrets.filter((secret) => secret.origin === "local");
    const replaced = current.secrets.filter((secret) => secret.origin === "source");
    const created: SecretManifestEntry[] = [];
    for (const secret of incoming) {
      const reference = yield* storeValue(secret.name, secret.value).pipe(
        Effect.tapError(() =>
          cleanupReferences(created.map((entry) => entry.reference))
        ),
      );
      created.push({
        name: secret.name,
        reference,
        origin: "source",
      });
    }
    const next = [...preserved, ...created];
    const retired = replaced.map((secret) => secret.reference);
    yield* writeManifest(next, retired).pipe(
      Effect.tapError(() =>
        cleanupReferences(created.map((entry) => entry.reference))
      ),
    );
    yield* removeRetiredReferences(next, retired, "replace shared secrets");
    return created.map((secret) => secret.name);
  });
