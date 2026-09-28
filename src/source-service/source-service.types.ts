import type { CertificateFingerprint } from "../domain/brand.ts";
import type {
  MachinePlatform,
  ProcessEnvironmentEntry,
} from "../machine/machine-state.types.ts";

export type SourceServiceHost = "127.0.0.1" | "::1";

/** What the supervised `canonfig source serve` listens on. */
export interface SourceServiceInput {
  readonly hostname: SourceServiceHost;
  readonly port: number;
}

/** The Source identity a healthy service must present on its endpoint. */
export interface SourceServiceIdentity {
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
  readonly sourceFingerprint: string;
}

export type SourceServiceMechanism =
  | "systemd-user-service"
  | "launchd-user-agent"
  | "task-scheduler-logon";

/** Everything a native definition is rendered from; pure data, no machine access. */
export interface SourceServiceSpecification {
  readonly platform: MachinePlatform;
  readonly home: string;
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  /** Carried into the service where the manager supports it (not Task Scheduler). */
  readonly environment: ReadonlyArray<ProcessEnvironmentEntry>;
  /** launchd output file; systemd uses the journal and Task Scheduler its history. */
  readonly logPath: string;
  /** Windows account the logon trigger and principal name. */
  readonly principal?: string | undefined;
}

export interface RenderedSourceService {
  readonly platform: MachinePlatform;
  readonly mechanism: SourceServiceMechanism;
  /** Unit name, launchd label, or Task Scheduler path. */
  readonly serviceName: string;
  /** Where the definition file lives; Task Scheduler keeps its own store. */
  readonly definitionPath?: string | undefined;
  readonly definition: string;
  /** Fingerprint embedded where the manager rewrites the definition (Task Scheduler). */
  readonly fingerprint: string;
}

/**
 * What the native manager reports. `active` means the manager says the
 * process is running now; `enabled` means it will start at login or boot.
 */
export interface SourceServiceManagerState {
  readonly installed: boolean;
  readonly matches: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly state: string;
  readonly pid?: number | undefined;
}

export type SourceServiceState =
  | "not-installed"
  | "running"
  | "not-running"
  | "not-serving"
  | "drifted";

export interface SourceServiceStatus {
  readonly state: SourceServiceState;
  readonly platform: MachinePlatform;
  readonly mechanism: SourceServiceMechanism;
  readonly serviceName: string;
  readonly definitionPath?: string | undefined;
  readonly endpoint: string;
  readonly manager: SourceServiceManagerState;
  /** The endpoint answered with this Source's pinned TLS and signing identity. */
  readonly serving: boolean;
  /** When the service runs on this platform: the supported unattended modes. */
  readonly supportedModes: string;
  /** Linux only: whether the user manager runs without a login. */
  readonly linger?: boolean | undefined;
  readonly logs: string;
  readonly detail: string;
}

export interface SourceServiceChange {
  readonly change: "installed" | "updated" | "unchanged";
  readonly status: SourceServiceStatus;
}

export interface SourceServiceRemoval {
  readonly change: "removed" | "unchanged";
  readonly serviceName: string;
}
