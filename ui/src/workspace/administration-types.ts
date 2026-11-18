import { failingDetailPrefix, type FleetUpdate } from "../../../src/domain/fleet-update";
import type { Schema } from "effect";
import type { UpdateLifecycle } from "./live/self-update";
import type { GuiAgentHarness, GuiAgentPolicy, GuiInstallerMethod, GuiSourceServiceStatus, GuiSelfUpdateCheck, GuiSelfUpdateStatus, GuiSelfUpdateProgress } from "../../../src/gui/contract/administration";
import type { GuiRequestError } from "../gui-client";

export interface AdministrationResource<T> {
  data: T | null;
  loading: boolean;
  busy: boolean;
  error: GuiRequestError | null;
  reload: () => void;
}

export interface InstallerChoice {
  method: typeof GuiInstallerMethod.Type;
  executable: string;
  arguments: readonly string[];
}

interface HarnessBounds {
  executable: string;
  paths: string[];
  /** Bytes, without rounding the CLI's exact evidence limit. */
  maximumInputBytes: number;
  origins: readonly string[];
  executables: string[];
  executableAuthorizations: NonNullable<typeof GuiAgentHarness.Type.executableAuthorizations>;
  secretBindings: NonNullable<typeof GuiAgentHarness.Type.secretBindings>;
  capabilities: typeof GuiAgentHarness.Type.allowedCapabilities;
  /** Values are never exposed in this summary. Null means the collection is write-only. */
  environmentNames: readonly string[] | null;
  argumentsDisclosed: boolean;
}
export type HarnessDraft = HarnessBounds & (
  | { kind: "codex" | "claude"; model: string }
  | { kind: "custom"; args: string[] }
);
export interface SavedPolicy {
  mode: typeof GuiAgentPolicy.Type;
  /** Null when no harness draft is available. */
  harness: HarnessDraft | null;
}
export type PolicySave =
  | { kind: "Idle" }
  | { kind: "SavingPolicy"; submitted: SavedPolicy }
  | { kind: "SavingHarness"; committedPolicy: SavedPolicy["mode"]; draftHarness: HarnessDraft }
  | { kind: "SavingHarnessFirst"; submitted: SavedPolicy }
  | { kind: "SavingPolicyLast"; submitted: SavedPolicy }
  | { kind: "Saved"; policy: SavedPolicy["mode"]; harness: HarnessDraft | null }
  | { kind: "PolicyFailed"; draft: SavedPolicy; error: GuiRequestError }
  | { kind: "HarnessFailed"; committedPolicy: SavedPolicy["mode"]; draftHarness: HarnessDraft; error: GuiRequestError }
  | { kind: "HarnessFirstFailed"; draft: SavedPolicy; error: GuiRequestError }
  | { kind: "PolicyLastFailed"; draft: SavedPolicy; error: GuiRequestError };

/** The failing items a probe lists in its details (such as MCP servers), as `name: reason`. */
export const failingItems = (details: Readonly<Record<string, boolean | number | string>> | undefined): string[] =>
  Object.entries(details ?? {}).flatMap(([item, value]) => {
    const text = String(value);
    return text.startsWith(failingDetailPrefix) ? [`${item}: ${text.slice(failingDetailPrefix.length)}`] : [];
  });

export interface DoctorCheck {
  check: string;
  result: "ok" | "warn" | "bad" | "off";
  detail: string;
  /** Failing items from the probe's details, shown under a problem. */
  items?: string[];
  fix?: { why: string; command: string };
  evidence?: Schema.Json;
  commands?: readonly string[];
}

export interface SetupJournal {
  phase: "planned" | "approved" | "applying" | "paused" | "complete";
  at: number;
}

export interface AdministrationSlice {
  fleet: (AdministrationResource<FleetUpdate> & { start: (canary: string) => void; stop: () => void }) | null;
  service: AdministrationResource<typeof GuiSourceServiceStatus.Type> & {
    since?: string;
    lingerMarked?: boolean;
    action: "install" | "remove" | "restart" | null;
    install: (hostname: "127.0.0.1" | "::1" | "tailnet", port: number) => void;
    remove: () => void;
    restart?: () => void;
  };
  agent: AdministrationResource<SavedPolicy> & {
    harnessConfigured: boolean;
    harnessLoading: boolean;
    harnessError: GuiRequestError | null;
    savedMessage: string;
    saveState: PolicySave;
    save: (policy: SavedPolicy) => Promise<boolean>;
    harnessLabels: Readonly<Record<string, string>>;
  };
  installers: AdministrationResource<readonly {
    name: string; path: string; status: "bound" | "not on this platform"; arguments: readonly string[];
  }[]> & {
    checking: string | null;
    checked: string | null;
    /** Unbound methods whose executable PATH provides, ready to add in one click. */
    detected: readonly InstallerChoice[];
    check: (method: string) => void;
    /** Records a binding after the same --version check `canonfig installer set` runs; resolves true on success. */
    add: (choice: InstallerChoice) => Promise<boolean>;
    remove: (method: string) => void;
  };
  doctor: AdministrationResource<readonly DoctorCheck[]> & {
    status: string | null;
    progress?: number;
    run: (timeoutMilliseconds?: number) => void;
  };
  version: AdministrationResource<typeof GuiSelfUpdateStatus.Type> & {
    lifecycle: UpdateLifecycle;
    resume: () => void;
    current: string;
    npmCli: string | null;
    latest: string | null;
    checked: typeof GuiSelfUpdateCheck.Type | null;
    checking: boolean;
    check: () => void;
    enable: (npmCli: string, confirmIdle: boolean) => void;
    disable: () => void;
    apply: () => void;
    progress: typeof GuiSelfUpdateProgress.Type | null;
    unfinished: boolean;
  };
  /** Demo setup presentation only; the live setup workflow belongs to enrollment. */
  setup: {
    journal: SetupJournal;
    steps: readonly { id: string; label: string; detail: string }[];
    journalLabel: string;
    lingerCommand: string;
    approve: () => void;
    apply: () => void;
    resume: () => void;
  } | null;
}
