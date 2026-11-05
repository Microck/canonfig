// Settings shared by both machine roles where the feature exists on both.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { APP_VERSION, DEMO, LATEST_PATCH, agentPolicy, doctor, installers, selfUpdateSeed } from "@/shared/data";
import { useSharedReader, useSharedState, useWorkspace } from "./store";
import { Body, CommandBox, Field, ListHead, ListRow, PageHeader, SectionLabel, SettingRow, settingsGroup, useDialogReturnFocus, useLeaveGuard } from "./kit";
import { focusPageHeading } from "./routes";
import { updateGate } from "./update-gate";

const LINGER_FIX = "sudo loginctl enable-linger ubuntu";
/** Ends the toasts below, which report simulated work; only the demo says where it happened. */
const IN_DEMO = DEMO ? " in this demo workspace" : "";

/**
 * Absolute (`/`), home (`~` or `~/`) or explicitly relative (`./`), on one line. A shape check only:
 * the demo can't see this machine's filesystem, so it never claims the path exists.
 * Used by Writable paths.
 */
const PATH_SHAPE = /^(?:~|(?:\/|~\/|\.\/)[^\r\n]*)$/;
const PATH_SHAPE_ERROR = "Enter a path that starts with /, ~/ or ./.";

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

/** A setInterval that is cleared when the screen unmounts mid-run. */
function useTicker() {
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);
  return (fn: () => boolean, ms: number) => {
    window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      if (fn()) window.clearInterval(timer.current);
    }, ms);
  };
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

/** Reinstalling keeps the port onboarding chose; 17342 is the CLI's default. */
function installCommand(endpoint: string) {
  const port = new URL(endpoint).port;
  return `canonfig source service install${port === "17342" ? "" : ` --port ${port}`}`;
}

/** The seeded start time; installs and restarts in this session replace it with the current time. */
const SERVICE_SINCE_SEED = "Monday 08:12";

function startedNow() {
  return `today ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export function ServiceView() {
  const ws = useWorkspace();
  // Shared so a removal survives navigation and the sidebar status line reads the same truth.
  const [installed, setInstalled] = useSharedState("service-installed", true);
  // Shared rather than page state: leaving and returning mid-operation keeps the guard, so a second
  // action can't start before the first lands. ws.later runs for the role's lifetime and is
  // cancelled when the demo switches roles, so a result never appears in the other role.
  const [busy, setBusy] = useSharedState<string | null>("service-busy", null);
  const [since, setSince] = useSharedState("service-since", SERVICE_SINCE_SEED);
  // Set when the person resumes setup after its linger step (SetupView).
  const [lingerMarked] = useSharedState("linger-marked", false);
  const [confirm, setConfirm] = useState(false);
  const act = (next: boolean, label: string, msg: string) => {
    setBusy(label);
    ws.later(() => {
      setInstalled(next);
      if (next) setSince(startedNow());
      setBusy(null);
      toast.success(msg);
    }, 800);
  };
  return (
    <>
      <PageHeader
        crumbs={["Settings", "Source service"]}
        actions={
          !installed ? (
            <Button
              size="sm"
              variant="primary"
              disabled={!!busy}
              onClick={() => act(true, "install", `Source service installed${IN_DEMO}`)}
            >
              {busy === "install" ? "Installing…" : "Install service"}
            </Button>
          ) : undefined
        }
      />
      <Body>
        <Column>
          <Lede>
            Your other machines fetch signed revisions from this <Term term="Source Machine">Source</Term> through the source service. It runs in the background under your user account.
          </Lede>
          <SectionLabel>Status</SectionLabel>
          <div data-tour="service-status" className={cn("mt-1", settingsGroup)}>
            <SettingRow title="State">
              <span className="inline-flex items-center gap-1.5 text-base">
                <StatusMark kind={installed ? "ok" : "off"} />
                {installed ? `Running since ${since}` : "Not installed"}
              </span>
            </SettingRow>
            <SettingRow title="Endpoint" description="Other machines fetch revisions from this address.">
              <Mono className="text-foreground">{ws.endpoint}</Mono>
            </SettingRow>
            <SettingRow title="Managed by" description="systemd user unit">
              <Mono className="text-foreground">canonfig-source.service</Mono>
            </SettingRow>
            {/* Linger only matters for a service that exists. */}
            {installed && (
              <SettingRow title="Keeps running">
                {lingerMarked ? (
                  <span className="inline-flex items-center gap-1.5 text-base">
                    <Check className="size-3.5 text-ok" /> Also after you log out
                    <Hint label="Keeps running">{"You marked linger as turned on when you resumed setup.\nCanonfig didn't check it."}</Hint>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-base text-warn">
                    <Warning className="size-3.5" /> Only while you're logged in
                    <Hint label="Keeps running">
                      Linger is off, so systemd stops the service when you log out. Canonfig never turns linger on.{"\n"}To keep the service running, run {LINGER_FIX} yourself.
                    </Hint>
                  </span>
                )}
              </SettingRow>
            )}
          </div>
          {installed && (
            <div className="mt-4 flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act(true, "restart", `Source service restarted${IN_DEMO}`)}>
                {busy === "restart" && <HourglassMedium />} {busy === "restart" ? "Restarting…" : "Restart"}
              </Button>
              <Button variant="destructive" size="sm" className="ml-4" disabled={!!busy} onClick={() => setConfirm(true)}>
                Remove service…
              </Button>
            </div>
          )}
        </Column>
      </Body>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Remove the source service?"
        body="Your other machines can't fetch new revisions until you install it again. Your profile, revisions and machine identities are kept."
        confirm="Remove service"
        onConfirm={() => act(false, "remove", `Source service removed${DEMO ? " from this demo workspace" : ""}`)}
      />
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

export interface SavedPolicy {
  mode: string;
  /** "codex" | "claude" (built-ins) or "custom". */
  harness: string;
  /** Built-ins only; "" means the agent's own default model. */
  model: string;
  /** "" runs a built-in from PATH by its name; required for custom. */
  executable: string;
  /** Custom only: one argv entry each, run without a shell. */
  args: string[];
  paths: string[];
  /** Whole kilobytes, 1 to MAX_EVIDENCE_KB. */
  maxKb: number;
}

/** 1 MiB in KB, the most `canonfig agent harness --maximum-input-bytes` accepts (1024 * 1024 bytes). */
const MAX_EVIDENCE_KB = 1024;

const POLICY_SEED: SavedPolicy = { mode: agentPolicy.mode, harness: agentPolicy.harness, model: "", executable: "", args: [], paths: agentPolicy.writablePaths, maxKb: agentPolicy.maxInputKb };

/** Built-in harnesses and the versions the demo reports as installed, shared by the picker and the health check. */
const HARNESS_VERSION: Record<string, string> = { codex: "0.62", claude: "2.1" };

/** Typed into the model field as hints only; any name the CLI accepts works. */
const MODEL_EXAMPLE: Record<string, string> = { codex: "gpt-5-codex", claude: "opus" };

/** Mirrors the CLI: one token, never starting with "-", so it can't become a second flag. */
const MODEL_SHAPE = /^[^\s-]\S*$/u;

/** Whole field: entries separated by whitespace; an entry is "quoted", 'quoted' or has no quotes. */
const ARGS_SHAPE = /^\s*(?:(?:"[^"]*"|'[^']*'|[^\s"']+)\s*)*$/u;

/**
 * Splits the custom arguments field into argv entries. Quotes keep spaces inside one entry;
 * there is no shell, so nothing else is special. Null when a quote is unclosed or mid-entry.
 */
function splitArguments(text: string): string[] | null {
  if (!ARGS_SHAPE.test(text)) return null;
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/gu)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/** Inverse of splitArguments: entries with spaces get double quotes. */
function joinArguments(args: string[]): string {
  return args.map((a) => (/\s/u.test(a) ? `"${a}"` : a)).join(" ");
}

/** The saved agent policy. Health check and Overview read it so their summaries match this page. */
export function useAgentPolicy() {
  return useSharedState("agent-policy", POLICY_SEED);
}

export function AgentPolicyView() {
  const ws = useWorkspace();
  // The form edits a draft; Save writes it to shared state so it outlives this page.
  const [saved, setSaved] = useAgentPolicy();
  const [mode, setMode] = useState(saved.mode);
  const [harness, setHarness] = useState(saved.harness);
  const [model, setModel] = useState(saved.model);
  const [executable, setExecutable] = useState(saved.executable);
  // Edited as text; Save stores the split argv. Re-joined with quotes so a round trip is lossless.
  const [argsText, setArgsText] = useState(joinArguments(saved.args));
  const [paths, setPaths] = useState<string[]>(saved.paths);
  const [newPath, setNewPath] = useState("");
  // A digits-only string while editing; Save stores it as a number.
  const [maxKb, setMaxKb] = useState(String(saved.maxKb));
  const custom = harness === "custom";
  const args = splitArguments(argsText);
  const dirty =
    mode !== saved.mode ||
    harness !== saved.harness ||
    model.trim() !== saved.model ||
    executable.trim() !== saved.executable ||
    (custom && JSON.stringify(args) !== JSON.stringify(saved.args)) ||
    maxKb !== String(saved.maxKb) ||
    paths.length !== saved.paths.length ||
    paths.some((path, i) => path !== saved.paths[i]);
  // Errors show only after a Save attempt, then follow the fields as they change.
  const [tried, setTried] = useState(false);
  // Set by an Add path attempt, so a half-typed path isn't flagged while it is still being typed.
  const [addTried, setAddTried] = useState(false);
  const off = mode === "deterministic-only";
  // The input strips non-digits, so the invalid values left are blank, zero and too large.
  // Number() of a very long digit string is huge or Infinity, so the upper bound catches it too.
  const kb = Number(maxKb);
  const maxInvalid = !(kb >= 1 && kb <= MAX_EVIDENCE_KB);
  const typedPath = newPath.trim();
  const pathPending = typedPath !== "";
  const hasChanges = dirty || pathPending;
  const maxError = tried && !off && maxInvalid ? `Enter a whole number from 1 to ${MAX_EVIDENCE_KB.toLocaleString("en-US")} KB.` : null;
  const modelTyped = model.trim();
  const modelInvalid = !custom && modelTyped !== "" && !MODEL_SHAPE.test(modelTyped);
  const modelError = tried && !off && modelInvalid ? "Enter one model name with no spaces, like opus." : null;
  // A custom agent has no name Canonfig could look up on PATH, so it needs one.
  const executableInvalid = custom && executable.trim() === "";
  const executableError = tried && !off && executableInvalid ? "Enter the command or full path of your agent." : null;
  const argsInvalid = custom && args === null;
  const argsError = tried && !off && argsInvalid ? "Close the quote, or remove it." : null;
  // A malformed path says so after either attempt; a well-formed one only needs adding before Save.
  const pathError = off || !pathPending
    ? null
    : (addTried || tried) && !PATH_SHAPE.test(typedPath)
      ? PATH_SHAPE_ERROR
      : tried
        ? "Add this path or clear the field before saving."
        : null;
  // A typed but unadded path is part of the draft too, as it is for Save.
  const { dialog: leaveDialog } = useLeaveGuard(hasChanges, "the agent policy");
  const save = () => {
    if (off) {
      // With the agent off the bounds are unused and inert, so they can't be checked or fixed here.
      // Saving keeps the last saved bounds and resets the greyed-out fields to match them.
      setSaved({ ...saved, mode });
      setHarness(saved.harness);
      setModel(saved.model);
      setExecutable(saved.executable);
      setArgsText(joinArguments(saved.args));
      setPaths(saved.paths);
      setMaxKb(String(saved.maxKb));
      setNewPath("");
      setAddTried(false);
    } else {
      setTried(true);
      const checks: Array<[boolean, string]> = [
        [modelInvalid, "ap-model"],
        [executableInvalid, "ap-exec"],
        [argsInvalid, "ap-args"],
        [maxInvalid, "ap-max"],
        [pathPending, "ap-path"],
      ];
      const firstInvalid = checks.find(([bad]) => bad);
      if (firstInvalid) {
        document.getElementById(firstInvalid[1])?.focus();
        return;
      }
      // Normalizes leading zeros in the field ("064" becomes "64").
      setMaxKb(String(kb));
      // Fields that don't apply to the chosen harness are stored empty, as the CLI would.
      setSaved({ mode, harness, model: custom ? "" : modelTyped, executable: executable.trim(), args: custom ? (args ?? []) : [], paths, maxKb: kb });
    }
    setTried(false);
    toast.success(`Agent policy saved${IN_DEMO}`);
  };
  const addPath = () => {
    if (!pathPending) return;
    setAddTried(true);
    if (!PATH_SHAPE.test(typedPath)) {
      document.getElementById("ap-path")?.focus();
      return;
    }
    if (!paths.includes(typedPath)) setPaths([...paths, typedPath]);
    setNewPath("");
    setAddTried(false);
  };
  return (
    <>
      <PageHeader
        crumbs={["Settings", "Agent policy"]}
        actions={
          // A typed but unadded path counts as an edit, so Save can say it still needs Add path.
          <Button size="sm" variant="primary" disabled={!hasChanges} onClick={save}>
            Save policy
          </Button>
        }
      />
      <Body>
        <Column>
          <Lede>
            Choose whether an <Term term="Configuration Agent">AI agent</Term> may help when Canonfig has no exact recipe.
          </Lede>
          <RadioGroup value={mode} onValueChange={setMode} aria-label="Agent policy" className={settingsGroup} data-tour="agent-mode">
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

          {/* inert keeps the disabled bounds out of the tab order, not just greyed out. */}
          <div className={cn("mt-8 grid gap-4", off && "opacity-40")} inert={off}>
            <SectionLabel>Harness bounds</SectionLabel>
            <div className={cn(settingsGroup, "max-sm:[&>div]:flex-col max-sm:[&>div]:items-start max-sm:[&>div]:gap-2")}>
              <SettingRow title="Agent harness" htmlFor="ap-harness" description="The agent CLI Canonfig starts for each job.">
                <Select value={harness} onValueChange={setHarness}>
                  <SelectTrigger id="ap-harness" className="w-40" data-tour="agent-harness">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(HARNESS_VERSION).map(([name, version]) => (
                      <SelectItem key={name} value={name}>
                        {name} {version}
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
                    title="Arguments"
                    htmlFor="ap-args"
                    description={
                      <>
                        Passed exactly as written, with no shell. Quote an argument that contains spaces. Include your agent's own plan or read-only flag.
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
                      placeholder="run --plan --json"
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
                  value={maxKb}
                  onChange={(e) => setMaxKb(e.target.value.replace(/\D/g, ""))}
                  aria-invalid={!!maxError}
                  aria-describedby={maxError ? "ap-max-note" : undefined}
                  inputMode="numeric"
                  autoComplete="off"
                  className="h-[28px] w-20 font-mono text-sm tabular-nums"
                />
                <span className="text-sm text-muted-foreground">KB</span>
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
                {agentPolicy.origins.map((o) => (
                  <span key={o} className="rounded border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
                    {o}
                  </span>
                ))}
              </div>
            </Field>
          </div>
        </Column>
      </Body>
      {leaveDialog}
    </>
  );
}

export function InstallersView() {
  const ws = useWorkspace();
  // Shared and finished through ws.later for the same reasons as the service's busy state:
  // the guard survives leaving the page, and switching roles cancels the result.
  const [checking, setChecking] = useSharedState<string | null>("installer-checking", null);
  const cols = "120px minmax(200px,360px) 160px minmax(90px,1fr)";
  return (
    <>
      <PageHeader crumbs={["Settings", "Installers"]} />
      <Body>
        <div className="flex items-center gap-1.5 border-b border-border px-[18px] py-3 text-sm text-muted-foreground">
          Installer bindings point tool recipes at a package manager on this machine.
          <Hint label="installer bindings">{"Tools in canonfig.jsonc carry an installation recipe per platform, like brew on macOS or apt on Linux.\nA binding points that recipe at a real executable."}</Hint>
        </div>
        <ListHead cols={cols} data-tour="installers-list">
          <span>Installer</span>
          <span>Executable</span>
          <span>Status</span>
          <span />
        </ListHead>
        {installers.map((r) => (
          <ListRow key={r.name} cols={cols} data-tour="installers-list">
            <span className="font-medium">{r.name}</span>
            <Mono className={r.path === "-" ? "text-faint" : "text-foreground"}>{r.path === "-" ? "None" : r.path}</Mono>
            <span className={cn("text-sm", r.status === "bound" ? "text-ok" : "text-faint")}>{r.status === "bound" ? "Bound" : "Not on this platform"}</span>
            {r.status === "bound" ? (
              <Button
                variant="outline"
                size="xs"
                className="justify-self-end"
                disabled={checking !== null}
                onClick={() => {
                  setChecking(r.name);
                  ws.later(() => {
                    setChecking(null);
                    toast.success(`${r.name} check passed${IN_DEMO}`, { description: r.path });
                  }, 600);
                }}
              >
                {checking === r.name ? "Checking…" : "Check"}
              </Button>
            ) : (
              <span />
            )}
          </ListRow>
        ))}
      </Body>
    </>
  );
}

/** The Source's `canonfig setup plan` steps (src/setup), in order, then the one step a person does. */
const SETUP_STEPS = [
  { id: "keys", label: "Initialize the Source", detail: "Signing key in Secret Service" },
  { id: "state", label: "Create the Canonfig folder", detail: "~/.canonfig" },
  { id: "profile", label: "Write canonfig.jsonc with your harnesses", detail: "~/.canonfig/canonfig.jsonc" },
  { id: "import", label: "Import what you chose from your harnesses", detail: "Into ~/.canonfig" },
  { id: "service", label: "Install source service", detail: "systemd user unit" },
  { id: "linger", label: "You turn on linger", detail: LINGER_FIX },
];

interface Journal {
  phase: "planned" | "approved" | "applying" | "paused" | "complete";
  /** Index of the step running now. */
  at: number;
}

const JOURNAL_SEED: Journal = { phase: "planned", at: 0 };

export function SetupView() {
  const ws = useWorkspace();
  // Shared so approval and progress survive moving between this role's pages. Like all demo state they
  // end on reload (or a Demo switch); only the real command's journal outlives that, and the Lede says so.
  const [journal, setJournal] = useSharedState("setup-journal", JOURNAL_SEED);
  // Setup's install step and the person's linger step feed the same state Service and Health read,
  // so Done never disagrees with them.
  const [installed, setInstalled] = useSharedState("service-installed", true);
  const [, setSince] = useSharedState("service-since", SERVICE_SINCE_SEED);
  const [, setLingerMarked] = useSharedState("linger-marked", false);
  const { phase, at } = journal;
  const steps = SETUP_STEPS;
  const last = steps.length - 1;
  const serviceStep = steps.findIndex((s) => s.id === "service");
  const apply = () => {
    setJournal({ phase: "applying", at: 0 });
    // Chained ws.later steps: setup keeps applying while the user looks at another page of this
    // role and each step lands in shared state, but switching roles cancels it.
    const advance = (i: number): void =>
      ws.later(() => {
        // Step i - 1 just finished.
        if (i - 1 === serviceStep) {
          setInstalled(true);
          if (!installed) setSince(startedNow());
        }
        if (i < last) {
          setJournal({ phase: "applying", at: i });
          advance(i + 1);
          return;
        }
        setJournal({ phase: "paused", at: i });
        toast("Setup paused at a step that needs you", { description: `Run ${LINGER_FIX}, then resume.` });
      }, 500);
    advance(1);
  };
  const primary =
    phase === "planned" ? (
      <Button size="sm" variant="primary" onClick={() => setJournal({ phase: "approved", at: 0 })}>
        Approve plan
      </Button>
    ) : phase === "approved" ? (
      <Button size="sm" variant="primary" onClick={apply}>
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
          <SectionLabel action={<span className="text-xs text-faint tabular-nums">Journal #3</span>}>
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
              <CommandBox>{LINGER_FIX}</CommandBox>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setJournal({ phase: "complete", at: last });
                    setLingerMarked(true);
                    toast.success(`Setup complete${IN_DEMO}`, { description: "You marked the linger step done.\nCanonfig didn't check it." });
                  }}
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

interface DoctorCheck {
  check: string;
  result: "ok" | "warn";
  detail: string;
  /** What a warning asks the user to run, and why. */
  fix?: { why: string; command: string };
}

/**
 * The static doctor rows, adjusted to this workspace: the follower is a Mac reaching atlas
 * over SSH, and the service, linger, tunnel and agent rows report what their settings pages last did.
 * Overview's health summary reads this too, so both agree.
 */
export function useChecks(): DoctorCheck[] {
  const ws = useWorkspace();
  const [installed] = useSharedState("service-installed", true);
  const [lingerMarked] = useSharedState("linger-marked", false);
  const [tunnelUp] = useSharedState("tunnel-up", true);
  const [policy] = useAgentPolicy();
  const agent: Partial<DoctorCheck> =
    policy.mode === "deterministic-only" ? { detail: "Not used: agent policy is deterministic only" } : { detail: policy.harness === "custom" ? `${policy.executable} found` : `${policy.executable || policy.harness} ${HARNESS_VERSION[policy.harness]} found` };
  // The harnesses probe warns about listed harnesses that are not installed and not excluded here
  // (src/runtime/doctor.ts); excluding one on this machine clears it.
  const missing = ws.harnesses.filter((h) => h.listed && !h.installed && !h.excluded);
  const harnessCheck: Partial<DoctorCheck> = missing.length
    ? {
        result: "warn",
        detail: `Not installed: ${missing.map((h) => h.name).join(", ")} ${missing.length === 1 ? "gets" : "get"} nothing on this machine`,
        fix: { why: "Install it, or exclude it on this machine so Canonfig stops reporting it.", command: `canonfig harnesses exclude ${missing[0].id}` },
      }
    : { detail: `${ws.harnesses.filter((h) => h.listed && h.installed && !h.excluded).length} listed harnesses installed` };
  const overrides: Record<string, Partial<DoctorCheck>> =
    ws.role === "source"
      ? {
          "Source service": installed
            ? { detail: `Listening on ${new URL(ws.endpoint).host}` }
            : {
                result: "warn",
                detail: "Not installed: other machines can't fetch revisions",
                fix: { why: "Install it so other machines can fetch new revisions.", command: installCommand(ws.endpoint) },
              },
          // Marked by the person when resuming setup; Canonfig never checks or changes linger itself.
          // Omitted below while the service is absent, matching the Service page.
          Linger: lingerMarked
            ? { result: "ok", detail: "On: you marked it done in setup" }
            : { fix: { why: "To keep user services running after you log out, run this yourself. Canonfig won't change it.", command: LINGER_FIX } },
          "Configuration Agent": agent,
          Harnesses: harnessCheck,
        }
      : {
          "Credential storage": { detail: "macOS Keychain unlocked" },
          "Native scheduler": { detail: "launchd user agent" },
          "Source service": !ws.tunnelConfigured
            ? { check: "SSH tunnel", detail: "Not set up" }
            : tunnelUp
              ? { check: "SSH tunnel", detail: "Connected to atlas" }
              : {
                  check: "SSH tunnel",
                  result: "warn",
                  detail: "Stopped: updates fail until you start it",
                  fix: { why: "Start it so this machine can fetch updates from atlas.", command: "canonfig tunnel start" },
                },
          Linger: { result: "ok", detail: "Not used on macOS" },
          "Package managers": { detail: "brew and npm found" },
          "Configuration Agent": agent,
          Harnesses: harnessCheck,
        };
  const checks = doctor.map((c) => ({ ...c, ...overrides[c.check] }));
  // Linger only matters for a service that exists; the Source service warning already covers its absence.
  return ws.role === "source" && !installed ? checks.filter((c) => c.check !== "Linger") : checks;
}

export function DoctorView() {
  const ws = useWorkspace();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(100);
  const tick = useTicker();
  const checks = useChecks();
  // The run's interval closes over the render that started it; the finish toast reads this
  // instead, so a service or linger change made mid-run is reflected (same pattern as guide.tsx).
  const latest = useRef(checks);
  latest.current = checks;
  const run = () => {
    setRunning(true);
    setProgress(0);
    let v = 0;
    tick(() => {
      v += 10;
      setProgress(v);
      if (v < 100) return false;
      setRunning(false);
      ws.reach("health-check");
      const final = latest.current;
      const warned = final.filter((c) => c.result === "warn");
      toast("Health check finished", { description: `${final.length - warned.length} passed${warned.length ? `\nWarning: ${warned.map(warningName).join(", ")}` : ""}` });
      return true;
    }, 120);
  };
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
      <Body>
        <Column>
          <Lede>The health check (Canonfig calls it doctor) tests whether this machine can run Canonfig. It changes nothing, and each problem lists the command that fixes it.</Lede>
          <div className="mb-4 h-1.5">{running && <DitherProgress label="Running health check" value={progress} />}</div>
          <div data-tour="doctor-results" className="border-t border-border" aria-live="polite">
            {checks.map((d, i) => {
              const shown = !running || progress > (i / checks.length) * 100;
              return (
                <div key={d.check} className="border-b border-border/70 py-2.5">
                  <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-base sm:grid-cols-[14px_auto_minmax(0,1fr)]">
                    {!shown ? (
                      <Circle className="size-3 text-faint" aria-label="Waiting" />
                    ) : d.result === "ok" ? (
                      <Check className="size-3.5 text-ok" aria-label="Passed" />
                    ) : (
                      <Warning className="size-3.5 text-warn" aria-label="Warning" />
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
                </div>
              );
            })}
          </div>
        </Column>
      </Body>
    </>
  );
}

/** This machine's self-update opt-in and what this session's checks found (`canonfig self-update`, docs/self-update.md). */
interface SelfUpdate {
  /** The official npm-cli.js recorded when updates were turned on, or null while they're off. */
  npmCli: string | null;
  /** The newest patch in this release line that the last check found, or null before a check. */
  latest: string | null;
}

/** Shared so the machine menu shows what this page last found. A machine fresh out of onboarding hasn't opted in (store.tsx sharedSeed). */
export function useSelfUpdate() {
  const ws = useWorkspace();
  return useSharedState<SelfUpdate>("self-update", { npmCli: selfUpdateSeed[ws.role].npmCli, latest: null });
}

/** The major.minor line self-update stays in: 5.0.x never moves to 5.1 or 6.0 on its own. */
const RELEASE_LINE = APP_VERSION.split(".").slice(0, 2).join(".");

/** What installs an available patch. The GUI shows it rather than running it: in-GUI apply waits on issue #260. */
const APPLY_COMMAND = "canonfig self-update apply --apply";

/**
 * Canonfig's own version and its opt-in patch updates. Updates stay off until a person names the npm to use and
 * confirms nothing else of Canonfig's runs. Check asks npm for the newest patch in this release line; installing it
 * is CLI-only for now, so an available patch shows the command to run in a terminal.
 */
export function VersionView() {
  const ws = useWorkspace();
  const [state, setState] = useSelfUpdate();
  // The running check, as an object only that check holds: turning updates off clears it, so a check that was
  // already asking npm finds itself replaced and drops its answer instead of advertising a patch.
  const [checking, setChecking] = useSharedState<object | null>("self-update-checking", null);
  const readChecking = useSharedReader<object | null>("self-update-checking", null);
  const [serviceInstalled] = useSharedState("service-installed", true);
  // Set while the Service page installs or removes the service: that command holds the lease before `installed` flips.
  const [serviceBusy] = useSharedState<string | null>("service-busy", null);
  const [skillBusy] = useSharedState<string | null>("skill-busy", null);
  const [journal] = useSharedState("setup-journal", JOURNAL_SEED);
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  // Cancel returns focus to the button that opened the dialog; turning updates on replaces that button, so focus goes to the page heading instead.
  const enableFocus = useDialogReturnFocus(focusPageHeading);
  const on = state.npmCli !== null;
  const available = on && state.latest !== null && state.latest !== APP_VERSION;
  // Every other Canonfig command holds an update lease while it runs (commandLease in coordination.ts), which
  // `self-update disable` refuses on; updateGate lists them. An interrupted sync blocks opting in.
  const { busyWith, unfinished } = updateGate({
    role: ws.role,
    serviceInstalled,
    serviceBusy: serviceBusy !== null,
    setupApplying: journal.phase === "applying",
    publishing: ws.publishing,
    syncRunning: ws.phase === "running",
    syncInterrupted: ws.interrupted,
    skillBusy: skillBusy !== null,
  });

  const check = () => {
    const run = {};
    setChecking(run);
    ws.later(() => {
      if (readChecking() !== run) return;
      setChecking(null);
      setState((prev) => ({ ...prev, latest: LATEST_PATCH }));
      if (LATEST_PATCH === APP_VERSION) toast("Canonfig is up to date", { description: `${APP_VERSION} is the newest ${RELEASE_LINE} release.` });
      else toast(`Canonfig ${LATEST_PATCH} is available`, { description: `This machine has ${APP_VERSION}.\nOnly patches in the ${RELEASE_LINE} line are offered.` });
    }, 900);
  };

  const newest = checking ? (
    "Checking…"
  ) : state.latest === null ? (
    <>
      <StatusMark kind="off" /> Not checked yet
    </>
  ) : available ? (
    <>
      <StatusMark kind="warn" /> {state.latest} available
    </>
  ) : (
    <>
      <StatusMark kind="ok" /> Up to date
    </>
  );

  return (
    <>
      <PageHeader
        crumbs={["Settings", "Canonfig version"]}
        actions={
          !on ? (
            <Button size="sm" variant="primary" onClick={() => setEnabling(true)}>
              Turn on updates…
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={checking !== null} onClick={check}>
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          )
        }
      />
      <Body>
        <Column>
          <Lede>
            Canonfig can update itself to new patch releases from npm. It stays in the {RELEASE_LINE} line: moving to a newer minor or major version is a step you take on every
            machine together, by hand.
          </Lede>
          <SectionLabel>This machine</SectionLabel>
          <div className={cn("mt-1", settingsGroup)}>
            <SettingRow title="Version">
              <Mono className="text-foreground">{APP_VERSION}</Mono>
            </SettingRow>
            <SettingRow
              title="Updates"
              description={on ? `Patches in the ${RELEASE_LINE} line, installed when you choose to.` : "Off. Turn them on to check npm for patches."}
            >
              <span className="inline-flex items-center gap-1.5 text-base">
                <StatusMark kind={on ? "ok" : "off"} />
                {on ? "On" : "Off"}
              </span>
            </SettingRow>
            {on && (
              <SettingRow
                title="npm"
                description={
                  <>
                    <Mono className="break-all">{state.npmCli}</Mono>
                    <br />
                    Canonfig fetches only its own package from registry.npmjs.org, with install scripts off.
                  </>
                }
              />
            )}
            {on && (
              <SettingRow title="Newest patch">
                <span className="inline-flex items-center gap-1.5 text-base" aria-live="polite">
                  {newest}
                </span>
              </SettingRow>
            )}
          </div>

          {available && (
            <div className="mt-5 grid max-w-[68ch] grid-cols-[minmax(0,1fr)] gap-2">
              <p className="text-base text-pretty">
                To install {state.latest}, run this in a terminal on this machine. It installs only while no other Canonfig command runs, and asks you to retry otherwise. It
                keeps {APP_VERSION} as a backup and restarts nothing: {state.latest} runs once you start Canonfig again.
              </p>
              <CommandBox>{APPLY_COMMAND}</CommandBox>
            </div>
          )}

          {!on && unfinished && (
            <div className="mt-5 grid max-w-[68ch] grid-cols-[minmax(0,1fr)] gap-2">
              <p className="flex items-start gap-2 text-base text-pretty">
                <StatusMark kind="act" className="mt-[3px]" />
                <span>Update #41 was interrupted. Recover or abandon it on Sync first: Canonfig doesn't turn updates on while a sync is unfinished.</span>
              </p>
              <div>
                <Button size="sm" variant="outline" onClick={() => ws.setView("sync")}>
                  Open Sync
                </Button>
              </div>
            </div>
          )}

          {on && (
            <Button variant="destructive" size="sm" className="mt-6" onClick={() => setDisabling(true)}>
              Turn off updates…
            </Button>
          )}
        </Column>
      </Body>

      <Dialog open={enabling} onOpenChange={setEnabling}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md" {...enableFocus}>
          <EnableUpdatesForm
            unfinished={unfinished}
            onCancel={() => setEnabling(false)}
            onEnable={(npmCli) => {
              setState((prev) => ({ ...prev, npmCli }));
              setEnabling(false);
              toast.success("Updates turned on", {
                description: `Canonfig can now install ${RELEASE_LINE} patches with this npm.\nStart the services and schedules you stopped again.${DEMO ? "\nSaved in this demo workspace." : ""}`,
              });
            }}
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={disabling}
        onOpenChange={setDisabling}
        title="Turn off Canonfig updates?"
        body="Canonfig stops checking for and installing patches on this machine. The backups of earlier versions and the update records stay."
        confirm="Turn off updates"
        onConfirm={() => {
          // `self-update disable` refuses while other commands run.
          if (busyWith) {
            toast.error("Updates are still on", {
              description:
                busyWith === "service"
                  ? "The source service is running.\nStop it first, then turn updates off."
                  : busyWith === "sync"
                    ? "A sync is running.\nTurn updates off once it finishes."
                    : "Another Canonfig command is running.\nTurn updates off once it finishes.",
            });
            return;
          }
          // A check still asking npm finds its run replaced and drops its answer, so it can't advertise a patch now.
          setChecking(null);
          setState((prev) => ({ ...prev, npmCli: null, latest: null }));
          toast("Updates turned off", { description: "Backups of earlier versions and the update records stay on this machine." });
        }}
      />
    </>
  );
}

/** An npm-cli.js path, as `self-update enable --npm-cli` takes it: absolute, ending in npm's bin/npm-cli.js. */
const NPM_CLI_SHAPE = /^\/.*\/npm-cli\.js$/;

/**
 * The opt-in form (`self-update enable --apply --confirm-idle --npm-cli <path>`). It lives inside the dialog's content,
 * so closing the dialog resets it. Canonfig can't see processes started before opting in, so the person confirms
 * they're stopped; an interrupted sync refuses the opt-in, as the CLI does.
 */
function EnableUpdatesForm({ unfinished, onCancel, onEnable }: { unfinished: boolean; onCancel: () => void; onEnable: (npmCli: string) => void }) {
  const ws = useWorkspace();
  const [path, setPath] = useState("");
  const [idle, setIdle] = useState(false);
  const [tried, setTried] = useState(false);
  const example = `${ws.role === "source" ? "/home/you" : "/Users/you"}/.npm-global/lib/node_modules/npm/bin/npm-cli.js`;
  const pathError = tried && !NPM_CLI_SHAPE.test(path.trim()) ? "Enter the full path to npm's bin/npm-cli.js, starting with /." : null;
  const idleError = tried && !idle ? "Tick this once every other Canonfig process is stopped and its schedules are paused." : null;
  const refusal = tried && !pathError && !idleError && unfinished ? "Update #41 was interrupted. Recover or abandon it on Sync first, then turn updates on." : null;
  return (
    <form
      className="contents"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!NPM_CLI_SHAPE.test(path.trim())) return e.currentTarget.querySelector<HTMLElement>("#npm-cli")?.focus();
        if (!idle) return e.currentTarget.querySelector<HTMLElement>("#npm-idle")?.focus();
        if (!unfinished) onEnable(path.trim());
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
