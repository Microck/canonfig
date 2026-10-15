// Settings shared by both machine roles where the feature exists on both.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Circle, CircleNotch, Warning, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DitherProgress, Hint, Mono, Term, goldButton } from "@/shared/shared";
import { agentPolicy, doctor, harnessProject, installers } from "@/shared/data";
import { shq } from "@/shared/shell";
import { useSharedState, useWorkspace } from "./store";
import { Body, Cli, CommandBox, DetailPanel, Field, ListHead, ListRow, PageHeader, Prop, SectionLabel, SettingRow, settingsGroup } from "./kit";

const LINGER_FIX = "sudo loginctl enable-linger ubuntu";

/**
 * Names a health-check warning plainly for summaries that can't show the whole check:
 * "Off: service stops when you log out" on Linger reads "Service stops when you log out (linger off)".
 */
export function warningName(d: { check: string; detail: string }) {
  const [state, effect] = d.detail.split(": ");
  if (!effect) return d.check;
  return `${effect.charAt(0).toUpperCase()}${effect.slice(1)} (${d.check.toLowerCase()} ${state.toLowerCase()})`;
}

/** A narrow settings column, like Linear's settings pages. */
function Column({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[640px] px-8 pt-6 pb-20">{children}</div>;
}

function Lede({ children }: { children: React.ReactNode }) {
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
  cli,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: React.ReactNode;
  confirm: string;
  onConfirm: () => void;
  cli?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-base text-pretty">{body}</DialogDescription>
        </DialogHeader>
        {cli && <Cli>{cli}</Cli>}
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
            <Button size="sm" className={goldButton} disabled={!!busy} onClick={() => act(true, "install", "Source service installed in this demo workspace")}>
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
          <div className={cn("mt-1", settingsGroup)}>
            <SettingRow title="State">
              <span className="inline-flex items-center gap-1.5 text-base">
                <span className={cn("size-1.5 rounded-full", installed ? "bg-ok" : "bg-faint")} />
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
                    <Hint label="Keeps running">You marked linger as turned on when you resumed setup. Canonfig didn't check it.</Hint>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-base text-warn">
                    <Warning className="size-3.5" /> Only while you're logged in
                    <Hint label="Keeps running">
                      Linger is off, so systemd stops the service when you log out. Canonfig never turns linger on. To keep the service running, run {LINGER_FIX} yourself.
                    </Hint>
                  </span>
                )}
              </SettingRow>
            )}
          </div>
          {installed && (
            <div className="mt-4 flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act(true, "restart", "Source service restarted in this demo workspace")}>
                {busy === "restart" && <CircleNotch className="animate-spin" />} {busy === "restart" ? "Restarting…" : "Restart"}
              </Button>
              <Button variant="ghost" size="sm" className="ml-4 text-muted-foreground hover:text-bad" disabled={!!busy} onClick={() => setConfirm(true)}>
                Remove service…
              </Button>
            </div>
          )}
          <div className="mt-8">
            <Cli>{installed ? "canonfig source service status" : installCommand(ws.endpoint)}</Cli>
          </div>
        </Column>
      </Body>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Remove the source service?"
        body="Your other machines can't fetch new revisions until you install it again. Your profile, revisions and machine identities are kept."
        confirm="Remove service"
        cli="canonfig source service remove"
        onConfirm={() => act(false, "remove", "Source service removed from this demo workspace")}
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
  harness: string;
  paths: string[];
  /** Whole kilobytes, at least 1. */
  maxKb: string;
}

const POLICY_SEED: SavedPolicy = { mode: agentPolicy.mode, harness: agentPolicy.harness, paths: agentPolicy.writablePaths, maxKb: String(agentPolicy.maxInputKb) };

/** Harness versions the demo reports as installed, shared by the harness picker and the health check. */
const HARNESS_VERSION: Record<string, string> = { codex: "0.62", claude: "2.1" };

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
  const [paths, setPaths] = useState<string[]>(saved.paths);
  const [newPath, setNewPath] = useState("");
  const [maxKb, setMaxKb] = useState(saved.maxKb);
  const [dirty, setDirty] = useState(false);
  // Errors show only after a Save attempt, then follow the fields as they change.
  const [tried, setTried] = useState(false);
  const touch = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setDirty(true);
  };
  const off = mode === "deterministic-only";
  // The input strips non-digits, so the only invalid values left are blank and zero.
  const maxInvalid = !(Number(maxKb) >= 1);
  const pathPending = newPath.trim() !== "";
  const maxError = tried && !off && maxInvalid ? "Enter a whole number of 1 KB or more." : null;
  const pathError = tried && !off && pathPending ? "Add this path or clear the field before saving." : null;
  const save = () => {
    if (off) {
      // With the agent off the bounds are unused and inert, so they can't be checked or fixed here.
      // Saving keeps the last saved bounds and resets the greyed-out fields to match them.
      setSaved({ ...saved, mode });
      setHarness(saved.harness);
      setPaths(saved.paths);
      setMaxKb(saved.maxKb);
      setNewPath("");
    } else {
      setTried(true);
      if (maxInvalid || pathPending) {
        document.getElementById(maxInvalid ? "ap-max" : "ap-path")?.focus();
        return;
      }
      const kb = String(Number(maxKb));
      setMaxKb(kb);
      setSaved({ mode, harness, paths, maxKb: kb });
    }
    setTried(false);
    setDirty(false);
    toast.success("Agent policy saved in this demo workspace");
  };
  const addPath = () => {
    const p = newPath.trim();
    if (p && !paths.includes(p)) touch(setPaths)([...paths, p]);
    setNewPath("");
  };
  return (
    <>
      <PageHeader
        crumbs={["Settings", "Agent policy"]}
        actions={
          // A typed but unadded path counts as an edit, so Save can say it still needs Add path.
          <Button size="sm" className={goldButton} disabled={!dirty && !pathPending} onClick={save}>
            Save policy
          </Button>
        }
      />
      <Body>
        <Column>
          <Lede>
            Choose whether an <Term term="Configuration Agent">AI agent</Term> may help when Canonfig has no exact recipe.
          </Lede>
          <RadioGroup value={mode} onValueChange={touch(setMode)} aria-label="Agent policy" className={settingsGroup}>
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
            <div className={settingsGroup}>
              <SettingRow title="Agent harness" htmlFor="ap-harness" description="The installed agent CLI Canonfig starts for each job.">
                <Select value={harness} onValueChange={touch(setHarness)}>
                  <SelectTrigger id="ap-harness" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(HARNESS_VERSION).map(([name, version]) => (
                      <SelectItem key={name} value={name}>
                        {name} {version}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow title="Max evidence per task" htmlFor="ap-max" description="How much observed state Canonfig may hand the agent." error={maxError}>
                <Input
                  id="ap-max"
                  value={maxKb}
                  onChange={(e) => touch(setMaxKb)(e.target.value.replace(/\D/g, ""))}
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
              <div className="grid gap-1">
                {paths.map((p) => (
                  <div key={p} className="flex h-8 items-center gap-2 rounded-md border border-border pr-1 pl-2.5">
                    <Mono className="truncate text-foreground">{p}</Mono>
                    <Button variant="ghost" size="icon-xs" className="ml-auto text-faint" aria-label={`Remove ${p}`} onClick={() => touch(setPaths)(paths.filter((x) => x !== p))}>
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
          <div className="mt-8">
            <Cli>{`canonfig agent policy ${mode}`}</Cli>
          </div>
        </Column>
      </Body>
    </>
  );
}

interface Project {
  path: string;
  targets: string[];
  pending: number;
  status: "valid" | "invalid" | "applied";
}

const PROJECT_SEED: Project[] = [
  { path: harnessProject.path, targets: harnessProject.targets, pending: harnessProject.pending, status: "valid" },
  { path: "~/code/canonfig", targets: ["claude", "codex"], pending: 0, status: "applied" },
];

export function HarnessView() {
  const ws = useWorkspace();
  // Shared so added projects and applied plans survive leaving the page.
  const [projects, setProjects] = useSharedState("harness-projects", PROJECT_SEED);
  const selected = ws.focus ?? harnessProject.path;
  const [initOpen, setInitOpen] = useState(false);
  const [folder, setFolder] = useState("");
  const [tried, setTried] = useState(false);
  const current = projects.find((p) => p.path === selected);
  const cols = "minmax(220px,2fr) minmax(160px,1.5fr) 140px";
  const path = folder.trim().replace(/\/+$/, "");
  const folderError = !tried ? null : !path ? "Enter a folder." : projects.some((p) => p.path === path) ? "That folder is already a harness project." : null;
  return (
    <>
      <PageHeader
        crumbs={["Settings", "Harness projects"]}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFolder("");
              setTried(false);
              setInitOpen(true);
            }}
          >
            Add project
          </Button>
        }
      />
      <Body
        detail={
          current && (
            <HarnessDetail key={current.path} project={current} onClose={() => ws.go("harness", "")} onChange={(p) => setProjects((all) => all.map((x) => (x.path === p.path ? p : x)))} />
          )
        }
      >
        <p className="border-b border-border px-4 py-3 text-sm text-pretty text-muted-foreground">
          A harness project keeps one <Mono>{harnessProject.file}</Mono> in a repository and writes each agent's instruction files from it. It's separate from the profile your machines sync.
        </p>
        <ListHead cols={cols}>
          <span>Folder</span>
          <span>Agents</span>
          <span>State</span>
        </ListHead>
        {projects.map((p) => (
          <ListRow key={p.path} cols={cols} selected={selected === p.path} onClick={() => ws.go("harness", p.path)}>
            <Mono className="truncate text-foreground">{p.path}</Mono>
            <span className="truncate text-sm text-muted-foreground">{p.targets.join(", ")}</span>
            <span className={cn("text-sm tabular-nums", p.pending ? "text-warn" : "text-muted-foreground")}>{p.pending ? `${p.pending} files to write` : "Up to date"}</span>
          </ListRow>
        ))}
      </Body>
      <Dialog open={initOpen} onOpenChange={setInitOpen}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (!path || projects.some((p) => p.path === path)) return;
              setProjects((p) => [...p, { path, targets: ["claude", "codex"], pending: 2, status: "valid" }]);
              ws.go("harness", path);
              setInitOpen(false);
              toast.success(`Added ${path} to this demo workspace`);
            }}
          >
            <DialogHeader>
              <DialogTitle>Add a harness project</DialogTitle>
              <DialogDescription className="text-base text-pretty">Creates {harnessProject.file} in the folder with your current agent files as a starting point.</DialogDescription>
            </DialogHeader>
            <Field label="Project folder" htmlFor="h-folder" error={folderError}>
              <Input
                id="h-folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                aria-invalid={!!folderError}
                aria-describedby={folderError ? "h-folder-note" : undefined}
                placeholder="~/code/my-repo"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </Field>
            <Cli>{`cd ${path ? shq(path) : "<folder>"} && canonfig harness init`}</Cli>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setInitOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="secondary">
                Create harness file
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HarnessDetail({ project, onClose, onChange }: { project: Project; onClose: () => void; onChange: (p: Project) => void }) {
  // Separate on purpose: Validation reports only what Validate found, while `planned` gates Apply
  // and is used up by it. Neither step implies the other.
  const [validated, setValidated] = useState(false);
  const [planned, setPlanned] = useState(false);
  const plan = ["AGENTS.md", "CLAUDE.md", ".cursor/rules/project.mdc", "GEMINI.md"].slice(0, Math.max(project.pending, 0));
  return (
    <DetailPanel
      title={<Mono className="text-base text-foreground">{project.path}</Mono>}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => (setValidated(true), toast.success(`${harnessProject.file} is valid in this demo workspace`))}>
            Validate
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPlanned(true)}>
            Plan
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            disabled={!planned || project.pending === 0}
            onClick={() => {
              onChange({ ...project, pending: 0, status: "applied" });
              setPlanned(false);
              toast.success(`Updated ${plan.length} agent files for ${project.path} in this demo workspace`);
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="px-4 py-3">
        <Prop label="File">
          <Mono className="text-foreground">{harnessProject.file}</Mono>
        </Prop>
        <Prop label="Agents">{project.targets.join(", ")}</Prop>
        <Prop label="Validation">{validated ? <span className="text-ok">Valid</span> : <span className="text-muted-foreground">Not run yet</span>}</Prop>
      </div>
      <div className="border-t border-border px-4 pt-3">
        <SectionLabel>Plan</SectionLabel>
        {!planned ? (
          <p className="pb-4 text-sm text-pretty text-muted-foreground">Run Plan to list the files Apply would write.</p>
        ) : plan.length === 0 ? (
          <p className="pb-4 text-sm text-muted-foreground">Every agent file already matches {harnessProject.file}.</p>
        ) : (
          <div className="pb-3">
            {plan.map((f) => (
              <div key={f} className="flex h-8 items-center gap-2 text-base">
                <span className="rounded bg-warn/12 px-1 font-mono text-xs text-warn">write</span>
                <Mono className="text-foreground">{f}</Mono>
              </div>
            ))}
          </div>
        )}
        <div className="grid gap-1 pb-4">
          <Cli>{`cd ${shq(project.path)} && canonfig harness plan`}</Cli>
          <Cli>{`cd ${shq(project.path)} && canonfig harness apply`}</Cli>
        </div>
      </div>
    </DetailPanel>
  );
}

export function InstallersView() {
  const ws = useWorkspace();
  // Shared and finished through ws.later for the same reasons as the service's busy state:
  // the guard survives leaving the page, and switching roles cancels the result.
  const [checking, setChecking] = useSharedState<string | null>("installer-checking", null);
  const cols = "120px minmax(200px,2fr) 160px 90px";
  return (
    <>
      <PageHeader crumbs={["Settings", "Installers"]} />
      <Body>
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-3 text-sm text-muted-foreground">
          Installer bindings point tool recipes at a package manager on this machine.
          <Hint label="installer bindings">Tool resources carry an installation recipe per platform, like brew on macOS or apt on Linux. A binding points that recipe at a real executable.</Hint>
        </div>
        <ListHead cols={cols}>
          <span>Installer</span>
          <span>Executable</span>
          <span>Status</span>
          <span />
        </ListHead>
        {installers.map((r) => (
          <ListRow key={r.name} cols={cols}>
            <span className="font-medium">{r.name}</span>
            <Mono className={r.path === "-" ? "text-faint" : "text-foreground"}>{r.path === "-" ? "None" : r.path}</Mono>
            <span className={cn("text-sm", r.status === "bound" ? "text-ok" : "text-faint")}>{r.status === "bound" ? "Bound" : "Not on this platform"}</span>
            {r.status === "bound" ? (
              <Button
                variant="ghost"
                size="xs"
                className="justify-self-end text-muted-foreground"
                disabled={checking !== null}
                onClick={() => {
                  setChecking(r.name);
                  ws.later(() => {
                    setChecking(null);
                    toast.success(`${r.name} check passed in this demo workspace`, { description: r.path });
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
        <div className="grid gap-1 px-4 pt-5">
          <Cli>canonfig installer list</Cli>
          <Cli>{`canonfig installer check ${checking ?? "<method>"}`}</Cli>
        </div>
      </Body>
    </>
  );
}

function setupSteps(profileFile: string) {
  return [
    { id: "state", label: "Create state directory", detail: "~/.local/state/canonfig" },
    { id: "keys", label: "Generate signing key", detail: "Stored in Secret Service" },
    { id: "profile", label: "Write profile file", detail: profileFile },
    { id: "service", label: "Install source service", detail: "systemd user unit" },
    { id: "linger", label: "You turn on linger", detail: LINGER_FIX },
  ];
}

interface Journal {
  phase: "planned" | "approved" | "applying" | "paused" | "complete";
  /** Index of the step running now. */
  at: number;
}

const JOURNAL_SEED: Journal = { phase: "planned", at: 0 };

export function SetupView() {
  const ws = useWorkspace();
  // Shared so approval and progress survive leaving the page, as the journal promises.
  const [journal, setJournal] = useSharedState("setup-journal", JOURNAL_SEED);
  // Setup's install step and the person's linger step feed the same state Service and Health read,
  // so Done never disagrees with them.
  const [installed, setInstalled] = useSharedState("service-installed", true);
  const [, setSince] = useSharedState("service-since", SERVICE_SINCE_SEED);
  const [, setLingerMarked] = useSharedState("linger-marked", false);
  const { phase, at } = journal;
  const steps = setupSteps(ws.profileFile);
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
      <Button size="sm" className={goldButton} onClick={() => setJournal({ phase: "approved", at: 0 })}>
        Approve plan
      </Button>
    ) : phase === "approved" ? (
      <Button size="sm" className={goldButton} onClick={apply}>
        Apply
      </Button>
    ) : null;
  return (
    <>
      <PageHeader crumbs={["Settings", "Setup"]} actions={primary} />
      <Body>
        <Column>
          <Lede>Setup writes each step to a journal before running it, so an interrupted setup resumes where it stopped.</Lede>
          <SectionLabel action={<span className="text-xs text-faint tabular-nums">Journal #3</span>}>
            {phase === "planned" ? "Plan" : phase === "complete" ? "Done" : "Approved plan"}
          </SectionLabel>
          <ol className={cn("mt-1", settingsGroup)} aria-live="polite">
            {steps.map((s, i) => {
              const done = phase === "complete" || (phase === "paused" ? i < last : phase === "applying" && i < at);
              const running = phase === "applying" && i === at;
              const blocked = phase === "paused" && i === last;
              // A finished install step can't stay ticked once the service is removed elsewhere.
              const removed = done && s.id === "service" && !installed;
              // Canonfig can't check linger; Resume records the person's word for it, and the row says so.
              const marked = done && s.id === "linger";
              return (
                <li key={s.id} className="flex h-[40px] items-center gap-3 px-[16px] text-base">
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {removed ? (
                      <Warning className="size-3.5 text-warn" aria-label="Removed since setup" />
                    ) : done ? (
                      <Check className="size-3.5 text-ok" aria-label={marked ? "Marked done by you" : "Done"} />
                    ) : running ? (
                      <CircleNotch className="size-3.5 animate-spin text-muted-foreground" aria-label="Running" />
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
                    toast.success("Setup complete in this demo workspace", { description: "You marked the linger step done. Canonfig didn't check it." });
                  }}
                >
                  I ran it, resume setup
                </Button>
              </div>
            </div>
          )}
          <div className="mt-8 grid gap-1">
            <Cli>canonfig setup plan --role source</Cli>
            <Cli>canonfig setup approve --approver marcos && canonfig setup apply</Cli>
            <Cli>canonfig setup status</Cli>
          </div>
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
    policy.mode === "deterministic-only" ? { detail: "Not used: agent policy is deterministic only" } : { detail: `${policy.harness} ${HARNESS_VERSION[policy.harness]} found` };
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
          Linger: lingerMarked
            ? { result: "ok", detail: "On: you marked it done in setup" }
            : { fix: { why: "To keep user services running after you log out, run this yourself. Canonfig won't change it.", command: LINGER_FIX } },
          "Configuration Agent": agent,
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
          "Configuration Agent": agent,
        };
  return doctor.map((c) => ({ ...c, ...overrides[c.check] }));
}

export function DoctorView() {
  const ws = useWorkspace();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(100);
  const tick = useTicker();
  const checks = useChecks();
  const warned = checks.filter((c) => c.result === "warn");
  const warnings = warned.length;
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
      toast("Health check finished", { description: `${checks.length - warnings} passed${warnings ? `. Warning: ${warned.map(warningName).join(", ")}` : ""}` });
      return true;
    }, 120);
  };
  // Opened from ⌘K "Run doctor": start immediately, even if this page is already open.
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
          <Button size="sm" className={goldButton} disabled={running} onClick={run}>
            {running ? "Checking…" : "Run checks"}
          </Button>
        }
      />
      <Body>
        <Column>
          <Lede>The health check (Canonfig calls it doctor) tests whether this machine can run Canonfig. It changes nothing, and each problem lists the command that fixes it.</Lede>
          <div className="mb-4 h-1.5">{running && <DitherProgress label="Running health check" value={progress} />}</div>
          <div className="border-t border-border" aria-live="polite">
            {checks.map((d, i) => {
              const shown = !running || progress > (i / checks.length) * 100;
              return (
                <div key={d.check} className="border-b border-border/70 py-2.5">
                  <div className="flex items-center gap-3 text-base">
                    {!shown ? (
                      <Circle className="size-3 text-faint" aria-label="Waiting" />
                    ) : d.result === "ok" ? (
                      <Check className="size-3.5 text-ok" aria-label="Passed" />
                    ) : (
                      <Warning className="size-3.5 text-warn" aria-label="Warning" />
                    )}
                    <span>{d.check}</span>
                    <span className="ml-auto text-sm text-muted-foreground">{shown ? d.detail : "Waiting"}</span>
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
          <div className="mt-6">
            <Cli>canonfig doctor</Cli>
          </div>
        </Column>
      </Body>
    </>
  );
}
