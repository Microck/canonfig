import { createHash, X509Certificate } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import { access, open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

import { Effect, Option, Redacted, Ref, Schema } from "effect";

import { programVersion } from "../cli/help.ts";
import {
  buildIdentity,
  minimumSupportedNodeMajor,
  nodeRuntimeIsSupported,
} from "./build-identity.ts";
import { canonfigVersionHeader } from "../enrollment/version-handshake.ts";
import { credentialReadiness, scheduledDefinitionReadiness } from "./readiness.ts";
import type { ScheduleFireEvidence } from "./readiness.ts";
import { AgentPolicy } from "../domain/identity.ts";
import type { CliFailureCategory } from "../cli/exit-codes.ts";
import {
  CertificateFingerprint,
  CredentialReference,
} from "../domain/brand.ts";
import {
  credentialFailureDetail,
  type MachineStateError,
} from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { CredentialStorageCapability } from "../machine/machine-state.types.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import {
  type SyncSchedule,
  unmanagedScheduleDetail,
} from "../schedule/schedule-manager.types.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import type { TunnelStatusReport } from "../enrollment/tunnel.types.ts";

export const doctorProbeNames = [
  "runtime",
  "state",
  "credentials",
  "source",
  "scheduler",
  "package-managers",
  "agent-adapter",
] as const;

export type DoctorProbeName = typeof doctorProbeNames[number];
export type DoctorProbeStatus = "pass" | "warning" | "fail" | "skipped";

export interface DoctorProbe {
  readonly name: DoctorProbeName;
  readonly status: DoctorProbeStatus;
  readonly message: string;
  readonly category?: CliFailureCategory | undefined;
  readonly details?: Readonly<Record<string, boolean | number | string>> | undefined;
}

export interface DoctorReport {
  readonly schema: "canonfig.doctor/v1";
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly noInput: boolean;
  readonly timeoutMilliseconds: number;
  readonly probes: ReadonlyArray<DoctorProbe>;
}

export interface DoctorSourceConfiguration {
  readonly endpoint: string;
  readonly tlsFingerprint: string;
  readonly credentialReference: string;
}

export interface DoctorAgentConfiguration {
  readonly adapter: string;
  readonly executable: string;
}

export interface DoctorScheduleConfiguration {
  readonly schedule: SyncSchedule;
  readonly executable?: string | undefined;
}

export interface DoctorInput {
  readonly noInput: boolean;
  readonly timeoutMilliseconds: number;
  readonly statePath: string;
  /**
   * Where an unenrolled machine keeps its agent policy. Enrollment stops using
   * this file, so an enrolled machine passes `agentPolicy` instead and the file
   * is not consulted.
   */
  readonly policyPath: string;
  /**
   * The policy this machine actually synchronizes under, when it is enrolled.
   * The probe used to read `policyPath` regardless, so an enrolled follower
   * with policy `agent-apply` and no harness reported a skipped probe rather
   * than the failure a run would hit.
   */
  readonly agentPolicy?: typeof AgentPolicy.Type | undefined;
  /**
   * The native job this follower should have, or undefined when it should have
   * none. The probe used to compare the installed job against the built-in
   * default and its own script path, so the only schedule that could ever read
   * `current` was a daily 00:00 job installed from the copy of canonfig on
   * PATH.
   */
  readonly schedule?: DoctorScheduleConfiguration | undefined;
  /** Why there is no schedule, e.g. a profile default awaiting `schedule set --default`. */
  readonly unscheduledDetail?: string | undefined;
  /** The unattended run records, oldest first. */
  readonly fires?: ReadonlyArray<ScheduleFireEvidence> | undefined;
  readonly source?: DoctorSourceConfiguration | undefined;
  /**
   * The managed tunnel, when the configured Source endpoint is reached through
   * it. A transport failure of the source probe is then reported as the
   * tunnel outage, with the command that restarts it.
   */
  readonly tunnel?: TunnelStatusReport | undefined;
  readonly agent?: DoctorAgentConfiguration | undefined;
}

const PolicyFile = Schema.Struct({
  policy: Schema.Literals(["deterministic-only", "agent-propose", "agent-apply"]),
});

const pass = (
  name: DoctorProbeName,
  message: string,
  details?: DoctorProbe["details"],
): DoctorProbe => details === undefined
  ? { name, status: "pass", message }
  : { name, status: "pass", message, details };

const skipped = (
  name: DoctorProbeName,
  message: string,
): DoctorProbe => ({ name, status: "skipped", message });

const failed = (
  name: DoctorProbeName,
  category: CliFailureCategory,
  message: string,
  details?: DoctorProbe["details"],
): DoctorProbe => details === undefined
  ? { name, status: "fail", category, message }
  : { name, status: "fail", category, message, details };

class DoctorSourceProbeError extends Error {
  readonly _tag = "DoctorSourceProbeError";

  constructor(
    readonly kind:
      | "configuration"
      | "local-credential"
      | "transport"
      | "tls-pin"
      | "authentication",
    /** The native credential-store failure, for `local-credential`. */
    readonly detail?: string | undefined,
  ) {
    super(`source probe failed: ${kind}`);
  }
}

const categoryForSourceError = (
  error: DoctorSourceProbeError,
): CliFailureCategory => {
  switch (error.kind) {
    case "configuration": return "usage-or-configuration";
    case "local-credential": return "human-action-required";
    case "transport": return "transport";
    case "tls-pin":
    case "authentication": return "authentication-or-revocation";
  }
};

const sourceFailureMessage = (error: DoctorSourceProbeError): string => {
  switch (error.kind) {
    case "configuration": return "source probe configuration is invalid";
    case "local-credential":
      return `this machine's credential store could not return the follower credential, so no Source request was made: ${error.detail ?? "unknown credential-store failure"}`;
    case "transport": return "configured source is unreachable";
    case "tls-pin": return "source TLS pin validation failed";
    case "authentication": return "source authentication failed";
  }
};

/**
 * How far the source probe got. The follower credential is read from the
 * local store before any Source traffic, so a probe that times out while
 * reading it (a locked keyring or Keychain waiting on an unlock prompt) is a
 * local failure, and a completed read proves native read access here.
 */
type SourceProbeStage = "not-started" | "loading-credential" | "credential-loaded";

const isolated = <Failure, Requirements>(
  name: DoctorProbeName,
  timeoutMilliseconds: number,
  operation: Effect.Effect<DoctorProbe, Failure, Requirements>,
  onFailure: (error: Failure) => DoctorProbe,
  timeoutCategory: CliFailureCategory,
  onTimeout: Effect.Effect<DoctorProbe> = Effect.succeed(
    failed(name, timeoutCategory, `${name} probe timed out`, { timeoutMilliseconds }),
  ),
): Effect.Effect<DoctorProbe, never, Requirements> =>
  operation.pipe(
    Effect.catch((error) => Effect.succeed(onFailure(error))),
    Effect.timeoutOption(timeoutMilliseconds),
    Effect.matchCauseEffect({
      onFailure: () =>
        Effect.succeed(failed(name, "internal", `${name} probe failed unexpectedly`)),
      onSuccess: Option.match({
        onNone: () => onTimeout,
        onSome: (result) => Effect.succeed(result),
      }),
    }),
  );

const runtimeProbe = (): Effect.Effect<DoctorProbe> =>
  Effect.sync(() => {
    const runtimeVersion = process.versions.node;
    const details = {
      runtime: "node",
      runtimeVersion,
      canonfigVersion: programVersion,
      platform: process.platform,
      architecture: process.arch,
    };
    return nodeRuntimeIsSupported(runtimeVersion)
      ? pass("runtime", "runtime is supported", details)
      : failed(
        "runtime",
        "human-action-required",
        `Node.js ${runtimeVersion} is unsupported; Canonfig requires Node.js ${minimumSupportedNodeMajor} or newer`,
        details,
      );
  });

const stateProbe = (
  statePath: string,
  repository: StateRepository["Service"],
): Effect.Effect<DoctorProbe, object> =>
  Effect.gen(function*() {
    yield* Effect.tryPromise({
      try: async () => {
        await access(statePath, filesystemConstants.R_OK | filesystemConstants.W_OK);
        const file = await open(statePath, "r+");
        try {
          const header = Buffer.alloc(16);
          await file.read(header, 0, header.byteLength, 0);
          if (header.toString("utf8") !== "SQLite format 3\0") {
            throw new Error("state is not a SQLite database");
          }
          await file.write(Buffer.alloc(0), 0, 0, 0);
        } finally {
          await file.close();
        }
      },
      catch: () => new Error("SQLite file health check failed"),
    });
    yield* repository.listRevisions();
    return pass("state", "SQLite state is migrated, readable, and writable", {
      header: "valid",
      migrations: "current",
      readWrite: true,
    });
  });

const credentialProbe = (
  machine: MachineState["Service"],
  capability: Ref.Ref<Option.Option<CredentialStorageCapability>>,
): Effect.Effect<DoctorProbe, MachineStateError> =>
  machine.credentialCapability().pipe(
    Effect.tap((found) => Ref.set(capability, Option.some(found))),
    Effect.map((found) => credentialReadiness(found)),
  );

const sourceProbe = (
  machine: MachineState["Service"],
  source: DoctorSourceConfiguration | undefined,
  stage: Ref.Ref<SourceProbeStage>,
): Effect.Effect<DoctorProbe, DoctorSourceProbeError> => {
  if (source === undefined) {
    return Effect.succeed(skipped(
      "source",
      "source reachability, TLS pin, and authentication are not configured",
    ));
  }
  return Effect.gen(function*() {
    const tlsFingerprint = yield* Schema.decodeUnknownEffect(CertificateFingerprint)(
      source.tlsFingerprint,
    ).pipe(Effect.mapError(() => new DoctorSourceProbeError("configuration")));
    const credentialReference = yield* Schema.decodeUnknownEffect(CredentialReference)(
      source.credentialReference,
    ).pipe(Effect.mapError(() => new DoctorSourceProbeError("configuration")));
    yield* Ref.set(stage, "loading-credential");
    const credential = yield* machine.loadCredential({
      reference: credentialReference,
    }).pipe(Effect.mapError((error) =>
      new DoctorSourceProbeError("local-credential", credentialFailureDetail(error))
    ));
    yield* Ref.set(stage, "credential-loaded");
    yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<void>((resolveProbe, rejectProbe) => {
          let endpoint: URL;
          try {
            endpoint = new URL(source.endpoint);
            const loopback = endpoint.hostname === "127.0.0.1"
              || endpoint.hostname === "[::1]"
              || endpoint.hostname === "::1";
            if (endpoint.protocol !== "https:" || !loopback) {
              throw new Error("invalid endpoint");
            }
          } catch {
            rejectProbe(new DoctorSourceProbeError("configuration"));
            return;
          }
          const host = endpoint.hostname.replaceAll("[", "").replaceAll("]", "");
          const socket = tlsConnect({
            host,
            port: Number(endpoint.port),
            rejectUnauthorized: false,
            minVersion: "TLSv1.2",
          });
          const abort = (): void => {
            socket.destroy(new Error("source probe aborted"));
          };
          signal.addEventListener("abort", abort, { once: true });
          socket.once("secureConnect", () => {
            const peer = socket.getPeerCertificate();
            if (peer.raw === undefined) {
              socket.destroy();
              rejectProbe(new DoctorSourceProbeError("transport"));
              return;
            }
            const fingerprint = createHash("sha256").update(peer.raw).digest("hex");
            if (fingerprint !== tlsFingerprint) {
              socket.destroy();
              rejectProbe(new DoctorSourceProbeError("tls-pin"));
              return;
            }
            const certificate = new X509Certificate(peer.raw).toString();
            socket.end();
            const request = httpsRequest({
              protocol: "https:",
              hostname: host,
              port: endpoint.port,
              path: "/v1/enrollment/authenticate",
              method: "GET",
              ca: certificate,
              rejectUnauthorized: true,
              minVersion: "TLSv1.2",
              headers: {
                authorization: `Bearer ${Redacted.value(credential)}`,
                accept: "application/json",
                [canonfigVersionHeader]: buildIdentity.packageVersion,
              },
            }, (response) => {
              response.resume();
              // A Source that dies mid-response never emits "end", and the
              // request-level "error" listener below does not fire once the
              // response has begun. Node only emits "error" on an
              // IncomingMessage that has a listener, so without this the probe
              // stalls until its outer timeout and reports a timeout instead
              // of the transport failure that actually happened.
              response.once("error", () => {
                signal.removeEventListener("abort", abortRequest);
                request.destroy();
                rejectProbe(new DoctorSourceProbeError("transport"));
              });
              response.once("end", () => {
                signal.removeEventListener("abort", abortRequest);
                if (response.statusCode === 200) resolveProbe();
                else rejectProbe(new DoctorSourceProbeError("authentication"));
              });
            });
            const abortRequest = (): void => {
              request.destroy(new Error("source probe aborted"));
            };
            signal.removeEventListener("abort", abort);
            signal.addEventListener("abort", abortRequest, { once: true });
            request.once("error", () => {
              signal.removeEventListener("abort", abortRequest);
              rejectProbe(new DoctorSourceProbeError("transport"));
            });
            request.end();
          });
          socket.once("error", () => {
            signal.removeEventListener("abort", abort);
            rejectProbe(new DoctorSourceProbeError("transport"));
          });
        }),
      catch: (error) =>
        error instanceof DoctorSourceProbeError
          ? error
          : new DoctorSourceProbeError("transport"),
    });
    return pass("source", "source is reachable, TLS-pinned, and authenticated", {
      reachable: true,
      tlsPinned: true,
      authenticated: true,
    });
  });
};

/**
 * The source probe, told what the managed tunnel carrying it is doing. An
 * unreachable Source behind a down tunnel is the tunnel's outage, and the
 * operator needs `canonfig tunnel start`, not a hunt for a network fault.
 */
const withTunnelEvidence = (
  probe: DoctorProbe,
  tunnel: TunnelStatusReport | undefined,
): DoctorProbe => {
  if (tunnel === undefined || tunnel.lifecycle === "not-configured") return probe;
  const details = { ...probe.details, tunnel: tunnel.lifecycle };
  if (probe.status !== "fail" || probe.category !== "transport" || tunnel.lifecycle === "running") {
    return { ...probe, details };
  }
  return failed(
    "source",
    "transport",
    `configured source is unreachable because the managed tunnel ${tunnel.endpoint ?? ""} is ${tunnel.lifecycle}: ${tunnel.detail}`,
    { ...details, recovery: tunnel.recovery ?? "canonfig tunnel start" },
  );
};

const schedulerProbe = (
  schedules: ScheduleManager["Service"],
  input: Pick<DoctorInput, "schedule" | "unscheduledDetail" | "fires">,
): Effect.Effect<DoctorProbe, object> => {
  if (input.schedule === undefined) {
    // No decision, so nothing to compare against, but a job left by an
    // earlier release (v2.x `schedule set`, a v3.x default) still runs.
    const unscheduled = skipped(
      "scheduler",
      input.unscheduledDetail ?? "this follower runs no scheduled synchronization",
    );
    return schedules.status().pipe(
      Effect.map((status): DoctorProbe =>
        status.state === "not-installed"
          ? unscheduled
          : { name: "scheduler", status: "warning", message: unmanagedScheduleDetail }
      ),
      Effect.catch(() => Effect.succeed(unscheduled)),
    );
  }
  return schedules.status(input.schedule).pipe(
    Effect.map((status) => scheduledDefinitionReadiness(status, input.fires)),
  );
};

const packageManagerProbe = Effect.fn("Doctor.packageManagers")(function*(
  machine: MachineState["Service"],
): Effect.fn.Return<DoctorProbe> {
  const available: Array<string> = [];
  for (const name of ["npm", "pnpm", "yarn"] as const) {
    const found = yield* machine.findExecutable({ name }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (found) available.push(name);
  }
  return available.length === 0
    ? failed(
      "package-managers",
      "usage-or-configuration",
      "no supported package manager is available",
    )
    : pass("package-managers", "package manager capability is available", {
      available: available.join(","),
    });
});

const executableAvailable = (
  machine: MachineState["Service"],
  executable: string,
): Effect.Effect<boolean> =>
  executable.includes("/") || executable.includes("\\")
    ? Effect.tryPromise({
      try: () => access(executable, filesystemConstants.X_OK).then(() => true),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)))
    : machine.findExecutable({ name: executable }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );

const readPolicy = (
  policyPath: string,
): Effect.Effect<typeof PolicyFile.Type | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const { readFile } = await import("node:fs/promises");
      return Schema.decodeUnknownSync(PolicyFile)(
        JSON.parse(await readFile(policyPath, "utf8")),
      );
    },
    catch: (error) => error,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

const agentProbe = Effect.fn("Doctor.agentAdapter")(function*(
  machine: MachineState["Service"],
  policyPath: string,
  enrolledPolicy: typeof AgentPolicy.Type | undefined,
  agent: DoctorAgentConfiguration | undefined,
): Effect.fn.Return<DoctorProbe> {
  // An enrolled follower's policy lives in its follower configuration, which is
  // what a run reads. Fall back to the policy file only when this machine is
  // not enrolled and that file is still the authority.
  const configuredPolicy = enrolledPolicy === undefined
    ? yield* readPolicy(policyPath)
    : { policy: enrolledPolicy };
  if (agent === undefined) {
    if (configuredPolicy?.policy === "deterministic-only") {
      return pass("agent-adapter", "deterministic-only policy requires no adapter", {
        policy: configuredPolicy.policy,
        configured: false,
      });
    }
    if (configuredPolicy === undefined) {
      return skipped("agent-adapter", "agent policy and adapter are not configured");
    }
    return failed(
      "agent-adapter",
      "usage-or-configuration",
      "configured agent policy requires an adapter",
      { policy: configuredPolicy.policy, configured: false },
    );
  }
  if (!["codex", "claude", "gemini"].includes(agent.adapter)) {
    return failed(
      "agent-adapter",
      "usage-or-configuration",
      "configured agent adapter is unsupported",
    );
  }
  const executable = yield* executableAvailable(machine, agent.executable);
  return executable
    ? pass("agent-adapter", "configured agent adapter executable is available", {
      adapter: agent.adapter,
      executableAvailable: true,
    })
    : failed(
      "agent-adapter",
      "usage-or-configuration",
      "configured agent adapter executable is unavailable",
      { adapter: agent.adapter, executableAvailable: false },
    );
});

export const runDoctorProbes = Effect.fn("runDoctorProbes")(function*(
  input: DoctorInput,
): Effect.fn.Return<
  DoctorReport,
  never,
  MachineState | ScheduleManager | StateRepository
> {
  const machine = yield* MachineState;
  const schedules = yield* ScheduleManager;
  const repository = yield* StateRepository;
  const timeout = input.timeoutMilliseconds;
  const sourceStage = yield* Ref.make<SourceProbeStage>("not-started");
  const capability = yield* Ref.make(Option.none<CredentialStorageCapability>());
  const sourceTimedOut = Effect.map(Ref.get(sourceStage), (stage) =>
    stage === "loading-credential"
      ? failed(
        "source",
        "human-action-required",
        `this machine's credential store did not return the follower credential within ${timeout} ms, so no Source request was made; a locked keyring or Keychain may be waiting for an unlock prompt that this session cannot show`,
        { timeoutMilliseconds: timeout, stage: "credential-load" },
      )
      : failed("source", "transport", "source probe timed out", { timeoutMilliseconds: timeout })
  );
  const probes = yield* Effect.all([
    isolated(
      "runtime",
      timeout,
      runtimeProbe(),
      () => failed("runtime", "internal", "runtime probe failed"),
      "internal",
    ),
    isolated(
      "state",
      timeout,
      stateProbe(input.statePath, repository),
      () => failed("state", "internal", "SQLite state health check failed"),
      "internal",
    ),
    isolated(
      "credentials",
      timeout,
      credentialProbe(machine, capability),
      (error) =>
        failed(
          "credentials",
          "human-action-required",
          `credential capability check failed: ${credentialFailureDetail(error)}`,
        ),
      "human-action-required",
    ),
    isolated(
      "source",
      timeout,
      sourceProbe(machine, input.source, sourceStage),
      (error) =>
        failed("source", categoryForSourceError(error), sourceFailureMessage(error)),
      "transport",
      sourceTimedOut,
    ).pipe(Effect.map((probe) => withTunnelEvidence(probe, input.tunnel))),
    isolated(
      "scheduler",
      timeout,
      schedulerProbe(schedules, input),
      () => failed("scheduler", "verification-or-apply-failure", "scheduler state check failed"),
      "verification-or-apply-failure",
    ),
    isolated(
      "package-managers",
      timeout,
      packageManagerProbe(machine),
      () => failed("package-managers", "internal", "package manager capability check failed"),
      "internal",
    ),
    isolated(
      "agent-adapter",
      timeout,
      agentProbe(machine, input.policyPath, input.agentPolicy, input.agent),
      () => failed("agent-adapter", "internal", "agent adapter capability check failed"),
      "internal",
    ),
  ], { concurrency: "unbounded" });
  // Provider presence alone stays a warning, but a native read of the enrolled
  // credential by this very process proves access from this session.
  const credentialLoaded = (yield* Ref.get(sourceStage)) === "credential-loaded";
  const knownCapability = yield* Ref.get(capability);
  const combined = credentialLoaded && Option.isSome(knownCapability)
    ? probes.map((probe) =>
      probe.name === "credentials"
        ? credentialReadiness(knownCapability.value, { enrolledCredentialLoaded: true })
        : probe
    )
    : probes;
  const failedCount = combined.filter((probe) => probe.status === "fail").length;
  const degraded = combined.some((probe) =>
    probe.status === "warning" || probe.status === "skipped"
  );
  return {
    schema: "canonfig.doctor/v1",
    status: failedCount > 0 ? "unhealthy" : degraded ? "degraded" : "healthy",
    noInput: input.noInput,
    timeoutMilliseconds: timeout,
    probes: combined,
  };
});

const categoryPriority: ReadonlyArray<CliFailureCategory> = [
  "internal",
  "verification-or-apply-failure",
  "authentication-or-revocation",
  "transport",
  "human-action-required",
  "conflict-or-drift",
  "usage-or-configuration",
];

export const doctorFailureCategory = (
  report: DoctorReport,
): CliFailureCategory | undefined =>
  categoryPriority.find((category) =>
    report.probes.some((probe) =>
      probe.status === "fail" && probe.category === category
    )
  );
