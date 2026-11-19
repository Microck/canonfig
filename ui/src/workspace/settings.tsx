import { Schema } from "effect";
import { GuardChecker, GuardReport, GuiGuardStatus, guardEndpoints, guardRules, promptGuardLocalEndpoint, type GuardApprovalChange, type GuardPolicy } from "../../../src/guard/contract";
import { GuiRequestError, type WorkspaceBackend } from "@/gui-client";
import { GuardFindings } from "@/live/session";
import { LiveResourcesContext, useLiveActions, useLiveResource } from "./live/resource";
// Settings shared by both machine roles where the feature exists on both.
import { useContext, useEffect, useState } from "react";
import { Check, Circle, HourglassMedium, Warning, WarningCircle, X } from "@/components/icons";
import { cn, removeKeepingFocus } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentHarnessOriginProblem, parseAgentSecretBinding } from "../../../src/domain/agent-harness-bounds";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CliText, DitherProgress, Hint, Mono, StatusMark, Term } from "@/shared/shared";
import { shq } from "@/shared/shell";
import { ErrorNotice } from "@/live/session";
import { SetupJournal } from "@/onboarding/enrollment-controller";
import { useWorkspace, type Workspace } from "./store";
import { CHECK_LABEL, type InstallerChoice, type SavedPolicy } from "./administration-types";
export type { SavedPolicy } from "./administration-types";
import { Body, CommandBox, EmptyState, Field, ListHead, ListRow, PageHeader, SectionLabel, SettingRow, settingsGroup, useDialogReturnFocus, useLeaveGuard } from "./kit";
import { focusPageHeading, workspaceHref } from "./routes";


/**
 * Names a health-check warning plainly for summaries that can't show the whole check:
 * "Off: service stops when you log out" on Linger reads "Service stops when you log out (linger off)".
 */
export function warningName(d: { check: string; detail: string }) {
  const [state, effect] = d.detail.split(": ");
  if (!effect) return d.check;
  return `${effect.charAt(0).toUpperCase()}${effect.slice(1)} (${d.check.toLowerCase()} ${state.toLowerCase()})`;
}

/** Settings share an 880px outer cap; list columns keep their own readable caps. Follower forms (follower.tsx) use it too. */
export function Column({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[880px] px-4 pt-6 pb-20 sm:px-8">{children}</div>;
}


function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  onConfirm,
  confirmVariant = "destructive",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: React.ReactNode;
  confirm: string;
  onConfirm: () => void;
  confirmVariant?: "destructive" | "primary";
}) {
  // Cancel returns to the button that asked; confirming often removes it, so focus then goes to the page heading.
  const returnFocus = useDialogReturnFocus(focusPageHeading);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md" {...returnFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild className="text-base text-pretty"><div>{body}</div></DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ConfirmDialog };

export function ServiceView() {
  const { admin, capabilities } = useWorkspace();
  const service = admin.service;
  const report = service.data;
  const [confirm, setConfirm] = useState(false);
  const [address, setAddress] = useState<"127.0.0.1" | "::1" | "tailnet" | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const hostname = address ?? report?.requested.hostname ?? "127.0.0.1";
  const portValue = port ?? String(report?.requested.port ?? 17342);
  const validPort = /^\d+$/.test(portValue) && Number(portValue) >= 1 && Number(portValue) <= 65535;
  const installed = report?.manager.installed;
  return (
    <>
      <PageHeader crumbs={["Settings", "Source service"]} actions={
        <>
          <Button size="sm" variant="outline" disabled={service.busy} onClick={service.reload}>Reload status</Button>
          {report && (!installed || !service.restart) && <Button size="sm" variant="primary" disabled={service.busy || !validPort || (hostname === "tailnet" && !report.tailnet.ready)} onClick={() => service.install(hostname, Number(portValue))}>
            {service.action === "install" ? "Installing…" : installed ? "Update service" : "Install service"}
          </Button>}
        </>
      } />
      <Body reloading={service.loading}>
        <Column>
          {service.error && <ErrorNotice error={service.error} />}
          <SectionLabel>Status</SectionLabel>
          <div data-tour="service-status" className={cn("mt-1", settingsGroup)}>
            {/* Running needs no explanation, and the header button fixes not-installed and drifted, so only the
                states it can't fix in one click keep the detail (they name the logs to read). */}
            <SettingRow title="State" description={report && (report.state === "not-running" || report.state === "not-serving") ? <CliText>{report.detail}</CliText> : undefined}>
              <span className="inline-flex items-center gap-1.5 text-base">
                <StatusMark kind={!report || !installed ? "off" : report.state === "running" ? "ok" : "warn"} />
                {service.since && report?.state === "running" ? `Running since ${service.since}` : report?.state.replaceAll("-", " ") ?? "Status unavailable"}
              </span>
            </SettingRow>
            <SettingRow title="Endpoint"><Mono className="text-foreground">{report?.endpoint || "Unavailable"}</Mono></SettingRow>
            {installed && report?.linger !== undefined && <SettingRow title="Keeps running">
              <span className={cn("inline-flex items-center gap-1.5 text-base", !report.linger && "text-warn")}>
                <StatusMark kind={report.linger ? "ok" : "warn"} />
                {report.linger ? "Also after you log out" : "Only while you're logged in"}
                {service.lingerMarked && <Hint label="Keeps running">{"You marked linger as turned on when you resumed setup.\nCanonfig didn't check it."}</Hint>}
                {!report.linger && admin.setup && <Hint label="Keeps running">{`Linger is off, so systemd stops the service when you log out. Canonfig never turns linger on.\nTo keep it running, run ${admin.setup.lingerCommand} yourself.`}</Hint>}
              </span>
            </SettingRow>}
          </div>
          {report && !service.restart && <div className={cn("mt-6", settingsGroup)}>
            <SettingRow title="Connection" htmlFor="source-service-host" description={report.tailnet.detail}><Select value={hostname} onValueChange={(value) => setAddress(value === "tailnet" ? "tailnet" : value === "::1" ? "::1" : "127.0.0.1")}>
              <SelectTrigger id="source-service-host" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="tailnet" disabled={!report.tailnet.ready}>Tailscale (recommended)</SelectItem><SelectItem value="127.0.0.1">Loopback IPv4 / SSH</SelectItem><SelectItem value="::1">Loopback IPv6 / SSH</SelectItem></SelectContent>
            </Select></SettingRow>
            <SettingRow title="Port" htmlFor="source-service-port" error={!validPort ? "Enter a port from 1 to 65535." : null}>
              <Input id="source-service-port" className="w-28 font-mono" inputMode="numeric" value={portValue} onChange={(event) => setPort(event.target.value)} aria-invalid={!validPort} />
            </SettingRow>
          </div>}
          {installed && <div className="mt-4 flex items-center gap-2">
            {capabilities.serviceRestart && service.restart && <Button variant="outline" size="sm" disabled={service.busy} onClick={service.restart}>{service.action === "restart" ? "Restarting…" : "Restart"}</Button>}
            <Button variant="destructive" size="sm" disabled={service.busy} onClick={() => setConfirm(true)}>Remove service…</Button>
          </div>}
          {report && !service.restart && <details className="mt-6 text-sm">
            <summary className="min-h-6 cursor-pointer text-muted-foreground">Technical details</summary>
            <div className={cn("mt-2", settingsGroup)}>
              <SettingRow title="Managed by" description={report.mechanism}><Mono className="text-foreground">{report.serviceName}</Mono></SettingRow>
              <SettingRow title="Native manager" description={report.manager.state}>
                {report.manager.active ? "Active" : "Inactive"} · {report.manager.enabled ? "Enabled" : "Disabled"} · {report.manager.matches ? "Definition matches" : "Definition differs"}
              </SettingRow>
              {report.definitionPath && <SettingRow title="Service definition"><Mono>{report.definitionPath}</Mono></SettingRow>}
              <SettingRow title="Logs"><Mono>{report.logs}</Mono></SettingRow>
            </div>
          </details>}
        </Column>
      </Body>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Remove the source service?"
        body="Your other machines can't fetch new revisions until you install it again. Your profile, revisions and machine identities are kept."
        confirm="Remove service" onConfirm={service.remove} />
    </>
  );
}

const MODES = [
  {
    value: "deterministic-only",
    label: "Deterministic only",
    body: "Canonfig never calls an agent. Anything without an exact recipe waits for a person.",
  },
  {
    value: "agent-propose",
    label: "Agent proposes",
    body: "An agent may draft a fix as a proposed profile change. Nothing changes until the Source publishes it.",
  },
  {
    value: "agent-apply",
    label: "Agent applies",
    body: "An agent may apply fixes on this machine within the bounds below. Each job it does is recorded.",
  },
] as const;

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MODEL_EXAMPLE: Record<string, string> = { codex: "gpt-5-codex", claude: "opus" };
const CAPABILITIES = [
  { value: "elevation", label: "Elevation", consequence: "May request elevated privileges to change protected system state." },
  { value: "login", label: "Login", consequence: "May establish an authenticated session." },
  { value: "restart", label: "Restart", consequence: "May restart services or applications, interrupting their work." },
  { value: "reboot", label: "Reboot", consequence: "May reboot this machine, interrupting all running work." },
] as const;

const boundLines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** Mirrors the CLI: one token, never starting with "-", so it can't become a second flag. */
const MODEL_SHAPE = /^[^\s-]\S*$/u;

/** JSON preserves every argv entry, including empty strings and embedded quotes. */
function splitArguments(text: string): string[] | null {
  try {
    const args: unknown = JSON.parse(text);
    return Array.isArray(args) && args.every((arg): arg is string => typeof arg === "string") ? args : null;
  } catch { return null; }
}

function joinArguments(args: string[]): string {
  return JSON.stringify(args);
}

export function AgentPolicyView() {
  const { admin } = useWorkspace();
  const agent = admin.agent;
  if (agent.loading || agent.harnessLoading) return <>
    <PageHeader crumbs={["Settings", "Agent policy"]} actions={<Button size="sm" variant="outline" disabled={agent.busy} onClick={agent.reload}>Reload settings</Button>} />
    <Body reloading={agent.loading || agent.harnessLoading}><Column>
      {agent.error && <ErrorNotice error={agent.error} />}
      <div className={settingsGroup}><SettingRow title="Agent policy">Not loaded</SettingRow><SettingRow title="Harness bounds">Not loaded</SettingRow></div>
    </Column></Body>
  </>;
  return <AgentPolicyForm saved={agent.data} />;
}

function AgentPolicyForm({ saved }: { saved: SavedPolicy | null }) {
  const agent = useWorkspace().admin.agent;
  // No policy is selected until the CLI reports one or the person chooses one.
  const initial = saved ?? { mode: null, harness: null };
  const initialHarness = initial.harness;
  const [mode, setMode] = useState<SavedPolicy["mode"] | null>(initial.mode);
  const [harness, setHarness] = useState(initialHarness?.kind ?? null);
  const [model, setModel] = useState(initialHarness && initialHarness.kind !== "custom" ? initialHarness.model : "");
  const [executable, setExecutable] = useState(initialHarness?.executable ?? "");
  // Per-mode field drafts intentionally survive switching the selected harness.
  const [argsText, setArgsText] = useState(joinArguments(initialHarness?.kind === "custom" ? initialHarness.args : []));
  const [paths, setPaths] = useState<string[]>(initialHarness?.paths ?? []);
  const [newPath, setNewPath] = useState("");
  // A digits-only string while editing; Save stores it as a number.
  const [maximumInputBytes, setMaximumInputBytes] = useState(String(initialHarness?.maximumInputBytes ?? 0));
  const [originsText, setOriginsText] = useState((initialHarness?.origins ?? []).join("\n"));
  const [executablesText, setExecutablesText] = useState((initialHarness?.executables ?? []).join("\n"));
  const [bindingsText, setBindingsText] = useState((initialHarness?.secretBindings ?? []).map(({ name, secret }) => `${name}=${secret}`).join("\n"));
  const [capabilities, setCapabilities] = useState(initialHarness?.capabilities ?? []);
  const [review, setReview] = useState<SavedPolicy | null>(null);
  const origins = boundLines(originsText);
  const executables = [...new Set(boundLines(executablesText))];
  let bindings: NonNullable<typeof initialHarness>["secretBindings"] = [];
  let bindingError: string | null = null;
  try { bindings = boundLines(bindingsText).map(parseAgentSecretBinding); }
  catch { bindingError = "Use ENV_NAME=secret-name, one binding per line."; }
  const originError = origins.map(agentHarnessOriginProblem).find((problem) => problem !== undefined);
  const custom = harness === "custom";
  const args = splitArguments(argsText);
  const dirty =
    mode !== initial.mode ||
    harness !== (initialHarness?.kind ?? null) ||
    model.trim() !== (initialHarness && initialHarness.kind !== "custom" ? initialHarness.model : "") ||
    executable.trim() !== (initialHarness?.executable ?? "") ||
    (custom && JSON.stringify(args) !== JSON.stringify(initialHarness?.kind === "custom" ? initialHarness.args : [])) ||
    maximumInputBytes !== String(initialHarness?.maximumInputBytes ?? 0) ||
    paths.length !== (initialHarness?.paths.length ?? 0) ||
    paths.some((path, i) => path !== initialHarness?.paths[i]);
  const boundsDirty = originsText !== (initialHarness?.origins ?? []).join("\n")
    || executablesText !== (initialHarness?.executables ?? []).join("\n")
    || bindingsText !== (initialHarness?.secretBindings ?? []).map(({ name, secret }) => `${name}=${secret}`).join("\n")
    || JSON.stringify(capabilities) !== JSON.stringify(initialHarness?.capabilities ?? []);
  // Errors show only after a Save attempt, then follow the fields as they change.
  const [tried, setTried] = useState(false);
  const off = harness === null;
  const bytes = Number(maximumInputBytes);
  const maxInvalid = !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_EVIDENCE_BYTES;
  const typedPath = newPath.trim();
  const pathPending = typedPath !== "";
  const hasChanges = dirty || boundsDirty || pathPending;
  const maxError = tried && !off && maxInvalid ? `Enter a whole number from 1 to ${MAX_EVIDENCE_BYTES.toLocaleString("en-US")} bytes.` : null;
  const modelTyped = model.trim();
  const modelInvalid = !custom && modelTyped !== "" && !MODEL_SHAPE.test(modelTyped);
  const modelError = tried && !off && modelInvalid ? "Enter one model name with no spaces, like opus." : null;
  // A custom agent has no name Canonfig could look up on PATH, so it needs one.
  const executableInvalid = custom && executable.trim() === "";
  const executableError = tried && !off && executableInvalid ? "Enter the command or full path of your agent." : null;
  const argsInvalid = custom && args === null;
  const argsError = tried && !off && argsInvalid ? "Enter a JSON array of strings, such as [\"run\", \"--plan\"]." : null;
  const pathError = !off && pathPending && tried ? "Add this path or clear the field before saving." : null;
  // A typed but unadded path is part of the draft too, as it is for Save.
  const { dialog: leaveDialog } = useLeaveGuard(hasChanges, "the agent policy");
  const discard = () => {
    setMode(initial.mode);
    setHarness(initialHarness?.kind ?? null);
    setModel(initialHarness && initialHarness.kind !== "custom" ? initialHarness.model : "");
    setExecutable(initialHarness?.executable ?? "");
    setArgsText(joinArguments(initialHarness?.kind === "custom" ? initialHarness.args : []));
    setPaths(initialHarness?.paths ?? []);
    setMaximumInputBytes(String(initialHarness?.maximumInputBytes ?? 0));
    setNewPath("");
    setTried(false);
    setOriginsText((initialHarness?.origins ?? []).join("\n"));
    setExecutablesText((initialHarness?.executables ?? []).join("\n"));
    setBindingsText((initialHarness?.secretBindings ?? []).map(({ name, secret }) => `${name}=${secret}`).join("\n"));
    setCapabilities(initialHarness?.capabilities ?? []);
  };
  const save = async (confirmed?: SavedPolicy) => {
    if (confirmed) {
      setReview(null);
      if (await agent.save(confirmed)) {
        setTried(false);
        if (confirmed.harness) {
          setOriginsText(confirmed.harness.origins.join("\n"));
          setExecutablesText(confirmed.harness.executables.join("\n"));
          setBindingsText(confirmed.harness.secretBindings.map(({ name, secret }) => `${name}=${secret}`).join("\n"));
          setMaximumInputBytes(String(confirmed.harness.maximumInputBytes));
        }
      }
      return;
    }
    if (mode === null) return;
    if (off) {
      if (await agent.save({ ...initial, mode })) {
        discard();
        setMode(mode);
      }
      return;
    }
    setTried(true);
    const checks: Array<[boolean, string]> = [
      [modelInvalid, "ap-model"], [executableInvalid, "ap-exec"], [argsInvalid, "ap-args"],
      [maxInvalid, "ap-max"], [pathPending, "ap-path"],
      [!!originError, "ap-origins"], [!!bindingError, "ap-bindings"],
    ];
    const firstInvalid = checks.find(([bad]) => bad);
    if (firstInvalid) {
      const field = document.getElementById(firstInvalid[1]);
      const section = field?.closest("details");
      if (section) section.open = true;
      field?.focus();
      return;
    }
    const next: SavedPolicy = { mode, harness: harness === null ? null : {
      executable: executable.trim(), paths, maximumInputBytes: bytes, origins, executables, secretBindings: bindings, capabilities,
      executableAuthorizations: executables.map((entry) => initialHarness?.executableAuthorizations.find(({ executable: savedExecutable }) => savedExecutable === entry) ?? { executable: entry, behavior: "leaf" }),
      environmentNames: initialHarness?.environmentNames ?? [], argumentsDisclosed: initialHarness?.argumentsDisclosed ?? true,
      ...(harness === "custom" ? { kind: "custom", args: args ?? [] } : { kind: harness, model: modelTyped }),
    } };
    setReview(next);
  };
  const addPath = () => {
    if (!pathPending) return;
    if (!paths.includes(typedPath)) setPaths([...paths, typedPath]);
    setNewPath("");
  };
  return (
    <>
      <PageHeader
        crumbs={["Settings", "Agent policy"]}
        actions={
          <>
            <Button size="sm" variant="outline" disabled={agent.busy || hasChanges} onClick={agent.reload}>Reload settings</Button>
            {hasChanges && <Button size="sm" variant="ghost" disabled={agent.busy} onClick={discard}>Discard</Button>}
            <Button size="sm" variant="primary" disabled={(!hasChanges && (off || agent.harnessConfigured)) || mode === null || agent.busy} onClick={() => void save()}>{agent.busy ? "Saving…" : "Review settings"}</Button>
          </>
        }
      />
      <Body reloading={agent.loading || agent.harnessLoading}>
        <Column>
          {agent.error && <ErrorNotice title={agent.saveState.kind === "PolicyLastFailed" ? agent.savedMessage : undefined} error={agent.error} />}
          {agent.harnessError && <ErrorNotice title={agent.saveState.kind === "HarnessFailed" ? agent.savedMessage : agent.saveState.kind === "HarnessFirstFailed" ? "Harness not saved" : "Harness unavailable"} error={agent.harnessError} />}
          {agent.savedMessage && !agent.error && !agent.harnessError && <p role="status" className="mb-4 text-sm">{agent.savedMessage}</p>}
          <RadioGroup value={mode ?? ""} onValueChange={(value) => { if (value === "deterministic-only" || value === "agent-propose" || value === "agent-apply") setMode(value); }} disabled={agent.busy} aria-label="Agent policy" variant="settings" data-tour="agent-mode">
            {MODES.map((m) => (
              <Label
                key={m.value}
                htmlFor={`mode-${m.value}`}
                className={cn("flex cursor-pointer items-start gap-3 px-[16px] py-[12px] font-normal hover:bg-raised/40", mode === m.value && "bg-raised/60")}
              >
                <RadioGroupItem id={`mode-${m.value}`} value={m.value} className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span className="text-base font-medium">{m.label}</span>
                  <span className="text-sm text-pretty text-muted-foreground">{m.body}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>

          {!agent.harnessConfigured && !agent.harnessError && <p className="mt-4 text-sm text-muted-foreground">Harness not saved yet.</p>}
          {harness !== null && <div className="mt-8 grid gap-4" inert={agent.busy}>
            <SectionLabel>Harness bounds</SectionLabel>
            <div className={cn(settingsGroup, "max-sm:[&>div]:flex-col max-sm:[&>div]:items-start max-sm:[&>div]:gap-2")}>
              <SettingRow title="Agent harness" htmlFor="ap-harness">
                <Select value={harness} onValueChange={(value) => { if (value === "codex" || value === "claude" || value === "custom") setHarness(value); }}>
                  <SelectTrigger id="ap-harness" className="w-40" data-tour="agent-harness">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(agent.harnessLabels).map(([name, label]) => (
                      <SelectItem key={name} value={name}>
                        {label}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">Custom command</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
              {custom ? (
                <>
                  <SettingRow title="Command" htmlFor="ap-exec" description="Your agent's executable, by name or full path." error={executableError}>
                    <Input
                      id="ap-exec"
                      value={executable}
                      onChange={(e) => setExecutable(e.target.value)}
                      aria-invalid={!!executableError}
                      aria-describedby={executableError ? "ap-exec-note" : undefined}
                      placeholder="/usr/local/bin/my-agent"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-[28px] w-64 font-mono text-sm"
                    />
                  </SettingRow>
                  <SettingRow
                    title="Arguments (JSON)"
                    htmlFor="ap-args"
                    description={
                      <>
                        {initialHarness?.kind === "custom" && !initialHarness.argumentsDisclosed && " Stored arguments are hidden. Leave [] to keep them, or enter replacement arguments."}
                        Enter a JSON array of arguments, passed without a shell. Include your agent's own plan or read-only flag.
                        <Hint label="How a custom agent talks to Canonfig">
                          Canonfig writes the task as JSON to the command's standard input and reads a proposal as JSON from its standard output.{"\n"}Anything else is refused, and every proposed action is still checked against the bounds on this page.
                        </Hint>
                      </>
                    }
                    error={argsError}
                  >
                    <Input
                      id="ap-args"
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      aria-invalid={!!argsError}
                      aria-describedby={argsError ? "ap-args-note" : undefined}
                      placeholder={'["run", "--plan", "--json"]'}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-[28px] w-64 font-mono text-sm"
                    />
                  </SettingRow>
                </>
              ) : (
                <>
                  <SettingRow title="Model" htmlFor="ap-model" description="Blank uses the agent's default." error={modelError}>
                    <Input
                      id="ap-model"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      aria-invalid={!!modelError}
                      aria-describedby={modelError ? "ap-model-note" : undefined}
                      placeholder={MODEL_EXAMPLE[harness]}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-[28px] w-40 font-mono text-sm"
                    />
                  </SettingRow>
                  <SettingRow title="Executable" htmlFor="ap-exec" description={<>Blank runs <Mono>{harness}</Mono> from your PATH.</>}>
                    <Input
                      id="ap-exec"
                      value={executable}
                      onChange={(e) => setExecutable(e.target.value)}
                      placeholder={harness}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-[28px] w-40 font-mono text-sm"
                    />
                  </SettingRow>
                </>
              )}
              <SettingRow title="Max evidence per task" htmlFor="ap-max" error={maxError}>
                <Input
                  id="ap-max"
                  value={maximumInputBytes}
                  onChange={(e) => setMaximumInputBytes(e.target.value.replace(/\D/g, ""))}
                  aria-invalid={!!maxError}
                  aria-describedby={maxError ? "ap-max-note" : undefined}
                  inputMode="numeric"
                  autoComplete="off"
                  className="h-[28px] w-20 font-mono text-sm tabular-nums"
                />
                <span className="text-sm text-muted-foreground">bytes</span>
              </SettingRow>
            </div>
            <Field label="Writable paths" htmlFor="ap-path" hint="Everything else is read-only." error={pathError}>
              <div data-tour="agent-paths" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
                {paths.map((p) => (
                  <div key={p} title={p} className="flex h-8 items-center gap-2 rounded-md border border-border pr-1 pl-2.5">
                    <Mono className="min-w-0 truncate text-foreground">{p}</Mono>
                    <Button variant="ghost" size="icon-xs" className="ml-auto size-6 shrink-0 text-faint" data-remove="writable-paths" aria-label={`Remove ${p}`} onClick={(e) => removeKeepingFocus(e.currentTarget, () => setPaths(paths.filter((x) => x !== p)), "ap-path")}>
                      <X />
                    </Button>
                  </div>
                ))}
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addPath();
                  }}
                >
                  <Input
                    id="ap-path"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    aria-invalid={!!pathError}
                    aria-describedby={pathError ? "ap-path-note" : undefined}
                    placeholder="~/.cursor"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-[28px] font-mono text-sm"
                  />
                  <Button type="submit" variant="outline" size="sm" disabled={!newPath.trim()}>
                    Add path
                  </Button>
                </form>
              </div>
            </Field>
            <Field label="Allowed network origins" htmlFor="ap-origins" hint="One exact HTTPS origin per line, e.g. https://api.example.com." error={tried ? originError : undefined}>
              <Textarea id="ap-origins" value={originsText} onChange={(event) => setOriginsText(event.target.value)} autoComplete="off" spellCheck={false} aria-invalid={tried && !!originError} className="font-mono text-sm" rows={3} />
            </Field>
            <details className="mt-2">
              <summary className="h-7 cursor-pointer text-base leading-7 font-medium text-muted-foreground">Advanced authorization bounds</summary>
              <div className="mt-4 grid gap-4">
                <Field label="Allowed executables" htmlFor="ap-executables" hint="One leaf executable per line.">
                  <Textarea id="ap-executables" value={executablesText} onChange={(event) => setExecutablesText(event.target.value)} autoComplete="off" spellCheck={false} className="font-mono text-sm" rows={3} />
                </Field>
                {initialHarness?.executableAuthorizations.some(({ behavior }) => behavior === "script-interpreter") && <p className="text-sm text-muted-foreground">Saved execution models: {initialHarness.executableAuthorizations.map(({ executable, behavior }) => `${executable} (${behavior})`).join(", ")}.</p>}
                <Field label="Secret bindings" htmlFor="ap-bindings" hint="One ENV_NAME=secret-name per line." error={tried ? bindingError : undefined}>
                  <Textarea id="ap-bindings" value={bindingsText} onChange={(event) => setBindingsText(event.target.value)} autoComplete="off" spellCheck={false} aria-invalid={tried && !!bindingError} className="font-mono text-sm" rows={3} />
                </Field>
                {!!initialHarness?.environmentNames?.length && <div className={settingsGroup}>
                  <SettingRow title="Environment names">
                    <span className="text-sm">{initialHarness.environmentNames.join(", ")}</span>
                  </SettingRow>
                </div>}
                <SectionLabel className="mt-2">Capabilities</SectionLabel>
                <div className={settingsGroup}>
                  {CAPABILITIES.map(({ value, label, consequence }) => <Label key={value} className="flex cursor-pointer items-start gap-3 px-4 py-3 font-normal">
                    <Checkbox checked={capabilities.includes(value)} onCheckedChange={(checked) => setCapabilities(checked === true ? [...capabilities, value] : capabilities.filter((entry) => entry !== value))} />
                    <span><span className="font-medium">{label}</span><span className="mt-1 block text-sm text-muted-foreground">{consequence}</span></span>
                  </Label>)}
                </div>
              </div>
            </details>
          </div>}
        </Column>
      </Body>
      <ConfirmDialog open={review !== null} onOpenChange={(open) => { if (!open) setReview(null); }} title="Save agent settings?" confirm="Save settings" confirmVariant="primary" onConfirm={() => { if (review) void save(review); }}
        body={<div className="grid gap-3">
          <p>{MODES.find(({ value }) => value === review?.mode)?.label}</p>
          {CAPABILITIES.filter(({ value }) => review?.harness?.capabilities.includes(value)).map(({ value, label, consequence }) => <p key={value}><strong>{label}:</strong> {consequence}</p>)}
          {!review?.harness?.capabilities.length && <p>Capabilities: none.</p>}
        </div>} />
      {leaveDialog}
    </>
  );
}

/** Package managers a binding can name; mirrors the CLI's installer methods. */
const INSTALLER_METHODS: readonly InstallerChoice["method"][] = ["apt", "brew", "bun", "cargo", "npm", "pnpm", "uv", "winget"];

/**
 * Add an installer by hand: the method plus the exact executable, and for npm or pnpm run through Node, the
 * JavaScript entrypoint. Saving runs the same --version check as `canonfig installer set` before anything is written.
 */
function AddInstallerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const installers = useWorkspace().admin.installers;
  const [method, setMethod] = useState<InstallerChoice["method"]>(installers.detected[0]?.method ?? "brew");
  const found = installers.detected.find((choice) => choice.method === method);
  // Untouched fields follow the chosen method's detected path; typing takes over.
  const [executable, setExecutable] = useState<string | null>(null);
  const [entrypoint, setEntrypoint] = useState<string | null>(null);
  const executableValue = executable ?? found?.executable ?? "";
  const entrypointValue = entrypoint ?? found?.arguments[0] ?? "";
  const save = async () => {
    const saved = await installers.add({ method, executable: executableValue.trim(), arguments: entrypointValue.trim() ? [entrypointValue.trim()] : [] });
    if (saved) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add installer</DialogTitle>
          <DialogDescription>Canonfig checks it runs before saving.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Package manager" htmlFor="installer-method">
            <Select value={method} onValueChange={(value) => { const next = INSTALLER_METHODS.find((entry) => entry === value); if (next) { setMethod(next); setExecutable(null); setEntrypoint(null); } }}>
              <SelectTrigger id="installer-method" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>{INSTALLER_METHODS.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Executable" htmlFor="installer-executable">
            <Input id="installer-executable" className="font-mono text-sm" spellCheck={false} autoComplete="off" placeholder="/usr/bin/apt-get" value={executableValue} onChange={(event) => setExecutable(event.target.value)} />
          </Field>
          {(method === "npm" || method === "pnpm") && <Field label="Entrypoint" htmlFor="installer-entrypoint" hint="When the executable is Node: the npm-cli.js or pnpm.cjs file it runs.">
            <Input id="installer-entrypoint" className="font-mono text-sm" spellCheck={false} autoComplete="off" value={entrypointValue} onChange={(event) => setEntrypoint(event.target.value)} />
          </Field>}
          {installers.error && <ErrorNotice title="Not added" error={installers.error} />}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={installers.busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={installers.busy || !executableValue.trim()} onClick={() => void save()}>{installers.busy ? "Checking…" : "Add installer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InstallersView() {
  const installers = useWorkspace().admin.installers;
  const checking = installers.checking;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const cols = "120px minmax(200px,360px) 160px minmax(150px,1fr)";
  const bound = installers.data ?? [];
  const addButton = <Button size="sm" variant="primary" disabled={installers.busy} onClick={() => setAdding(true)}>Add installer</Button>;
  return (
    <>
      <PageHeader crumbs={["Settings", "Installers"]} actions={<>
        <Button size="sm" variant="outline" disabled={installers.busy} onClick={installers.reload}>Reload</Button>
        {bound.length > 0 && addButton}
      </>} />
      <Body reloading={installers.loading}>
        {installers.error && !adding && <div className="px-[18px] py-3"><ErrorNotice error={installers.error} /></div>}
        {installers.data && bound.length === 0 && installers.detected.length === 0 && (
          <EmptyState title="No installers set up" body="Add the package managers Canonfig may use to install tools on this machine." action={addButton} />
        )}
        {bound.length > 0 && <ListHead cols={cols} data-tour="installers-list">
          <span>Installer</span>
          <span>Executable</span>
          <span>Status</span>
          <span />
        </ListHead>}
        {bound.map((r) => (
          <ListRow key={r.name} cols={cols} data-tour="installers-list">
            <span className="font-medium">{r.name}</span>
            <div className="min-w-0"><Mono className={r.path === "-" ? "text-faint" : "text-foreground"}>{r.path === "-" ? "None" : r.path}</Mono>
              {r.arguments.length > 0 && <p className="break-all font-mono text-xs text-muted-foreground">{r.arguments.map(shq).join(" ")}</p>}
            </div>
            <span className={cn("text-sm", r.status === "bound" ? "text-ok" : "text-faint")}>{installers.checked === r.name ? "Verified this session" : r.status === "bound" ? "Bound" : "Not on this platform"}</span>
            <span className="flex justify-end gap-1">
              {r.status === "bound" && <Button variant="outline" size="xs" disabled={installers.busy} onClick={() => installers.check(r.name)}>
                {checking === r.name ? "Checking…" : "Check"}
              </Button>}
              <Button variant="ghost" size="xs" disabled={installers.busy} onClick={() => setRemoving(r.name)}>Remove</Button>
            </span>
          </ListRow>
        ))}
        {installers.detected.length > 0 && <Column>
          <SectionLabel action={bound.length === 0 ? addButton : undefined}>Found on this machine</SectionLabel>
          <div className={cn("mt-1", settingsGroup)}>
            {installers.detected.map((choice) => (
              <SettingRow key={choice.method} title={choice.method} description={<Mono className="break-all">{[choice.executable, ...choice.arguments].join(" ")}</Mono>}>
                <Button variant="outline" size="xs" disabled={installers.busy} onClick={() => void installers.add(choice)}>Add</Button>
              </SettingRow>
            ))}
          </div>
        </Column>}
      </Body>
      {adding && <AddInstallerDialog open onOpenChange={setAdding} />}
      <ConfirmDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }} title={`Remove the ${removing ?? ""} installer?`}
        body="Canonfig stops using it to install tools here until you add it again. Nothing is uninstalled."
        confirm="Remove" onConfirm={() => { if (removing) installers.remove(removing); }} />
    </>
  );
}


export function SetupView() {
  const ws = useWorkspace();
  const setup = ws.admin.setup;
  const installed = ws.admin.service.data?.manager.installed;
  if (ws.enrollmentBackend && ws.session) return <SetupJournal backend={ws.enrollmentBackend} session={ws.session}
    frame={(actions, content) => <><PageHeader crumbs={["Settings", "Setup"]} actions={actions} /><Body><Column>{content}</Column></Body></>} />;
  if (!setup) return null;
  const { phase, at } = setup.journal;
  const steps = setup.steps;
  const last = steps.length - 1;
  const primary =
    phase === "planned" ? (
      <Button size="sm" variant="primary" onClick={setup.approve}>
        Approve plan
      </Button>
    ) : phase === "approved" ? (
      <Button size="sm" variant="primary" onClick={setup.apply}>
        Apply
      </Button>
    ) : null;
  return (
    <>
      <PageHeader crumbs={["Settings", "Setup"]} actions={primary} />
      <Body>
        <Column>
          <SectionLabel action={<span className="text-xs text-faint tabular-nums">{setup.journalLabel}</span>}>
            {phase === "planned" ? "Plan" : phase === "complete" ? "Done" : "Approved plan"}
          </SectionLabel>
          <ol data-tour="setup-plan" className={cn("mt-1", settingsGroup)} aria-live="polite">
            {steps.map((s, i) => {
              const done = phase === "complete" || (phase === "paused" ? i < last : phase === "applying" && i < at);
              const running = phase === "applying" && i === at;
              const blocked = phase === "paused" && i === last;
              // A finished install step can't stay ticked once the service is removed elsewhere.
              const removed = done && s.id === "service" && !installed;
              // Canonfig can't check linger; Resume records the person's word for it, and the row says so.
              const marked = done && s.id === "linger";
              return (
                <li key={s.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-base">
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {removed ? (
                      <Warning className="size-3.5 text-warn" aria-label="Removed since setup" />
                    ) : done ? (
                      <Check className="size-3.5 text-ok" aria-label={marked ? "Marked done by you" : "Done"} />
                    ) : running ? (
                      <HourglassMedium className="size-3.5 text-muted-foreground" aria-label="Running" />
                    ) : blocked ? (
                      <Warning className="size-3.5 text-act" aria-label="Needs you" />
                    ) : (
                      <Circle className="size-3 text-faint" aria-label="Pending" />
                    )}
                  </span>
                  <span>{s.label}</span>
                  {removed ? (
                    <span className="ml-auto truncate text-sm text-warn">Removed since setup</span>
                  ) : marked ? (
                    <span className="ml-auto truncate text-sm text-muted-foreground">Marked done by you</span>
                  ) : (
                    <Mono className="ml-auto truncate text-faint">{s.detail}</Mono>
                  )}
                </li>
              );
            })}
          </ol>
          {phase === "applying" && <DitherProgress label="Applying setup" value={(at / last) * 100} className="mt-4" />}
          {phase === "paused" && (
            <div className="mt-5 grid gap-2">
              <p className="text-base">
                <Term term="Human Action Required">This step needs you.</Term> Canonfig never changes linger itself, so run this in a terminal, then resume.
              </p>
              <CommandBox>{setup.lingerCommand}</CommandBox>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={setup.resume}
                >
                  I ran it, resume setup
                </Button>
              </div>
            </div>
          )}
        </Column>
      </Body>
    </>
  );
}


/**
 * Where a problem can be fixed in the GUI, keyed by the CLI probe name or the demo's display name (lowercased,
 * spaces as dashes). Checks without an entry are fixed in a terminal (their message says how).
 */
const CHECK_ACTION: Record<string, { label: string; open: (ws: Workspace) => void }> = {
  harnesses: { label: "Edit list", open: (ws) => ws.role === "source" ? ws.navigate(workspaceHref("source", "profile", { profileTab: "harnesses" })) : ws.go("local") },
  "agent-adapter": { label: "Open agent policy", open: (ws) => ws.go("agent") },
  "configuration-agent": { label: "Open agent policy", open: (ws) => ws.go("agent") },
  "package-managers": { label: "Open installers", open: (ws) => ws.go("installers") },
  scheduler: { label: "Open schedule", open: (ws) => ws.go("schedule") },
  "native-scheduler": { label: "Open schedule", open: (ws) => ws.go("schedule") },
  source: { label: "Open sync", open: (ws) => ws.go("sync") },
};

/** Overview uses the same result rows as the health screen. */
export function useChecks() {
  return useWorkspace().admin.doctor.data ?? [];
}

export function DoctorView() {
  const ws = useWorkspace();
  const doctor = ws.admin.doctor;
  const running = doctor.busy;
  const [timeout, setTimeout] = useState("5000");
  const progress = doctor.progress;
  // A skipped check does not apply to this machine (a Source has no tunnel or schedule), so it is not shown.
  const relevant = (doctor.data ?? []).filter((check) => check.result !== "off");
  const issues = relevant.filter((check) => check.result === "warn" || check.result === "bad").length;
  const run = () => doctor.run(Number(timeout));
  // Opened from ⌘K "Run doctor" or the guide: start immediately, even if this page is already open.
  const { focus, go } = ws;
  useEffect(() => {
    if (focus !== "run") return;
    go("doctor", undefined, { replace: true });
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  // A fresh page has no result to show, so check once on open instead of showing an empty page.
  useEffect(() => {
    if (!doctor.data && !doctor.error && !running && focus !== "run") run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <PageHeader
        crumbs={["Settings", "Health check"]}
        actions={
          <Button size="sm" variant="primary" disabled={running} type="submit" form="doctor-check">
            {running ? "Checking…" : "Run checks"}
          </Button>
        }
      />
      <Body reloading={doctor.loading}>
        <Column>
          {doctor.error && <ErrorNotice error={doctor.error} />}
          {!doctor.data && running && <p className="mb-4 text-sm text-muted-foreground">Running checks…</p>}
          {doctor.data && <p role="status" className="mb-4 text-base font-medium">
            {issues === 0 ? "Everything checks out" : `${issues} ${issues === 1 ? "thing needs" : "things need"} attention`}
          </p>}
          {/* Only a failed share needs words: the Source can no longer see this machine's health. */}
          {doctor.data && !running && doctor.sourceReport?.status === "failed" && (
            <p className="-mt-2 mb-4 flex items-center gap-2 text-sm text-pretty text-muted-foreground">
              <StatusMark kind="warn" /> Results not shown on the Source: {doctor.sourceReport.detail}
            </p>
          )}
          <div className="mb-4 h-1.5">{running && progress !== undefined && <DitherProgress label="Running health check" value={progress} />}</div>
          <div data-tour="doctor-results" className={cn(relevant.length > 0 && "border-t border-border")} aria-live="polite">
            {relevant.map((d, i) => {
              const shown = !running || progress === undefined || progress > (i / relevant.length) * 100;
              const problem = shown && (d.result === "warn" || d.result === "bad");
              const action = problem ? CHECK_ACTION[d.check.toLowerCase().replaceAll(" ", "-")] : undefined;
              return (
                <div key={d.check} className="border-b border-border/70 py-2.5">
                  <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 text-base">
                    {!shown ? <Circle className="size-3 text-faint" aria-label="Waiting" /> : <StatusMark kind={d.result} />}
                    <span>{CHECK_LABEL[d.check] ?? d.check}</span>
                    {action && <Button variant="outline" size="xs" onClick={() => action.open(ws)}>{action.label}</Button>}
                  </div>
                  {/* A passing check needs no sentence; a problem says what is wrong and what to do. */}
                  {/* Commands get their own copy box below, so the sentence points at it instead of repeating it. */}
                  {problem && <p className="mt-1 ml-6.5 text-sm text-pretty text-muted-foreground"><CliText>{d.commands?.length ? d.detail.replace(/`[^`]+`/gu, d.commands.length === 1 ? "the command below" : "the commands below") : d.detail}</CliText></p>}
                  {problem && d.items && d.items.length > 0 && (
                    <ul className="mt-1 ml-6.5 grid gap-0.5">
                      {d.items.map((item) => <li key={item}><Mono className="text-xs break-all">{item}</Mono></li>)}
                    </ul>
                  )}
                  {problem && d.fix && (
                    <div className="mt-2 ml-6.5 grid gap-1.5">
                      <p className="text-sm text-pretty text-muted-foreground"><CliText>{d.fix.why}</CliText></p>
                      <CommandBox>{d.fix.command}</CommandBox>
                    </div>
                  )}
                  {problem && d.commands?.map((command, index) => <div className="mt-2 ml-6.5" key={index}><CommandBox>{command}</CommandBox></div>)}
                </div>
              );
            })}
          </div>
          <form id="doctor-check" className="mt-5" onSubmit={(event) => { event.preventDefault(); run(); }}>
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">Advanced checks</summary>
              <div className="mt-3 grid max-w-sm gap-2">
                <Label htmlFor="doctor-timeout">Timeout per probe (ms)</Label>
                <Input id="doctor-timeout" type="number" required min={1} max={300000} step={1} value={timeout} disabled={running} onChange={(event) => setTimeout(event.target.value)} />
              </div>
            </details>
          </form>
        </Column>
      </Body>
    </>
  );
}

/** The machine menu reads the same last check as this screen. */
export function useSelfUpdate() {
  const version = useWorkspace().admin.version;
  return [{ npmCli: version.npmCli, latest: version.latest }] as const;
}

const RESTART_COMMAND = "canonfig ui";

export function VersionView() {
  const ws = useWorkspace();
  const version = ws.admin.version;
  const [confirmation, setConfirmation] = useState<{ kind: "none" | "enable" | "disable" } | { kind: "install"; candidate: string }>({ kind: "none" });
  const closeConfirmation = (open: boolean) => { if (!open) setConfirmation({ kind: "none" }); };
  const enableFocus = useDialogReturnFocus(focusPageHeading);
  const on = version.data?.enabled;
  const available = !!on && version.checked?.status === "available";
  const updated = version.checked?.status === "updated";
  return <>
    <PageHeader crumbs={["Settings", "Version"]} actions={<>
      <Button size="sm" variant="outline" disabled={version.busy || updated || version.lifecycle.kind === "observation-lost"} onClick={version.reload}>Reload status</Button>
      {!on ? <Button size="sm" variant="primary" disabled={version.busy || updated || !version.data} onClick={() => setConfirmation({ kind: "enable" })}>Turn on updates…</Button>
        : <Button size="sm" variant="primary" disabled={version.busy || updated || version.lifecycle.kind === "observation-lost"} onClick={version.check}>{version.checking ? "Checking…" : "Check for updates"}</Button>}
    </>} />
    <Body reloading={version.loading}>
      <Column>
        {version.error && <ErrorNotice error={version.error} />}
        {version.lifecycle.kind === "observation-lost" && <div className="mt-3"><p>The update may still be running.</p><Button variant="outline" size="sm" onClick={version.resume}>Resume update observation</Button></div>}
        <SectionLabel>This machine</SectionLabel>
        <div className={cn("mt-1", settingsGroup)}>
          <SettingRow title="Version"><Mono className="text-foreground">{version.current}</Mono></SettingRow>
          <SettingRow title="Self-updates">
            <span className="inline-flex items-center gap-1.5 text-base"><StatusMark kind={on ? "ok" : "off"} />{version.data ? on ? "On" : "Off" : "Not loaded"}</span>
          </SettingRow>
          {version.npmCli && <SettingRow title="npm" description={<><Mono className="break-all">{version.npmCli}</Mono></>} />}
          {(on || version.checked) && <SettingRow title="Newest same-major release">
            <span className="inline-flex items-center gap-1.5 text-base" aria-live="polite">
              <StatusMark kind={available ? "warn" : version.checked?.status === "current" || updated ? "ok" : "off"} />
              {version.checking ? "Checking…" : version.checked ? `${version.checked.candidate}: ${version.checked.status}` : "Not checked yet"}
            </span>
          </SettingRow>}
        </div>
        {version.progress && <p role="status" className="mt-4 text-base capitalize">{version.progress.phase}{version.progress.candidate ? ` ${version.progress.candidate}` : ""}</p>}
        {version.checked && <p role="status" className="mt-4 text-sm text-pretty">{updated ? <>Canonfig {version.checked.candidate} is installed. Start <Mono>{RESTART_COMMAND}</Mono> again.</> : version.checked.detail}</p>}
        {updated && <p className="mt-2 text-sm">{version.checked?.detail}</p>}
        {version.checked?.status === "deferred" && <p className="mt-2 text-sm">Exit code 0</p>}
        {updated && <CommandBox>{RESTART_COMMAND}</CommandBox>}
        {available && <Button size="sm" variant="primary" className="mt-5" disabled={version.busy} onClick={() => setConfirmation({ kind: "install", candidate: version.latest! })}>Install {version.latest}…</Button>}
        {version.unfinished && <p className="mt-5 text-base text-warn">An interrupted operation needs attention before updates can proceed.</p>}
        {!on && version.unfinished && <Button size="sm" variant="outline" className="mt-2" disabled={version.busy || updated} onClick={() => ws.setView("sync")}>Open Sync</Button>}
        {on && <Button variant="destructive" size="sm" className="mt-6" disabled={version.busy || updated || version.lifecycle.kind === "observation-lost"} onClick={() => setConfirmation({ kind: "disable" })}>Turn off updates…</Button>}
        {ws.role === "source" && ws.admin.fleet !== null && <FleetUpdates />}
      </Column>
    </Body>
    <Dialog open={confirmation.kind === "enable"} onOpenChange={closeConfirmation}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md" {...enableFocus}>
        <EnableUpdatesForm unfinished={version.unfinished} onCancel={() => setConfirmation({ kind: "none" })} onEnable={(npmCli, confirmIdle) => { version.enable(npmCli, confirmIdle); setConfirmation({ kind: "none" }); }} />
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={confirmation.kind === "disable"} onOpenChange={closeConfirmation} title="Turn off Canonfig updates?"
      body="Manual and periodic self-updates stop on this machine. Source-driven Fleet Updates remain automatic. Backups and update records stay."
      confirm="Turn off updates" onConfirm={version.disable} />
    <ConfirmDialog open={confirmation.kind === "install"} onOpenChange={closeConfirmation} title={`Install Canonfig ${confirmation.kind === "install" ? confirmation.candidate : ""}?`}
      body="Stop every other Canonfig process and pause its schedules first. After installation, this GUI stops. Start canonfig ui again to use the installed version. Canonfig restarts nothing."
      confirm="Install update" onConfirm={version.apply} />
  </>;
}

/** An npm-cli.js path, as `self-update enable --npm-cli` takes it: absolute, ending in npm's bin/npm-cli.js. */
const NPM_CLI_SHAPE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)[\s\S]*[\\/]npm-cli\.js$/;

/**
 * The standalone opt-in form (`self-update enable --apply --confirm-idle --npm-cli <path>`).
 * Closing the dialog resets it. Older builds may lack command leases, so the person
 * confirms other processes are stopped; unfinished syncs still block enablement.
 */
function EnableUpdatesForm({ unfinished, onCancel, onEnable }: { unfinished: boolean; onCancel: () => void; onEnable: (npmCli: string, confirmIdle: boolean) => void }) {
  const ws = useWorkspace();
  const [path, setPath] = useState("");
  const [idle, setIdle] = useState(false);
  const [tried, setTried] = useState(false);
  const example = ws.admin.version.data?.platform === "win32"
    ? "C:\\Users\\you\\npm\\node_modules\\npm\\bin\\npm-cli.js"
    : `${ws.role === "source" ? "/home/you" : "/Users/you"}/.npm-global/lib/node_modules/npm/bin/npm-cli.js`;
  const pathError = tried && !NPM_CLI_SHAPE.test(path.trim()) ? "Enter the absolute path to npm's npm-cli.js file." : null;
  const idleError = tried && !idle ? "Tick this once every other Canonfig process is stopped and its schedules are paused." : null;
  const refusal = tried && !pathError && !idleError && unfinished ? "A sync was interrupted. Recover or abandon it on Sync first, then turn updates on." : null;
  return (
    <form
      className="contents"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!NPM_CLI_SHAPE.test(path.trim())) return e.currentTarget.querySelector<HTMLElement>("#npm-cli")?.focus();
        if (!idle) return e.currentTarget.querySelector<HTMLElement>("#npm-idle")?.focus();
        if (!unfinished) onEnable(path.trim(), idle);
      }}
    >
      <DialogHeader>
        <DialogTitle>Turn on Canonfig updates</DialogTitle>
        <DialogDescription className="text-base text-pretty">
          Canonfig updates itself with the npm you name here, in a global npm folder inside your home. Stop every other Canonfig process and pause its schedules first.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="npm's npm-cli.js" htmlFor="npm-cli" error={pathError} description={`The file itself, not an npm shortcut, like ${example}.`}>
          <Input
            id="npm-cli"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={example}
            aria-invalid={!!pathError}
            aria-describedby="npm-cli-note"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
          />
        </Field>
        <div className="grid gap-1.5">
          <Label htmlFor="npm-idle" className="flex cursor-pointer items-start gap-2.5 text-base font-normal">
            <Checkbox id="npm-idle" checked={idle} onCheckedChange={(c) => setIdle(c === true)} aria-invalid={!!idleError} aria-describedby={idleError ? "npm-idle-note" : undefined} className="mt-0.5" />
            I stopped every other Canonfig process and paused its schedules.
          </Label>
          {idleError && (
            <p id="npm-idle-note" role="alert" className="flex items-start gap-1.5 text-sm text-bad">
              <WarningCircle className="mt-0.5 size-3.5 shrink-0" />
              {idleError}
            </p>
          )}
        </div>
        {refusal && (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-pretty text-bad">
            <StatusMark kind="bad" className="mt-0.5" />
            {refusal}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Turn on updates
        </Button>
      </DialogFooter>
    </form>
  );
}

function FleetUpdates() {
  const ws = useWorkspace();
  const fleet = ws.admin.fleet;
  const [canary, setCanary] = useState("");
  const [confirmation, setConfirmation] = useState<"start" | "stop" | null>(null);
  if (fleet === null) return null;
  const running = fleet.data?.status === "running";
  const selected = ws.followers.find((follower) => follower.id === canary);
  return <section className="mt-10" aria-label="Fleet Update">
    <SectionLabel>Follower releases</SectionLabel>
    {fleet.error && <ErrorNotice error={fleet.error} />}
    <p className="mt-2 text-sm">Roll out this Source's {ws.admin.version.current} release. Followers update on their next sync, one at a time, after the canary proves Convergence.</p>
    <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); if (selected) setConfirmation("start"); }}>
      <Field label="Canary follower" htmlFor="fleet-canary">
        <Select value={canary} onValueChange={setCanary} disabled={running || fleet.busy || fleet.loading}>
          <SelectTrigger id="fleet-canary" className="min-w-52"><SelectValue placeholder="Choose a follower" /></SelectTrigger>
          <SelectContent>{ws.followers.map((follower) => <SelectItem key={follower.id} value={follower.id}>{follower.name}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Button type="submit" variant="primary" disabled={!selected || running || fleet.busy || fleet.loading}>Start Fleet Update…</Button>
      <Button type="button" variant="outline" disabled={fleet.busy} onClick={fleet.reload}>Refresh followers</Button>
      {running && <Button type="button" variant="destructive" disabled={fleet.busy} onClick={() => setConfirmation("stop")}>Stop rollout…</Button>}
    </form>
    {ws.followers.length === 0 && <p className="mt-3 text-sm">Enroll a follower before starting a Fleet Update.</p>}
    {fleet.data && <div className="mt-4" aria-live="polite">
      <p className="text-sm">{fleet.data.version}: {fleet.data.status}</p>
      <div className={cn("mt-2", settingsGroup)}>{fleet.data.followers.map((follower) => <SettingRow key={follower.id} title={follower.name} description={follower.detail}>
        <span className="text-sm">{follower.version ?? "Not reported"} · {follower.status}</span>
      </SettingRow>)}</div>
    </div>}
    <ConfirmDialog open={confirmation === "start"} onOpenChange={(open) => { if (!open) setConfirmation(null); }} title={`Roll out Canonfig ${ws.admin.version.current}?`}
      body={`${selected?.name ?? "The canary"} updates first, then the other enrolled followers. A failed health check halts the rollout; rollback is manual.`}
      confirm="Start rollout" onConfirm={() => fleet.start(canary)} />
    <ConfirmDialog open={confirmation === "stop"} onOpenChange={(open) => { if (!open) setConfirmation(null); }} title="Stop this rollout?"
      body="No more followers will be admitted. A follower already activating may finish. Installed releases and applied configuration stay in place."
      confirm="Stop rollout" onConfirm={fleet.stop} />
  </section>;
}

export function GuardView() {
  const { enrollmentBackend, role } = useWorkspace();
  return enrollmentBackend ? <LiveGuardSettings backend={enrollmentBackend} source={role === "source"} /> : null;
}

const CheckerDraft = Schema.Struct({ version: Schema.Literal(1), checker: Schema.optional(GuardChecker) });
const GuardSaved = Schema.Struct({ saved: Schema.Boolean });

interface GuardDraft {
  readonly policy: typeof GuardPolicy.Type;
  readonly digest: string;
  readonly rules: NonNullable<typeof GuardPolicy.Type["rules"]>;
  readonly checkerText: string | null;
}

function LiveGuardSettings({ backend, source }: { backend: WorkspaceBackend; source: boolean }) {
  const resources = useContext(LiveResourcesContext);
  const current = useLiveResource(backend, guardEndpoints.status, GuiGuardStatus, true);
  const actions = useLiveActions(backend, () => resources?.cache.invalidate([guardEndpoints.status]));
  const [draft, setDraft] = useState<GuardDraft | null>(null);
  const [consent, setConsent] = useState(false);
  const [invalidPolicy, setInvalidPolicy] = useState(false);
  const [scanReport, setScanReport] = useState<typeof GuardReport.Type | null>(null);
  const recorded = current.data?.latest;
  const latest = scanReport && (!recorded || scanReport.at >= recorded.at) ? scanReport : recorded;
  const policy = current.data?.policy;
  const digest = current.data?.digest;
  const checkerJson = (policy: typeof GuardPolicy.Type) => JSON.stringify({ version: 1, checker: policy.checker }, null, 2);
  const changed = draft !== null && (
    JSON.stringify(draft.rules) !== JSON.stringify(draft.policy.rules ?? {})
    || (draft.checkerText !== null && draft.checkerText !== checkerJson(draft.policy)) || consent
  );
  const { dialog: leaveDialog } = useLeaveGuard(changed, "the Guard policy");
  const busy = current.loading || actions.state.loading;
  const edit = (change: (draft: GuardDraft) => GuardDraft) => {
    if (policy && digest) setDraft((existing) => change(existing ?? {
      policy, digest, rules: policy.rules ?? {}, checkerText: null,
    }));
  };
  const cancelEdit = () => {
    setDraft(null);
    setConsent(false);
    setInvalidPolicy(false);
  };
  const save = () => {
    if (draft === null) return;
    let checker = draft.policy.checker;
    if (draft.checkerText !== null) {
      try {
        checker = Schema.decodeUnknownSync(CheckerDraft, { onExcessProperty: "error" })(JSON.parse(draft.checkerText)).checker;
      } catch {
        setInvalidPolicy(true);
        return;
      }
    }
    void actions.run(async (signal) => {
      const policy = { ...draft.policy, rules: Object.keys(draft.rules).length ? draft.rules : undefined, checker };
      await backend.request(guardEndpoints.status, GuardSaved, signal, {
        method: "PUT", body: { policy, digest: draft.digest, consent },
      });
      cancelEdit();
    });
  };
  const scan = () => void actions.run(async (signal) => {
    try {
      const operation = await actions.operation(guardEndpoints.scan, {}, signal);
      setScanReport(Schema.decodeUnknownSync(GuardReport)(operation.result));
    } catch (error) {
      if (error instanceof GuiRequestError && error.failure.guard) setScanReport(error.failure.guard);
      else throw error;
    }
  });
  const changeApproval = (change: typeof GuardApprovalChange.Type) => {
    if (!digest) return;
    void actions.run(async (signal) => {
      await backend.request(guardEndpoints.approval, GuardSaved, signal, {
        method: "POST", body: { change, digest },
      });
    });
  };
  return <>
    <PageHeader crumbs={["Settings", "Guard"]} actions={
      <>
        <Button variant="outline" size="sm" disabled={busy} onClick={scan}>Scan current folder</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => resources?.cache.invalidate([guardEndpoints.status])}>Reload status</Button>
      </>
    } />
    <Body reloading={current.loading}><Column>
      {current.error && <ErrorNotice error={current.error} />}
      {actions.state.error && <ErrorNotice error={actions.state.error} />}
      {(current.data || latest) && <div className={settingsGroup}>
        {current.data && <>
          <SettingRow title="Built-in rules">Offline</SettingRow>
          {source && <SettingRow title="Optional checker">{policy?.checker?.kind ?? "Off"}</SettingRow>}
          {source && policy?.checker?.authentication === "bearer-env" && <SettingRow title="Bearer credential">{current.data.bearerAvailable ? "Available" : "Missing"}</SettingRow>}
        </>}
        <SettingRow title={scanReport && latest === scanReport ? "Scan result" : "Last recorded scan"}>{latest
          ? `${latest.verdict} · ${latest.trigger} · ${latest.at}`
          : "No result recorded"}</SettingRow>
        {latest && <div className="px-4 pb-4">
          <p className="mt-2 text-sm">{latest.checked} files checked, {latest.unsupported} unsupported, {latest.unavailable} unavailable</p>
          <GuardFindings report={latest} />
          {latest.next && <p className="mt-2 text-sm">{latest.next}</p>}
        </div>}
      </div>}
      {current.data && digest && policy && <>
        <GuardApprovals status={current.data} latest={latest} disabled={busy || draft !== null} onChange={changeApproval} />
        <div className="mt-8">
          <SectionLabel>Rule overrides</SectionLabel>
          <div className={cn(settingsGroup, "max-sm:[&>div]:flex-col max-sm:[&>div]:items-start max-sm:[&>div]:gap-2")}>
            {Object.entries(guardRules).map(([code, severity]) => <SettingRow key={code} title={<Mono>{code}</Mono>} htmlFor={`rule-${code}`}>
              <Select disabled={busy} value={(draft?.rules ?? policy.rules)?.[code] ?? "default"} onValueChange={(value) => edit((existing) => {
                const rules = { ...existing.rules };
                if (value === "default") delete rules[code];
                else if (value === "warn" || value === "block" || value === "off") rules[code] = value;
                return { ...existing, rules };
              })}>
                <SelectTrigger id={`rule-${code}`} className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default ({severity})</SelectItem>
                  <SelectItem value="block">Block</SelectItem>
                  <SelectItem value="warn">Warn</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>)}
          </div>
        </div>
        {source && <div className="mt-8 space-y-3">
          <Label htmlFor="guard-policy">Checker policy</Label>
          <Textarea id="guard-policy" className="font-mono" rows={8} spellCheck={false} readOnly={draft?.checkerText == null || busy}
            value={draft?.checkerText ?? checkerJson(policy)}
            onChange={(event) => {
              const checkerText = event.target.value;
              edit((existing) => ({ ...existing, checkerText }));
              setInvalidPolicy(false);
            }} />
          {draft?.checkerText == null ? <Button variant="outline" disabled={busy} onClick={() => {
            edit((existing) => ({ ...existing, checkerText: checkerJson(existing.policy) }));
          }}>Edit checker policy</Button> : <>
            <Button variant="outline" disabled={busy} onClick={() => {
              const checkerText = JSON.stringify({ version: 1, checker: { kind: "http", endpoint: promptGuardLocalEndpoint } }, null, 2);
              edit((existing) => ({ ...existing, checkerText }));
              setConsent(false);
              setInvalidPolicy(false);
            }}>Prompt Guard 2 (local adapter)</Button>
            <Label className="flex items-start gap-2">
              <Checkbox checked={consent} disabled={busy} onCheckedChange={(checked) => setConsent(checked === true)} />
              I allow this checker to receive eligible instruction and script text. This can include confidential material. A local proxy can forward it, and remote services may charge for requests.
            </Label>
            {invalidPolicy && <p role="alert" className="text-bad">Enter a valid checker policy in JSON.</p>}
          </>}
        </div>}
        {draft !== null && <div className="mt-4 flex gap-2">
          <Button variant="primary" disabled={busy || (!changed && draft.checkerText === null)} onClick={save}>Save policy</Button>
          <Button variant="outline" disabled={busy} onClick={cancelEdit}>Cancel</Button>
        </div>}
      </>}
    </Column></Body>
    {leaveDialog}
  </>;
}

function GuardApprovals({ status, latest, disabled, onChange }: {
  status: typeof GuiGuardStatus.Type;
  latest: typeof GuardReport.Type | null | undefined;
  disabled: boolean;
  onChange: (change: typeof GuardApprovalChange.Type) => void;
}) {
  const [confirmation, setConfirmation] = useState<typeof GuardApprovalChange.Type | null>(null);
  const approvalKeys = new Set(status.approvals.map(({ item, digest }) => `${digest}:${item}`));
  const held = latest?.blockedItems?.filter(({ item, digest }) => !approvalKeys.has(`${digest}:${item}`)) ?? [];
  const approval = confirmation?.action === "approve" ? confirmation.approval : null;
  return <section className="mt-8" aria-label="Exact-version approvals">
    <SectionLabel>Exact-version approvals</SectionLabel>
    <div className={settingsGroup}>
      {status.approvals.length === 0 && <SettingRow title="No approvals" />}
      {status.approvals.map(({ item, digest, note, status }) => <SettingRow key={item} title={<Mono>{item}</Mono>}
        description={<><Mono>{digest.slice(0, 12)}</Mono> · {status}{note && <> · {note}</>}</>}>
        <Button variant="outline" size="sm" disabled={disabled} aria-label={`Revoke approval for ${item}`}
          onClick={() => setConfirmation({ action: "revoke", item })}>Revoke…</Button>
      </SettingRow>)}
      {held.map((approval) => <SettingRow key={`${approval.digest}:${approval.item}`} title={<Mono>{approval.item}</Mono>}
        description={<Mono>{approval.digest.slice(0, 12)}</Mono>}>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirmation({ action: "approve", approval })}>
          Approve this exact version
        </Button>
      </SettingRow>)}
    </div>
    <ConfirmDialog open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}
      title={approval ? "Approve this exact version?" : "Revoke exact-version approval?"}
      body={approval ? <>Guard will turn blocks for <Mono>{approval.item}</Mono> at <Mono>{approval.digest.slice(0, 12)}</Mono> into warnings on this machine.</>
        : <>Guard will apply the configured rules again for <Mono>{confirmation?.action === "revoke" && confirmation.item}</Mono>.</>}
      confirm={approval ? "Approve version" : "Revoke approval"} confirmVariant={approval ? "primary" : "destructive"}
      onConfirm={() => { if (confirmation && !disabled) onChange(confirmation); }} />
  </section>;
}
