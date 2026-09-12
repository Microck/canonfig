import { Effect, Redacted } from "effect";

import type { CredentialReference } from "../domain/brand.ts";
import type {
  CredentialStorageCapability,
  MachinePath,
} from "../machine/machine-state.types.ts";
import type { MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { SecretTransferError } from "./secret-store.ts";

/**
 * Headless Linux credential bootstrap.
 *
 * The engine verifies the native Secret Service provider end to end without
 * ever printing a secret: package presence, D-Bus readiness with bounded
 * polling (so delayed bus registration is tolerated), a disposable round trip
 * whose attributes and bytes are compared tolerantly, and persistence across
 * a provider recycle. Every scenario runs against the injected host, which is
 * what makes cold start, existing provider, delayed registration, and restart
 * deterministic in tests.
 *
 * The production host never restarts a provider it did not start: replacing
 * another daemon can relock its collections. Restart and logout persistence
 * therefore report "manual" with rerun guidance unless the host attests an
 * actual recycle. Re-running after a restart or reboot takes the
 * existing-provider path and re-verifies.
 */

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

export interface LinuxCredentialBootstrapHost {
  readonly capability: () => Effect.Effect<CredentialStorageCapability, MachineStateError>;
  readonly findExecutable: (name: string) => Effect.Effect<string | undefined>;
  readonly runCommand: (
    executable: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ProviderCommandOutput, SecretTransferError>;
  readonly sessionBusAddress: () => string | undefined;
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
  /**
   * Recycle the provider when the host owns it. The production host returns
   * recycled false: it must not replace a daemon another session started.
   */
  readonly recycleProvider: () => Effect.Effect<{ readonly recycled: boolean }, SecretTransferError>;
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
 * Compare secret bytes while tolerating provider framing. Providers append a
 * trailing newline to lookup output; that framing is stripped before the
 * comparison. Anything else, including leading whitespace or an interior
 * newline difference, still fails.
 */
export const secretBytesEqual = (expected: string, actual: string): boolean =>
  expected === actual || expected === actual.replace(/(\r\n|\n|\r)+$/u, "");

/**
 * Compare lookup attributes while tolerating provider-added metadata. Every
 * expected attribute must match exactly; extra attributes the provider added
 * (schemas, timestamps, labels) are ignored.
 */
export const lookupAttributesMatch = (
  expected: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  actual: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): boolean => {
  const expectedEntries = expected instanceof Map ? expected.entries() : Object.entries(expected);
  const read = (key: string): string | undefined =>
    actual instanceof Map ? actual.get(key) : actual[key];
  for (const [key, value] of expectedEntries) {
    if (read(key) !== value) return false;
  }
  return true;
};

const secretToolPackages =
  "install the Secret Service client (Debian and Ubuntu: libsecret-tools; Fedora and RHEL: libsecret; Arch: libsecret)";

const providerPackages =
  "install and enable a Secret Service provider (for example gnome-keyring with its daemon enabled for the user session)";

const busRecovery =
  "Run inside a user D-Bus session (an existing graphical or ssh login session, dbus-run-session, or a systemd --user service), then retry.";

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
  const value = Redacted.make(`canonfig-bootstrap-${probeId}`);
  return host.storeProbe(`canonfig-bootstrap-probe:${probeId}`, value).pipe(
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
    if (!secretBytesEqual(Redacted.value(probe.value), bytes)) {
      return yield* failure("the provider did not return the stored credential bytes");
    }
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

const retryProbe = (
  host: LinuxCredentialBootstrapHost,
  options: LinuxCredentialBootstrapOptions,
  attemptProbe: (attempt: number) => Effect.Effect<void, SecretTransferError>,
  exhaustedMessage: string,
): Effect.Effect<BusWait, SecretTransferError> => {
  const maximum = options.maxBusAttempts ?? 30;
  const delay = options.busRetryDelayMilliseconds ?? 1000;
  const attempt = (
    number: number,
  ): Effect.Effect<BusWait, SecretTransferError> =>
    attemptProbe(number).pipe(
      Effect.as({ attempts: number }),
      Effect.catchAll(() =>
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

const waitForStoredProbe = (
  host: LinuxCredentialBootstrapHost,
  probe: ProbeRecord,
  options: LinuxCredentialBootstrapOptions,
): Effect.Effect<BusWait, SecretTransferError> =>
  retryProbe(
    host,
    options,
    () => verifyBootstrapProbe(host, probe, true),
    "the credential did not survive the provider restart",
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
  startProvider: boolean,
): Effect.Effect<LinuxCredentialBootstrapResult, SecretTransferError> =>
  Effect.gen(function*() {
    const secretTool = yield* host.findExecutable("secret-tool");
    if (secretTool === undefined) {
      return yield* failure(`secret-tool is not on PATH. ${secretToolPackages}.`);
    }
    const initialRoundTrip = yield* roundTrip(
      host,
      host.randomProbeId(),
      true,
    ).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    );
    let bus: BusWait;
    if (initialRoundTrip) {
      bus = { attempts: 1 };
    } else {
      if (!startProvider) {
        return yield* failure(`the Secret Service provider is unavailable. ${lockRecovery}`);
      }
      const daemon = yield* host.findExecutable("gnome-keyring-daemon");
      if (daemon === undefined) {
        return yield* failure(
          `no Secret Service provider answered and no provider starter is installed. ${providerPackages}. ${lockRecovery}`,
        );
      }
      const started = yield* host.runCommand(daemon, ["--start", "--components=secrets"]);
      if (started.exitCode !== 0) {
        return yield* failure(
          `the credential provider did not start. ${providerPackages}. ${lockRecovery}`,
        );
      }
      bus = yield* waitForRoundTrip(host, options);
    }
    const persistenceProbe = yield* storeBootstrapProbe(host, host.randomProbeId());
    const persistence = yield* Effect.ensuring(
      Effect.gen(function*() {
        yield* verifyBootstrapProbe(host, persistenceProbe, true);
        const recycle = yield* host.recycleProvider();
        if (!recycle.recycled) {
          return {
            verdict: "manual" as const,
            attempts: 0,
          };
        }
        return yield* waitForStoredProbe(host, persistenceProbe, options).pipe(
          Effect.map((second) => ({
            verdict: "verified" as const,
            attempts: second.attempts,
          })),
          Effect.catchAll(() =>
            Effect.succeed({
              verdict: "failed" as const,
              attempts: options.maxBusAttempts ?? 30,
            })
          ),
        );
      }),
      host.removeProbe(persistenceProbe.stored.reference).pipe(Effect.ignore),
    );
    const manual = persistence.verdict === "manual";
    return {
      provider: "secret-service",
      selectedPolicy: "secure-store",
      backupEncryption: "unknown",
      backupEncryptionDetail:
        "backup encryption depends on the provider collection, which Canonfig cannot inspect " +
        "without reading secrets. A login keyring is encrypted at rest and unlocks at login; " +
        "a session collection may be memory-only.",
      secretTool,
      busAttempts: bus.attempts + persistence.attempts,
      roundTripsPassed: persistence.verdict === "failed" ? 1 : 2,
      restartPersistence: persistence.verdict,
      logoutPersistence: "manual",
      persistenceDetail: manual
        ? "Canonfig did not recycle the provider it found. Restart the provider (or reboot), " +
          "then rerun this command: the existing-provider path re-verifies stored credentials."
        : "logout and reboot persistence depend on the provider collection. Reboot (or log out and " +
          "back in), then rerun this command: the existing-provider path re-verifies stored credentials.",
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
        return yield* failure(`the Secret Service bus is unavailable. ${busRecovery}`);
      }
      return yield* secretServiceBootstrap(host, options, true);
    }
    if (capability.provider !== "secret-service") {
      return yield* failure(
        "this bootstrap supports the Secret Service provider and the local-file policy; " +
        `the platform reported ${capability.provider}.`,
      );
    }
    return yield* secretServiceBootstrap(host, options, true);
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
export const machineStateBootstrapHost = (
  machine: MachineState["Service"],
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): LinuxCredentialBootstrapHost => {
  let ownedProviderPid: number | undefined;
  let ownedProviderExecutable: string | undefined;
  const findExecutable = (name: string): Effect.Effect<string | undefined> =>
    machine.findExecutable({ name }).pipe(
      Effect.map((found) => found.path.absolute),
      Effect.catchAll(() => Effect.succeed(undefined)),
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
      Effect.map((result) => {
        const stdout = new TextDecoder().decode(result.standardOutput);
        const stderr = new TextDecoder().decode(result.standardError);
        if (
          args.includes("--components=secrets")
          && executable.endsWith("gnome-keyring-daemon")
          && result.exitCode === 0
        ) {
          const pid = /\bGNOME_KEYRING_PID=(\d+)\b/u.exec(stdout)?.[1];
          ownedProviderPid = pid === undefined ? undefined : Number(pid);
          ownedProviderExecutable = executable;
        }
        return { exitCode: result.exitCode, stdout, stderr };
      }),
      Effect.mapError(() => failure("a credential provider command could not run")),
    );
  return {
    capability: () => machine.credentialCapability(),
    findExecutable,
    runCommand,
    sessionBusAddress: () =>
      environment.find((entry) => entry.name === "DBUS_SESSION_BUS_ADDRESS")?.value,
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
    recycleProvider: () => {
      const pid = ownedProviderPid;
      const provider = ownedProviderExecutable;
      if (pid === undefined || provider === undefined) {
        return Effect.succeed({ recycled: false });
      }
      return Effect.gen(function*() {
        const kill = yield* findExecutable("kill");
        if (kill === undefined) return { recycled: false };
        const stopped = yield* runCommand(kill, ["-TERM", String(pid)]);
        if (stopped.exitCode !== 0) {
          return yield* failure("the credential provider Canonfig started could not be stopped");
        }
        yield* Effect.sleep("200 millis");
        const restarted = yield* runCommand(provider, ["--start", "--components=secrets"]);
        if (restarted.exitCode !== 0) {
          return yield* failure("the credential provider Canonfig started could not be restarted");
        }
        return { recycled: true };
      });
    },
    sleep: (milliseconds) => Effect.sleep(`${milliseconds} millis`),
    randomProbeId: () =>
      `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`,
  };
};
