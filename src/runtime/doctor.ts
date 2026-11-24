import { resumeMachineCredentialPersistence } from "../secrets/linux-credential-bootstrap.ts";
import { createHash, X509Certificate } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import { access, open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { dirname, join } from "node:path";

import { Effect, Option, Predicate, Redacted, Ref, Schema } from "effect";

import { installerMethods } from "../domain/installer-method.ts";
import { harnessReport } from "../projection/detect.ts";
import { TARGET_IDS } from "../projection/model.ts";
import { checkInstalledHarnessMcp, MCP_MAXIMUM_STARTUP_MILLISECONDS, MCP_STARTUP_TIMEOUT_MILLISECONDS, type McpCheckResult } from "./mcp-check.ts";
import { rootContext } from "../projection/plan.ts";
import { resolveInstallerInvocation } from "../synchronization/installer-bindings.ts";
import { programVersion } from "../cli/help.ts";
import {
  buildIdentity,
  supportedNodeVersions,
  nodeRuntimeIsSupported,
} from "./build-identity.ts";
import { canonfigVersionHeader } from "../enrollment/version-handshake.ts";
import { credentialReadiness, proveCredentialStorage, scheduledDefinitionReadiness } from "./readiness.ts";
import type { ScheduleFireEvidence } from "./readiness.ts";
import { AgentPolicy } from "../domain/identity.ts";
import {
  type DoctorSourceReport, failingDetailPrefix, machineHealthKeyLimit, machineHealthTextLimit, type MachineHealthProbe, type MachineHealthReport,
} from "../domain/fleet-update.ts";
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
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import {
  type SyncSchedule,
  unmanagedScheduleDetail,
} from "../schedule/schedule-manager.types.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import type { TunnelStatusReport } from "../enrollment/tunnel.types.ts";
import { checkSourceServerIdentity } from "../enrollment/tls-identity.ts";
import { detectTailnet, resolveSourceEndpoint } from "../enrollment/tailnet.ts";

export const doctorProbeNames = [
  "runtime",
  "state",
  "credentials",
  "source",
  "scheduler",
  "package-managers",
  "agent-adapter",
  "harnesses",
  "mcp",
  "tailscale",
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
  /**
   * Where the Source's Machines view gets this report: sent by an enrolled
   * Follower, recorded locally by a Source, or why sending failed.
   */
  readonly sourceReport?: DoctorSourceReport | undefined;
}

const clip = (text: string): string =>
  text.length <= machineHealthTextLimit ? text : `${text.slice(0, machineHealthTextLimit - 1)}…`;

/**
 * Leaves room under the Source's 64 KiB request limit (source-server.ts) for
 * the HTTP framing; clipping each field alone does not bound a machine with
 * many MCP servers.
 */
const machineHealthByteBudget = 48 * 1024;
const serializedBytes = (report: MachineHealthReport): number => Buffer.byteLength(JSON.stringify(report));

/**
 * The report as the Source stores it, with text clipped to the wire limits.
 * When it is still too large, passing detail lines go first, then every
 * detail line; the messages still name what failed.
 */
export const machineHealthOf = (report: DoctorReport): MachineHealthReport => {
  const full: MachineHealthReport = {
    recordedAt: new Date().toISOString(),
    version: buildIdentity.packageVersion,
    status: report.status,
    probes: report.probes.map((probe) => {
      const health: MachineHealthProbe = { name: probe.name, status: probe.status, message: clip(probe.message) };
      if (probe.details === undefined) return health;
      const details = Object.fromEntries(Object.entries(probe.details).map(([key, value]) =>
        [key.slice(0, machineHealthKeyLimit), Predicate.isString(value) ? clip(value) : value]));
      return { ...health, details };
    }),
  };
  if (serializedBytes(full) <= machineHealthByteBudget) return full;
  const failingOnly: MachineHealthReport = {
    ...full,
    probes: full.probes.map((probe) => probe.details === undefined ? probe : {
      ...probe,
      details: Object.fromEntries(Object.entries(probe.details).filter(([, value]) =>
        Predicate.isString(value) && value.startsWith(failingDetailPrefix))),
    }),
  };
  if (serializedBytes(failingOnly) <= machineHealthByteBudget) return failingOnly;
  return { ...full, probes: full.probes.map(({ details: _details, ...probe }) => probe) };
};

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
   * The policy this machine synchronizes under. Only an enrolled Follower
   * Machine has one; elsewhere it is undefined and the agent probe is skipped.
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
  /** The environment harness roots resolve from. */
  readonly environment: (name: string) => string | undefined;
  /**
   * The environment and folder harnesses would start MCP servers with. The mcp
   * probe starts real processes, so it runs only when the caller supplies this.
   */
  readonly mcpLaunch?: { readonly environment: NodeJS.ProcessEnv; readonly cwd: string } | undefined;
}

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
        `Node.js ${runtimeVersion} is unsupported; Canonfig requires Node.js ${supportedNodeVersions}`,
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
): Effect.Effect<DoctorProbe, MachineStateError> =>
  machine.credentialCapability().pipe(
    Effect.flatMap((found) =>
      found.kind === "secure-noninteractive" && found.verification === "provider-presence"
        ? proveCredentialStorage(machine).pipe(
          Effect.as(credentialReadiness({ ...found, verification: "session-probe" })),
          Effect.catch((reason) => Effect.succeed(credentialReadiness(found, reason))),
        )
        : Effect.succeed(credentialReadiness(found))
    ),
    Effect.flatMap((probe) => Effect.gen(function*() {
      if (process.platform !== "linux" || probe.details?.provider !== "secret-service") return probe;
      const persistence = yield* resumeMachineCredentialPersistence(machine).pipe(Effect.catch((error) => Effect.succeed({ verdict: "manual" as const, detail: error.message })));
      if (persistence === undefined) return probe;
      const message = `${probe.message}. ${persistence.detail}`;
      const details = { ...probe.details, restartPersistence: persistence.verdict, persistenceDetail: persistence.detail };
      return persistence.verdict === "failed"
        ? failed("credentials", "human-action-required", message, details)
        : { ...probe, message, details };
    })),
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
    const endpoint = yield* Effect.tryPromise({
      try: () => resolveSourceEndpoint(source.endpoint),
      catch: () => new DoctorSourceProbeError("configuration"),
    });
    yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<void>((resolveProbe, rejectProbe) => {
          const host = endpoint.hostname.replaceAll("[", "").replaceAll("]", "");
          const socket = tlsConnect({
            host,
            port: Number(endpoint.port || "443"),
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
              checkServerIdentity: checkSourceServerIdentity(tlsFingerprint),
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

export const schedulerProbe = (
  schedules: Pick<ScheduleManager["Service"], "status">,
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
          : { name: "scheduler", status: "warning", message: input.unscheduledDetail === undefined
            ? unmanagedScheduleDetail
            : `${input.unscheduledDetail}. A native job remains installed; remove it with `
              + "`canonfig schedule remove` if it is no longer wanted" }
      ),
      Effect.catch(() => Effect.succeed(unscheduled)),
    );
  }
  return schedules.status(input.schedule).pipe(
    Effect.map((status) => scheduledDefinitionReadiness(status, input.fires)),
  );
};

export const packageManagerProbe = Effect.fn("Doctor.packageManagers")(function*(
  machine: MachineState["Service"],
): Effect.fn.Return<DoctorProbe> {
  const available: Array<string> = [];
  for (const name of installerMethods) {
    const found = yield* resolveInstallerInvocation(name).pipe(
      Effect.provideService(MachineState, machine),
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
    : pass("package-managers", "installer invocation is available", {
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

const agentProbe = Effect.fn("Doctor.agentAdapter")(function*(
  machine: MachineState["Service"],
  policy: typeof AgentPolicy.Type | undefined,
  agent: DoctorAgentConfiguration | undefined,
): Effect.fn.Return<DoctorProbe> {
  // Only follower runs call an agent, so a Source or an unenrolled machine has
  // no agent policy for this probe to check.
  if (policy === undefined) {
    return skipped("agent-adapter", "agent policy applies only to an enrolled Follower Machine");
  }
  if (agent === undefined) {
    if (policy === "deterministic-only") {
      return pass("agent-adapter", "deterministic-only policy requires no adapter", {
        policy,
        configured: false,
      });
    }
    return failed(
      "agent-adapter",
      "usage-or-configuration",
      "configured agent policy requires an adapter",
      { policy, configured: false },
    );
  }
  if (!["codex", "claude", "custom"].includes(agent.adapter)) {
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

/**
 * The same report as `canonfig harnesses`: detection, the folder's list,
 * exclusions, pinned roots and snapshots. A listed harness that is not
 * installed is a warning; the run still converges without it.
 */
const harnessProbe = (
  statePath: string,
  environment: (name: string) => string | undefined,
  repository: StateRepository["Service"],
) =>
  Effect.gen(function*() {
    const report = yield* harnessReport({
      folder: dirname(statePath),
      context: yield* rootContext(environment),
      takeovers: yield* repository.loadHarnessTakeovers(),
    });
    if (!report.configured) return skipped("harnesses", `${join(report.folder, "canonfig.jsonc")} does not exist yet`);
    const pinned = report.harnesses.flatMap((row) =>
      row.pinnedRoot === undefined ? [] : [[`root.${row.harness}`, row.pinnedRoot] as const]
    );
    const entries: Array<readonly [string, string | number]> = [
      ["listed", report.listed.join(",")],
      ["excluded", report.excluded.join(",")],
      ["detected", report.detected.join(",")],
      ["notInstalled", report.notInstalled.join(",")],
      ["snapshots", report.snapshots],
      ...pinned,
    ];
    if (report.latestSnapshot !== undefined) entries.push(["latestSnapshot", report.latestSnapshot]);
    const details = Object.fromEntries(entries);
    return report.notInstalled.length > 0
      ? { name: "harnesses" as const, status: "warning" as const, message: `listed but not installed: ${report.notInstalled.join(", ")}`, details }
      : pass("harnesses", `${report.harnesses.filter((row) => row.status === "selected").length} listed harness(es) installed`, details);
  });

// A failing line starts with `failingDetailPrefix` (src/domain/fleet-update.ts), which the GUI relies on.
const mcpLine = (result: McpCheckResult): string =>
  [result.status, result.harnesses.join(","), result.detail, ...result.milliseconds === undefined ? [] : [`${result.milliseconds} ms`]].join(" · ");

/**
 * Launches every MCP server the installed harnesses are configured to start,
 * the way they start them, and requires initialize and tools/list to answer.
 * Each server gets at least Codex's default startup budget, because a doctor
 * timeout shorter than the harness's would report healthy servers as failing.
 */
const mcpProbe = (input: DoctorInput, perServerMilliseconds: number) =>
  Effect.gen(function*() {
    if (input.mcpLaunch === undefined) return skipped("mcp", "MCP servers are checked only by canonfig doctor and the GUI health check");
    const results = yield* checkInstalledHarnessMcp({
      context: yield* rootContext(input.environment),
      folder: dirname(input.statePath),
      environment: input.mcpLaunch.environment,
      cwd: input.mcpLaunch.cwd,
      timeoutMilliseconds: perServerMilliseconds,
    });
    if (results.length === 0) return skipped("mcp", "no installed harness declares an MCP server");
    // A name declared differently by several harnesses gets one row per launch, keyed by its harnesses.
    const nameCounts = new Map<string, number>();
    for (const result of results) nameCounts.set(result.name, (nameCounts.get(result.name) ?? 0) + 1);
    const label = (result: McpCheckResult) =>
      (nameCounts.get(result.name) ?? 0) > 1 ? `${result.name} (${result.harnesses.join(",")})` : result.name;
    const details = Object.fromEntries(
      [...results].sort((left, right) => left.name.localeCompare(right.name)).map((result) => [label(result), mcpLine(result)]),
    );
    const failing = results.filter((result) => result.status === "fail");
    const unchecked = results.filter((result) => result.status === "skipped");
    const answered = results.length - failing.length - unchecked.length;
    if (failing.length > 0) {
      const names = failing.map((result) => `${result.name} (${result.harnesses.join(",")})`).join(", ");
      return failed("mcp", "verification-or-apply-failure", `${failing.length} of ${results.length} MCP server(s) failed to start or answer: ${names}`, details);
    }
    const message = `${answered} MCP server(s) started and listed their tools`;
    return unchecked.length > 0
      ? { name: "mcp" as const, status: "warning" as const, message: `${message}; ${unchecked.length} not checked`, details }
      : pass("mcp", message, details);
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
  const mcpPerServerMilliseconds = Math.max(timeout, MCP_STARTUP_TIMEOUT_MILLISECONDS);
  const sourceStage = yield* Ref.make<SourceProbeStage>("not-started");
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
      credentialProbe(machine),
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
      agentProbe(machine, input.agentPolicy, input.agent),
      () => failed("agent-adapter", "internal", "agent adapter capability check failed"),
      "internal",
    ),
    isolated(
      "harnesses",
      timeout,
      harnessProbe(input.statePath, input.environment, repository),
      (error) =>
        failed("harnesses", "usage-or-configuration", `harness selection could not be read: ${error.message}`),
      "internal",
    ),
    isolated(
      "mcp",
      // The probe bounds each server and checks one harness at a time, so this
      // only guards against a hang outside them.
      // Entry budgets may exceed the default but are capped, so this bounds a harness's slowest server.
      // Each harness batch may also spend up to 2 s closing HTTP sessions.
      (Math.max(mcpPerServerMilliseconds, MCP_MAXIMUM_STARTUP_MILLISECONDS) + 2_000) * TARGET_IDS.length + 5_000,
      mcpProbe(input, mcpPerServerMilliseconds),
      () => failed("mcp", "internal", "MCP server check failed"),
      "verification-or-apply-failure",
    ),
    isolated("tailscale", timeout, detectTailnet().pipe(Effect.map((report): DoctorProbe => ({
      name: "tailscale",
      status: report.ready ? "pass" : "skipped",
      message: report.detail,
      details: {
        installed: report.installed, backendState: report.backendState,
        addresses: report.addresses.join(", "), dnsName: report.dnsName ?? "",
        tailnet: report.tailnet ?? "", controlUrl: report.controlUrl ?? "",
        httpsAvailable: report.httpsAvailable, userspace: report.userspace,
      },
    }))), () => skipped("tailscale", "Tailscale discovery failed"), "transport",
    Effect.succeed(skipped("tailscale", "Tailscale LocalAPI discovery timed out"))),
  ], { concurrency: "unbounded" });
  const failedCount = probes.filter((probe) => probe.status === "fail").length;
  const degraded = probes.some((probe) =>
    probe.status === "warning" || probe.status === "skipped"
  );
  return {
    schema: "canonfig.doctor/v1",
    status: failedCount > 0 ? "unhealthy" : degraded ? "degraded" : "healthy",
    noInput: input.noInput,
    timeoutMilliseconds: timeout,
    probes,
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
