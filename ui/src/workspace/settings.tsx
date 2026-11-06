// Settings shared by both machine roles where the feature exists on both.
import { useEffect, useState } from "react";
import { Check, Circle, HourglassMedium, Warning, WarningCircle, X } from "@/components/icons";
import { cn, removeKeepingFocus } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DitherProgress, Hint, Mono, StatusMark, Term } from "@/shared/shared";
import { DEMO } from "@/shared/metadata";
import { shq } from "@/shared/shell";
import { ErrorNotice } from "@/live/session";
import { SetupJournal } from "@/onboarding/enrollment-controller";
import { useWorkspace } from "./store";
import type { SavedPolicy } from "./administration-types";
export type { SavedPolicy } from "./administration-types";
import { Body, CommandBox, Field, ListHead, ListRow, PageHeader, SectionLabel, SettingRow, settingsGroup, useDialogReturnFocus, useLeaveGuard } from "./kit";
import { focusPageHeading } from "./routes";


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

export function Lede({ children }: { children: React.ReactNode }) {
  return <p className="mb-6 max-w-[70ch] text-base text-pretty text-muted-foreground">{children}</p>;
}


function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: React.ReactNode;
  confirm: string;
  onConfirm: () => void;
}) {
  // Cancel returns to the button that asked; confirming often removes it, so focus then goes to the page heading.
  const returnFocus = useDialogReturnFocus(focusPageHeading);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md" {...returnFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-base text-pretty">{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
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
  const [address, setAddress] = useState<"127.0.0.1" | "::1" | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const endpoint = report ? new URL(report.endpoint) : null;
  const hostname = address ?? (endpoint?.hostname === "[::1]" ? "::1" : "127.0.0.1");
  const portValue = port ?? endpoint?.port ?? "17342";
  const validPort = /^\d+$/.test(portValue) && Number(portValue) >= 1 && Number(portValue) <= 65535;
  const installed = report?.manager.installed;
  return (
    <>
      <PageHeader crumbs={["Settings", "Source service"]} actions={
        <>
          <Button size="sm" variant="outline" disabled={service.busy} onClick={service.reload}>Reload status</Button>
          {report && (!installed || !service.restart) && <Button size="sm" variant="primary" disabled={service.busy || !validPort} onClick={() => service.install(hostname, Number(portValue))}>
            {service.action === "install" ? "Installing…" : installed ? "Update service" : "Install service"}
          </Button>}
        </>
      } />
      <Body reloading={service.loading}>
        <Column>
          <Lede>Your other machines fetch signed revisions from this <Term term="Source Machine">Source</Term> through the source service. It runs in the background under your user account.</Lede>
          {service.error && <ErrorNotice error={service.error} />}
          <SectionLabel>Status</SectionLabel>
          <div data-tour="service-status" className={cn("mt-1", settingsGroup)}>
            <SettingRow title="State" description={report?.detail}>
              <span className="inline-flex items-center gap-1.5 text-base">
                <StatusMark kind={!report || !installed ? "off" : report.state === "running" ? "ok" : "warn"} />
                {service.since && report?.state === "running" ? `Running since ${service.since}` : report?.state.replaceAll("-", " ") ?? "Status unavailable"}
              </span>
            </SettingRow>
            <SettingRow title="Endpoint" description="Other machines fetch revisions from this address."><Mono className="text-foreground">{report?.endpoint ?? "Not loaded"}</Mono></SettingRow>
            <SettingRow title="Managed by" description={report?.mechanism}><Mono className="text-foreground">{report?.serviceName ?? "Not loaded"}</Mono></SettingRow>
            {report && !service.restart && <SettingRow title="Native manager" description={report.manager.state}>
              {report.manager.active ? "Active" : "Inactive"} · {report.manager.enabled ? "Enabled" : "Disabled"} · {report.manager.matches ? "Definition matches" : "Definition differs"}
            </SettingRow>}
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
            <SettingRow title="Listen address" htmlFor="source-service-host"><Select value={hostname} onValueChange={(value) => setAddress(value === "::1" ? "::1" : "127.0.0.1")}>
              <SelectTrigger id="source-service-host" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="127.0.0.1">127.0.0.1</SelectItem><SelectItem value="::1">::1</SelectItem></SelectContent>
            </Select></SettingRow>
            <SettingRow title="Port" htmlFor="source-service-port" error={!validPort ? "Enter a port from 1 to 65535." : null}>
              <Input id="source-service-port" className="w-28 font-mono" inputMode="numeric" value={portValue} onChange={(event) => setPort(event.target.value)} aria-invalid={!validPort} />
            </SettingRow>
          </div>}
          {installed && <div className="mt-4 flex items-center gap-2">
            {capabilities.serviceRestart && service.restart && <Button variant="outline" size="sm" disabled={service.busy} onClick={service.restart}>{service.action === "restart" ? "Restarting…" : "Restart"}</Button>}
            <Button variant="destructive" size="sm" disabled={service.busy} onClick={() => setConfirm(true)}>Remove service…</Button>
          </div>}
          {report && !service.restart && <div className={cn("mt-5", settingsGroup)}>
            {report.definitionPath && <SettingRow title="Service definition"><Mono>{report.definitionPath}</Mono></SettingRow>}
            <SettingRow title="Serving revisions">{report.serving ? "Yes" : "No"}</SettingRow>
            <SettingRow title="Supported modes">{report.supportedModes}</SettingRow>
            <SettingRow title="Logs"><Mono>{report.logs}</Mono></SettingRow>
          </div>}
        </Column>
      </Body>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Remove the source service?"
        body="Your other machines can't fetch new revisions until you install it again. Your profile, revisions and machine identities are kept."
        confirm="Remove service" onConfirm={service.remove} />
    </>
  );
}

function modes(source: boolean) {
  return [
    {
      value: "deterministic-only",
      label: "Deterministic only",
      body: "Canonfig never calls an agent. Anything without an exact recipe waits for a person (Canonfig calls this Human Action Required).",
    },
    {
      value: "agent-propose",
      label: "Agent proposes",
      body: source
        ? "An agent may draft a fix as a proposed profile change. Nothing changes until you publish it."
        : "An agent may draft a fix as a proposed profile change. Nothing changes until the Source publishes it.",
    },
    {
      value: "agent-apply",
      label: "Agent applies",
      body: "An agent may apply fixes on this machine within the bounds below. Each job it does is recorded.",
    },
  ] as const;
}

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MODEL_EXAMPLE: Record<string, string> = { codex: "gpt-5-codex", claude: "opus" };
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

/** Shared summaries read the same saved policy as the editor. */
export function useAgentPolicy() {
  return [useWorkspace().admin.agent.data] as const;
}

export function AgentPolicyView() {
  const { admin } = useWorkspace();
  const agent = admin.agent;
  if (agent.loading || agent.harnessLoading) return <>
    <PageHeader crumbs={["Settings", "Agent policy"]} actions={<Button size="sm" variant="outline" disabled={agent.busy} onClick={agent.reload}>Reload settings</Button>} />
    <Body reloading={agent.loading || agent.harnessLoading}><Column>
      {agent.error && <ErrorNotice error={agent.error} />}
      <Lede>Choose whether an AI agent may help when Canonfig has no exact recipe.</Lede>
      <div className={settingsGroup}><SettingRow title="Agent policy">Not loaded</SettingRow><SettingRow title="Harness bounds">Not loaded</SettingRow></div>
    </Column></Body>
  </>;
  return <AgentPolicyForm saved={agent.data} />;
}

function AgentPolicyForm({ saved }: { saved: SavedPolicy | null }) {
  const ws = useWorkspace();
  const agent = ws.admin.agent;
  // No policy is selected until the CLI reports one or the person chooses one.
  const initial = saved ?? { mode: null, harness: null, model: "", executable: "", args: [], paths: [], maximumInputBytes: 0, origins: [] };
  const [mode, setMode] = useState<SavedPolicy["mode"] | null>(initial.mode);
  const [harness, setHarness] = useState(initial.harness);
  const [model, setModel] = useState(initial.model);
  const [executable, setExecutable] = useState(initial.executable);
  // JSON keeps the CLI's exact argv entries on a round trip.
  const [argsText, setArgsText] = useState(joinArguments(initial.args));
  const [paths, setPaths] = useState<string[]>(initial.paths);
  const [newPath, setNewPath] = useState("");
  // A digits-only string while editing; Save stores it as a number.
  const [maximumInputBytes, setMaximumInputBytes] = useState(String(initial.maximumInputBytes));
  const custom = harness === "custom";
  const args = splitArguments(argsText);
  const dirty =
    mode !== initial.mode ||
    harness !== initial.harness ||
    model.trim() !== initial.model ||
    executable.trim() !== initial.executable ||
    (custom && JSON.stringify(args) !== JSON.stringify(initial.args)) ||
    maximumInputBytes !== String(initial.maximumInputBytes) ||
    paths.length !== initial.paths.length ||
    paths.some((path, i) => path !== initial.paths[i]);
  // Errors show only after a Save attempt, then follow the fields as they change.
  const [tried, setTried] = useState(false);
  const off = mode === "deterministic-only" || harness === null || !agent.harnessWritable;
  const bytes = Number(maximumInputBytes);
  const maxInvalid = !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_EVIDENCE_BYTES;
  const typedPath = newPath.trim();
  const pathPending = typedPath !== "";
  const hasChanges = dirty || pathPending;
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
    setHarness(initial.harness);
    setModel(initial.model);
    setExecutable(initial.executable);
    setArgsText(joinArguments(initial.args));
    setPaths(initial.paths);
    setMaximumInputBytes(String(initial.maximumInputBytes));
    setNewPath("");
    setTried(false);
  };
  const save = async () => {
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
    ];
    const firstInvalid = checks.find(([bad]) => bad);
    if (firstInvalid) {
      document.getElementById(firstInvalid[1])?.focus();
      return;
    }
    const next = { mode, harness, model: custom ? "" : modelTyped, executable: executable.trim(), args: custom ? (args ?? []) : [], paths, maximumInputBytes: bytes, origins: initial.origins };
    if (await agent.save(next)) {
      setMaximumInputBytes(String(bytes));
      setModel(next.model);
      setExecutable(next.executable);
      setArgsText(joinArguments(next.args));
      setTried(false);
    }
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
            <Button size="sm" variant="primary" disabled={(!hasChanges && agent.configured && (off || agent.harnessConfigured)) || mode === null || agent.busy} onClick={() => void save()}>{agent.busy ? "Saving…" : "Save policy"}</Button>
          </>
        }
      />
      <Body reloading={agent.loading || agent.harnessLoading}>
        <Column>
          <Lede>
            Choose whether an <Term term="Configuration Agent">AI agent</Term> may help when Canonfig has no exact recipe.
          </Lede>
          {!agent.configured && saved && <p role="status" className="mb-4 text-sm text-muted-foreground">Not configured yet. These are the CLI defaults. Save policy to create the configuration.</p>}
          {agent.error && <ErrorNotice error={agent.error} />}
          {agent.harnessError && <ErrorNotice title="Harness unavailable" error={agent.harnessError} />}
          {agent.savedMessage && <p role="status" className="mb-4 text-sm">{agent.savedMessage}</p>}
          <RadioGroup value={mode ?? ""} onValueChange={(value) => { if (value === "deterministic-only" || value === "agent-propose" || value === "agent-apply") setMode(value); }} disabled={agent.busy} aria-label="Agent policy" className={settingsGroup} data-tour="agent-mode">
            {modes(ws.role === "source").map((m) => (
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

          {!agent.harnessWritable && <p className="mt-4 text-sm text-muted-foreground">Harness settings apply only to enrolled Followers. Saving here changes the Source policy.</p>}
          {agent.harnessWritable && !agent.harnessConfigured && !agent.harnessError && <p className="mt-4 text-sm text-muted-foreground">Harness not configured yet. The fields below show defaults, not saved settings.</p>}
          {/* inert keeps the disabled bounds out of the tab order, not just greyed out. */}
          {harness !== null && <div className={cn("mt-8 grid gap-4", off && "opacity-40")} inert={off || agent.busy}>
            <SectionLabel>Harness bounds</SectionLabel>
            <div className={cn(settingsGroup, "max-sm:[&>div]:flex-col max-sm:[&>div]:items-start max-sm:[&>div]:gap-2")}>
              <SettingRow title="Agent harness" htmlFor="ap-harness" description="The agent CLI Canonfig starts for each job.">
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
                  <SettingRow title="Model" htmlFor="ap-model" description="Leave empty to use the agent's own default." error={modelError}>
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
                  <SettingRow title="Executable" htmlFor="ap-exec" description={<>Leave empty to run <Mono>{harness}</Mono> from your PATH.</>}>
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
              <SettingRow title="Max evidence per task" htmlFor="ap-max" description="How much observed state Canonfig may hand the agent." error={maxError}>
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
            <Field label="Writable paths" htmlFor="ap-path" hint="The agent's sandbox can write only here. Everything else is read-only." error={pathError}>
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
            <Field label="Allowed network origins" description="Requests anywhere else are blocked.">
              <div className="flex flex-wrap gap-1">
                {initial.origins.map((o) => (
                  <span key={o} className="rounded border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
                    {o}
                  </span>
                ))}
              </div>
            </Field>
          </div>}
        </Column>
      </Body>
      {leaveDialog}
    </>
  );
}

export function InstallersView() {
  const installers = useWorkspace().admin.installers;
  const checking = installers.checking;
  const cols = "120px minmax(200px,360px) 160px minmax(90px,1fr)";
  return (
    <>
      <PageHeader crumbs={["Settings", "Installers"]} actions={<Button size="sm" variant="outline" disabled={installers.busy} onClick={installers.reload}>Reload installers</Button>} />
      <Body reloading={installers.loading}>
        <div className="flex items-center gap-1.5 border-b border-border px-[18px] py-3 text-sm text-muted-foreground">
          Installer bindings point tool recipes at a package manager on this machine.
          <Hint label="installer bindings">{"Tools in canonfig.jsonc carry an installation recipe per platform, like brew on macOS or apt on Linux.\nA binding points that recipe at a real executable."}</Hint>
        </div>
        {installers.error && <div className="px-[18px] py-3"><ErrorNotice error={installers.error} /></div>}
        {installers.data?.length === 0 && <p className="px-[18px] py-3 text-sm text-muted-foreground">No installer bindings are configured. Use canonfig installer set in a terminal.</p>}
        <ListHead cols={cols} data-tour="installers-list">
          <span>Installer</span>
          <span>Executable</span>
          <span>Status</span>
          <span />
        </ListHead>
        {installers.data?.map((r) => (
          <ListRow key={r.name} cols={cols} data-tour="installers-list">
            <span className="font-medium">{r.name}</span>
            <div className="min-w-0"><Mono className={r.path === "-" ? "text-faint" : "text-foreground"}>{r.path === "-" ? "None" : r.path}</Mono>
              {r.arguments.length > 0 && <p className="break-all font-mono text-xs text-muted-foreground">{r.arguments.map(shq).join(" ")}</p>}
            </div>
            <span className={cn("text-sm", r.status === "bound" ? "text-ok" : "text-faint")}>{installers.checked === r.name ? "Verified this session" : r.status === "bound" ? "Bound" : "Not on this platform"}</span>
            {r.status === "bound" ? (
              <Button
                variant="outline"
                size="xs"
                className="justify-self-end"
                disabled={installers.busy}
                onClick={() => installers.check(r.name)}
              >
                {checking === r.name ? "Checking…" : "Check"}
              </Button>
            ) : (
              <span />
            )}
          </ListRow>
        ))}
        {installers.suggestions.length > 0 && <Column><SectionLabel>Suggested bindings</SectionLabel>
          {installers.suggestions.map((suggestion) => <CommandBox key={suggestion.method}>{suggestion.command}</CommandBox>)}
        </Column>}
      </Body>
    </>
  );
}


export function SetupView() {
  const ws = useWorkspace();
  const setup = ws.admin.setup;
  const installed = ws.admin.service.data?.manager.installed;
  if (ws.enrollmentBackend && ws.session) return <>
    <PageHeader crumbs={["Settings", "Setup"]} />
    <Body><Column><SetupJournal backend={ws.enrollmentBackend} session={ws.session} /></Column></Body>
  </>;
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
          <Lede>
            The setup command writes each step to a journal before running it, so an interrupted setup resumes where it stopped.
            {DEMO && " In this demo, progress carries on while you visit other pages, and is lost on reload or when you switch roles."}
          </Lede>
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

/** Overview uses the same result rows as the health screen. */
export function useChecks() {
  return useWorkspace().admin.doctor.data ?? [];
}

export function DoctorView() {
  const ws = useWorkspace();
  const doctor = ws.admin.doctor;
  const running = doctor.busy;
  const progress = doctor.progress;
  const checks = doctor.data ?? [];
  const run = doctor.run;
  // Opened from ⌘K "Run doctor" or the guide: start immediately, even if this page is already open.
  const { focus, go } = ws;
  useEffect(() => {
    if (focus !== "run") return;
    go("doctor", undefined, { replace: true });
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  return (
    <>
      <PageHeader
        crumbs={["Settings", "Health check"]}
        actions={
          <Button size="sm" variant="primary" disabled={running} onClick={run}>
            {running ? "Checking…" : "Run checks"}
          </Button>
        }
      />
      <Body reloading={doctor.loading}>
        <Column>
          <Lede>The health check (Canonfig calls it doctor) tests whether this machine can run Canonfig. Copying a recovery command does not run it.</Lede>
          {doctor.error && <ErrorNotice error={doctor.error} />}
          {doctor.status && <p role="status" className="mb-4 text-sm">Health: {doctor.status}</p>}
          {!doctor.data && <p className="mb-4 text-sm text-muted-foreground">{running ? "Running checks…" : "Run checks to read this machine's current health."}</p>}
          <div className="mb-4 h-1.5">{running && progress !== undefined && <DitherProgress label="Running health check" value={progress} />}</div>
          <div data-tour="doctor-results" className="border-t border-border" aria-live="polite">
            {checks.map((d, i) => {
              const shown = !running || progress === undefined || progress > (i / checks.length) * 100;
              return (
                <div key={d.check} className="border-b border-border/70 py-2.5">
                  <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-base sm:grid-cols-[14px_auto_minmax(0,1fr)]">
                    {!shown ? (
                      <Circle className="size-3 text-faint" aria-label="Waiting" />
                    ) : (
                      <StatusMark kind={d.result} />
                    )}
                    <span>{d.check}</span>
                    <span className="col-start-2 text-sm text-muted-foreground sm:col-start-3 sm:text-right">{shown ? d.detail : "Waiting"}</span>
                  </div>
                  {shown && d.fix && (
                    <div className="mt-2 ml-6.5 grid gap-1.5">
                      <p className="text-sm text-pretty text-muted-foreground">{d.fix.why}</p>
                      <CommandBox>{d.fix.command}</CommandBox>
                    </div>
                  )}
                  {shown && d.commands?.map((command, index) => <div className="mt-2 ml-6.5" key={index}><CommandBox>{command}</CommandBox></div>)}
                </div>
              );
            })}
          </div>
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
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [installing, setInstalling] = useState(false);
  const enableFocus = useDialogReturnFocus(focusPageHeading);
  const on = version.data?.enabled;
  const releaseLine = version.current.split(".").slice(0, 2).join(".");
  const available = version.checked?.status === "available";
  const updated = version.checked?.status === "updated";
  return <>
    <PageHeader crumbs={["Settings", "Canonfig version"]} actions={<>
      <Button size="sm" variant="outline" disabled={version.busy || updated} onClick={version.reload}>Reload status</Button>
      {!on ? <Button size="sm" variant="primary" disabled={version.busy || updated || !version.data} onClick={() => setEnabling(true)}>Turn on updates…</Button>
        : <Button size="sm" variant="primary" disabled={version.busy || updated} onClick={version.check}>{version.checking ? "Checking…" : "Check for updates"}</Button>}
    </>} />
    <Body reloading={version.loading}>
      <Column>
        <Lede>Canonfig can update itself to new patch releases from npm. It stays in the {releaseLine} line: moving to a newer minor or major version is a step you take on every machine together, by hand.</Lede>
        {version.error && <ErrorNotice error={version.error} />}
        <SectionLabel>This machine</SectionLabel>
        <div className={cn("mt-1", settingsGroup)}>
          <SettingRow title="Version"><Mono className="text-foreground">{version.current}</Mono></SettingRow>
          <SettingRow title="Updates" description={on ? `Patches in the ${releaseLine} line, installed when you choose to.` : "Opt in to patch updates from npm."}>
            <span className="inline-flex items-center gap-1.5 text-base"><StatusMark kind={on ? "ok" : "off"} />{version.data ? on ? "On" : "Off" : "Not loaded"}</span>
          </SettingRow>
          {version.npmCli && <SettingRow title="npm" description={<><Mono className="break-all">{version.npmCli}</Mono><br />Canonfig fetches only its own package from registry.npmjs.org, with install scripts off.</>} />}
          {(on || version.checked) && <SettingRow title="Newest patch">
            <span className="inline-flex items-center gap-1.5 text-base" aria-live="polite">
              <StatusMark kind={available ? "warn" : version.checked?.status === "current" ? "ok" : "off"} />
              {version.checking ? "Checking…" : version.checked ? `${version.checked.candidate}: ${version.checked.status}` : "Not checked yet"}
            </span>
          </SettingRow>}
        </div>
        {version.progress && <p role="status" className="mt-4 text-base capitalize">{version.progress.phase}{version.progress.candidate ? ` ${version.progress.candidate}` : ""}</p>}
        {version.checked && <p role="status" className="mt-4 text-sm text-pretty">{updated ? <>Canonfig {version.checked.candidate} is installed. Start <Mono>{RESTART_COMMAND}</Mono> again.</> : version.checked.detail}</p>}
        {updated && DEMO && <p className="mt-2 text-sm">{version.checked?.detail}</p>}
        {version.checked?.status === "deferred" && <p className="mt-2 text-sm">Exit code 0</p>}
        {updated && <CommandBox>{RESTART_COMMAND}</CommandBox>}
        {available && <Button size="sm" variant="primary" className="mt-5" disabled={version.busy} onClick={() => setInstalling(true)}>Install {version.latest}…</Button>}
        {version.unfinished && <p className="mt-5 text-base text-warn">An interrupted operation needs attention before updates can proceed.</p>}
        {!on && version.unfinished && <Button size="sm" variant="outline" className="mt-2" disabled={version.busy || updated} onClick={() => ws.setView("sync")}>Open Sync</Button>}
        {on && <Button variant="destructive" size="sm" className="mt-6" disabled={version.busy || updated} onClick={() => setDisabling(true)}>Turn off updates…</Button>}
      </Column>
    </Body>
    <Dialog open={enabling} onOpenChange={setEnabling}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md" {...enableFocus}>
        <EnableUpdatesForm unfinished={version.unfinished} onCancel={() => setEnabling(false)} onEnable={(npmCli, confirmIdle) => { version.enable(npmCli, confirmIdle); setEnabling(false); }} />
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={disabling} onOpenChange={setDisabling} title="Turn off Canonfig updates?"
      body="Canonfig stops checking for and installing patches on this machine. The backups of earlier versions and the update records stay."
      confirm="Turn off updates" onConfirm={version.disable} />
    <ConfirmDialog open={installing} onOpenChange={setInstalling} title={`Install Canonfig ${version.latest}?`}
      body="Stop every other Canonfig process and pause its schedules first. After installation, this GUI stops. Start canonfig ui again to use the installed version. Canonfig restarts nothing."
      confirm="Install update" onConfirm={version.apply} />
  </>;
}

/** An npm-cli.js path, as `self-update enable --npm-cli` takes it: absolute, ending in npm's bin/npm-cli.js. */
const NPM_CLI_SHAPE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)[\s\S]*[\\/]npm-cli\.js$/;

/**
 * The opt-in form (`self-update enable --apply --confirm-idle --npm-cli <path>`). It lives inside the dialog's content,
 * so closing the dialog resets it. Canonfig can't see processes started before opting in, so the person confirms
 * they're stopped; an interrupted sync refuses the opt-in, as the CLI does.
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
          Canonfig updates itself with the npm you name here, in a global npm folder inside your home. Stop every other Canonfig process and pause its schedules first:
          ones started earlier can't tell an update they're running.
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
