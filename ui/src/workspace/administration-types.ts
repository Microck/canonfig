import type { Schema } from "effect";
import type { GuiAgentPolicy, GuiSourceServiceStatus, GuiSelfUpdateCheck, GuiSelfUpdateStatus, GuiSelfUpdateProgress } from "../../../src/gui/contract/administration";
import type { GuiRequestError } from "../gui-client";

export interface AdministrationResource<T> {
  data: T | null;
  loading: boolean;
  busy: boolean;
  error: GuiRequestError | null;
  reload: () => void;
}

export interface SavedPolicy {
  mode: typeof GuiAgentPolicy.Type;
  /** Null when the CLI refuses access to harness configuration. */
  harness: "codex" | "claude" | "custom" | null;
  model: string;
  executable: string;
  args: string[];
  paths: string[];
  /** Bytes, without rounding the CLI's exact evidence limit. */
  maximumInputBytes: number;
  origins: readonly string[];
}

export interface DoctorCheck {
  check: string;
  result: "ok" | "warn" | "bad" | "off";
  detail: string;
  fix?: { why: string; command: string };
  evidence?: Schema.Json;
  commands?: readonly string[];
}

export interface SetupJournal {
  phase: "planned" | "approved" | "applying" | "paused" | "complete";
  at: number;
}

export interface AdministrationSlice {
  service: AdministrationResource<typeof GuiSourceServiceStatus.Type> & {
    since?: string;
    lingerMarked?: boolean;
    action: "install" | "remove" | "restart" | null;
    install: (hostname: "127.0.0.1" | "::1", port: number) => void;
    remove: () => void;
    restart?: () => void;
  };
  agent: AdministrationResource<SavedPolicy> & {
    configured: boolean;
    harnessWritable: boolean;
    harnessConfigured: boolean;
    harnessLoading: boolean;
    harnessError: GuiRequestError | null;
    savedMessage: string;
    save: (policy: SavedPolicy) => Promise<boolean>;
    harnessLabels: Readonly<Record<string, string>>;
  };
  installers: AdministrationResource<readonly {
    name: string; path: string; status: "bound" | "not on this platform"; arguments: readonly string[];
  }[]> & {
    checking: string | null;
    checked: string | null;
    suggestions: readonly { method: string; command: string }[];
    check: (method: string) => void;
  };
  doctor: AdministrationResource<readonly DoctorCheck[]> & {
    status: string | null;
    progress?: number;
    run: () => void;
  };
  version: AdministrationResource<typeof GuiSelfUpdateStatus.Type> & {
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
