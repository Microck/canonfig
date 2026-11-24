import type { CertificateFingerprint } from "../domain/brand.ts";
import type { TailnetReport } from "../domain/tailnet.ts";
import type { MachinePlatform } from "../machine/machine-state.types.ts";
import type { NativeServiceManagerState, NativeServiceMechanism } from "../machine/native-service.ts";

export type SourceServiceHost = "127.0.0.1" | "::1" | "tailnet";

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

export type SourceServiceState =
  | "not-installed"
  | "running"
  | "not-running"
  | "not-serving"
  | "drifted";

export interface SourceServiceStatus {
  readonly state: SourceServiceState;
  readonly platform: MachinePlatform;
  readonly mechanism: NativeServiceMechanism;
  readonly serviceName: string;
  readonly definitionPath?: string | undefined;
  readonly endpoint: string;
  readonly requested: SourceServiceInput;
  readonly tailnet: TailnetReport;
  readonly manager: NativeServiceManagerState;
  /** The endpoint answered with this Source's pinned TLS and signing identity. */
  readonly serving: boolean;
  /** Manager lifecycle and credential-access constraints for unattended operation. */
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
