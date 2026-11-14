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
import { CliText, DitherProgress, Hint, Mono, StatusMark, Term } from "@/shared/shared";
import { shq } from "@/shared/shell";
import { ErrorNotice } from "@/live/session";
import { SetupJournal } from "@/onboarding/enrollment-controller";
import { useWorkspace, type Workspace } from "./store";
import type { InstallerChoice, SavedPolicy } from "./administration-types";
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
  // Errors show only after a Save attempt, then follow the fields as they change.
  const [tried, setTried] = useState(false);
  const off = mode === "deterministic-only" || harness === null;
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
    setHarness(initialHarness?.kind ?? null);
    setModel(initialHarness && initialHarness.kind !== "custom" ? initialHarness.model : "");
    setExecutable(initialHarness?.executable ?? "");
    setArgsText(joinArguments(initialHarness?.kind === "custom" ? initialHarness.args : []));
    setPaths(initialHarness?.paths ?? []);
    setMaximumInputBytes(String(initialHarness?.maximumInputBytes ?? 0));
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
    const next: SavedPolicy = { mode, harness: harness === null ? null : {
      executable: executable.trim(), paths, maximumInputBytes: bytes, origins: initialHarness?.origins ?? [],
      ...(harness === "custom" ? { kind: "custom", args: args ?? [] } : { kind: harness, model: modelTyped }),
    } };
    if (await agent.save(next)) {
      setMaximumInputBytes(String(bytes));
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
            <Button size="sm" variant="primary" disabled={(!hasChanges && (off || agent.harnessConfigured)) || mode === null || agent.busy} onClick={() => void save()}>{agent.busy ? "Saving…" : "Save policy"}</Button>
          </>
        }
      />
      <Body reloading={agent.loading || agent.harnessLoading}>
        <Column>
          {agent.error && <ErrorNotice error={agent.error} />}
          {agent.harnessError && <ErrorNotice title="Harness unavailable" error={agent.harnessError} />}
          {agent.savedMessage && <p role="status" className="mb-4 text-sm">{agent.savedMessage}</p>}
          <RadioGroup value={mode ?? ""} onValueChange={(value) => { if (value === "deterministic-only" || value === "agent-propose" || value === "agent-apply") setMode(value); }} disabled={agent.busy} aria-label="Agent policy" className={settingsGroup} data-tour="agent-mode">
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
          {/* inert keeps the disabled bounds out of the tab order, not just greyed out. */}
          {harness !== null && <div className={cn("mt-8 grid gap-4", off && "opacity-40")} inert={off || agent.busy}>
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
            <Field label="Allowed network origins" description="Requests anywhere else are blocked.">
              <div className="flex flex-wrap gap-1">
                {(initialHarness?.origins ?? []).map((o) => (
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

/** Plain names for the CLI's doctor probes; the demo's names are already plain and pass through. */
const CHECK_LABEL: Record<string, string> = {
  runtime: "Node.js runtime", state: "Local database", credentials: "Credential storage", source: "Connection to the Source",
  scheduler: "Update schedule", "package-managers": "Package managers", "agent-adapter": "AI agent", harnesses: "AI coding tools",
};

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
  const progress = doctor.progress;
  // A skipped check does not apply to this machine (a Source has no tunnel or schedule), so it is not shown.
  const relevant = (doctor.data ?? []).filter((check) => check.result !== "off");
  const issues = relevant.filter((check) => check.result === "warn" || check.result === "bad").length;
  const run = doctor.run;
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
          <Button size="sm" variant="primary" disabled={running} onClick={run}>
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
          <SettingRow title="Updates">
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
      </Column>
    </Body>
    <Dialog open={confirmation.kind === "enable"} onOpenChange={closeConfirmation}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md" {...enableFocus}>
        <EnableUpdatesForm unfinished={version.unfinished} onCancel={() => setConfirmation({ kind: "none" })} onEnable={(npmCli, confirmIdle) => { version.enable(npmCli, confirmIdle); setConfirmation({ kind: "none" }); }} />
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={confirmation.kind === "disable"} onOpenChange={closeConfirmation} title="Turn off Canonfig updates?"
      body="Canonfig stops checking for and installing updates on this machine. The backups of earlier versions and the update records stay."
      confirm="Turn off updates" onConfirm={version.disable} />
    <ConfirmDialog open={confirmation.kind === "install"} onOpenChange={closeConfirmation} title={`Install Canonfig ${confirmation.kind === "install" ? confirmation.candidate : ""}?`}
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
