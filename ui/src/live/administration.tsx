import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Schema } from "effect";
import {
  GuiSourceServiceReport, GuiSourceServiceChange, GuiSourceServiceRemoval, GuiAgentHarness, GuiAgentPolicy, GuiInstallers,
  GuiInstallerCheck, GuiSelfUpdateCheck, GuiSelfUpdateStatus, GuiDoctorResult,
} from "../../../src/gui/contract/administration";
import { GuiOperationTicket } from "../../../src/gui/contract/operations";
import { GuiSetupStatus, GuiSetupJournal } from "../../../src/gui/contract/enrollment";
import { GuiRequestError, type GuiOperation, type WorkspaceBackend } from "../gui-client";
import { ErrorNotice } from "./session";
import type { LiveScreen, LiveScreenProps } from "./routes";
import { CommandBox, Field, SettingRow, settingsGroup } from "../workspace/kit";
import { shq } from "../shared/shell";
import { StatusMark } from "../shared/shared";
import { Button } from "../components/ui/button";

const control = "min-h-11 rounded border border-border bg-background px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2";
const button = "min-h-11 sm:min-h-8";

function SettingsColumn({ children }: { children: ReactNode }) {
  return <div className="max-w-[880px] space-y-6 pb-20">{children}</div>;
}

function CopyCommand({ command }: { command: string }) {
  return <CommandBox>{command}</CommandBox>;
}

function stringList(text: string, label: string): readonly string[] {
  try {
    return Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(text));
  } catch {
    throw new GuiRequestError({ category: "usage-or-configuration", exitCode: 2, message: `${label} must be a JSON array of strings.` });
  }
}

/** Reports remain inspectable when the CLI has platform-specific evidence. */
function Evidence({ value }: { value: Schema.Json }) {
  if (value === null) return <span>None</span>;
  if (Array.isArray(value)) return <ul className="space-y-3">{value.map((item, index) =>
    <li className="border-b border-border py-2" key={index}><Evidence value={item} /></li>)}</ul>;
  if (typeof value === "object") return <dl className="space-y-2">{Object.entries(value).map(([key, item]) =>
    <div className="grid gap-1 sm:grid-cols-[170px_minmax(0,1fr)]" key={key}>
      <dt className="text-muted-foreground">{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt>
      <dd className="min-w-0 break-words"><Evidence value={item} /></dd>
    </div>)}</dl>;
  return <span className="whitespace-pre-wrap">{String(value)}</span>;
}

function Report({ report }: { report: typeof GuiSourceServiceReport.Type }) {
  return <>{report.error && <ErrorNotice error={new GuiRequestError(report.error)} />}
    <Evidence value={report.report} /></>;
}

function useAdministration(backend: WorkspaceBackend) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GuiRequestError>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => {
    controller.current?.abort();
    controller.current = null;
  }, []);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current !== null) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(undefined);
    try { await action(request.signal); }
    catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof GuiRequestError ? cause : new GuiRequestError({
        category: "internal", exitCode: 1,
        message: cause instanceof Error ? cause.message : "The operation failed.",
      }));
    } finally {
      if (controller.current === request) controller.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return { backend, busy, error, run };
}

function ServiceSettings({ backend }: LiveScreenProps) {
  const action = useAdministration(backend);
  const [report, setReport] = useState<typeof GuiSourceServiceReport.Type>();
  const [port, setPort] = useState("17342");
  const [hostname, setHostname] = useState("127.0.0.1");
  const [confirmation, setConfirmation] = useState(false);
  const [change, setChange] = useState<Schema.Json>();
  const reload = () => action.run(async (signal) => {
    const loaded = await backend.request("/api/source-service", GuiSourceServiceReport, signal);
    setReport(loaded);
    const endpoint = new URL(loaded.report.endpoint);
    setPort(endpoint.port);
    setHostname(endpoint.hostname === "[::1]" ? "::1" : endpoint.hostname);
  });
  useEffect(() => { void reload(); }, [backend]);
  return <SettingsColumn>
    <p>The Source service serves this machine's signed profile. Its native manager and endpoint are checked separately.</p>
    {action.error && <ErrorNotice error={action.error} />}
    <Button className={button} disabled={action.busy} onClick={() => void reload()}>Reload status</Button>
    {report && <Report report={report} />}
    <form className="space-y-4" onSubmit={(event) => {
      event.preventDefault();
      void action.run(async (signal) => {
        setChange(await backend.request("/api/source-service", GuiSourceServiceChange, signal, {
          method: "POST", body: { hostname, port: Number(port) },
        }));
        setReport(await backend.request("/api/source-service", GuiSourceServiceReport, signal));
      });
    }}>
      <div className={settingsGroup}>
        <SettingRow title="Listen address" htmlFor="source-service-host">
          <select id="source-service-host" className={control} value={hostname} onChange={(event) => setHostname(event.target.value)}>
            <option>127.0.0.1</option><option>::1</option>
          </select>
        </SettingRow>
        <SettingRow title="Port" htmlFor="source-service-port">
          <input id="source-service-port" className={`${control} w-28`} type="number" min={1} max={65535} required value={port} onChange={(event) => setPort(event.target.value)} />
        </SettingRow>
      </div>
      <Button className={button} disabled={action.busy}>Install service</Button>
    </form>
    <div className="space-y-3 border-t border-border pt-4">
      <label className="flex items-center gap-3"><input type="checkbox" checked={confirmation} onChange={(event) => setConfirmation(event.target.checked)} />
        Remove the Source service. Followers cannot connect while it is stopped.</label>
      <Button className={button} disabled={action.busy || !confirmation} onClick={() => void action.run(async (signal) => {
        setChange(await backend.request("/api/source-service", GuiSourceServiceRemoval, signal, { method: "DELETE", body: {} }));
        setConfirmation(false);
        setReport(await backend.request("/api/source-service", GuiSourceServiceReport, signal));
      })}>Remove service</Button>
    </div>
    {change !== undefined && <section aria-label="Last operation"><Evidence value={change} /></section>}
  </SettingsColumn>;
}

function AgentSettings({ backend }: LiveScreenProps) {
  const action = useAdministration(backend);
  const [policy, setPolicy] = useState<typeof GuiAgentPolicy.Type>();
  const [harness, setHarness] = useState<typeof GuiAgentHarness.Type>();
  const [harnessError, setHarnessError] = useState<GuiRequestError>();
  const [kind, setKind] = useState("codex");
  const [model, setModel] = useState("");
  const [executable, setExecutable] = useState("codex");
  const [argumentsText, setArgumentsText] = useState("[]");
  const [paths, setPaths] = useState("[]");
  const [limit, setLimit] = useState("65536");
  const [saved, setSaved] = useState("");
  const reload = () => action.run(async (signal) => {
    const [loadedPolicy, loadedHarness] = await Promise.allSettled([
      backend.request("/api/agent/policy", GuiAgentPolicy, signal),
      backend.request("/api/agent/harness", GuiAgentHarness, signal),
    ]);
    if (signal.aborted) return;
    if (loadedHarness.status === "fulfilled") {
      const loaded = loadedHarness.value;
      setHarness(loaded); setKind(loaded.kind); setModel(loaded.model ?? "");
      setExecutable(loaded.executable); setArgumentsText(JSON.stringify(loaded.arguments ?? [], null, 2));
      setPaths(JSON.stringify(loaded.allowedPaths, null, 2)); setLimit(String(loaded.maximumInputBytes)); setHarnessError(undefined);
    } else if (loadedHarness.reason instanceof GuiRequestError) {
      setHarnessError(loadedHarness.reason);
    } else {
      throw loadedHarness.reason;
    }
    if (loadedPolicy.status === "rejected") throw loadedPolicy.reason;
    setPolicy(loadedPolicy.value);
  });
  useEffect(() => { void reload(); }, [backend]);
  return <SettingsColumn>
    <p>Policy and harness are saved as two CLI operations. A saved policy is not rolled back if the harness operation fails.</p>
    {action.error && <ErrorNotice error={action.error} />}
    {harnessError && <ErrorNotice title="Harness unavailable" error={harnessError} />}
    <Button className={button} disabled={action.busy} onClick={() => void reload()}>Reload settings</Button>
    <form className="space-y-4" onSubmit={(event) => {
      event.preventDefault();
      if (policy === undefined) return;
      setSaved("");
      void action.run(async (signal) => {
        const argumentsList = kind === "custom" ? stringList(argumentsText, "Arguments") : undefined;
        const allowedPaths = stringList(paths, "Writable paths");
        await backend.request("/api/agent/policy", GuiAgentPolicy, signal, { method: "PUT", body: policy });
        setSaved("Policy saved. Harness has not been saved.");
        const body = {
          ...harness, kind, executable, ...(model ? { model } : {}),
          ...(argumentsList ? { arguments: argumentsList } : {}),
          maximumInputBytes: Number(limit), allowedPaths,
          allowedExecutables: harness?.allowedExecutables ?? [],
          allowedOrigins: harness?.allowedOrigins ?? [], allowedCapabilities: harness?.allowedCapabilities ?? [],
        };
        if (!model || kind === "custom") delete body.model;
        if (kind !== "custom") delete body.arguments;
        setHarness(await backend.request("/api/agent/harness", GuiAgentHarness, signal, { method: "PUT", body }));
        setHarnessError(undefined); setSaved("Policy and harness saved.");
      });
    }}>
      <label className="grid gap-2">Policy<select className={control} value={policy ?? ""} required onChange={(event) => {
        setPolicy(Schema.decodeUnknownSync(GuiAgentPolicy)(event.target.value));
      }}><option value="" disabled>Load policy first</option><option value="deterministic-only">Deterministic only</option>
        <option value="agent-propose">Agent proposes</option><option value="agent-apply">Agent applies</option></select></label>
      <label className="grid gap-2">Harness<select className={control} value={kind} onChange={(event) => {
        setKind(event.target.value); if (event.target.value !== "custom") setExecutable(event.target.value);
      }}><option value="codex">Codex</option><option value="claude">Claude</option><option value="custom">Custom</option></select></label>
      {kind !== "custom" && <Field label="Model" htmlFor="agent-model"><input id="agent-model" className={control} value={model} onChange={(event) => setModel(event.target.value)} /></Field>}
      <Field label="Executable" htmlFor="agent-executable"><input id="agent-executable" className={control} required value={executable} onChange={(event) => setExecutable(event.target.value)} /></Field>
      {kind === "custom" && <Field label="Arguments (JSON array)" htmlFor="agent-arguments"><textarea id="agent-arguments" className={control} value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} /></Field>}
      <Field label="Writable paths (JSON array)" htmlFor="agent-paths"><textarea id="agent-paths" className={control} value={paths} onChange={(event) => setPaths(event.target.value)} /></Field>
      <Field label="Maximum evidence bytes" htmlFor="agent-limit"><input id="agent-limit" className={control} type="number" min={1} max={1048576} required value={limit} onChange={(event) => setLimit(event.target.value)} /></Field>
      <Button className={button} disabled={action.busy || policy === undefined}>{action.busy ? "Saving or loading…" : "Save settings"}</Button>
      <p role="status">{saved}</p>
    </form>
  </SettingsColumn>;
}

function InstallerSettings({ backend }: LiveScreenProps) {
  const action = useAdministration(backend);
  const [installers, setInstallers] = useState<typeof GuiInstallers.Type>();
  const [checked, setChecked] = useState<typeof GuiInstallerCheck.Type>();
  const reload = () => action.run(async (signal) => setInstallers(await backend.request("/api/installers", GuiInstallers, signal)));
  useEffect(() => { void reload(); }, [backend]);
  return <SettingsColumn>
    <p>Checks run the exact bound installer with its bounded version command. They do not install packages.</p>
    {action.error && <ErrorNotice error={action.error} />}
    <Button className={button} disabled={action.busy} onClick={() => void reload()}>Reload installers</Button>
    {installers?.bindings.length === 0 && <p>No installer bindings are configured. Use canonfig installer set in a terminal.</p>}
    {installers?.bindings.map((binding) => <section className="space-y-3 border-b border-border pb-4" key={binding.method}>
      <h2 className="font-medium">{binding.method}</h2><code className="break-all">{binding.executable}</code>
      <Evidence value={[...binding.arguments]} />
      <Button className={button} disabled={action.busy} onClick={() => void action.run(async (signal) => {
        setChecked(await backend.request(`/api/installers/${binding.method}/check`, GuiInstallerCheck, signal, { method: "POST", body: {} }));
      })}>Check {binding.method}</Button>
    </section>)}
    {installers?.suggestions.map((suggestion) => <CopyCommand key={suggestion.method} command={suggestion.command} />)}
    {checked && <p role="status">{checked.binding.method} verified in the current process.</p>}
  </SettingsColumn>;
}

function DoctorSettings({ backend }: LiveScreenProps) {
  const action = useAdministration(backend);
  const [report, setReport] = useState<typeof GuiDoctorResult.Type>();
  return <SettingsColumn>
    <p>Run the CLI's non-interactive health checks. Copying a recovery command does not run it.</p>
    {action.error && <ErrorNotice error={action.error} />}
    <Button className={button} disabled={action.busy} onClick={() => void action.run(async (signal) => {
      setReport(await backend.request("/api/doctor", GuiDoctorResult, signal, { method: "POST", body: {} }));
    })}>{action.busy ? "Running checks…" : "Run checks"}</Button>
    {report && <>
      {report.error && <ErrorNotice error={new GuiRequestError(report.error)} />}
      <p role="status">Health: {report.report.status}</p>
      {report.report.probes.map((probe) => <section className="space-y-3 border-b border-border pb-4" key={probe.name}>
        <h2 className="flex items-center gap-2 font-medium"><StatusMark kind={probe.status === "pass" ? "ok" : probe.status === "warning" ? "warn" : probe.status === "fail" ? "bad" : "off"} />{probe.name}: {probe.status}</h2>
        <p className="whitespace-pre-wrap">{probe.message}</p>
        {probe.details && <Evidence value={{ ...probe.details }} />}
        {[...probe.message.matchAll(/`([^`]+)`/g)].map((match, index) =>
          <CopyCommand key={index} command={match[1] ?? ""} />)}
        <details><summary>Copy full check details</summary><CopyCommand command={JSON.stringify(probe, null, 2)} /></details>
      </section>)}
    </>}
  </SettingsColumn>;
}

function VersionSettings({ backend, session }: LiveScreenProps) {
  const action = useAdministration(backend);
  const [status, setStatus] = useState<typeof GuiSelfUpdateStatus.Type>();
  const [check, setCheck] = useState<typeof GuiSelfUpdateCheck.Type>();
  const [npmPath, setNpmPath] = useState("");
  const reload = () => action.run(async (signal) => setStatus(await backend.request("/api/self-update", GuiSelfUpdateStatus, signal)));
  useEffect(() => { void reload(); }, [backend]);
  return <SettingsColumn>
    <p>Canonfig {session.version}</p>
    {action.error && <ErrorNotice error={action.error} />}
    <Button className={button} disabled={action.busy} onClick={() => void reload()}>Reload status</Button>
    {status && <><p>Updates {status.enabled ? "enabled" : "disabled"}. {status.pending ? "An interrupted update needs attention." : "No interrupted update recorded."}</p>
      {status.settings !== null && <Evidence value={status.settings} />}</>}
    <Button className={button} disabled={action.busy} onClick={() => void action.run(async (signal) => {
      setCheck(await backend.request("/api/self-update/check", GuiSelfUpdateCheck, signal, { method: "POST", body: {} }));
    })}>Check for updates</Button>
    {check && <Evidence value={{ ...check }} />}
    <section className="space-y-4 border-t border-border pt-4">
      <h2 className="font-medium">Update from a terminal</h2>
      <p>Stop this GUI and all Canonfig processes and schedules before enabling, disabling or applying updates. Only a user-private npm installation under your home is supported.</p>
      <Field label={`Absolute npm-cli.js path (${status?.platform === "win32" ? "PowerShell" : "POSIX shell"})`} htmlFor="update-npm-path">
        <input id="update-npm-path" className={control} value={npmPath} onChange={(event) => setNpmPath(event.target.value)} />
      </Field>
      {npmPath !== "" && status && <CopyCommand command={`canonfig self-update enable --apply --confirm-idle --npm-cli ${status.platform === "win32" ? `'${npmPath.replaceAll("'", "''")}'` : shq(npmPath)}`} />}
      <CopyCommand command="canonfig self-update disable --apply" />
      <CopyCommand command="canonfig self-update apply --apply" />
    </section>
  </SettingsColumn>;
}

function SetupSettings({ backend }: LiveScreenProps) {
  const action = useAdministration(backend);
  const [setup, setSetup] = useState<GuiSetupStatus>();
  const setupEvidence = useMemo(() => setup === undefined ? null : Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(setup))), [setup]);
  const [approver, setApprover] = useState("");
  const [approved, setApproved] = useState(false);
  const [operation, setOperation] = useState<GuiOperation>();
  const [pollError, setPollError] = useState<GuiRequestError>();
  const reload = () => action.run(async (signal) => {
    setSetup(await backend.request("/api/setup", GuiSetupStatus, signal)); setApproved(false);
  });
  useEffect(() => { void reload(); }, [backend]);
  useEffect(() => {
    if (operation?.state !== "running" || pollError) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void backend.operation(operation.id, controller.signal).then(setOperation, (cause: unknown) => {
        if (!controller.signal.aborted) setPollError(cause instanceof GuiRequestError ? cause : new GuiRequestError({
          category: "transport", exitCode: 6, message: "Cannot read the setup operation. Retry to read its current journal.",
        }));
      });
    }, 750);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [operation, backend, pollError]);
  return <SettingsColumn>
    <p>Review the recorded plan before approving it. Human steps are verified by health checks, not a completion checkbox.</p>
    {action.error && <ErrorNotice error={action.error} />}
    {pollError && <><ErrorNotice error={pollError} /><Button className={button} onClick={() => setPollError(undefined)}>Retry operation status</Button></>}
    <Button className={button} disabled={action.busy} onClick={() => void reload()}>Reload setup</Button>
    {setup && <Evidence value={setupEvidence} />}
    <form className="space-y-4" onSubmit={(event) => {
      event.preventDefault();
      void action.run(async (signal) => {
        await backend.request("/api/setup/approve", GuiSetupJournal, signal, {
          method: "POST", body: { approver, planDigest: setup?.planDigest },
        });
        setSetup(await backend.request("/api/setup", GuiSetupStatus, signal)); setApproved(false);
      });
    }}>
      <label className="grid gap-2">Approver name<input className={control} required value={approver} onChange={(event) => setApprover(event.target.value)} /></label>
      <label className="flex gap-3"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />I reviewed and approve this exact plan.</label>
      <Button className={button} disabled={action.busy || !approved || !setup?.planDigest}>Approve plan</Button>
    </form>
    <Button className={button} disabled={action.busy || !setup?.approved || !setup.planDigest || operation?.state === "running"} onClick={() => void action.run(async (signal) => {
      const ticket = await backend.request("/api/setup/apply", GuiOperationTicket, signal, { method: "POST", body: { planDigest: setup?.planDigest } });
      setOperation(await backend.operation(ticket.id, signal));
    })}>Apply approved plan</Button>
    {operation && <><p role="status">Apply {operation.state}</p>
      {operation.failure && <ErrorNotice error={new GuiRequestError(operation.failure)} />}
      <Evidence value={operation.journal} /></>}
    <p><a className="underline underline-offset-4" href="./health">Open health check</a> to verify this machine's current readiness.</p>
  </SettingsColumn>;
}

export const administrationScreens: ReadonlyArray<LiveScreen> = [
  { title: "Source service", path: (role) => role === "source" ? "/source/settings/service" : undefined, render: (props) => <ServiceSettings {...props} /> },
  ...([
    ["Agent policy", "agent", AgentSettings],
    ["Installers", "installers", InstallerSettings],
    ["Setup", "setup", SetupSettings],
    ["Health check", "health", DoctorSettings],
    ["Canonfig version", "version", VersionSettings],
  ] as const).map(([title, path, Component]) => ({
    title, path: (role: LiveScreenProps["session"]["role"]) => role === "unconfigured" ? undefined : `/${role}/settings/${path}`,
    render: (props: LiveScreenProps) => <Component {...props} />,
  })),
];
