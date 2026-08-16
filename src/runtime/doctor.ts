import { createHash, X509Certificate } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import { access, open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

import { Effect, Option, Redacted, Schema } from "effect";

import { programVersion } from "../cli/cli.ts";
import type { CliFailureCategory } from "../cli/exit-codes.ts";
import {
  CertificateFingerprint,
  CredentialReference,
} from "../domain/brand.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import { StateRepository } from "../state/state-repository.service.ts";

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

export interface DoctorInput {
  readonly noInput: boolean;
  readonly timeoutMilliseconds: number;
  readonly statePath: string;
  readonly policyPath: string;
  readonly source?: DoctorSourceConfiguration | undefined;
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

const warning = (
  name: DoctorProbeName,
  message: string,
  details?: DoctorProbe["details"],
): DoctorProbe => details === undefined
  ? { name, status: "warning", message }
  : { name, status: "warning", message, details };

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
    readonly kind: "configuration" | "transport" | "tls-pin" | "authentication",
  ) {
    super(`source probe failed: ${kind}`);
  }
}

const categoryForSourceError = (
  error: DoctorSourceProbeError,
): CliFailureCategory => {
  switch (error.kind) {
    case "configuration": return "usage-or-configuration";
    case "transport": return "transport";
    case "tls-pin":
    case "authentication": return "authentication-or-revocation";
  }
};

const sourceFailureMessage = (error: DoctorSourceProbeError): string => {
  switch (error.kind) {
    case "configuration": return "source probe configuration is invalid";
    case "transport": return "configured source is unreachable";
    case "tls-pin": return "source TLS pin validation failed";
    case "authentication": return "source authentication failed";
  }
};

const isolated = <Failure, Requirements>(
  name: DoctorProbeName,
  timeoutMilliseconds: number,
  operation: Effect.Effect<DoctorProbe, Failure, Requirements>,
  onFailure: (error: Failure) => DoctorProbe,
  timeoutCategory: CliFailureCategory,
): Effect.Effect<DoctorProbe, never, Requirements> =>
  operation.pipe(
    Effect.catch((error) => Effect.succeed(onFailure(error))),
    Effect.timeoutOption(timeoutMilliseconds),
    Effect.matchCause({
      onFailure: () =>
        failed(name, "internal", `${name} probe failed unexpectedly`),
      onSuccess: Option.match({
        onNone: () =>
          failed(name, timeoutCategory, `${name} probe timed out`, {
            timeoutMilliseconds,
          }),
        onSome: (result) => result,
      }),
    }),
  );

const runtimeProbe = (): Effect.Effect<DoctorProbe> =>
  Effect.sync(() =>
    pass("runtime", "runtime is supported", {
      runtime: "node",
      runtimeVersion: process.versions.node,
      canonfigVersion: programVersion,
      platform: process.platform,
      architecture: process.arch,
    })
  );

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
): Effect.Effect<DoctorProbe, object> =>
  machine.credentialCapability().pipe(
    Effect.map((capability) => {
      switch (capability.kind) {
        case "secure-noninteractive":
          return pass(
            "credentials",
            "noninteractive credential storage is available",
            { kind: capability.kind, provider: capability.provider },
          );
        case "local-file":
          return warning(
            "credentials",
            "credential storage uses an explicitly configured local file",
            { kind: capability.kind },
          );
        case "unavailable":
          return warning(
            "credentials",
            "noninteractive credential storage is unavailable",
            { kind: capability.kind },
          );
      }
    }),
  );

const sourceProbe = (
  machine: MachineState["Service"],
  source: DoctorSourceConfiguration | undefined,
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
    const credential = yield* machine.loadCredential({
      reference: credentialReference,
    }).pipe(Effect.mapError(() => new DoctorSourceProbeError("authentication")));
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
              },
            }, (response) => {
              response.resume();
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

const schedulerProbe = (
  schedules: ScheduleManager["Service"],
): Effect.Effect<DoctorProbe, object> =>
  schedules.status({ executable: process.argv[1] }).pipe(
    Effect.map((status) => {
      const details = {
        state: status.state,
        platform: status.platform,
        mechanism: status.definition.mechanism,
      };
      return status.state === "current" || status.state === "not-installed"
        ? pass("scheduler", `scheduler state is ${status.state}`, details)
        : warning("scheduler", `scheduler state is ${status.state}`, details);
    }),
  );

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
  agent: DoctorAgentConfiguration | undefined,
): Effect.fn.Return<DoctorProbe> {
  const configuredPolicy = yield* readPolicy(policyPath);
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
      () => failed("credentials", "human-action-required", "credential capability check failed"),
      "human-action-required",
    ),
    isolated(
      "source",
      timeout,
      sourceProbe(machine, input.source),
      (error) =>
        failed("source", categoryForSourceError(error), sourceFailureMessage(error)),
      "transport",
    ),
    isolated(
      "scheduler",
      timeout,
      schedulerProbe(schedules),
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
      agentProbe(machine, input.policyPath, input.agent),
      () => failed("agent-adapter", "internal", "agent adapter capability check failed"),
      "internal",
    ),
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
