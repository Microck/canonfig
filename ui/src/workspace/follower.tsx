// Shared Follower screens read machine data and operations from the workspace provider.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowRight, CaretRight, Check, DotsThree, HourglassMedium, Key, Plus, WarningCircle, X } from "@/components/icons";
import { cn, removeKeepingFocus } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AnimatedNumber, DitherProgress, Mono, StateBand, StateLabel, StatusMark, Term, type StatusKind } from "@/shared/shared";
import {
  APPEND_LOCAL_LABEL,
  CATEGORY_LABEL,
  DEMO,
  HARNESS_NAMES,
  LOCAL_CATEGORIES,
  PLAIN,
  SECRETS_GROUP,
  SOURCE_TEXT_END,
  SOURCE_TEXT_START,
  SETTINGS_FILES,
  type HarnessId,
  type KeptSurface,
  type LocalCategory,
  type LocalItem,
  type Resource,
} from "@/shared/metadata";
import { useSharedReader, useSharedState, useWorkspace, type PlanAction, type PlanItem, type Workspace } from "./store";
import { GetStarted } from "./guide";
import { WorkspaceEvidence } from "./source";
import { HarnessTable } from "./harnesses";
import {
  AnimatedRow,
  Body,
  CATEGORY_ICON,
  CommandBox,
  DetailPanel,
  Field,
  EmptyState,
  GroupRow,
  ListHead,
  ListRow,
  PageHeader,
  RowPresence,
  SectionLabel,
  SettingRow,
  StateHeader,
  StatusRow,
  settingsGroup,
  useLeaveGuard,
  copy,
} from "./kit";
import { Column, ConfirmDialog } from "./settings";
import { ScheduleFields, nextCheck, scheduleError, scheduleSummary, type Schedule } from "./schedule";
import { FollowerOperationEvidence, TunnelEvidence } from "./follower-evidence";
import { LocalAuthoringEditor } from "./follower-authoring";
import { record, text } from "./live/follower";
export { FollowerOperationEvidence } from "./follower-evidence";

const ACTION: Record<PlanAction, { label: string; cls: string; hint: string }> = {
  write: { label: "Write", cls: "bg-ok/12 text-ok", hint: "Replace the harness file or folder with the revision's copy." },
  append: { label: "Add section", cls: "bg-ok/12 text-ok", hint: "Write Canonfig's marked section at the top of the file.\nEverything below it stays as this machine's text." },
  merge: { label: "Set keys", cls: "bg-ok/12 text-ok", hint: "Set only the keys Canonfig owns; every other key in the file stays as it is." },
  install: { label: "Install", cls: "bg-[oklch(0.72_0.12_240)]/14 text-[oklch(0.78_0.1_240)]", hint: "Run the tool's install recipe for this system, then check it runs." },
  "skip-drift": { label: "Held", cls: "bg-warn/12 text-warn", hint: "You edited this item's file here.\nCanonfig keeps your edit and holds what it writes from it." },
};

const DEFAULT_TIME = "09:00";

/**
 * Shared-state keys this file owns (see FIXLIST shared contracts). Every reader passes the same
 * initial. `null` schedule means none is set: onboarding seeds it when the schedule was turned off.
 */
const SCHEDULE_KEY = "follower-schedule";
const TUNNEL_KEY = "tunnel-up";
const TUNNEL_STARTED_KEY = "tunnel-started-here";
/**
 * Operations in flight and their results. Shared rather than page-local so leaving and returning
 * to a page within the role keeps a running operation busy and its finished result; the timers
 * that settle them are `ws.later`, which the workspace cancels when the role changes.
 */
const CHECKING_KEY = "sync-checking";
const TUNNEL_BUSY_KEY = "tunnel-busy";
const SECRETS_KEY = "secrets-refresh";

/**
 * Why this machine can't sync right now, or null. `stopped`: Stop syncing ended it, which blocks
 * every sync action (apply, checking, recovery, schedule, secrets). `blocked`: anything that must
 * reach the Source (apply, checking, secret refresh) also waits while the SSH tunnel is stopped.
 * `unreachable` reads the connection when called, for an operation already waiting when it stops.
 */
function useSyncBlocks() {
  const ws = useWorkspace();
  const [tunnelUp] = useSharedState(TUNNEL_KEY, ws.tunnelUp);
  const readTunnelUp = useSharedReader(TUNNEL_KEY, ws.tunnelUp);
  const stopped = ws.unenrolled ? `Syncing is stopped on this machine. Joining again needs a new invitation from ${ws.sourceMachine.hostname}.` : null;
  const tunnelDown = ws.tunnelConfigured && !(ws.followerLive ? ws.tunnelUp : tunnelUp) ? `The SSH tunnel is stopped, so this machine can't reach ${ws.sourceMachine.hostname}. Start it in Settings, SSH tunnel.` : null;
  const unreachable = () => ws.isStopped() || (ws.tunnelConfigured && !(ws.followerLive ? ws.tunnelUp : readTunnelUp()));
  return { stopped, blocked: stopped ?? tunnelDown, unreachable };
}

/** A drifted item: its mirror file keeps your edit, and every run leaves it and its projections as they are. */
const isHeld = (p: PlanItem) => p.action === "skip-drift";

export function ActionTag({ action }: { action: PlanAction }) {
  const a = ACTION[action];
  return (
    <span title={a.hint} className={cn("inline-flex h-5 items-center rounded px-1.5 text-xs font-medium whitespace-nowrap", a.cls)}>
      {a.label}
    </span>
  );
}

export function Attention({ tone, title, children, actions }: { tone: "warn" | "act" | "bad"; title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    // px-1: the same 4px row inset as the Source overview's lists; Sync offsets its wrapper to keep the text at 18px.
    <div className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 border-b border-border/70 px-1 py-3 @min-[640px]:grid-cols-[14px_minmax(0,1fr)_auto]">
      {/* h-lh centres the marker on the title's first line, whatever the marker's height. */}
      <span className="flex h-lh items-center text-base">
        <StatusMark kind={tone} />
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-medium">{title}</h2>
        <div className="mt-0.5 max-w-[68ch] text-base text-pretty text-muted-foreground">{children}</div>
      </div>
      {actions && <div className="col-start-2 flex flex-wrap items-center gap-1.5 @min-[640px]:col-start-3">{actions}</div>}
    </div>
  );
}

/**
 * Both actions change this machine for good (Recover writes files, Abandon gives up the last 2 steps), so each is confirmed first.
 * A stopped follower is no longer managed, so neither is offered; the journal is left as it was.
 */
function InterruptedNotice() {
  const ws = useWorkspace();
  const { stopped } = useSyncBlocks();
  const [confirming, setConfirming] = useState<"recover" | "abandon" | null>(null);
  return (
    <>
      <RowPresence>
        {ws.interrupted && (
          <AnimatedRow key="interrupted">
            <Attention
              tone="bad"
              title={
                <>
                  <Term term="Synchronization Run">Update</Term> {ws.followerLive ? "" : "#41 "}was interrupted
                </>
              }
              actions={
                <>
                  <Button variant="destructive" size="xs" disabled={stopped !== null} onClick={() => setConfirming("abandon")}>
                    Abandon…
                  </Button>
                  <Button variant="outline" size="xs" disabled={stopped !== null} onClick={() => setConfirming("recover")}>
                    Recover…
                  </Button>
                </>
              }
            >
              {ws.followerLive ? "Recover resumes the recorded writes. Abandon closes the run and leaves applied changes in place; nothing is rolled back." : "It stopped yesterday at 21:14 after 3 of 5 steps, when this machine went to sleep. Recover finishes the other 2. Abandon closes it and leaves the 3 finished steps in place; nothing is rolled back."}{stopped && ` ${stopped}`}
            </Attention>
          </AnimatedRow>
        )}
      </RowPresence>
      <ConfirmDialog
        open={confirming === "recover"}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={ws.followerLive ? "Recover interrupted update?" : "Recover update #41?"}
        body={ws.followerLive ? "Canonfig resumes this run's recorded writes. Finished steps stay in place." : "Canonfig runs the 2 remaining steps from the run's journal and writes them to this machine. The 3 finished steps stay as they are."}
        confirm="Recover"
        onConfirm={ws.recover}
      />
      <ConfirmDialog
        open={confirming === "abandon"}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={ws.followerLive ? "Abandon interrupted update?" : "Abandon update #41?"}
        body={ws.followerLive ? "Finished steps stay; nothing is rolled back. The remaining steps do not run." : "3 finished steps stay; nothing is rolled back. The remaining 2 don't run."}
        confirm="Abandon"
        onConfirm={ws.abandon}
      />
    </>
  );
}

function HumanActionItem() {
  const ws = useWorkspace();
  if (ws.followerLive) return null;
  return (
    <RowPresence>
      {ws.humanAction && (
        <AnimatedRow key="human">
          <Attention
            tone="act"
            title={
              <>
                <Term term="Human Action Required">Needs you</Term>: sign in to the GitHub CLI
              </>
            }
            actions={
              <Button variant="outline" size="xs" onClick={() => (ws.setHumanAction(false), toast.success("gh-cli checked", { description: "Signed in as maria." }))}>
                Check again
              </Button>
            }
          >
            <ol className="mt-1 grid list-decimal gap-1.5 pl-4">
              <li>Open a terminal on this machine.</li>
              <li>
                Run this and pick GitHub.com, HTTPS, then Login with a web browser.
                <div className="mt-1.5 max-w-sm">
                  <CommandBox>gh auth login</CommandBox>
                </div>
              </li>
              <li>Come back here and check again.</li>
            </ol>
          </Attention>
        </AnimatedRow>
      )}
    </RowPresence>
  );
}

export function FollowerOverview() {
  const ws = useWorkspace();
  const rev = ws.targetRevision;
  const [schedule] = useSharedState<Schedule | null>(SCHEDULE_KEY, ws.followerSchedule);
  const [tunnelUp] = useSharedState(TUNNEL_KEY, ws.tunnelUp);
  const drifted = ws.plan.find(isHeld);
  const held = ws.plan.filter(isHeld).length;
  const changes = ws.plan.length - held;
  const ready = ws.phase !== "done";
  const running = ws.phase === "running";
  // After a run: each held item and a pending sign-in is one step for a person.
  const needs = held + (ws.humanAction ? 1 : 0);
  const tone = ws.unenrolled ? "muted" : running ? "ok" : ready ? "warn" : needs > 0 ? "act" : "ok";
  const managed = ws.harnesses.filter((h) => h.listed && h.installed && !h.excluded).length;
  const heldText = held > 0 ? ` and holds ${held === 1 ? "one item" : `${held} items`} you edited here` : "";
  return (
    <>
      <PageHeader
        crumbs={["Overview"]}
        actions={
          !ws.capabilities.simulatedTelemetry ? <Button size="sm" variant="outline" onClick={ws.reload}>Reload</Button> : ready && !ws.unenrolled && (
            <Button size="sm" variant="primary" onClick={() => ws.setView("sync")}>
              Review what will change
            </Button>
          )
        }
      />
      <Body>
        {!ws.capabilities.simulatedTelemetry ? <StateHeader tone="muted" title={ws.session?.machineName ?? ws.machineName} body="Open Sync to check for updates." /> : <StateHeader
          tone={tone}
          running={running}
          title={
            ws.unenrolled
              ? "Syncing stopped"
              : running
                ? `Applying revision ${rev}…`
                : ready
                  ? `Revision ${rev} is ready to apply`
                  : needs === 0
                    ? `Up to date on revision ${rev}`
                    : needs === 1
                      ? "One step needs you"
                      : `${needs} steps need you`
          }
          body={
            ws.unenrolled ? (
              <>This machine no longer gets revisions. Files Canonfig placed stay as they are. Joining again needs a new invitation from {ws.sourceMachine.hostname}.</>
            ) : ready ? (
              <>
                {ws.appliedRevision === 0 ? (
                  "Nothing is applied on this machine yet."
                ) : (
                  <>
                    {ws.appliedRevision !== undefined && <>This machine is on revision <AnimatedNumber value={ws.appliedRevision} />.</>}
                  </>
                )}{" "}
                Revision {rev} changes {changes} {changes === 1 ? "item" : "items"}
                {heldText}.
              </>
            ) : needs === 0 ? (
              <>Everything this machine should have matches revision {rev} and passed its check.</>
            ) : held === 0 ? (
              <>
                Revision {rev} is applied. Sign in to the GitHub CLI and this machine is <Term term="Convergence">up to date</Term>.
              </>
            ) : (
              <>
                Revision {rev} is applied, except {held === 1 ? "one item" : `${held} items`} you edited here. Canonfig keeps {held === 1 ? "that edit" : "those edits"} and
                holds what it writes from {held === 1 ? "it" : "them"}.
              </>
            )
          }
        />}
        {/* Same columns as the Source overview: the side column joins at @3xl, 320px wide. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 px-4 pt-6 pb-20 @3xl:grid-cols-[minmax(0,1fr)_320px] @3xl:gap-12 @3xl:px-8">
          <div className="min-w-0 space-y-8">
            <WorkspaceEvidence />
            {ws.capabilities.simulatedTelemetry && <GetStarted rowInset={4} />}
            {ws.capabilities.simulatedTelemetry && <section data-tour="follower-needs">
              <SectionLabel>Needs you</SectionLabel>
              <div className="border-t border-border">
                <InterruptedNotice />
                <RowPresence>
                  {drifted && (
                    <AnimatedRow key="drift">
                      <Attention
                        tone="warn"
                        title={
                          <>
                            <Term term="Follower Drift">You edited</Term> {drifted.resource}
                          </>
                        }
                        actions={
                          <Button variant="outline" size="xs" onClick={() => ws.go("sync", drifted.resource)}>
                            How to settle it <ArrowRight />
                          </Button>
                        }
                      >
                        You changed <Mono>{drifted.target}</Mono>. Canonfig keeps your edit, reports it and holds what it writes from it. Move the change to your local folder,
                        or ask {ws.sourceMachine.hostname} to publish it.
                      </Attention>
                    </AnimatedRow>
                  )}
                </RowPresence>
                <HumanActionItem />
                {!ws.interrupted && !drifted && !ws.humanAction && (
                  <div className="flex h-9 items-center gap-2 px-1 text-base text-muted-foreground">
                    <Check className="size-3.5 text-ok" /> Nothing needs you.
                  </div>
                )}
              </div>
            </section>}
          </div>
          {ws.capabilities.simulatedTelemetry && <aside className="min-w-0 space-y-8">
            <section data-tour="follower-this-machine">
              <SectionLabel
                action={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" aria-label="This machine: more actions">
                        <DotsThree />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                      <DropdownMenuItem onSelect={() => ws.setView("sync")}>Check for updates</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => ws.setView("schedule")}>Change when it checks…</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => ws.go("local", "new")}>Add a local item…</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" disabled={ws.unenrolled} onSelect={() => ws.setUnenrollOpen(true)}>
                        {PLAIN.unenroll}…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              >
                This machine
              </SectionLabel>
              <div className="border-t border-border">
                <StatusRow
                  label="Revision"
                  title="Canonfig calls this the profile revision."
                  value={ws.appliedRevision === undefined ? "Not reported" : ws.appliedRevision === 0 ? "None applied yet" : <AnimatedNumber value={ws.appliedRevision} />}
                  onClick={() => ws.setView("sync")}
                />
                <StatusRow label="Next check" value={schedule ? nextCheck(schedule, DEFAULT_TIME) : "Not scheduled"} onClick={() => ws.setView("schedule")} />
                <StatusRow
                  label="Harnesses"
                  title="Listed by the Source, installed here and not excluded."
                  value={
                    <>
                      <AnimatedNumber value={managed} /> managed
                    </>
                  }
                  onClick={() => ws.setView("local")}
                />
                <StatusRow
                  label="Local items"
                  value={
                    <>
                      <AnimatedNumber value={ws.local.length} /> in the local folder
                    </>
                  }
                  onClick={() => ws.setView("local")}
                />
                <StatusRow
                  status={ws.backups ? undefined : "warn"}
                  label="Backups"
                  value={ws.backups ? `${ws.snapshots.length} ${ws.snapshots.length === 1 ? "snapshot" : "snapshots"}` : "Off"}
                  onClick={() => ws.setView("backups")}
                />
                <StatusRow
                  status={!ws.tunnelConfigured ? "off" : tunnelUp ? "ok" : "offline"}
                  label="Tunnel"
                  value={!ws.tunnelConfigured ? "Not used" : tunnelUp ? "Connected" : "Stopped"}
                  onClick={() => ws.setView("tunnel")}
                />
                {ws.unenrolled && <StatusRow status="off" label="Syncing" value="Stopped" onClick={() => ws.setView("machine")} />}
              </div>
            </section>
            <section data-tour="follower-runs">
              <SectionLabel>Recent updates</SectionLabel>
              {/* A newly enrolled follower has no runs yet; say so rather than leave a bare rule under the label. */}
              {ws.runs.length === 0 ? (
                <p className="border-t border-border px-1 py-2 text-sm text-muted-foreground">No updates yet. Each update this machine applies shows here.</p>
              ) : (
                <ol className="border-t border-border text-base">
                  <RowPresence>
                    {ws.runs.map((r) => (
                      <AnimatedRow key={r.n} as="li">
                        <div className="flex h-8 items-center gap-2 border-b border-border/70 px-1">
                          <span className="w-8 font-mono text-xs text-faint tabular-nums">#{r.n}</span>
                          <span className={cn("truncate", r.tone === "bad" && "text-bad", r.tone === "muted" && "text-muted-foreground")}>{r.what}</span>
                          <span className="ml-auto shrink-0 pl-2 text-sm text-faint tabular-nums">{r.when}</span>
                        </div>
                      </AnimatedRow>
                    ))}
                  </RowPresence>
                </ol>
              )}
            </section>
          </aside>}
        </div>
      </Body>
    </>
  );
}

const DIFF = [
  { t: " ", s: "## Review checklist" },
  { t: "-", s: "- Check tests cover the change." },
  { t: "+", s: "- Check tests cover the change, including failure paths." },
  { t: "+", s: "- Flag any TODO left in the diff." },
  { t: " ", s: "- Keep comments short." },
];

/** A plan step's progress in the app's status-marker language: ring, half while it runs, check when done. */
function StepIcon({ step }: { step: PlanItem }) {
  // A held step never runs, so it never shows as done; it waits for a person like other "needs you" states.
  const [kind, label]: [StatusKind, string] = isHeld(step) ? ["warn", "Held"] : step.status === "done" ? ["ok", "Done"] : step.status === "running" ? ["warn", "Running"] : ["off", "Not started"];
  return (
    <span className="flex items-center">
      <StatusMark kind={kind} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

// Match DetailPanel's md breakpoint: only the side-by-side layout gets a default selection.
const SYNC_DETAIL_QUERY = "(min-width: 48rem)";
function subscribeSyncDetailLayout(onChange: () => void) {
  const query = window.matchMedia(SYNC_DETAIL_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}


export function SyncView() {
  return <SyncForm />;
}


function SyncForm() {
  const ws = useWorkspace();
  const live = ws.followerLive;
  const sent = ws.resources.filter((r) => r.groups.length === 0 || r.groups.some((group) => ws.selfFollower?.groups.includes(group))).length;
  const notSent = ws.resources.length - sent;
  const rev = ws.targetRevision;
  const steps = ws.plan;
  const held = steps.filter(isHeld).length;
  const collisions = unsettledCollisions(ws.local, ws.overlays, ws);
  // First adoptions only exist before the run that writes them; afterwards the file holds Canonfig's section.
  const adoption = ws.phase === "plan" ? steps.find((p) => p.adoption) : undefined;
  const sideBySide = useSyncExternalStore(
    subscribeSyncDetailLayout,
    () => window.matchMedia(SYNC_DETAIL_QUERY).matches,
    () => false,
  );
  // Explicit URL selections (including Overview's "How to settle it") work at every width.
  // An empty focus means the user closed the panel, so it must not select the default.
  const selected = ws.focus ?? (sideBySide ? (steps.find(isHeld)?.resource ?? adoption?.resource ?? null) : null);
  const setSelected = (id: string | null) => ws.go("sync", id ?? "");
  const [checking, setChecking] = useSharedState(CHECKING_KEY, false);
  const blocks = useSyncBlocks();
  const cols = "18px 92px minmax(150px,240px) minmax(200px,360px) minmax(220px,1fr)";
  // Column minimums + 4 gaps + row inset padding; narrower screens scroll the list sideways instead of clipping it.
  const colsMin = 18 + 92 + 150 + 200 + 220 + 4 * 12 + 20;
  const current = steps.find((p) => p.resource === selected);
  const unchanged = Math.max(0, sent - steps.length);
  const running = ws.phase === "running";
  const step = ws.progress === undefined ? undefined : Math.min(steps.length, Math.floor((ws.progress / 100) * steps.length) + 1);

  return (
    <>
      <PageHeader
        // Title is the page name like every other top-level page; the revision detail is the band heading below.
        crumbs={["Sync"]}
        actions={
          <>
            <Button
              data-tour="sync-check"
              variant="outline"
              size="sm"
              disabled={running || checking || blocks.blocked !== null}
              onClick={() => {
                if (live) { live.check(); return; }
                setChecking(true);
                ws.later(() => {
                  setChecking(false);
                  // Syncing or the tunnel stopped during the check: the Source can't have answered.
                  if (blocks.unreachable()) return;
                  toast(ws.phase === "done" ? "No newer revision" : `Revision ${rev} is still the latest`);
                }, 900);
              }}
            >
              {checking && <HourglassMedium />} {checking ? "Checking…" : "Check for updates"}
            </Button>
            {ws.phase !== "done" && (
              <Button
                size="sm"
                variant="primary"
                disabled={running || ws.interrupted || blocks.blocked !== null || collisions.length > 0 || (live !== undefined && !live.canApply)}
                onClick={ws.applyPlan}
                data-tour="sync-apply"
              >
                {running ? "Applying…" : "Apply changes"}
              </Button>
            )}
          </>
        }
      />
      <Body
        // Checking asks the Source for its latest revision, which rebuilds the plan below.
        reloading={checking}
        detail={
          current?.drift ? (
            <DriftPanel item={current} onClose={() => setSelected(null)} />
          ) : current?.adoption ? (
            <AdoptionPanel item={current} onClose={() => setSelected(null)} />
          ) : undefined
        }
      >
        {live ? <>
          <InterruptedNotice />
          {!live.operation && <EmptyState title="Check for a revision" body="Nothing changes until you apply." />}
          <FollowerOperationEvidence />
          <div className="space-y-3 border-t border-border px-[18px] py-5">
            <SectionLabel>Held items and local changes</SectionLabel>
            <Button variant="outline" size="sm" onClick={() => ws.go("local")}>Open Local settings</Button>
            <SectionLabel className="pt-4">Private adoption review</SectionLabel>
            <p className="max-w-prose text-sm text-muted-foreground">Create the CLI's private review files before first adoption.</p>
            <Button variant="outline" size="sm" disabled={running || blocks.blocked !== null} onClick={live.createReview}>Create private review</Button>
          </div>
        </> : <>
        <section data-tour="sync-summary" className="relative isolate overflow-hidden border-b border-border" aria-live="polite">
          <StateBand tone={ws.phase === "plan" || held > 0 ? "warn" : "ok"} mode={running ? "running" : "idle"} className="-z-10 opacity-70" />
          <div className="px-[18px] py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 text-base">
              <h2 className="font-medium">
                {running ? (
                  <>
                    {step !== undefined ? <>Applying step <AnimatedNumber value={step} /> of {steps.length}</> : "Applying changes"}
                  </>
                ) : ws.phase === "done" ? (
                  held > 0 ? (
                    `Update #${ws.runs[0].n} finished: revision ${rev} applied, ${held} ${held === 1 ? "item" : "items"} held`
                  ) : (
                    `Update #${ws.runs[0].n} finished`
                  )
                ) : ws.appliedRevision === 0 ? (
                  `Revision ${rev}`
                ) : (
                  `From revision ${ws.appliedRevision} to ${rev}`
                )}
              </h2>
              <span className="text-muted-foreground">
                {!running && blocks.blocked
                  ? blocks.blocked
                  : ws.phase === "plan"
                    ? ws.interrupted
                      ? "Recover or abandon the interrupted update first."
                      : collisions.length > 0
                        ? "Settle the name collision first."
                        : "Nothing changes until you apply."
                    : ws.phase === "done" && held > 0
                      ? "What you edited here stays as you left it."
                      : null}
              </span>
              <span className="ml-auto shrink-0 rounded bg-background px-2 py-1 font-mono text-xs text-foreground tabular-nums">
                {running ? ws.progress === undefined ? "Applying" : `${ws.progress}%` : `${steps.length} ${steps.length === 1 ? "change" : "changes"}`}
              </span>
            </div>
            {ws.progress !== undefined && <DitherProgress value={ws.progress} running={running} label={`Applying revision ${rev}`} className={cn("mt-3", !running && "invisible")} />}
          </div>
        </section>
        {(ws.interrupted || ws.humanAction || collisions.length > 0 || adoption) && (
          // 14px plus Attention's own 4px row inset puts the notice text on the list's 18px line.
          <div data-tour="sync-recover" className="px-[14px]">
            <InterruptedNotice />
            <HumanActionItem />
            <CollisionNotice collisions={collisions} />
            {adoption && (
              <Attention
                tone="warn"
                title={`Check what ${adoption.target} keeps before you apply`}
                actions={
                  <Button variant="outline" size="xs" onClick={() => setSelected(adoption.resource)}>
                    Review the text
                  </Button>
                }
              >
                Canonfig hasn't written this file before, so it keeps the entire file as your text, even where it matches what {ws.sourceMachine.hostname} publishes: matching text doesn't
                show who wrote it. Look at the exact text Canonfig adds and the text it keeps.
              </Attention>
            )}
          </div>
        )}
        <ListHead cols={cols} minWidth={colsMin} data-tour="sync-plan">
          <span />
          <span>Change</span>
          <span>Item</span>
          <span>Where</span>
          <span>Why</span>
        </ListHead>
        {steps.map((p) => {
          const Icon = CATEGORY_ICON[p.category];
          return (
            <ListRow key={p.resource} cols={cols} minWidth={colsMin} selected={selected === p.resource} onClick={() => setSelected(p.resource)} data-tour={isHeld(p) ? "sync-held" : "sync-plan"}>
              <StepIcon step={p} />
              <span className="flex items-center gap-1">
                <ActionTag action={p.action} />
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="size-3.5 shrink-0 text-faint" />
                <span className="truncate font-medium">{p.resource}</span>
              </span>
              <Mono className="truncate">{p.target}</Mono>
              <span className="truncate text-sm text-muted-foreground" title={p.reason}>
                {p.reason}
              </span>
            </ListRow>
          );
        })}
        {(unchanged > 0 || notSent > 0) && (
          <div className="mx-[8px] flex h-[36px] items-center gap-2 px-[10px] text-sm text-faint">
            <Check className="size-3.5" />
            {[
              unchanged > 0 && `${unchanged} other ${unchanged === 1 ? "item already matches" : "items already match"}.`,
              notSent > 0 && `${notSent} ${notSent === 1 ? "isn't" : "aren't"} sent to this machine.`,
            ]
              .filter(Boolean)
              .join(" ")}
          </div>
        )}
        <div className="pb-16" />
        </>}
      </Body>
    </>
  );
}

/**
 * Follower Drift on a mirror file. Canonfig offers no choice here: it never overwrites the edit. The person
 * settles it outside this panel, by moving the change into the local folder, asking the Source to publish
 * it, or putting the file back.
 */
function DriftPanel({ item, onClose }: { item: PlanItem; onClose: () => void }) {
  const ws = useWorkspace();
  const applied = item.appliedRevision ?? ws.appliedRevision;
  return (
    <DetailPanel
      title={item.resource}
      subtitle={<StateLabel state="drift" self />}
      onClose={onClose}
      footer={
        <Button variant="secondary" size="sm" className="ml-auto" onClick={() => ws.setView("local")}>
          Open {PLAIN.localNav}
        </Button>
      }
    >
      <p className="px-4 py-3 text-base text-pretty text-muted-foreground">
        You changed <Mono className="text-foreground">{item.target}</Mono>, this machine's copy of what {ws.sourceMachine.hostname} published, after Canonfig applied revision {applied}. Canonfig
        never overwrites it: it keeps your edit, reports it, and holds what it writes from {item.resource} in your harnesses at revision {applied}.
      </p>
      <div className="px-4">
        <div className="flex items-center gap-4 pb-1.5 font-mono text-xs text-faint">
          <span>
            <span className="text-bad">−</span> Revision {applied}
          </span>
          <span>
            <span className="text-ok">+</span> Your edit
          </span>
        </div>
        <pre tabIndex={0} aria-label={`Difference between revision ${applied} and your edit`} className="overflow-x-auto rounded-md border border-border bg-canvas/70 py-2 font-mono text-xs leading-relaxed">
          {DIFF.map((l, i) => (
            <div key={i} className={cn("px-3", l.t === "-" && "bg-bad/8 text-bad", l.t === "+" && "bg-ok/8 text-ok", l.t === " " && "text-muted-foreground")}>
              <span className="mr-2 text-faint select-none">{l.t === "-" ? "−" : l.t}</span>
              {l.s}
            </div>
          ))}
        </pre>
      </div>
      <div className="grid gap-2 px-4 py-4">
        <SectionLabel>To settle it</SectionLabel>
        <ul className="grid list-disc gap-2 pl-4 text-sm text-pretty text-muted-foreground">
          <li>
            <span className="text-foreground">Keep it on this machine.</span> Add your version to <Mono>~/.canonfig/local/{item.category}</Mono>, then put this file back as
            revision {applied} had it. Under its own name it sits next to the published one; under this name the update stops until you rename it or let yours replace the
            published one on this machine.
          </li>
          <li>
            <span className="text-foreground">Share it with every machine.</span> Ask {ws.sourceMachine.hostname} to publish the change. Once a revision holds the same content, the file
            matches again.
          </li>
          <li>
            <span className="text-foreground">Drop it.</span> Put the file back as revision {applied} had it, and the next update carries on.
          </li>
        </ul>
      </div>
    </DetailPanel>
  );
}

/** Shared-state key for the private adoption review: what `sync --plan --review-local` writes, as it was written. */
const REVIEW_KEY = "adoption-review";
type AdoptionReview = { id: string; files: { target: string; sourceAddition: string; retainedLocal: string }[] } | null;
/** The demo's review directory id; Canonfig names each one with a fresh UUID, which the real backend will report. */
const DEMO_REVIEW_ID = "6b1d0e52-94c3-4f7a-8e21-0c5f3a9d7b14";

/** The whole file `sync --apply` writes: Canonfig's marked section, a blank line, then the kept text (composeTextFile). */
const proposedText = (sourceAddition: string, retainedLocal: string) => `${SOURCE_TEXT_START}\n${sourceAddition}\n${SOURCE_TEXT_END}\n\n${retainedLocal}`;

/**
 * The text Canonfig owns in an instructions file: the published AGENTS.md, then this machine's local/AGENTS.md when
 * local.allow admits it (withLocalInstructions in src/projection/folder.ts), then links to the rules for harnesses
 * that read rules from their instructions file, as Amp and Codex do (instructionsText in shared-documents.ts).
 */
function sourceSection(published: Resource[], local: LocalItem[], home: string, localAllow: LocalCategory[]): string {
  const shared = published.find((r) => r.id === "instructions" && r.change !== "removed")?.detail.Body;
  const mine = localAllow.includes("instructions") ? local.find((l) => l.id === "instructions")?.detail?.Body : undefined;
  const text = shared !== undefined && mine !== undefined ? `${shared}${shared.endsWith("\n") ? "\n" : "\n\n"}${mine}` : (shared ?? mine);
  const sections = text?.trim() ? [text.trim()] : [];
  const rules = [
    ...published.filter((r) => r.category === "rules" && r.change !== "removed").map((r) => ({ path: `${home}/.canonfig/${r.path}`, detail: r.detail })),
    ...(localAllow.includes("rules") ? local.filter((l) => l.category === "rules").map((l) => ({ path: `${home}/.canonfig/local/${l.path}`, detail: l.detail ?? {} })) : []),
  ];
  if (rules.length > 0) {
    const scope = (d: Record<string, string>) => {
      const paths = (d.Paths ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      switch (d.Activation || (paths.length > 0 ? "path" : "always")) {
        case "path":
          return `applies to ${paths.map((p) => `\`${p}\``).join(", ")}`;
        case "manual":
          return "applies only when the user asks for it";
        case "model":
          return "applies when its description matches the task";
        default:
          return "always applies";
      }
    };
    sections.push(
      ["## Canonfig rules", "", "Read a rule file before doing work it covers:", "", ...rules.map((r) => `- \`${r.path}\` (${scope(r.detail)})${r.detail.Description ? `: ${r.detail.Description}` : ""}`)].join("\n"),
    );
  }
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

/**
 * An append-local first adoption (`sync --plan --review-local`). The text only appears after the person asks for it,
 * because writing the review copies instructions that may hold secrets into ~/.canonfig/.reviews/. What shows is the
 * review as written, so editing local/AGENTS.md afterwards needs a new review, as with the CLI.
 */
function AdoptionPanel({ item, onClose }: { item: PlanItem; onClose: () => void }) {
  const ws = useWorkspace();
  const [review, setReview] = useSharedState<AdoptionReview>(REVIEW_KEY, null);
  const file = review?.files.find((f) => f.target === item.target);
  const reviewDirOf = (id: string) => `~/.canonfig/.reviews/adoption-review-${id}/`;
  const reviewDir = review && reviewDirOf(review.id);
  const planned = ws.phase === "plan";
  const write = () => {
    const sourceAddition = sourceSection(ws.resources, ws.local, ws.followerSelf.home, ws.profile.localAllow);
    const files = ws.plan.flatMap((p) => (p.adoption ? [{ target: p.target, sourceAddition, retainedLocal: p.adoption.retained }] : []));
    setReview({ id: DEMO_REVIEW_ID, files });
    toast(`Wrote ${files.length} private ${files.length === 1 ? "review" : "reviews"}`, {
      description: `In ${reviewDirOf(DEMO_REVIEW_ID)}, readable only by you.\nDelete it when you're done.${DEMO ? "\nSimulated in this demo; no file is written." : ""}`,
    });
  };
  return (
    <DetailPanel
      title={item.resource}
      subtitle={<Mono>{item.target}</Mono>}
      onClose={onClose}
      footer={
        !ws.capabilities.privateReviewDelete ? null : review ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setReview(null);
              toast(`Deleted ${reviewDir}`);
            }}
          >
            Delete the review
          </Button>
        ) : (
          <Button variant="secondary" size="sm" className="ml-auto" disabled={!planned} onClick={write}>
            Show the exact text
          </Button>
        )
      }
    >
      <p className="px-4 py-3 text-base text-pretty text-muted-foreground">
        {planned ? (
          <>
            Canonfig hasn't written this file before. It backs it up, adds its own section at the top between two markers, and keeps the entire file you have below it as
            your text, even where it matches what {ws.sourceMachine.hostname} publishes: matching text doesn't show who wrote it. Later updates replace only Canonfig's section.
          </>
        ) : (
          <>Applied. Canonfig's section sits at the top of the file and your text below it. Later updates replace only Canonfig's section.</>
        )}
      </p>
      {file ? (
        <div className="grid gap-4 px-4 pb-4">
          <div className="grid gap-1.5">
            <SectionLabel>What Canonfig adds</SectionLabel>
            <ReviewText label="Text Canonfig adds and owns">{file.sourceAddition}</ReviewText>
          </div>
          <div className="grid gap-1.5">
            <SectionLabel>What stays yours</SectionLabel>
            <ReviewText label="Text this machine keeps">{file.retainedLocal}</ReviewText>
          </div>
          <Collapsible>
            <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1 rounded text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
              <CaretRight className="size-3.5 transition-transform duration-150 ease-snap group-data-[state=open]:rotate-90" />
              The whole file after this update
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <ReviewText label={`${item.target} after this update`}>{proposedText(file.sourceAddition, file.retainedLocal)}</ReviewText>
            </CollapsibleContent>
          </Collapsible>
          <p className="text-sm text-pretty text-faint">
            Written to <Mono>{reviewDir}</Mono>, readable only by you. It can hold secrets from your instructions, so don't paste it anywhere, and delete it when you're done.
          </p>
        </div>
      ) : (
        <p className="px-4 pb-4 text-sm text-pretty text-faint">
          {planned
            ? "Showing the text writes a private review to ~/.canonfig/.reviews/ on this machine. Canonfig never puts this text in the plan, the journal or anything it sends."
            : "Plan the next update to review a file again."}
        </p>
      )}
    </DetailPanel>
  );
}

/** Exact file text, scrollable and focusable so a long review can be read with the keyboard. */
function ReviewText({ label, children }: { label: string; children: string }) {
  return (
    // Ligatures off: the review shows exact bytes, and `<!--` must not render as an arrow.
    <pre
      tabIndex={0}
      aria-label={label}
      className="max-h-72 overflow-auto rounded-md border border-border bg-canvas/70 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [font-variant-ligatures:none]"
    >
      {children}
    </pre>
  );
}

export function ScheduleView() {
  const ws = useWorkspace();
  return <ScheduleForm key={ws.followerLive ? JSON.stringify(ws.followerSchedule) : "demo"} />;
}

function ScheduleForm() {
  const ws = useWorkspace();
  const [simulatedSaved, setSaved] = useSharedState<Schedule | null>(SCHEDULE_KEY, ws.followerSchedule);
  const saved = ws.followerLive ? ws.followerSchedule : simulatedSaved;
  // This is an unsaved form draft, not evidence of an installed schedule.
  const initial: Schedule = saved ?? { cadence: "default", days: [], time: ws.profileSchedule?.time ?? "" };
  const [draft, setDraft] = useState<Schedule>(initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  // With nothing saved, the untouched form is only the Source's default on offer, not an edit to lose.
  const { dialog: leaveDialog } = useLeaveGuard(JSON.stringify(draft) !== JSON.stringify(initial), "the schedule");
  const error = scheduleError(draft);
  const defaultLabel = ws.followerLive ? "published default" : "every day at 09:00";
  const { stopped } = useSyncBlocks();
  return (
    <>
      <PageHeader
        crumbs={["Schedule"]}
        actions={
          <Button
            data-tour="schedule-save"
            size="sm"
            variant="primary"
            disabled={(!dirty && !ws.followerLive) || error !== null || stopped !== null || ws.followerLive?.action.loading}
            onClick={async () => {
              if (ws.followerLive) {
                if (await ws.followerLive.saveSchedule(draft)) toast.success("Schedule saved");
                return;
              }
              setSaved(draft);
              ws.reach("schedule");
              toast.success("Schedule saved", { description: `${scheduleSummary(draft, `Same as the Source: ${defaultLabel}`)}.${DEMO ? "\nSaved in this demo workspace." : ""}` });
            }}
          >
            Save schedule
          </Button>
        }
      />
      <Body>
        <Column>
          {(stopped || saved === null) && <p role="status" className="mb-6 text-sm text-muted-foreground">{stopped ? `${stopped} Its schedule was removed.` : "No schedule is set, so this machine only updates when you apply from Sync."}</p>}
          <ScheduleFields idPrefix="sch" value={draft} onChange={setDraft} defaultLabel={defaultLabel} allowCustom={!!ws.followerLive} />
          {ws.followerLive ? <div className={cn("mt-8", settingsGroup)}>
            {/* "Not selected" tells you to run a CLI command; Save schedule above does that. */}
            <SettingRow title="Native schedule" description={text(ws.followerLive.schedule?.state) === "not-selected" ? undefined : text(ws.followerLive.schedule?.detail)}>{text(ws.followerLive.schedule?.state)?.replaceAll("-", " ") ?? "Not reported"}</SettingRow>
            {text(ws.followerLive.schedule?.nextRun) && <SettingRow title="Next check">{text(ws.followerLive.schedule?.nextRun)}</SettingRow>}
            {text(ws.followerLive.schedule?.platform) && <SettingRow title="Platform">{text(ws.followerLive.schedule?.platform)}</SettingRow>}
            {text(ws.followerLive.schedule?.unattendedRuns) && <SettingRow title="Recorded runs">{text(ws.followerLive.schedule?.unattendedRuns)}</SettingRow>}
          </div> : <div data-tour="schedule-next" className={cn("mt-8", settingsGroup)}>
            {/* Only a saved schedule has a real next check; an edited or never-saved one is a preview. */}
            <SettingRow title={!stopped && dirty ? "If you save this" : "Next check"}>{stopped ? "None" : nextCheck(draft, DEFAULT_TIME)}</SettingRow>
            <SettingRow title="Runs through" description="launchd agent">
              <Mono className="text-foreground">com.canonfig.follower</Mono>
            </SettingRow>
            <SettingRow title="If asleep">Runs when it wakes up</SettingRow>
          </div>}
        </Column>
      </Body>
      {leaveDialog}
    </>
  );
}

/** Singular names as Canonfig's collision message uses them (src/projection/folder.ts addLocal). */
const LOCAL_ONE: Record<LocalCategory, string> = { instructions: "instructions", rules: "rule", skills: "skill", plugins: "plugin", agents: "agent", commands: "command", mcp: "MCP server", settings: "setting" };

/** Where a local item lives, relative to ~/.canonfig/local/. */
function localPath(category: LocalCategory, name: string) {
  if (category === "instructions") return "AGENTS.md";
  if (category === "mcp" || category === "settings") return `local.jsonc ${category}.${name}`;
  return category === "skills" || category === "plugins" ? `${category}/${name}/` : `${category}/${name}.md`;
}


/** Whether two settings key paths name the same key or one sits inside the other. */
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/**
 * A local item's name collision with a published item, as Canonfig's message words it (addLocal and
 * mergeLocalSettings in src/projection/folder.ts), or null. Items outside local.allow aren't loaded, so they never
 * collide, and local/AGENTS.md is appended rather than compared. The message leaves out the command it suggests:
 * here that choice is a button.
 */
function collisionOf(l: LocalItem, ws: Pick<Workspace, "profile" | "resources">): string | null {
  if (l.category === "instructions" || !ws.profile.localAllow.includes(l.category)) return null;
  const name = l.id.slice(l.category.length + 1);
  if (l.category === "settings") {
    const published = Object.keys(ws.resources.find((r) => r.id === l.id)?.keys ?? {});
    for (const key of Object.keys(l.keys ?? {})) {
      const clash = published.find((p) => overlaps(key, p));
      if (clash) return `local setting ${name} ${key} overlaps published setting ${clash}; remove one of them`;
    }
    return null;
  }
  return ws.resources.some((r) => r.change !== "added" && r.id === l.id) ? `local ${LOCAL_ONE[l.category]} ${name} has the same name as a published one; rename or remove one of them` : null;
}

/** Local items whose collision no overlay settles. Any one stops the whole update before it changes anything. */
function unsettledCollisions(local: LocalItem[], overlays: string[], ws: Pick<Workspace, "profile" | "resources">) {
  return local.filter((l) => !overlays.includes(l.id) && collisionOf(l, ws) !== null);
}

/** A key claim, `settings/<harness>#<key>` in local.jsonc `overlays`, or null for an item overlay. */
function claimOf(entry: string): { harness: HarnessId; key: string } | null {
  const match = /^settings\/([^#]+)#(.+)$/.exec(entry);
  return match ? { harness: match[1] as HarnessId, key: match[2]! } : null;
}

/** Whether `key` is the claimed key or sits inside it, which is what a claim covers. */
const covers = (claimed: string, key: string) => key === claimed || key.startsWith(`${claimed}.`);

/**
 * The keys Canonfig writes in a harness's settings file here: the ones its adapter always owns and the ones
 * SOURCE publishes in settings.<harness>.
 */
function writtenKeys(harness: HarnessId, resources: Resource[]) {
  return [...(SETTINGS_FILES[harness]?.owned ?? []), ...Object.keys(resources.find((r) => r.id === `settings/${harness}`)?.keys ?? {})];
}

/**
 * Why Canonfig would refuse claiming `key` in `harness`'s settings file, in its own words where it has them
 * (keyClaimIssue and buildProjection in src/projection/plan.ts, the loader in folder.ts), or null. The CLI refuses
 * a claim inside a value only at the next update; here the claim is refused up front, as the local editor refuses
 * a name collision.
 */
function claimError(harness: HarnessId | "", key: string, overlays: string[], local: LocalItem[], resources: Resource[]): string | null {
  if (!harness) return "Choose a harness.";
  if (!key) return "Enter a key, such as model.";
  if (!/^(?:[^.\\]|\\[.\\])+(?:\.(?:[^.\\]|\\[.\\])+)*$/.test(key)) return "Use a settings path such as model or tui.theme; write \\. for a dot inside a key name.";
  const item = `settings/${harness}#${key}`;
  if (overlays.includes(item)) return `${key} is already yours in ${HARNESS_NAMES[harness]}'s settings.`;
  const segments = key.split(".");
  const reserved = SETTINGS_FILES[harness]?.reserved.find((pattern) => pattern.split(".").every((part, i) => i >= segments.length || part === "*" || part === segments[i]));
  if (reserved) return `${HARNESS_NAMES[harness]} keeps ${reserved} for itself, so Canonfig never writes it and there is nothing to claim.`;
  const whole = writtenKeys(harness, resources).find((written) => key.startsWith(`${written}.`));
  if (whole) return `Canonfig writes ${whole} as one value, so the update would stop: “overlay ${item} claims part of ${whole}, which Canonfig writes as one value; claim ${whole} instead”. Claim ${whole} instead.`;
  const localKey = Object.keys(local.find((l) => l.id === `settings/${harness}`)?.keys ?? {}).find((k) => overlaps(k, key));
  if (localKey) return `Your local settings also set ${localKey} for ${harness}, so the update would stop: “local setting ${harness} ${localKey} overlaps the key claim ${item}; remove one of them”. Remove that key first.`;
  return null;
}

/** The Sync notice for unsettled collisions: Canonfig won't choose between the two items, so the run can't start. */
function CollisionNotice({ collisions }: { collisions: LocalItem[] }) {
  const ws = useWorkspace();
  return (
    <RowPresence>
      {collisions.length > 0 && (
        <AnimatedRow key="collision">
          <Attention
            tone="act"
            title={
              <>
                <Term term="Human Action Required">Needs you</Term>:{" "}
                {collisions.length === 1 ? `${collisions[0].id} clashes with what ${ws.sourceMachine.hostname} publishes` : `${collisions.length} local items clash with what ${ws.sourceMachine.hostname} publishes`}
              </>
            }
            actions={
              <Button variant="outline" size="xs" onClick={() => ws.go("local")}>
                Open {PLAIN.localNav}
              </Button>
            }
          >
            The update stops before it changes anything: {collisions.map((l) => `“${collisionOf(l, ws)}”`).join(" ")}. Rename or remove yours, or let it replace the published one
            on this machine.
          </Attention>
        </AnimatedRow>
      )}
    </RowPresence>
  );
}

export function LocalView() {
  return <LocalForm />;
}

function LocalForm() {
  const ws = useWorkspace();
  const allowed = ws.followerLive?.allowed ?? ws.profile.localAllow;
  const shownCategories = LOCAL_CATEGORIES.filter((c) => allowed.includes(c) || ws.local.some((l) => l.category === c));
  const selected = ws.focus;
  const adding = selected === "new";
  const current = ws.local.find((l) => l.id === selected);
  const cols = "minmax(160px,240px) minmax(180px,360px) minmax(200px,1fr)";
  const colsMin = 160 + 180 + 200 + 2 * 12 + 20;
  const startAdding = () => ws.go("local", "new");
  const toggleHarness = (id: HarnessId, on: boolean) => {
    ws.setExcluded((prev) => (on ? prev.filter((h) => h !== id) : [...prev, id]));
    if (ws.followerLive) return;
    toast(on ? `Managing ${HARNESS_NAMES[id]} here again` : `Excluded ${HARNESS_NAMES[id]} on this machine`, {
      description: `Saved to ~/.canonfig/local/local.jsonc.\n${on ? "The next update writes the folder into it again." : "The next update leaves it alone."}${DEMO ? "\nSaved in this demo workspace." : ""}`,
    });
  };
  const [removingOverlay, setRemovingOverlay] = useState<string | null>(null);
  const [disableBackups, setDisableBackups] = useState(false);
  const [overlayDraft, setOverlayDraft] = useState("");
  // local.jsonc keeps item overlays and key claims in one list; this section shows the items, KeyClaims the claims.
  const itemOverlays = ws.overlays.filter((o) => claimOf(o) === null);
  const collisions = unsettledCollisions(ws.local, ws.overlays, ws);
  // An item's state as `sync --plan` sees it: ignored outside local.allow, stopping on an unsettled name collision,
  // or projected (replacing the published item when an overlay names it).
  const statusOf = (l: LocalItem): [StatusKind, string, string | undefined] => {
    if (ws.followerLive) return [allowed.includes(l.category) ? "ok" : "warn", allowed.includes(l.category) ? "Local item; checked on the next sync" : "Not admitted by the Source", undefined];
    if (!allowed.includes(l.category)) {
      // The warning `canonfig sync --plan` prints for a category local.allow leaves out (src/projection/plan.ts).
      const where = l.category === "instructions" ? "local/AGENTS.md" : l.category === "mcp" || l.category === "settings" ? `local/local.jsonc ${l.category}` : `local/${l.category}/`;
      return ["warn", `Not used: ${ws.sourceMachine.hostname} doesn't allow local ${l.category}`, `${where} is not admitted by canonfig.jsonc local.allow and was not projected`];
    }
    const collision = collisionOf(l, ws);
    const settings = l.category === "settings";
    if (collision && !ws.overlays.includes(l.id)) return ["act", `${settings ? "Overlaps published keys" : "Same name as a published one"}: the update stops`, collision];
    if (collision) return ["ok", settings ? `Replaces the ${ws.sourceMachine.hostname} keys it overlaps` : `Replaces ${ws.sourceMachine.hostname}'s ${l.id} here`, undefined];
    return ["ok", l.category === "instructions" ? "Added after the published instructions" : "Added to your harnesses", undefined];
  };
  // Harness files whose own content append-local keeps: what earlier updates kept, plus first adoptions the plan holds.
  const lineCount = (text: string) => text.replace(/\n$/, "").split("\n").length;
  const kept: (KeptSurface & { adopting?: string })[] = [
    ...ws.kept.filter((k) => ws.profile.appendLocal.includes(k.category)),
    ...ws.plan.flatMap((p) => (p.adoption ? [{ category: "instructions" as const, target: p.target, text: p.adoption.retained, adopting: ws.phase !== "done" ? p.resource : undefined }] : [])),
  ];

  return (
    <>
      <PageHeader
        crumbs={[PLAIN.localNav]}
        actions={
          <>
            {ws.followerLive && <Button size="sm" variant="outline" disabled={ws.followerLive.action.loading} onClick={() => { if ((!adding && !current) || window.confirm("Reload local settings and discard unsaved edits?")) ws.reload(); }}>Reload</Button>}
            {/* `canonfig export` takes this machine's mirror together with its local folder. */}
            <Button size="sm" variant="outline" disabled={ws.followerLive?.action.loading} onClick={ws.followerLive?.exportArchive ?? ws.exportArchive} title="Download ~/.canonfig/ and its local folder as a .tar.gz with a checksum manifest">
              Export
            </Button>
            {/* One gold action per view: while the editor is open its Save is the commit, so this steps down, like Profile's Add item. */}
            <Button size="sm" variant={adding || current ? "outline" : "primary"} disabled={allowed.length === 0} onClick={startAdding} data-tour="local-add">
              <Plus /> Add a local item
            </Button>
          </>
        }
      />
      <Body detail={(adding || current) && (ws.followerLive
        ? <LocalAuthoringEditor live={ws.followerLive} key={`${adding ? "new" : selected}:${ws.followerLive.local?.items.find((entry) => entry.path === (adding || current?.category === "mcp" || current?.category === "settings" ? "local.jsonc" : current?.path))?.digest ?? ""}`} item={adding ? null : current!} onClose={() => ws.go("local")} />
        : <LocalEditor key={adding ? "new" : selected} item={adding ? null : current!} onClose={() => ws.go("local")} />)}>
        <p className="border-b border-border px-[18px] py-3 text-sm text-pretty text-muted-foreground">
          Items in <Mono className="text-foreground">~/.canonfig/local</Mono> add to what the Source publishes and stay on this machine.
        </p>
        {/* A kind the Source does not allow, with nothing in it, is a row with nothing to do; list only usable or occupied kinds. */}
        {shownCategories.length === 0 && <EmptyState title="No local items allowed" body="The Source chooses which kinds a machine may add, in its Profile defaults." />}
        {shownCategories.length > 0 && <ListHead cols={cols} minWidth={colsMin} data-tour="local-list">
          <span>Name</span>
          <span>In ~/.canonfig/local</span>
          <span>Status</span>
        </ListHead>}
        {shownCategories.map((c) => {
          const items = ws.local.filter((l) => l.category === c);
          const ok = allowed.includes(c);
          return (
            <div key={c} data-tour="local-list">
              <GroupRow
                icon={CATEGORY_ICON[c]}
                label={CATEGORY_LABEL[c].label}
                count={items.length}
                hint={ok ? `${ws.sourceMachine.hostname} allows local ${CATEGORY_LABEL[c].label.toLowerCase()}.` : `${ws.sourceMachine.hostname}'s canonfig.jsonc local.allow leaves out ${c}, so Canonfig reports these and doesn't use them.`}
                minWidth={colsMin}
              />
              {items.length === 0 && <p className="mx-[8px] flex h-9 items-center px-[10px] text-sm text-faint">{ok ? "None yet." : `Not allowed by ${ws.sourceMachine.hostname}.`}</p>}
              <RowPresence>
                {items.map((l) => {
                  const [kind, label, title] = statusOf(l);
                  return (
                    <AnimatedRow key={l.id}>
                      <ListRow cols={cols} minWidth={colsMin} selected={selected === l.id} onClick={() => ws.go("local", l.id)}>
                        <span className="truncate font-medium">{c === "instructions" ? "AGENTS.md" : l.id.slice(c.length + 1)}</span>
                        <Mono className="truncate">{l.path}</Mono>
                        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" title={title}>
                          <StatusMark kind={kind} />
                          <span className="truncate">{label}</span>
                        </span>
                      </ListRow>
                    </AnimatedRow>
                  );
                })}
              </RowPresence>
            </div>
          );
        })}

        <div className="px-4 pt-8 sm:px-[18px]">
          <SectionLabel>
            <Term term="Local Overlay">Replacing published items</Term>
          </SectionLabel>
          <p className="pb-2 text-sm text-pretty text-muted-foreground">
            A local item named like a published one stops updates until you rename or remove it, or let it replace the published one here.
          </p>
          <div data-tour="local-overlays" className={cn("mt-1 max-w-[880px]", settingsGroup)}>
            {ws.followerLive && <form className="flex flex-wrap gap-2 px-4 py-3" onSubmit={(event) => { event.preventDefault(); if (overlayDraft.trim()) ws.setOverlays((current) => [...current, overlayDraft.trim()]); }}>
              <Input aria-label="Local item overlay" placeholder="rules/my-rule" className="min-w-40 flex-1" value={overlayDraft} onChange={(event) => setOverlayDraft(event.target.value)} />
              <Button type="submit" variant="outline" size="sm" disabled={ws.followerLive.action.loading || !overlayDraft.trim()}>Set overlay</Button>
            </form>}
            {itemOverlays.length === 0 && collisions.length === 0 && <p className="px-[16px] py-3 text-sm text-faint">{ws.followerLive ? "No item overlays recorded." : "No local item shares a published item's name."}</p>}
            {collisions.map((l) => (
              <SettingRow
                key={`collision:${l.id}`}
                title={
                  <span className="flex items-center gap-2" title={collisionOf(l, ws) ?? undefined}>
                    <StatusMark kind="act" />
                    <span className="font-mono text-sm">{l.id}</span>
                  </span>
                }
                description={`${l.category === "settings" ? `Sets keys ${ws.sourceMachine.hostname} also sets` : `Same name as ${ws.sourceMachine.hostname}'s`}, so the next update stops and needs you.`}
              >
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    ws.setOverlays((prev) => [...prev, l.id]);
                    if (ws.followerLive) return;
                    toast.success(`Yours replaces ${ws.sourceMachine.hostname}'s ${l.id}`, {
                      description: `Saved as an overlay in ~/.canonfig/local/local.jsonc.\nThe next update uses your ${l.id} on this machine.${DEMO ? "\nSaved in this demo workspace." : ""}`,
                    });
                  }}
                >
                  Let mine replace it
                </Button>
              </SettingRow>
            ))}
            {itemOverlays.map((o) => {
              const mine = ws.local.some((l) => l.id === o && allowed.includes(l.category));
              const theirs = ws.followerLive ? undefined : ws.resources.some((r) => r.change !== "added" && r.id === o);
              // The plan's OVERLAY_UNUSED warning (src/projection/plan.ts), without the command it suggests.
              const unused = `overlay ${o} finds no admitted local/ item of that name, so ${theirs ? "the published item is projected" : "it changes nothing"}`;
              return (
                <SettingRow
                  key={`overlay:${o}`}
                  title={
                    <span className="flex items-center gap-2" title={mine ? undefined : unused}>
                      <StatusMark kind={mine ? (theirs ? "ok" : "off") : "warn"} />
                      <span className="font-mono text-sm">{o}</span>
                    </span>
                  }
                  description={
                    ws.followerLive ? "The local item replaces the published item on this machine. Sync checks that both items exist." :
                    mine
                      ? theirs
                        ? o.startsWith("settings/")
                          ? `Your keys replace the ${ws.sourceMachine.hostname} keys they overlap in ${o} on this machine; the others stay.`
                          : `Your ${o} replaces ${ws.sourceMachine.hostname}'s on this machine.`
                        : `${ws.sourceMachine.hostname} doesn't publish ${o}, so yours is simply added.`
                      : `No local ${o} here, so ${theirs ? `${ws.sourceMachine.hostname}'s is used` : "this changes nothing"}. Add the local item, or remove this.`
                  }
                >
                  <Button variant="outline" size="xs" onClick={() => setRemovingOverlay(o)}>
                    Remove…
                  </Button>
                </SettingRow>
              );
            })}
          </div>
        </div>

        <KeyClaims />
        {ws.followerLive?.archive && <div className="px-[18px] pt-8"><SectionLabel>Verified export</SectionLabel><div className={settingsGroup}>
          <SettingRow title="Archive checksum"><Mono className="break-all">{ws.followerLive.archive.sha256}</Mono></SettingRow>
          <SettingRow title="Manifest checksum"><Mono className="break-all">{ws.followerLive.archive.manifestSha256}</Mono></SettingRow>
          <SettingRow title="Signer"><Mono className="break-all">{ws.followerLive.archive.signer}</Mono></SettingRow>
        </div></div>}

        {!ws.followerLive && <>
        <div className="px-4 pt-8 sm:px-[18px]">
          <SectionLabel>
            <Term term="Append-local">Your own content in shared files</Term>
          </SectionLabel>
          <p className="pb-2 text-sm text-pretty text-muted-foreground">
            {ws.profile.appendLocal.length > 0
              ? `${ws.sourceMachine.hostname} shares ${ws.profile.appendLocal.map((c) => APPEND_LOCAL_LABEL[c].toLowerCase()).join(" and ")} with this machine. Canonfig owns only its marked section of each instructions file and the skills it writes; what you put there stays, byte for byte, and never counts as an edit.`
              : `${ws.sourceMachine.hostname} doesn't share instructions files or skills folders, so Canonfig owns them whole. Keep your own text and skills in ~/.canonfig/local.`}
          </p>
          {kept.length > 0 && (
            <div data-tour="local-kept" className={cn("mt-1 max-w-[880px]", settingsGroup)}>
              {kept.map((k) => (
                <SettingRow
                  key={k.target}
                  title={<span className="font-mono text-sm">{k.target}</span>}
                  description={
                    k.adopting
                      ? "Canonfig hasn't written it yet. The next update keeps the whole file as your text, below Canonfig's section."
                      : k.category === "instructions"
                        ? `Your ${lineCount(k.text)} ${lineCount(k.text) === 1 ? "line" : "lines"} below Canonfig's section stay as they are.`
                        : `${k.entries.length} skills of yours sit beside Canonfig's: ${k.entries.join(", ")}.`
                  }
                >
                  {k.adopting && ws.phase === "plan" && (
                    <Button variant="outline" size="xs" onClick={() => ws.go("sync", k.adopting)}>
                      Review in Sync
                    </Button>
                  )}
                </SettingRow>
              ))}
            </div>
          )}
        </div>
        </>}

        <div className="px-[18px] pt-8">
          <SectionLabel>Harnesses on this machine</SectionLabel>
          <p className="pb-2 text-sm text-pretty text-muted-foreground">
            Canonfig writes the folder into each harness {ws.sourceMachine.hostname} lists that is installed here. Untick one to exclude it on this machine only; {ws.sourceMachine.hostname}'s list stays as it is.
          </p>
        </div>
        <div data-tour="local-harnesses">
          <HarnessTable edit="managed" onToggle={toggleHarness} />
        </div>
        <div className="px-4 pt-8 pb-20 sm:px-[18px]">
          <SectionLabel>Backups</SectionLabel>
          <div data-tour="local-backups" className={cn("mt-1 max-w-[880px]", settingsGroup)}>
            <SettingRow
              title="Back up a harness before taking it over"
              htmlFor="local-backups"
              description={
                <>
                  <Mono>"backups"</Mono> in local.jsonc. Only this machine decides; {ws.sourceMachine.hostname} can't turn it off.
                </>
              }
            >
              <Switch
                id="local-backups"
                checked={ws.backups}
                onCheckedChange={(on) => {
                  if (ws.followerLive) { if (on) ws.setBackups(true); else setDisableBackups(true); return; }
                  ws.setBackups(on);
                  toast(on ? "Backups on" : "Backups off on this machine", {
                    description: `${on ? "Canonfig backs up each harness before it first writes there." : `Saved as "backups": false in ~/.canonfig/local/local.jsonc.\nCanonfig takes over new harnesses without a snapshot; existing snapshots stay.`}${DEMO ? "\nSaved in this demo workspace." : ""}`,
                  });
                }}
              />
            </SettingRow>
          </div>
        </div>
      </Body>
      <ConfirmDialog open={disableBackups} onOpenChange={setDisableBackups} title="Turn off takeover backups?" body="When Canonfig first syncs into a harness, it will no longer back up what was there. Existing snapshots remain." confirm="Turn off backups" onConfirm={() => ws.setBackups(false)} />
      <ConfirmDialog
        open={removingOverlay !== null}
        onOpenChange={(o) => !o && setRemovingOverlay(null)}
        title={`Stop replacing ${removingOverlay}?`}
        body={
          ws.local.some((l) => l.id === removingOverlay && collisionOf(l, ws) !== null)
            ? `Canonfig removes the overlay from ~/.canonfig/local/local.jsonc. Your ${removingOverlay} stays, so the next update stops with the name collision until you rename or remove it.`
            : `Canonfig removes the overlay from ~/.canonfig/local/local.jsonc. No local item of that name clashes with what ${ws.sourceMachine.hostname} publishes, so nothing else changes.`
        }
        confirm="Remove"
        onConfirm={() => {
          const item = removingOverlay;
          ws.setOverlays((prev) => prev.filter((o) => o !== item));
          if (ws.followerLive) return;
          toast(`Removed the overlay for ${item}`, { description: `Saved to ~/.canonfig/local/local.jsonc.${DEMO ? "\nSaved in this demo workspace." : ""}` });
        }}
      />
    </>
  );
}

/** Harnesses whose settings file Canonfig writes; a key claim can name only these. */
const CLAIM_HARNESSES = (Object.keys(HARNESS_NAMES) as HarnessId[]).filter((h) => SETTINGS_FILES[h] !== undefined);

/**
 * Key claims (ADR 0003 section 11): `settings/<harness>#<key>` entries in local.jsonc `overlays`. A claimed key is
 * this machine's own in that harness's settings file: Canonfig never writes, removes or checks it there, and the other
 * keys it writes in the file keep following SOURCE. Removing a claim lets the next update write SOURCE's value again.
 */
function KeyClaims() {
  const ws = useWorkspace();
  const [harness, setHarness] = useState<HarnessId | "">("");
  const [key, setKey] = useState("");
  const [tried, setTried] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const claims = ws.overlays.flatMap((item) => {
    const claim = claimOf(item);
    return claim ? [{ item, ...claim }] : [];
  });
  const trimmed = key.trim();
  const error = claimError(harness, trimmed, ws.overlays, ws.local, ws.resources);
  const add = () => {
    setTried(true);
    if (error || !harness) {
      document.getElementById(harness ? "claim-key" : "claim-harness")?.focus();
      return;
    }
    ws.setOverlays((prev) => [...prev, `settings/${harness}#${trimmed}`]);
    if (ws.followerLive) return;
    toast.success(`${trimmed} is yours in ${HARNESS_NAMES[harness]}'s settings`, {
      description: `Saved as a key claim in ~/.canonfig/local/local.jsonc.\nThe next update stops writing it; set it in ${HARNESS_NAMES[harness]}'s own settings file.${DEMO ? "\nSaved in this demo workspace." : ""}`,
    });
    setKey("");
    setTried(false);
  };
  const removed = removing === null ? null : claimOf(removing);
  const removedValue = removed && ws.resources.find((r) => r.id === `settings/${removed.harness}`)?.keys?.[removed.key];

  return (
    <div className="px-4 pt-8 sm:px-[18px]">
      <SectionLabel>
        <Term term="Key Claim">Settings keys you set yourself</Term>
      </SectionLabel>
      <p className="pb-2 text-sm text-pretty text-muted-foreground">
        Claim one key of a harness's settings file to set it in that file yourself. Canonfig stops writing, removing or checking that key on this machine, and the
        other keys it writes there keep following {ws.sourceMachine.hostname}. Claims live in local.jsonc and never go to {ws.sourceMachine.hostname}.
      </p>
      <div data-tour="local-claims" className={cn("mt-1 max-w-[880px]", settingsGroup)}>
        {claims.length === 0 && <p className="px-[16px] py-3 text-sm text-faint">No key is claimed, so Canonfig writes every key it owns.</p>}
        {claims.map((c) => {
          const name = HARNESS_NAMES[c.harness];
          const written = writtenKeys(c.harness, ws.resources);
          const whole = written.find((k) => c.key.startsWith(`${k}.`));
          const covered = written.filter((k) => covers(c.key, k));
          // The refusal buildProjection gives, and the plan's CLAIM_UNUSED warning (src/projection/plan.ts).
          const [kind, description, title]: [StatusKind, string, string | undefined] = ws.followerLive
            ? ["ok", `This key belongs to this machine. The next sync checks the claim against published settings.`, undefined] : whole
            ? ["act", `Canonfig writes ${whole} as one value, so the next update stops. Claim ${whole} instead.`, `overlay ${c.item} claims part of ${whole}, which Canonfig writes as one value; claim ${whole} instead`]
            : covered.length === 0
              ? ["warn", `Canonfig writes no ${c.key} in ${name}'s settings file, so this changes nothing.`, `overlay ${c.item} covers no key Canonfig writes in ${c.harness}'s settings file, so it changes nothing`]
              : ["ok", `${ws.sourceMachine.hostname} sets ${covered.join(", ")}. Here you set it in ${name}'s settings file, and Canonfig leaves it alone.`, undefined];
          return (
            <SettingRow
              key={`claim:${c.item}`}
              title={
                <span className="flex items-center gap-2" title={title}>
                  <StatusMark kind={kind} />
                  <span className="font-mono text-sm">{c.item}</span>
                </span>
              }
              description={description}
            >
              <Button variant="outline" size="xs" onClick={() => setRemoving(c.item)}>
                Remove…
              </Button>
            </SettingRow>
          );
        })}
        <form
          className="flex flex-wrap items-center gap-2 px-[16px] py-3"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Select value={harness} onValueChange={(h: HarnessId) => setHarness(h)}>
            <SelectTrigger id="claim-harness" aria-label="Harness" className="w-[200px]" aria-invalid={tried && !harness}>
              <SelectValue placeholder="Choose a harness">{harness && HARNESS_NAMES[harness]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CLAIM_HARNESSES.map((h) => (
                <SelectItem key={h} value={h}>
                  {HARNESS_NAMES[h]}
                  <span className="font-mono text-xs text-faint">{h}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            id="claim-key"
            aria-label="Settings key"
            className="min-w-[160px] flex-1 font-mono"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="model"
            spellCheck={false}
            aria-invalid={tried && !!error}
            aria-describedby={tried && error ? "claim-key-note" : undefined}
          />
          <Button type="submit" variant="outline" size="sm">
            <Plus /> Claim key
          </Button>
          {tried && error && (
            <p id="claim-key-note" role="alert" className="flex w-full items-center gap-1.5 text-sm text-pretty text-bad">
              <WarningCircle className="size-3.5 shrink-0" />
              {error}
            </p>
          )}
        </form>
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Give ${removed?.key} back to ${ws.sourceMachine.hostname}?`}
        body={
          ws.followerLive ? "Canonfig removes the claim. The next sync may write the published value to this key again." :
          removed && writtenKeys(removed.harness, ws.resources).some((k) => covers(removed.key, k))
            ? `Canonfig removes the claim from ~/.canonfig/local/local.jsonc. The next update writes ${ws.sourceMachine.hostname}'s ${removed.key}${removedValue ? ` (${removedValue})` : ""} over yours in ${HARNESS_NAMES[removed.harness]}'s settings file, and an edit after that counts as a local change.`
            : `Canonfig removes the claim from ~/.canonfig/local/local.jsonc. It writes no ${removed?.key} there, so nothing else changes.`
        }
        confirm="Remove"
        onConfirm={() => {
          const item = removing;
          ws.setOverlays((prev) => prev.filter((o) => o !== item));
          if (ws.followerLive) return;
          toast(`Removed the claim on ${removed?.key}`, { description: `Saved to ~/.canonfig/local/local.jsonc.${DEMO ? "\nSaved in this demo workspace." : ""}` });
        }}
      />
    </div>
  );
}

interface KeyRow {
  id: number;
  key: string;
  value: string;
}

/**
 * Add or edit one item in ~/.canonfig/local/. AGENTS.md, rules, skills, agents and commands are files; MCP servers and
 * settings are keys of local.jsonc. A name that collides with a published item, or a settings key that overlaps a
 * published one, would stop every update with Human Action Required, so saving one needs the overlay that settles it:
 * "Let mine replace" records `<category>/<name>` in local.jsonc `overlays`.
 */
function LocalEditor({ item, onClose }: { item: LocalItem | null; onClose: () => void }) {
  const ws = useWorkspace();
  const isNew = item === null;
  const allowed = ws.profile.localAllow;
  // local/AGENTS.md is one file, so a folder that has it offers no second one.
  const kinds = allowed.filter((c) => c !== "instructions" || !ws.local.some((l) => l.id === "instructions" && l !== item));
  const initial: LocalItem = item ?? { id: "", category: kinds[0], path: "", summary: "", detail: {} };
  const [category, setCategory] = useState<LocalCategory>(initial.category);
  const [name, setName] = useState(item && item.category !== "instructions" ? item.id.slice(item.category.length + 1) : "");
  const [detail, setDetail] = useState<Record<string, string>>(initial.detail ?? {});
  const [rows, setRows] = useState<KeyRow[]>(() => Object.entries(initial.keys ?? {}).map(([key, value], id) => ({ id, key, value })));
  const initialReplace = item !== null && ws.overlays.includes(item.id);
  const [replace, setReplace] = useState(initialReplace);
  const [tried, setTried] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (k: string, v: string) => setDetail((d) => ({ ...d, [k]: v }));
  const trimmed = name.trim();
  const isInstructions = category === "instructions";
  const id = isInstructions ? "instructions" : `${category}/${trimmed}`;
  const isFile = !isInstructions && category !== "mcp" && category !== "settings";
  const transport = detail.Transport ?? "stdio";
  const published = ws.resources.find((r) => r.change !== "added" && r.id === id);
  const publishedKeys = category === "settings" ? Object.keys(ws.resources.find((r) => r.id === id)?.keys ?? {}) : [];
  const keyClash = (key: string) => publishedKeys.find((p) => overlaps(key, p));
  // What projection would compare: only admitted categories load, and local/AGENTS.md is appended, never compared.
  const collides =
    allowed.includes(category) && !isInstructions && (category === "settings" ? rows.some((r) => r.key.trim() && keyClash(r.key.trim())) : published !== undefined);

  const nameError = isInstructions
    ? null
    : !trimmed
      ? category === "settings"
        ? "Choose a harness."
        : "Enter a name."
      : !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)
        ? "Use letters, digits, - and _, starting with a letter or digit."
        : ws.local.some((l) => l.id === id && l !== item)
          ? `${id} is already in your local folder.`
          : collides && category !== "settings" && !replace
            ? `${ws.sourceMachine.hostname} publishes ${id} too, so the update would stop and need you: “local ${LOCAL_ONE[category]} ${trimmed} has the same name as a published one; rename or remove one of them”. Rename yours, or let it replace the published one.`
            : null;
  const requiredError = isFile
    ? category !== "rules" && !detail.Description?.trim()
      ? "Enter a description."
      : null
    : category === "mcp" && !(transport === "stdio" ? detail.Command : detail.URL)?.trim()
      ? transport === "stdio"
        ? "Enter a command."
        : "Enter the URL."
      : null;
  // With instructions shared append-local, Canonfig's section sits between reserved markers, and local/AGENTS.md is
  // part of that section, so marker text in it stops projection for each harness (sourceTextIssue).
  const markerHarness = ws.harnesses.find((h) => h.listed && h.installed && !h.excluded)?.id ?? "codex";
  const markerError =
    isInstructions && ws.profile.appendLocal.includes("instructions") && [SOURCE_TEXT_START, SOURCE_TEXT_END].some((m) => (detail.Body ?? "").includes(m))
      ? `Remove the Canonfig marker text. Every update would stop: “${markerHarness} instructions cannot keep this machine's text: append-local Source text contains a reserved Canonfig marker”.`
      : null;
  const rowError = (r: KeyRow) => {
    const key = r.key.trim();
    if (!key) return "Name this key, or remove the row.";
    // The loader refuses a local setting for a key this machine claims (loadCanonicalFolder in src/projection/folder.ts).
    const claimed = ws.overlays.map(claimOf).find((c) => c?.harness === trimmed && overlaps(c.key, key));
    if (claimed) return `You claimed ${claimed.key} for ${trimmed}, so the update would stop: “local setting ${trimmed} ${key} overlaps the key claim settings/${trimmed}#${claimed.key}; remove one of them”. Remove the key, or remove the claim under Settings keys you set yourself.`;
    const clash = keyClash(key);
    return clash && !replace
      ? `${ws.sourceMachine.hostname} sets ${clash} for ${trimmed}, so the update would stop and need you: “local setting ${trimmed} ${key} overlaps published setting ${clash}; remove one of them”. Remove the key, or let yours replace the published one.`
      : null;
  };
  const badRow = category === "settings" ? rows.find((r) => rowError(r) !== null) : undefined;

  const keys = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
  const lines = (detail.Body ?? "").split("\n").length;
  const next: LocalItem = {
    id,
    category,
    path: localPath(category, trimmed),
    summary: isInstructions
      ? `${lines} ${lines === 1 ? "line" : "lines"}`
      : category === "settings"
        ? `${rows.length} ${rows.length === 1 ? "key" : "keys"}`
        : category === "mcp"
          ? transport === "stdio"
            ? `stdio, ${detail.Command ?? ""}`
            : transport
          : CATEGORY_LABEL[category].label,
    detail,
    ...(category === "settings" ? { keys } : {}),
  };
  // Compared field by field with what the panel opened on; an unnamed key row is already an edit.
  const dirty =
    trimmed !== (item && item.category !== "instructions" ? item.id.slice(item.category.length + 1) : "") ||
    JSON.stringify(detail) !== JSON.stringify(initial.detail ?? {}) ||
    JSON.stringify(rows.map((r) => [r.key, r.value])) !== JSON.stringify(Object.entries(initial.keys ?? {})) ||
    replace !== initialReplace;
  const { dialog: leaveDialog, leaveWithoutAsking } = useLeaveGuard(dirty, isNew ? "the new local item" : item.id);

  const save = () => {
    setTried(true);
    if (nameError || requiredError || markerError || badRow) {
      document.getElementById(nameError ? "local-name" : requiredError ? "local-required" : markerError ? "local-body" : `local-key-${badRow!.id}`)?.focus();
      return;
    }
    ws.setLocal((prev) => (isNew ? [...prev, next] : prev.map((l) => (l === item ? next : l))));
    // The overlay settles a collision this item has; one it no longer needs stays, as `canonfig overlay` leaves it.
    const overlaid = collides && replace && !ws.overlays.includes(id);
    if (overlaid) ws.setOverlays((prev) => [...prev, id]);
    toast.success(`Saved ${id}`, {
      description: `Written to ~/.canonfig/local/${next.path}.\n${
        isInstructions ? "The next update adds it after the published instructions in every harness." : "The next update adds it to your harnesses."
      }${overlaid ? `\n${category === "settings" ? `Your keys replace the ${ws.sourceMachine.hostname} keys they overlap in ${id}` : `Yours replaces ${ws.sourceMachine.hostname}'s ${id} here`}: saved as an overlay in local.jsonc.` : ""}${DEMO ? "\nSaved in this demo workspace." : ""}`,
    });
    leaveWithoutAsking(() => ws.go("local", id, { replace: isNew }));
  };

  return (
    <DetailPanel
      title={isNew ? "Add a local item" : item.id}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button variant="destructive" size="sm" onClick={() => setConfirmRemove(true)}>
              Remove…
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={!isNew && !dirty}
              onClick={
                isNew
                  ? () => leaveWithoutAsking(onClose)
                  : () => (
                      setDetail(initial.detail ?? {}),
                      setRows(Object.entries(initial.keys ?? {}).map(([key, value], id) => ({ id, key, value }))),
                      setReplace(initialReplace),
                      setTried(false)
                    )
              }
            >
              {isNew ? "Cancel" : "Discard"}
            </Button>
            <Button variant="primary" size="sm" disabled={!isNew && !dirty} onClick={save}>
              {isNew ? "Add to the local folder" : "Save"}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid gap-4 px-4 py-4">
        {!allowed.includes(category) && (
          <p className="text-sm text-pretty text-warn">
            {ws.sourceMachine.hostname}'s canonfig.jsonc local.allow leaves out {category}, so Canonfig reports this item and doesn't use it. Ask {ws.sourceMachine.hostname} to allow local {category}, or remove it.
          </p>
        )}
        <Field label="Kind" htmlFor="local-category" description={isNew ? `${ws.sourceMachine.hostname} allows ${allowed.map((c) => CATEGORY_LABEL[c].label.toLowerCase()).join(", ")}.` : undefined}>
          <Select
            value={category}
            disabled={!isNew}
            onValueChange={(c: LocalCategory) => {
              setCategory(c);
              setName("");
              setDetail({});
              setRows([]);
            }}
          >
            <SelectTrigger id="local-category" className="w-full">
              <SelectValue>{CATEGORY_LABEL[category].label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {kinds.map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABEL[c].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {isInstructions ? null : category === "settings" ? (
          <Field label="Harness" htmlFor="local-name" error={tried ? nameError : null}>
            <Select value={trimmed} onValueChange={setName} disabled={!isNew}>
              <SelectTrigger id="local-name" className="w-full" aria-invalid={tried && !!nameError}>
                <SelectValue placeholder="Choose a harness">{trimmed && HARNESS_NAMES[trimmed as HarnessId]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(HARNESS_NAMES) as HarnessId[]).map((h) => (
                  <SelectItem key={h} value={h}>
                    {HARNESS_NAMES[h]}
                    <span className="font-mono text-xs text-faint">{h}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Field label="Name" htmlFor="local-name" error={tried ? nameError : null}>
            <Input
              id="local-name"
              value={name}
              disabled={!isNew}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={tried && !!nameError}
              aria-describedby={tried && nameError ? "local-name-note" : undefined}
              placeholder={category === "mcp" ? "notes" : "pdf-tools"}
              autoComplete="off"
              spellCheck={false}
              autoFocus={isNew}
              className="font-mono text-sm"
            />
          </Field>
        )}
        {isFile && (
          <>
            <Field label="Description" htmlFor="local-required" error={tried ? requiredError : null}>
              <Input id="local-required" value={detail.Description ?? ""} onChange={(e) => set("Description", e.target.value)} aria-invalid={tried && !!requiredError} autoComplete="off" />
            </Field>
            <Field label="Body" htmlFor="local-body">
              <Textarea id="local-body" value={detail.Body ?? ""} onChange={(e) => set("Body", e.target.value)} spellCheck={false} className="max-h-80 font-mono text-sm" />
            </Field>
          </>
        )}
        {isInstructions && (
          <Field
            label="Body"
            htmlFor="local-body"
            error={tried ? markerError : null}
            description="Saved as ~/.canonfig/local/AGENTS.md. Canonfig adds it after the published instructions, inside its own section, in every harness on this machine."
          >
            <Textarea
              id="local-body"
              value={detail.Body ?? ""}
              placeholder="## On this machine"
              onChange={(e) => set("Body", e.target.value)}
              aria-invalid={tried && !!markerError}
              aria-describedby="local-body-note"
              spellCheck={false}
              autoFocus={isNew}
              className="max-h-80 font-mono text-sm"
            />
          </Field>
        )}
        {category === "mcp" && (
          <>
            <Field label="Transport" htmlFor="local-transport">
              <Select value={transport} onValueChange={(v) => set("Transport", v)}>
                <SelectTrigger id="local-transport" className="w-full" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["stdio", "streamable-http", "sse"].map((t) => (
                    <SelectItem key={t} value={t}>
                      <span className="font-mono text-sm">{t}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={transport === "stdio" ? "Command" : "URL"} htmlFor="local-required" error={tried ? requiredError : null}>
              <Input
                id="local-required"
                value={(transport === "stdio" ? detail.Command : detail.URL) ?? ""}
                onChange={(e) => set(transport === "stdio" ? "Command" : "URL", e.target.value)}
                aria-invalid={tried && !!requiredError}
                placeholder={transport === "stdio" ? "uvx mcp-notes" : "https://notes.example.com/mcp"}
                autoComplete="off"
                spellCheck={false}
                className="h-7 font-mono text-sm"
              />
            </Field>
          </>
        )}
        {category === "settings" && (
          <div className="grid gap-2">
            <SectionLabel
              action={
                <Button
                  type="button"
                  id="local-add-key"
                  variant="ghost"
                  size="xs"
                  onClick={() => setRows((prev) => [...prev, { id: Math.max(-1, ...prev.map((r) => r.id)) + 1, key: "", value: '""' }])}
                >
                  <Plus /> Add key
                </Button>
              }
            >
              Keys this machine sets
            </SectionLabel>
            {rows.length === 0 && <p className="text-sm text-faint">No keys yet.</p>}
            {rows.map((r, i) => {
              const err = tried ? rowError(r) : null;
              return (
                <div key={r.id} className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)_24px] items-start gap-x-1.5">
                  <div className="grid gap-1">
                    <Input
                      id={`local-key-${r.id}`}
                      value={r.key}
                      aria-label={`Key ${i + 1} path`}
                      placeholder="model"
                      aria-invalid={!!err}
                      aria-describedby={err ? `local-key-${r.id}-note` : undefined}
                      onChange={(e) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, key: e.target.value } : x)))}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-7 font-mono text-sm"
                    />
                    {err && (
                      <span id={`local-key-${r.id}-note`} role="alert" className="text-xs text-pretty text-bad">
                        {err}
                      </span>
                    )}
                  </div>
                  <Input
                    value={r.value}
                    aria-label={`Key ${i + 1} value`}
                    onChange={(e) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-7 font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="mt-0.5 text-faint"
                    aria-label={`Remove key ${r.key || i + 1}`}
                    onClick={(e) => removeKeepingFocus(e.currentTarget, () => setRows((prev) => prev.filter((x) => x.id !== r.id)), "local-add-key")}
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
            {publishedKeys.length > 0 && (
              <p className="text-xs text-pretty text-faint">
                {ws.sourceMachine.hostname} already sets {publishedKeys.join(", ")} for this harness. A local key that overlaps one of those stops the update unless yours replaces it.
              </p>
            )}
          </div>
        )}
        {collides && (
          <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5">
            <Checkbox id="local-replace" checked={replace} onCheckedChange={(on) => setReplace(on === true)} className="mt-0.5" />
            <Label htmlFor="local-replace" className="cursor-pointer text-base font-normal text-pretty">
              Let mine replace {ws.sourceMachine.hostname}'s on this machine
            </Label>
            <p className="col-start-2 text-sm text-pretty text-faint">
              {category === "settings" ? `Your keys replace the published keys they overlap in ${id}; ${ws.sourceMachine.hostname}'s other keys stay.` : `Your ${id} is used here instead of ${ws.sourceMachine.hostname}'s.`}{" "}
              Kept in local.jsonc as a <Term term="Local Overlay">local replacement</Term> and never sent to {ws.sourceMachine.hostname}.
            </p>
          </div>
        )}
      </div>
      {!isNew && (
        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove ${item.id}?`}
          body="Canonfig deletes it from ~/.canonfig/local, and the next update removes what it wrote from it."
          confirm="Remove"
          onConfirm={() =>
            leaveWithoutAsking(() => {
              ws.setLocal((prev) => prev.filter((l) => l !== item));
              ws.go("local");
              toast(`Removed ${item.id}`, {
                description: ws.overlays.includes(item.id) ? `Its overlay stays in local.jsonc and now finds no local item.\nRemove it under Replacing published items.` : undefined,
              });
            })
          }
        />
      )}
      {leaveDialog}
    </DetailPanel>
  );
}

export function FollowerSecretsView() {
  const ws = useWorkspace();
  const [refresh, setRefresh] = useSharedState(SECRETS_KEY, ws.secretsRefresh);
  const { blocked, unreachable } = useSyncBlocks();
  const cols = "minmax(180px,240px) minmax(140px,1fr)";
  const secretRows = ws.followerLive ? ws.followerLive.secrets : ws.secrets;
  const colsMin = 180 + 140 + 12 + 20;
  return (
    <>
      <PageHeader
        crumbs={["Secrets"]}
        actions={
          <Button
            data-tour="secrets-update"
            size="sm"
            variant="primary"
            disabled={ws.followerLive ? ws.followerLive.action.loading || blocked !== null : !ws.capabilities.followerWrite || refresh.busy || blocked !== null}
            onClick={() => {
              if (ws.followerLive) { ws.followerLive.refreshSecrets(); return; }
              setRefresh((prev) => ({ ...prev, busy: true }));
              ws.later(() => {
                if (unreachable()) {
                  // Syncing or the tunnel stopped during the refresh: nothing was refreshed, so keep the earlier time.
                  setRefresh((prev) => ({ ...prev, busy: false }));
                  return;
                }
                // A clock time, unlike "just now", stays true when the page is opened again later.
                setRefresh({ busy: false, updated: `today at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` });
                toast.success("Secrets updated", { description: `${DEMO ? "Checked in this demo workspace: " : ""}2 secrets, no changes.` });
              }, 900);
            }}
          >
            {(ws.followerLive ? ws.secretsRefresh.busy : refresh.busy) ? "Updating…" : "Update secrets"}
          </Button>
        }
      />
      <Body reloading={refresh.busy}>
        {(ws.capabilities.simulatedTelemetry || (ws.followerLive && ws.secretsRefresh.updated)) && <p data-tour="secrets-about" className="border-b border-border px-[18px] py-3 text-sm text-pretty text-muted-foreground">
          {ws.capabilities.simulatedTelemetry ? <>This machine <Term term="Follower Group"><span className="lowercase">{PLAIN.secretsGroup}</span></Term> (group <Mono className="text-foreground">{SECRETS_GROUP}</Mono>), so it gets shared secrets from {ws.sourceMachine.hostname} into the macOS Keychain. Last updated {refresh.updated}.{blocked && ` ${blocked}`}</> : null}
          {ws.followerLive && ws.secretsRefresh.updated && <span role="status"> {ws.secretsRefresh.updated}</span>}
        </p>}
        {secretRows.length === 0 ? <EmptyState title="No shared secrets" body="Update secrets fetches any the Source shares with this machine." /> : <ListHead cols={cols} minWidth={colsMin} data-tour="secrets-list">
          <span>Name</span>
          <span>{ws.followerLive ? "Origin" : "Updated at Source"}</span>
        </ListHead>}
        {secretRows.map((s) => (
          <ListRow key={s.name} cols={cols} minWidth={colsMin} data-tour="secrets-list">
            <span className="flex min-w-0 items-center gap-2">
              <Key className="size-3.5 shrink-0 text-faint" />
              <span className="truncate font-mono text-sm">{s.name}</span>
            </span>
            <span className="text-sm text-muted-foreground tabular-nums">{"origin" in s ? s.origin === "source" ? "Shared by the Source" : "This machine" : s.updated}</span>
          </ListRow>
        ))}
      </Body>
    </>
  );
}

export function TunnelView() {
  return <TunnelForm />;
}

function TunnelForm() {
  const ws = useWorkspace();
  const [simulatedUp, setUp] = useSharedState(TUNNEL_KEY, ws.tunnelUp);
  const up = ws.followerLive ? ws.tunnelUp : simulatedUp;
  // Started from this screen (or just now at enrollment), so the seeded uptime would be wrong.
  const [startedHere, setStartedHere] = useSharedState(TUNNEL_STARTED_KEY, false);
  const [simulatedBusy, setBusy] = useSharedState(TUNNEL_BUSY_KEY, false);
  const busy = ws.followerLive ? ws.followerLive.action.loading : simulatedBusy;
  const toggle = () => {
    if (ws.followerLive) { ws.followerLive.toggleTunnel(); return; }
    const next = !up;
    setBusy(true);
    ws.later(() => {
      setUp(next);
      if (next) setStartedHere(true);
      setBusy(false);
      // Like the Source service: a completed start is a success; stopping is neutral, as removals are.
      if (next) toast.success("Tunnel started", { description: `${DEMO ? "In this demo workspace: forwarding" : "Forwarding"} 127.0.0.1:17342 to ${ws.sourceMachine.hostname}.` });
      else toast("Tunnel stopped", { description: "Applying changes, checking for updates and updating secrets wait until you start it again." });
    }, 700);
  };
  if (!ws.tunnelConfigured) {
    return (
      <>
        <PageHeader crumbs={["Settings", "SSH tunnel"]} actions={ws.followerLive && <Button size="sm" variant="outline" onClick={ws.reload}>Reload</Button>} />
        <Body>
          <EmptyState title="No SSH tunnel" body="This machine connects to the Source directly." />
        </Body>
      </>
    );
  }
  return (
    <>
      <PageHeader
        crumbs={["Settings", "SSH tunnel"]}
        actions={
          <Button size="sm" variant={up ? "outline" : "primary"} disabled={busy} onClick={toggle}>
            {busy ? (up ? "Stopping…" : "Starting…") : up ? "Stop tunnel" : "Start tunnel"}
          </Button>
        }
      />
      <Body>
        <Column>
          <SectionLabel>Status</SectionLabel>
          {ws.followerLive ? <TunnelEvidence report={ws.followerLive.tunnel ?? {}} /> : <div data-tour="tunnel-status" className={cn("mt-1", settingsGroup)}>
            <SettingRow title="State">
              <span className="inline-flex items-center gap-1.5 text-base">
                <StatusMark kind={up ? "ok" : "offline"} />
                {up ? (startedHere || ws.justJoined ? "Connected just now" : "Connected for 3 h 12 min") : "Stopped"}
              </span>
            </SettingRow>
            <SettingRow title="Host">maria@atlas.local</SettingRow>
            <SettingRow title="Forwarding">
              <Mono className="text-foreground">127.0.0.1:17342 → atlas:17342</Mono>
            </SettingRow>
            <SettingRow title="Host key" description="Pinned when this machine joined. The tunnel refuses to connect if atlas presents a different key.">
              <Mono className="text-foreground">SHA256:mG3k…Q9a</Mono>
            </SettingRow>
          </div>}
        </Column>
      </Body>
    </>
  );
}

/** "Stop syncing this machine", reachable from the Overview's machine menu, the sidebar menu and Enrollment; always confirmed. */
export function UnenrollDialog() {
  const ws = useWorkspace();
  const [, setSchedule] = useSharedState<Schedule | null>(SCHEDULE_KEY, ws.followerSchedule);
  return (
    <ConfirmDialog
      open={ws.unenrollOpen}
      onOpenChange={ws.setUnenrollOpen}
      title={`Stop syncing ${ws.machineName}?`}
      body={ws.capabilities.simulatedTelemetry ? `This machine stops getting revisions, an update in progress stops, its schedule is removed, and its identity is deleted. Files Canonfig placed stay as they are but aren't managed any more. Joining again needs a new invitation from ${ws.sourceMachine.hostname}.` : "Canonfig removes this machine's enrollment. Applied files, the native schedule and tunnel configuration remain. Joining again needs a new invitation."}
      confirm={PLAIN.unenroll}
      onConfirm={() => {
        ws.unenroll();
        if (ws.capabilities.simulatedTelemetry) setSchedule(null);
      }}
    />
  );
}

export function MachineView() {
  const ws = useWorkspace();
  return (
    <>
      <PageHeader crumbs={["Settings", "Enrollment"]} actions={ws.followerLive && <Button size="sm" variant="outline" onClick={ws.reload}>Reload</Button>} />
      <Body>
        <Column>
          <SectionLabel>How it joined</SectionLabel>
          <div className={cn("mt-1", settingsGroup)}>
            <SettingRow title="Name">{ws.machineName}</SettingRow>
            <SettingRow title="Source">
              {ws.sourceMachine.hostname}
              {ws.tunnelConfigured ? " (via SSH tunnel)" : ""}
            </SettingRow>
            <SettingRow title="Identity">{ws.unenrolled ? "Deleted" : <Mono className="text-foreground">{ws.selfFollower?.id ?? "Not reported"}</Mono>}</SettingRow>
            <SettingRow title={<Term term="Machine Profile">Profile</Term>} >
              {ws.followerLive ? text(record(ws.followerLive.local?.canonicalConfig.profile).name) ?? "Not reported" : ws.profile.name || "Not reported"}
            </SettingRow>
            <SettingRow title={PLAIN.groups} description={`Groups come from the invitation. To change them, ${ws.sourceMachine.hostname} makes a new invitation and this machine joins again with it.`}>
              <span className="grid justify-items-end">
                {ws.selfFollower ? ws.selfFollower.groups.map((group) => <Mono key={group}>{group}</Mono>) : "Not reported"}
              </span>
            </SettingRow>
            {ws.followerLive?.enrollment && <>
              <SettingRow title="Enrolled">{ws.followerLive.enrollment.follower.enrolledAt}</SettingRow>
              <SettingRow title="Enrollment state">{ws.followerLive.enrollment.pending ? "Pending" : ws.followerLive.enrollment.follower.revoked ? "Revoked" : "Enrolled"}</SettingRow>
              {([["Source signing fingerprint", ws.followerLive.enrollment.source.signingFingerprint], ["TLS fingerprint", ws.followerLive.enrollment.source.tlsFingerprint]] as const).map(([label, value]) => <SettingRow key={label} title={label}><span className="flex min-w-0 items-center gap-2"><Mono className="break-all">{value}</Mono><Button variant="outline" size="xs" onClick={() => { void copy(value, "Fingerprint copied"); }}>Copy</Button></span></SettingRow>)}
            </>}
          </div>

          <SectionLabel className="mt-10">{PLAIN.unenroll}</SectionLabel>
          <div data-tour="enrollment-stop" className="flex flex-col items-start gap-3 rounded-md border border-bad/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
            <p className="min-w-0 text-sm text-pretty text-muted-foreground">
              Stops updates and deletes this machine's identity. Files stay where they are. Canonfig calls this <Mono>unenroll</Mono>.
            </p>
            <Button variant="destructive" size="sm" className="shrink-0 sm:ml-auto" disabled={ws.unenrolled} onClick={() => ws.setUnenrollOpen(true)}>
              {ws.unenrolled ? "Stopped" : `${PLAIN.unenroll}…`}
            </Button>
          </div>
        </Column>
      </Body>
    </>
  );
}
