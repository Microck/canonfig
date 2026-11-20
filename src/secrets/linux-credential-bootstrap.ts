import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { Effect, Option, Redacted, Schema } from "effect";

import { CredentialReference } from "../domain/brand.ts";
import { linuxCredentialKey, linuxSecretServiceReference, resolveLinuxSessionBus } from "../machine/linux.layer.ts";
import type {
  CredentialStorageCapability,
  MachinePath,
} from "../machine/machine-state.types.ts";
import type { MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { SecretTransferError } from "./secret-store.ts";
import { processIdentity } from "../synchronization/process-identity.ts";

/** Observe persistence across the system's next Secret Service restart. */
export type CredentialPersistenceVerdict = "verified" | "failed" | "manual";

export interface LinuxCredentialBootstrapResult {
  readonly provider: "secret-service" | "local-file";
  readonly selectedPolicy: "secure-store" | "local-file";
  readonly backupEncryption: "encrypted" | "unencrypted" | "unknown";
  readonly backupEncryptionDetail: string;
  readonly secretTool: string | undefined;
  readonly busAttempts: number;
  readonly roundTripsPassed: number;
  readonly restartPersistence: CredentialPersistenceVerdict;
  readonly logoutPersistence: CredentialPersistenceVerdict;
  readonly persistenceDetail: string;
}

export interface StoredProbe {
  readonly reference: CredentialReference;
  /** Provider lookup key, echoed so the engine never reimplements key derivation. */
  readonly key: string;
}

export interface ProviderCommandOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const SecretServiceIdentity = Schema.Struct({
  bus: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  process: Schema.NonEmptyString,
  owner: Schema.String.check(Schema.isPattern(/^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/u)),
});
type SecretServiceIdentity = typeof SecretServiceIdentity.Type;

const PersistenceProbeId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u));
const SavedProbe = { probeId: PersistenceProbeId, keyring: Schema.NonEmptyString };
const SettledEvidence = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Failed", { keyring: Schema.NonEmptyString }),
  Schema.TaggedStruct("Pending", { ...SavedProbe, provider: SecretServiceIdentity }),
  Schema.TaggedStruct("Verified", {
    provider: SecretServiceIdentity,
    keyring: Schema.NonEmptyString,
    probeId: Schema.optionalKey(PersistenceProbeId),
  }),
]);
const PersistenceEvidence = Schema.Union([
  SettledEvidence,
  Schema.TaggedStruct("Preparing", { ...SavedProbe, previous: Schema.optionalKey(SettledEvidence) }),
]);
type PersistenceEvidence = typeof PersistenceEvidence.Type;

const bootstrapProbeMaterial = (id: string) => ({
  name: `canonfig-bootstrap-probe:${id}`,
  value: Redacted.make(`canonfig-bootstrap-${id}`),
});

/** Re-derive only the disposable probe reference. A marker never selects an arbitrary credential. */
const persistenceProbeOf = (probeId: string): ProbeRecord => {
  const { name, value } = bootstrapProbeMaterial(probeId);
  const key = linuxCredentialKey(name);
  return { stored: { reference: linuxSecretServiceReference(key), key }, value };
};

const sameProvider = (left: SecretServiceIdentity, right: SecretServiceIdentity) =>
  left.bus === right.bus && left.owner === right.owner && left.process === right.process;

interface PersistenceStore {
  readonly read: Effect.Effect<PersistenceEvidence | undefined, SecretTransferError>;
  readonly write: (evidence: PersistenceEvidence) => Effect.Effect<void, SecretTransferError>;
}

const withPersistenceStore = <A>(
  machine: MachineState["Service"],
  create: boolean,
  use: (store: PersistenceStore) => Effect.Effect<A, SecretTransferError>,
) => Effect.gen(function*() {
  const home = (yield* machine.userDirectories()).home;
  const path = yield* machine.normalizePath({ path: ".canonfig/credential-persistence.json", base: home });
  const markerExists = Effect.tryPromise({
    try: async () => {
      try { await lstat(path.absolute); return true; }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    },
    catch: () => failure("the credential persistence marker could not be inspected"),
  });
  if (!create && !(yield* markerExists)) return undefined;
  if (create) {
    const folder = yield* machine.normalizePath({ path: ".canonfig", base: home });
    yield* machine.ensureDirectory({ path: folder, mode: 0o700 });
  }
  const read = Effect.gen(function*() {
    if (!(yield* markerExists)) return undefined;
    const bytes = yield* machine.readFile({ path, anchor: home, maximumBytes: 2048 });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistenceEvidence))(new TextDecoder().decode(bytes));
  }).pipe(Effect.mapError(() => failure("the credential persistence marker could not be read")));
  const write = (evidence: PersistenceEvidence) => machine.atomicWrite({
    path, anchor: home, mode: 0o600,
    content: new TextEncoder().encode(JSON.stringify(evidence) + "\n"),
  }).pipe(
    Effect.asVoid,
    Effect.mapError(() => failure("the credential persistence marker could not be saved")),
  );
  const { withSqliteWriteLock } = yield* Effect.tryPromise({
    try: () => import("../state/sqlite-write-lock.ts"),
    catch: () => failure("the credential persistence marker is unavailable"),
  });
  return yield* withSqliteWriteLock(
    `${path.absolute}.sqlite`, use({ read, write }),
    () => failure("the credential persistence marker is in use or unavailable"),
  );
}).pipe(Effect.mapError((error) => error instanceof SecretTransferError
  ? error : failure("the credential persistence marker is unavailable")));

const BusStringReply = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("s"),
  data: Schema.Tuple([Schema.String]),
}));
const BusPidReply = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("u"),
  data: Schema.Tuple([Schema.Int.check(Schema.isGreaterThan(0))]),
}));
const SecretServiceAliasReply = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("o"),
  data: Schema.Tuple([Schema.String]),
}));
const SecretServiceSearchReply = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("aoao"),
  data: Schema.Tuple([Schema.Array(Schema.String), Schema.Array(Schema.String)]),
}));

export interface LinuxCredentialBootstrapHost {
  readonly capability: () => Effect.Effect<CredentialStorageCapability, MachineStateError>;
  readonly findExecutable: (name: string) => Effect.Effect<string | undefined>;
  readonly sessionBusAddress: () => string | undefined;
  readonly providerIdentity: () => Effect.Effect<SecretServiceIdentity | undefined>;
  readonly keyringIdentity: () => Effect.Effect<string | undefined>;
  readonly persistence?: PersistenceStore | undefined;
  readonly storeProbe: (
    name: string,
    value: Redacted.Redacted<string>,
  ) => Effect.Effect<StoredProbe, SecretTransferError>;
  readonly loadProbeBytes: (
    reference: CredentialReference,
  ) => Effect.Effect<string, SecretTransferError>;
  /** Attributes reported by the provider for a lookup key, including provider-added ones. */
  readonly probeAttributes: (
    key: string,
  ) => Effect.Effect<ReadonlyMap<string, string>, SecretTransferError>;
  readonly removeProbe: (
    reference: CredentialReference,
  ) => Effect.Effect<void, SecretTransferError>;
  /** True only when the current provider explicitly reports no matching item. */
  readonly probeAbsent: (key: string) => Effect.Effect<boolean>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
  readonly randomProbeId: () => string;
}

export interface LinuxCredentialBootstrapOptions {
  readonly maxBusAttempts?: number | undefined;
  readonly busRetryDelayMilliseconds?: number | undefined;
}

const operation = "bootstrap credential store";

const failure = (message: string): SecretTransferError =>
  new SecretTransferError({ category: "storage", operation, message });

/**
 * Compare lookup attributes while tolerating provider-added metadata. Every
 * expected attribute must match exactly; extra attributes the provider added
 * (schemas, timestamps, labels) are ignored.
 */
export const lookupAttributesMatch = (
  expected: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  actual: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): boolean => {
  const expectedEntries = expected instanceof Map
    ? expected.entries()
    : Object.entries(expected);
  const actualEntries = actual instanceof Map ? actual.entries() : Object.entries(actual);
  const actualMap = new Map(actualEntries);
  for (const [key, value] of expectedEntries) {
    if (actualMap.get(key) !== value) return false;
  }
  return true;
};

const secretToolPackages =
  "install the Secret Service client (Debian and Ubuntu: libsecret-tools; Fedora and RHEL: libsecret; Arch: libsecret)";

// dbus-run-session is not a remedy: its private bus activates a second,
// empty keyring that needs a graphical prompter and never reaches the login
// keyring, so nothing stored there helps a later run.
const busRecovery =
  "Run canonfig with your user session bus: set XDG_RUNTIME_DIR=/run/user/$(id -u) (canonfig then uses $XDG_RUNTIME_DIR/bus) or DBUS_SESSION_BUS_ADDRESS. If that socket does not exist, keep the systemd user manager running without a login session with `sudo loginctl enable-linger $USER`. Do not use dbus-run-session: its private bus cannot reach the login keyring.";

const lockRecovery =
  "Start and unlock a Secret Service provider for this user session, then retry.";

interface BusWait {
  readonly attempts: number;
}

interface ProbeRecord {
  readonly stored: StoredProbe;
  readonly value: Redacted.Redacted<string>;
}

const storeBootstrapProbe = (
  host: LinuxCredentialBootstrapHost,
  probeId: string,
): Effect.Effect<ProbeRecord, SecretTransferError> => {
  const { name, value } = bootstrapProbeMaterial(probeId);
  return host.storeProbe(name, value).pipe(
    Effect.map((stored) => ({ stored, value })),
  );
};

const verifyBootstrapProbe = (
  host: LinuxCredentialBootstrapHost,
  probe: ProbeRecord,
  checkAttributes: boolean,
): Effect.Effect<void, SecretTransferError> =>
  Effect.gen(function*() {
    if (checkAttributes) {
      const attributes = yield* host.probeAttributes(probe.stored.key);
      if (!lookupAttributesMatch(
        new Map([["canonfig-key", probe.stored.key]]),
        attributes,
      )) {
        return yield* failure("the provider did not return the stored credential attributes");
      }
    }
    const bytes = yield* host.loadProbeBytes(probe.stored.reference);
    // Byte-exact: a provider that changes even a trailing newline fails.
    if (Redacted.value(probe.value) !== bytes) {
      return yield* failure("the provider did not return the stored credential bytes");
    }
  });

const pendingPersistenceDetail = "Run canonfig doctor after a natural Secret Service restart or next login to verify the saved test credential.";
const unfinishedProbeDetail = "Canonfig could not remove an interrupted test credential. Unlock the same login keyring, then run canonfig doctor.";
const restartLossDetail = "The saved test credential did not survive the Secret Service restart.";
const retryAfterLossDetail = `${restartLossDetail} Check the provider’s persistence settings, then run canonfig secrets bootstrap again.`;
const restartConfirmedDetail = "The saved test credential survived a Secret Service process restart.";

const wrongKeyringDetail = "The saved test credential belongs to a different or unavailable session keyring. Use the original session and its default collection, then run canonfig doctor.";

const removeSavedProbe = (host: LinuxCredentialBootstrapHost, probeId: string, keyring: string) =>
  Effect.gen(function*() {
    if ((yield* host.keyringIdentity()) !== keyring) return false;
    const { stored } = persistenceProbeOf(probeId);
    const removed = yield* host.removeProbe(stored.reference).pipe(Effect.result);
    const absent = removed._tag === "Success" || (yield* host.probeAbsent(stored.key));
    return absent && (yield* host.keyringIdentity()) === keyring;
  });

const hasUnfinishedProbe = (evidence: PersistenceEvidence): boolean =>
  evidence._tag === "Preparing" || evidence._tag === "Pending"
  || evidence._tag === "Verified" && evidence.probeId !== undefined;

export const resumeLinuxCredentialPersistence = (host: LinuxCredentialBootstrapHost, store: PersistenceStore) =>
  Effect.gen(function*() {
    let evidence = yield* store.read;
    if (evidence === undefined || evidence._tag === "Idle") return undefined;
    if ((yield* host.keyringIdentity()) !== evidence.keyring) {
      return hasUnfinishedProbe(evidence) ? { verdict: "manual" as const, detail: wrongKeyringDetail } : undefined;
    }
    if (evidence._tag === "Preparing") {
      if (!(yield* removeSavedProbe(host, evidence.probeId, evidence.keyring))) {
        return { verdict: "manual" as const, detail: unfinishedProbeDetail };
      }
      evidence = evidence.previous ?? { _tag: "Idle" };
      yield* store.write(evidence);
    }
    if (evidence._tag === "Idle") return undefined;
    if (evidence._tag === "Failed") return { verdict: "failed" as const, detail: retryAfterLossDetail };
    let verifiedEvidence;
    if (evidence._tag === "Pending") {
      const provider = yield* host.providerIdentity();
      if (provider === undefined || provider.process === evidence.provider.process) {
        return { verdict: "manual" as const, detail: pendingPersistenceDetail };
      }
      const probe = persistenceProbeOf(evidence.probeId);
      const verified = yield* verifyBootstrapProbe(host, probe, true).pipe(Effect.result);
      const absent = verified._tag === "Failure" && (yield* host.probeAbsent(probe.stored.key));
      const after = yield* host.providerIdentity();
      const stable = after !== undefined && sameProvider(provider, after)
        && (yield* host.keyringIdentity()) === evidence.keyring;
      if (absent && stable) {
        yield* store.write({ _tag: "Failed", keyring: evidence.keyring });
        return { verdict: "failed" as const, detail: retryAfterLossDetail };
      }
      if (verified._tag === "Failure" || !stable) {
        return { verdict: "manual" as const, detail: "The provider restarted but the saved test credential could not be verified. Unlock the same login keyring, then run canonfig doctor." };
      }
      verifiedEvidence = { _tag: "Verified", provider, keyring: evidence.keyring, probeId: evidence.probeId } as const;
      yield* store.write(verifiedEvidence);
    } else {
      verifiedEvidence = evidence;
    }
    const { probeId, provider, keyring } = verifiedEvidence;
    if (probeId !== undefined && (yield* removeSavedProbe(host, probeId, keyring))) {
      yield* store.write({ _tag: "Verified", provider, keyring });
    }
    return { verdict: "verified" as const, detail: restartConfirmedDetail };
  });

const roundTrip = (
  host: LinuxCredentialBootstrapHost,
  probeId: string,
  checkAttributes: boolean,
): Effect.Effect<void, SecretTransferError> =>
  Effect.gen(function*() {
    const probe = yield* storeBootstrapProbe(host, probeId);
    yield* Effect.ensuring(
      verifyBootstrapProbe(host, probe, checkAttributes),
      host.removeProbe(probe.stored.reference).pipe(Effect.ignore),
    );
  });

const retryProbe = <A>(
  host: LinuxCredentialBootstrapHost,
  options: LinuxCredentialBootstrapOptions,
  attemptProbe: (attempt: number) => Effect.Effect<A, SecretTransferError>,
  exhaustedMessage: string,
): Effect.Effect<BusWait & { readonly value: A }, SecretTransferError> => {
  const maximum = options.maxBusAttempts ?? 30;
  const delay = options.busRetryDelayMilliseconds ?? 1000;
  const attempt = (
    number: number,
  ): Effect.Effect<BusWait & { readonly value: A }, SecretTransferError> =>
    attemptProbe(number).pipe(
      Effect.map((value) => ({ attempts: number, value })),
      Effect.catch(() =>
        number >= maximum
          ? Effect.fail(failure(exhaustedMessage))
          : host.sleep(delay).pipe(Effect.flatMap(() => attempt(number + 1)))
      ),
    );
  return attempt(1);
};

const waitForRoundTrip = (
  host: LinuxCredentialBootstrapHost,
  options: LinuxCredentialBootstrapOptions,
): Effect.Effect<BusWait, SecretTransferError> =>
  retryProbe(
    host,
    options,
    (attempt) => roundTrip(host, `${host.randomProbeId()}-${attempt}`, true),
    host.sessionBusAddress() === undefined
      ? `the Secret Service bus is not ready. ${busRecovery} ${lockRecovery}`
      : `the Secret Service bus is not ready. ${lockRecovery}`,
  );

const localFileBootstrap = (
  host: LinuxCredentialBootstrapHost,
  path: MachinePath,
): Effect.Effect<LinuxCredentialBootstrapResult, SecretTransferError> =>
  Effect.gen(function*() {
    const probeId = host.randomProbeId();
    yield* roundTrip(host, probeId, false);
    return {
      provider: "local-file",
      selectedPolicy: "local-file",
      backupEncryption: "unencrypted",
      backupEncryptionDetail:
        `the local-file policy stores plaintext bytes under ${path.absolute} with owner-only permissions. ` +
        "Encrypt the volume or select the secure-store policy for encrypted backups.",
      secretTool: undefined,
      busAttempts: 0,
      roundTripsPassed: 1,
      restartPersistence: "verified",
      logoutPersistence: "verified",
      persistenceDetail:
        "file-backed credentials persist across provider restarts, logout, and reboot by construction; " +
        "no provider process is involved.",
    } satisfies LinuxCredentialBootstrapResult;
  });

const secretServiceBootstrap = (
  host: LinuxCredentialBootstrapHost,
  options: LinuxCredentialBootstrapOptions,
): Effect.Effect<LinuxCredentialBootstrapResult, SecretTransferError> =>
  Effect.gen(function*() {
    const secretTool = yield* host.findExecutable("secret-tool");
    if (secretTool === undefined) {
      return yield* failure(`secret-tool is not on PATH. ${secretToolPackages}.`);
    }
    const store = host.persistence;
    if (store !== undefined && (yield* host.findExecutable("busctl")) === undefined) {
      return yield* failure("busctl is required to identify and recover the Secret Service test credential. Install the systemd D-Bus tool and retry.");
    }
    const previous = store === undefined ? undefined : yield* resumeLinuxCredentialPersistence(host, store);
    let busAttempts = 0;
    let roundTripsPassed = 0;
    let restartPersistence: CredentialPersistenceVerdict = previous?.verdict ?? "manual";
    let detail = previous?.detail
      ?? "Canonfig could not observe the Secret Service process. Make busctl available and run credential bootstrap to record the baseline.";
    if (store !== undefined) {
      let evidence = yield* store.read;
      const collectionError = `the default Secret Service collection could not be identified. ${lockRecovery}`;
      const collection = yield* retryProbe(host, options, () => host.keyringIdentity().pipe(
        Effect.flatMap((keyring) => keyring === undefined ? Effect.fail(failure(collectionError)) : Effect.succeed(keyring)),
      ), collectionError);
      const keyring = collection.value;
      if (evidence !== undefined && evidence._tag !== "Idle" && evidence.keyring !== keyring) {
        if (hasUnfinishedProbe(evidence)) return yield* failure(wrongKeyringDetail);
        evidence = undefined;
      }
      if (evidence?._tag === "Preparing") return yield* failure(unfinishedProbeDetail);
      const probeId = randomUUID();
      // Store can trigger normal D-Bus activation. Journal the same probe
      // before the first write, even when its provider cannot yet be identified.
      yield* store.write(evidence === undefined
        ? { _tag: "Preparing", probeId, keyring }
        : { _tag: "Preparing", probeId, keyring, previous: evidence });
      const needsBaseline = evidence === undefined || evidence._tag === "Idle" || evidence._tag === "Failed";
      let baseline: SecretServiceIdentity | undefined;
      const readiness = yield* retryProbe(host, options, () => Effect.gen(function*() {
        if ((yield* host.keyringIdentity()) !== keyring) return yield* failure(wrongKeyringDetail);
        const probe = yield* storeBootstrapProbe(host, probeId);
        const before = needsBaseline ? yield* host.providerIdentity() : undefined;
        yield* verifyBootstrapProbe(host, probe, true);
        const after = before === undefined ? undefined : yield* host.providerIdentity();
        if ((yield* host.keyringIdentity()) !== keyring) return yield* failure(wrongKeyringDetail);
        if (before !== undefined && after !== undefined && sameProvider(before, after)) baseline = before;
      }), `the Secret Service bus is not ready. ${lockRecovery}`);
      busAttempts = collection.attempts + readiness.attempts - 1;
      roundTripsPassed = 1;
      if (baseline !== undefined) {
        yield* store.write({ _tag: "Pending", provider: baseline, probeId, keyring });
        restartPersistence = "manual";
        detail = previous?.verdict === "failed"
          ? `${restartLossDetail} A new test credential is saved. ${pendingPersistenceDetail}`
          : pendingPersistenceDetail;
      } else if (yield* removeSavedProbe(host, probeId, keyring)) {
        yield* store.write(evidence ?? { _tag: "Idle" });
      } else {
        detail = unfinishedProbeDetail;
      }
    } else {
      busAttempts = (yield* waitForRoundTrip(host, options)).attempts;
      roundTripsPassed = 1;
    }
    return {
      provider: "secret-service",
      selectedPolicy: "secure-store",
      backupEncryption: "unknown",
      backupEncryptionDetail:
        "backup encryption depends on the provider collection, which Canonfig cannot inspect "
        + "without reading secrets. A login keyring is encrypted at rest and unlocks at login; "
        + "a session collection may be memory-only.",
      secretTool,
      busAttempts,
      roundTripsPassed,
      restartPersistence,
      logoutPersistence: "manual",
      persistenceDetail: detail,
    } satisfies LinuxCredentialBootstrapResult;
  });

/**
 * Run the headless Linux credential bootstrap against the injected host.
 * Storage selection is explicit: the host capability decides between the
 * secure-store and local-file policies, and the completion result records
 * the selected policy alongside accurate backup-encryption and persistence
 * evidence. No secret value reaches the result, errors, or logs.
 */
export const runLinuxCredentialBootstrap = (
  host: LinuxCredentialBootstrapHost,
  options: LinuxCredentialBootstrapOptions = {},
): Effect.Effect<LinuxCredentialBootstrapResult, SecretTransferError> =>
  Effect.gen(function*() {
    const capability = yield* host.capability().pipe(
      Effect.mapError(() =>
        failure("the platform credential-store capability could not be determined")
      ),
    );
    if (capability.kind === "local-file") {
      return yield* localFileBootstrap(host, capability.path);
    }
    if (capability.kind === "unavailable") {
      if (host.sessionBusAddress() === undefined) {
        return yield* failure(`the Secret Service bus is unavailable. ${capability.recovery}`);
      }
      return yield* secretServiceBootstrap(host, options);
    }
    if (capability.provider !== "secret-service") {
      return yield* failure(
        "this bootstrap supports the Secret Service provider and the local-file policy; " +
        `the platform reported ${capability.provider}.`,
      );
    }
    return yield* secretServiceBootstrap(host, options);
  });

const searchAttributePattern =
  /^\s*(?:attribute\.)?([^=\s][^=]*?)\s*=\s*(.*?)\s*$/u;

/** Parse bounded `secret-tool search` output without retaining secret text. */
export const parseSearchAttributes = (output: string): ReadonlyMap<string, string> => {
  const attributes = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = searchAttributePattern.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      attributes.set(match[1], match[2]);
    }
  }
  return attributes;
};

/**
 * Adapt a live MachineState service to the bootstrap host. Command output is
 * bounded and secret-bearing stdout stays in memory; only exit codes and step
 * names reach errors.
 */
// A single Unix endpoint remains the same when D-Bus republishes it with
// a guid. For opaque transports or address lists, query the serving bus.
const unixSessionEndpoint = (address: string): string | undefined => {
  const endpoint = /^unix:([^;]+)$/u.exec(address)?.[1];
  if (endpoint === undefined) return undefined;
  const fields = endpoint.split(",").filter((field) => !field.startsWith("guid="));
  if (fields.length !== 1 || !/^(?:path=(?:\/|%2f).*|abstract=.+)$/iu.test(fields[0]!)) return undefined;
  return `unix:${fields[0]!.replace(/%[0-9a-f]{2}/giu, (byte) => byte.toUpperCase())}`;
};

const machineStateBootstrapHost = (
  machine: MachineState["Service"],
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): LinuxCredentialBootstrapHost => {
  const findExecutable = (name: string): Effect.Effect<string | undefined> =>
    machine.findExecutable({ name }).pipe(
      Effect.map((found) => found.path.absolute),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  const runCommand = (
    executable: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ProviderCommandOutput, SecretTransferError> =>
    machine.normalizePath({ path: executable }).pipe(
      Effect.flatMap((path) =>
        machine.runProcess({
          executable: path,
          arguments: [...args],
          environment,
          timeoutMilliseconds: 15_000,
          maximumOutputBytes: 1024 * 1024,
        })
      ),
      Effect.map((result) => ({
        exitCode: result.exitCode,
        stdout: new TextDecoder().decode(result.standardOutput),
        stderr: new TextDecoder().decode(result.standardError),
      })),
      Effect.mapError(() => failure("a credential provider command could not run")),
    );
  const sessionBusAddress = () =>
    environment.find((entry) => entry.name === "DBUS_SESSION_BUS_ADDRESS")?.value;
  const openBus = Effect.gen(function*() {
    const address = sessionBusAddress();
    if (address === undefined) return undefined;
    const busctl = yield* findExecutable("busctl");
    if (busctl === undefined) return undefined;
    return <A>(
      method: string,
      args: ReadonlyArray<string>,
      schema: Schema.Decoder<{ readonly data: A }>,
      destination = "org.freedesktop.DBus",
      object = "/org/freedesktop/DBus",
      interfaceName = "org.freedesktop.DBus",
    ) => runCommand(busctl, [
      `--address=${address}`, "--json=short", "call",
      destination, object, interfaceName, method, ...args,
    ]).pipe(
      Effect.map((reply) => reply.exitCode === 0
        ? Schema.decodeUnknownOption(schema)(reply.stdout).pipe(Option.getOrUndefined)?.data
        : undefined),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  });
  const providerIdentity = () => Effect.gen(function*() {
    const busCall = yield* openBus;
    if (busCall === undefined) return undefined;
    // Bind the bus and its unique owner to the OS process birth identity.
    // A reconnect by the same process is not proof of persistence.
    const [bus] = (yield* busCall("GetId", [], BusStringReply)) ?? [];
    const [owner] = (yield* busCall("GetNameOwner", ["s", "org.freedesktop.secrets"], BusStringReply)) ?? [];
    if (bus === undefined || owner === undefined) return undefined;
    const [pid] = (yield* busCall("GetConnectionUnixProcessID", ["s", owner], BusPidReply)) ?? [];
    if (pid === undefined) return undefined;
    const birth = yield* Effect.promise(() => processIdentity(pid));
    if (birth === undefined) return undefined;
    const [currentOwner] = (yield* busCall("GetNameOwner", ["s", "org.freedesktop.secrets"], BusStringReply)) ?? [];
    const [currentBus] = (yield* busCall("GetId", [], BusStringReply)) ?? [];
    if (owner !== currentOwner || bus !== currentBus) return undefined;
    return Option.getOrUndefined(Schema.decodeUnknownOption(SecretServiceIdentity)({
      bus, owner, process: `${pid}:${birth}`,
    }));
  });
  return {
    capability: () => machine.credentialCapability(),
    findExecutable,
    sessionBusAddress,
    providerIdentity,
    keyringIdentity: () => Effect.gen(function*() {
      const address = sessionBusAddress();
      const busCall = yield* openBus;
      if (address === undefined || busCall === undefined) return undefined;
      // ReadAlias can activate Secret Service without storing anything.
      const localEndpoint = unixSessionEndpoint(address);
      const endpoint = localEndpoint ?? (yield* busCall("GetId", [], BusStringReply))?.[0];
      if (endpoint === undefined) return undefined;
      const [collection] = (yield* busCall("ReadAlias", ["s", "default"], SecretServiceAliasReply,
        "org.freedesktop.secrets", "/org/freedesktop/secrets", "org.freedesktop.Secret.Service")) ?? [];
      if (collection === undefined || collection === "/") return undefined;
      if (localEndpoint === undefined && endpoint !== (yield* busCall("GetId", [], BusStringReply))?.[0]) return undefined;
      return linuxCredentialKey(endpoint + "\0" + collection);
    }),
    storeProbe: (name, value) =>
      machine.storeCredential({ name, value }).pipe(
        Effect.map((reference) => ({
          reference,
          key: String(reference).split(":").slice(1).join(":"),
        })),
        Effect.mapError(() => failure("the bootstrap probe could not be stored")),
      ),
    loadProbeBytes: (reference) =>
      machine.loadCredential({ reference }).pipe(
        Effect.map((loaded) => Redacted.value(loaded)),
        Effect.mapError(() => failure("the bootstrap probe could not be loaded")),
      ),
    probeAttributes: (key) =>
      findExecutable("secret-tool").pipe(
        Effect.flatMap((secretTool) =>
          secretTool === undefined
            ? Effect.fail(failure(`secret-tool is not on PATH. ${secretToolPackages}.`))
            : runCommand(secretTool, ["search", "canonfig-key", key]).pipe(
              Effect.flatMap((search) =>
                search.exitCode === 0
                  ? Effect.succeed(
                    parseSearchAttributes(`${search.stdout}\n${search.stderr}`),
                  )
                  : Effect.fail(failure("the provider did not answer the attribute search"))
              ),
            )
        ),
      ),
    removeProbe: (reference) =>
      machine.removeCredential(reference).pipe(
        Effect.mapError(() => failure("the bootstrap probe could not be removed")),
      ),
    probeAbsent: (key) => Effect.gen(function*() {
      const current = yield* providerIdentity();
      if (current === undefined) return false;
      const busCall = yield* openBus;
      if (busCall === undefined) return false;
      const reply = yield* busCall("SearchItems", ["a{ss}", "1", "canonfig-key", key], SecretServiceSearchReply,
        current.owner, "/org/freedesktop/secrets", "org.freedesktop.Secret.Service");
      if (reply === undefined || reply.some((items) => items.length > 0)) return false;
      const after = yield* providerIdentity();
      return after !== undefined && sameProvider(current, after);
    }),
    sleep: (milliseconds) => Effect.sleep(`${milliseconds} millis`),
    randomProbeId: () =>
      `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`,
  };
};

// Bind bootstrap and doctor to the same bus MachineState resolves, including
// the XDG runtime session-socket fallback.
const sessionBusEnvironment = () => {
  const bus = resolveLinuxSessionBus();
  return bus.kind === "missing" ? [] : [{ name: "DBUS_SESSION_BUS_ADDRESS", value: bus.address }];
};

export const bootstrapMachineCredentialStore = (machine: MachineState["Service"]) =>
  withPersistenceStore(machine, true, (persistence) =>
    runLinuxCredentialBootstrap({ ...machineStateBootstrapHost(machine, sessionBusEnvironment()), persistence }),
  ).pipe(Effect.flatMap((result) => result === undefined
    ? Effect.fail(failure("the credential persistence marker is unavailable"))
    : Effect.succeed(result)));

export const resumeMachineCredentialPersistence = (machine: MachineState["Service"]) =>
  withPersistenceStore(machine, false, (store) =>
    resumeLinuxCredentialPersistence(machineStateBootstrapHost(machine, sessionBusEnvironment()), store),
  );
