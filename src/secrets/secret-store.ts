import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";

import { Effect, Redacted, Schema } from "effect";

import { CredentialReference } from "../domain/brand.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";

export const SECRET_SHARE_GROUP = "canonfig:secrets";
export const maximumSharedSecrets = 128;
export const maximumSecretBytes = 16 * 1024;
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

const readManifest = (): Effect.Effect<
  SecretManifest,
  SecretTransferError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const paths = yield* secretPaths();
    if (!(yield* pathExists(paths.manifest.absolute))) {
      return { schemaVersion: 1, secrets: [] };
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
    return manifest;
  });

const writeManifest = (
  secrets: ReadonlyArray<SecretManifestEntry>,
): Effect.Effect<void, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    yield* validateUniqueNames(
      secrets.map((secret) => secret.name),
      "write secret manifest",
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
  typeof CredentialReference.Type,
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

const cleanupReferences = (
  references: ReadonlyArray<typeof CredentialReference.Type>,
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
    const machine = yield* MachineState;
    const validName = yield* decodeName(name);
    const validValue = yield* decodeValue(value);
    const current = yield* readManifest();
    const previous = current.secrets.find((secret) => secret.name === validName);
    const reference = yield* storeValue(validName, validValue);
    const next = [
      ...current.secrets.filter((secret) => secret.name !== validName),
      { name: validName, reference, origin },
    ];
    yield* writeManifest(next).pipe(
      Effect.tapError(() => cleanupReferences([reference])),
    );
    if (previous !== undefined) {
      const removed = yield* machine.removeCredential(previous.reference).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      );
      if (!removed) {
        return yield* secretError(
          "storage",
          "replace secret",
          "the secret was updated but its previous credential could not be removed",
        );
      }
    }
    return { name: validName, origin };
  });

export const removeSecret = (
  name: string,
): Effect.Effect<boolean, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const validName = yield* decodeName(name);
    const current = yield* readManifest();
    const existing = current.secrets.find((secret) => secret.name === validName);
    if (existing === undefined) return false;
    yield* writeManifest(
      current.secrets.filter((secret) => secret.name !== validName),
    );
    const removed = yield* machine.removeCredential(existing.reference).pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    );
    if (!removed) {
      return yield* secretError(
        "storage",
        "remove secret",
        "the secret was unlisted but its credential could not be removed",
      );
    }
    return true;
  });

export const loadSharedSecrets = (): Effect.Effect<
  TransferredSecrets,
  SecretTransferError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const manifest = yield* readManifest();
    const shared = manifest.secrets.filter((secret) => secret.origin === "local");
    const secrets = yield* Effect.forEach(shared, (secret) =>
      machine.loadCredential({ reference: secret.reference }).pipe(
        Effect.map((value) => ({
          name: secret.name,
          value: Redacted.value(value),
        })),
        Effect.mapError(() =>
          secretError("storage", "load shared secrets", "a shared credential is unavailable")
        ),
      ));
    return { schemaVersion: 1, secrets };
  });

export const applyTransferredSecrets = (
  payload: TransferredSecrets,
): Effect.Effect<ReadonlyArray<string>, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
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
    const current = yield* readManifest();
    const incomingNames = new Set(incoming.map((secret) => secret.name));
    const preserved = current.secrets.filter((secret) =>
      secret.origin === "local" && !incomingNames.has(secret.name)
    );
    const retired = current.secrets.filter((secret) => !preserved.includes(secret));
    const created: Array<SecretManifestEntry> = [];
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
    yield* writeManifest([...preserved, ...created]).pipe(
      Effect.tapError(() =>
        cleanupReferences(created.map((entry) => entry.reference))
      ),
    );
    let cleanupFailed = false;
    for (const secret of retired) {
      const removed = yield* machine.removeCredential(secret.reference).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      );
      cleanupFailed ||= !removed;
    }
    if (cleanupFailed) {
      return yield* secretError(
        "storage",
        "replace shared secrets",
        "shared secrets were updated but obsolete credentials could not all be removed",
      );
    }
    return created.map((secret) => secret.name);
  });
