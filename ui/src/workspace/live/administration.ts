import { useCallback, useEffect, useRef, useState } from "react";
import {
  GuiAgentHarness, GuiAgentHarnessRead, GuiAgentPolicy, GuiAgentPolicyRead, GuiDoctorResult, GuiInstallerCheck, GuiInstallers,
  GuiSelfUpdateCheck, GuiSelfUpdateStatus, GuiSourceServiceChange, GuiSourceServiceRemoval, GuiSourceServiceReport,
} from "../../../../src/gui/contract/administration";
import type { GuiSession } from "../../../../src/gui/contract/session";
import { GuiRequestError, type WorkspaceBackend } from "../../gui-client";
import type { AdministrationSlice, SavedPolicy } from "../administration-types";

function requestError(cause: unknown): GuiRequestError {
  return cause instanceof GuiRequestError ? cause : new GuiRequestError({
    category: "internal", exitCode: 1, message: cause instanceof Error ? cause.message : "The operation failed.",
  });
}

/** Each resource owns its request and error so an unavailable harness cannot hide policy. */
function useAdministrationResource<T>(load: ((signal: AbortSignal) => Promise<T>) | null, enabled = false) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const attempted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GuiRequestError | null>(null);
  const controller = useRef<AbortController | null>(null);
  const run = useCallback(async (action: (signal: AbortSignal) => Promise<void>, reading = false) => {
    if (controller.current) return false;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setLoading(reading);
    setError(null);
    try {
      await action(request.signal);
      return !request.signal.aborted;
    } catch (cause) {
      if (!request.signal.aborted) setError(requestError(cause));
      return false;
    } finally {
      if (controller.current === request) controller.current = null;
      if (!request.signal.aborted) { setBusy(false); setLoading(false); }
    }
  }, []);
  const reload = useCallback(() => {
    if (load) void run(async (signal) => {
      attempted.current = true;
      const value = await load(signal);
      if (!signal.aborted) setData(value);
    }, true);
  }, [load, run]);
  useEffect(() => {
    if (enabled && !attempted.current) reload();
  }, [enabled, reload]);
  useEffect(() => () => {
    controller.current?.abort(); controller.current = null; attempted.current = false;
  }, []);
  return { data, setData, loading: enabled && (!attempted.current || loading), busy, error, setError, run, reload };
}

export function useLiveAdministration(backend: WorkspaceBackend, session: GuiSession, paths: readonly string[]): AdministrationSlice {
  const configured = session.role !== "unconfigured";
  const sourceLoad = useCallback((signal: AbortSignal) => backend.request("/api/source-service", GuiSourceServiceReport, signal), [backend]);
  const service = useAdministrationResource(session.role === "source" ? sourceLoad : null, paths.includes("/api/source-service"));
  const policyLoad = useCallback((signal: AbortSignal) => backend.request("/api/agent/policy", GuiAgentPolicyRead, signal), [backend]);
  const harnessLoad = useCallback((signal: AbortSignal) => backend.request("/api/agent/harness", GuiAgentHarnessRead, signal), [backend]);
  const policy = useAdministrationResource(configured ? policyLoad : null, paths.includes("/api/agent/policy"));
  const harness = useAdministrationResource(configured ? harnessLoad : null, paths.includes("/api/agent/harness"));
  const installersLoad = useCallback((signal: AbortSignal) => backend.request("/api/installers", GuiInstallers, signal), [backend]);
  const installers = useAdministrationResource(configured ? installersLoad : null, paths.includes("/api/installers"));
  const doctor = useAdministrationResource<typeof GuiDoctorResult.Type>(null);
  const versionLoad = useCallback((signal: AbortSignal) => backend.request("/api/self-update", GuiSelfUpdateStatus, signal), [backend]);
  const version = useAdministrationResource(configured ? versionLoad : null, paths.includes("/api/self-update"));
  const [serviceAction, setServiceAction] = useState<"install" | "remove" | null>(null);
  const [checkingInstaller, setCheckingInstaller] = useState<string | null>(null);
  const [checkedInstaller, setCheckedInstaller] = useState<string | null>(null);
  const [checkedVersion, setCheckedVersion] = useState<typeof GuiSelfUpdateCheck.Type | null>(null);
  const [savedMessage, setSavedMessage] = useState("");

  const changeService = (action: "install" | "remove", hostname?: "127.0.0.1" | "::1", port?: number) => {
    if (service.busy) return;
    void service.run(async (signal) => {
      setServiceAction(action);
      try {
        if (action === "install") {
          const changed = await backend.request("/api/source-service", GuiSourceServiceChange, signal, { method: "POST", body: { hostname, port } });
          if (!signal.aborted) service.setData({ report: changed.status, error: null });
        } else {
          await backend.request("/api/source-service", GuiSourceServiceRemoval, signal, { method: "DELETE", body: {} });
        }
        const report = await sourceLoad(signal);
        if (!signal.aborted) service.setData(report);
      } finally { if (!signal.aborted) setServiceAction(null); }
    });
  };

  const savedHarness = harness.data?.configured ? harness.data.value : null;
  const savedPolicy: SavedPolicy | null = policy.data === null ? null : {
    mode: policy.data.configured ? policy.data.value : policy.data.default,
    harness: savedHarness?.kind ?? "codex", model: savedHarness?.model ?? "",
    executable: savedHarness?.executable === savedHarness?.kind ? "" : savedHarness?.executable ?? "", args: [...(savedHarness?.arguments ?? [])],
    paths: [...(savedHarness?.allowedPaths ?? [])], maximumInputBytes: savedHarness?.maximumInputBytes ?? 1024 * 1024,
    origins: savedHarness?.allowedOrigins ?? [],
  };
  const savePolicy = async (next: SavedPolicy) => {
    if (policy.busy || harness.busy) return false;
    setSavedMessage("");
    const policySaved = await policy.run(async (signal) => {
      const saved = await backend.request("/api/agent/policy", GuiAgentPolicy, signal, { method: "PUT", body: next.mode });
      if (!signal.aborted) {
        policy.setData({ configured: true, value: saved });
        setSavedMessage("Policy saved.");
      }
    });
    if (!policySaved) return false;
    // A Source can change its policy, but the CLI refuses its follower-only harness configuration.
    if (session.role !== "follower" || next.mode === "deterministic-only" || next.harness === null) return true;
    const kind = next.harness;
    const { model: _model, arguments: _arguments, ...bounds } = savedHarness ?? {
      model: undefined, arguments: undefined, allowedExecutables: [], allowedOrigins: [], allowedCapabilities: [],
    };
    setSavedMessage("Policy saved. Harness has not been saved.");
    return harness.run(async (signal) => {
      const body = {
        ...bounds, kind, executable: next.executable || kind,
        ...(kind === "custom" ? { arguments: next.args } : next.model ? { model: next.model } : {}),
        allowedPaths: next.paths, maximumInputBytes: next.maximumInputBytes,
      };
      const savedHarness = await backend.request("/api/agent/harness", GuiAgentHarness, signal, { method: "PUT", body });
      if (!signal.aborted) {
        harness.setData({ configured: true, value: savedHarness });
        setSavedMessage("Policy and harness saved.");
      }
    });
  };
  const runDoctor = () => { void doctor.run(async (signal) => {
    const report = await backend.request("/api/doctor", GuiDoctorResult, signal, { method: "POST", body: {} });
    if (!signal.aborted) doctor.setData(report);
  }); };
  const settings = version.data?.settings;
  const updateSettings = settings !== null && typeof settings === "object" && !Array.isArray(settings)
    ? Object.fromEntries(Object.entries(settings))
    : null;
  const npmCli = typeof updateSettings?.npmCli === "string" ? updateSettings.npmCli : null;

  return {
    service: {
      data: service.data?.report ?? null, loading: service.loading, busy: service.busy,
      error: service.error ?? (service.data?.error ? new GuiRequestError(service.data.error) : null),
      reload: service.reload, action: serviceAction,
      install: (hostname, port) => changeService("install", hostname, port), remove: () => changeService("remove"),
    },
    agent: {
      configured: policy.data?.configured ?? false,
      harnessWritable: session.role === "follower",
      harnessConfigured: harness.data?.configured ?? false,
      data: savedPolicy, loading: policy.loading, busy: policy.busy || harness.busy, error: policy.error,
      harnessLoading: harness.loading, harnessError: harness.error, savedMessage, save: savePolicy,
      reload: () => { policy.reload(); harness.reload(); }, harnessLabels: { codex: "codex", claude: "claude" },
    },
    installers: {
      data: installers.data?.bindings.map((binding) => ({ name: binding.method, path: binding.executable, status: "bound" as const, arguments: binding.arguments })) ?? null,
      loading: installers.loading, busy: installers.busy, error: installers.error, reload: installers.reload,
      checking: checkingInstaller, checked: checkedInstaller, suggestions: installers.data?.suggestions ?? [],
      check: (method) => {
        if (installers.busy) return;
        void installers.run(async (signal) => {
          setCheckingInstaller(method); setCheckedInstaller(null);
          try {
            const checked = await backend.request(`/api/installers/${encodeURIComponent(method)}/check`, GuiInstallerCheck, signal, { method: "POST", body: {} });
            if (!signal.aborted) setCheckedInstaller(checked.binding.method);
          } finally { if (!signal.aborted) setCheckingInstaller(null); }
        });
      },
    },
    doctor: {
      data: doctor.data?.report.probes.map((probe) => ({
        check: probe.name, result: probe.status === "pass" ? "ok" : probe.status === "warning" ? "warn" : probe.status === "fail" ? "bad" : "off",
        detail: probe.message, evidence: { ...probe }, commands: [...probe.message.matchAll(/`([^`]+)`/g)].map((match) => match[1]!),
      })) ?? null,
      loading: doctor.loading, busy: doctor.busy, error: doctor.error ?? (doctor.data?.error ? new GuiRequestError(doctor.data.error) : null),
      reload: runDoctor, status: doctor.data?.report.status ?? null, run: runDoctor,
    },
    version: {
      data: version.data, loading: version.loading, busy: version.busy, error: version.error, reload: version.reload,
      current: session.version, npmCli, latest: checkedVersion?.candidate ?? null, checked: checkedVersion,
      checking: version.busy && !version.loading, unfinished: version.data?.pending ?? false,
      check: () => {
        if (version.busy) return;
        void version.run(async (signal) => {
          const checked = await backend.request("/api/self-update/check", GuiSelfUpdateCheck, signal, { method: "POST", body: {} });
          if (!signal.aborted) setCheckedVersion(checked);
        });
      },
    },
    setup: null,
  };
}
