// Follower screens use simulated sync plans, schedules, local settings, secrets, tunnels, and enrollment.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowRight, Check, DotsThree, HourglassMedium, Key, Plus, WarningCircle, X } from "@/components/icons";
import { cn, removeKeepingFocus } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AnimatedNumber, DitherProgress, Mono, StateBand, StateLabel, StatusMark, Term, type StatusKind } from "@/shared/shared";
import { DEMO, PLAIN, POLICY_TITLE, SECRETS_GROUP, configKeysFor, machine, resources, secrets as seedSecrets } from "@/shared/data";
import { FOLLOWER_PLAN, JOINED_PLAN, LOCAL_VALUES, conflictsIn, useSharedReader, useSharedState, useWorkspace, type Overlay, type PlanAction, type PlanItem } from "./store";
import { FOLLOWER_PROFILES, followerProfile, profilePlan } from "./profiles";
import { GetStarted } from "./guide";
import {
  AnimatedRow,
  Body,
  CommandBox,
  DetailPanel,
  EmptyState,
  Field,
  KIND_ICON,
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
} from "./kit";
import { Column, ConfirmDialog, Lede } from "./settings";
import { ScheduleFields, nextCheck, scheduleError, scheduleSummary, type Schedule } from "./schedule";

/** "decide" is never stored: Sync derives it from the plan and the kept keys (see `useSteps`). */
type Shown = PlanAction | "decide";

const ACTION: Record<Shown, { label: string; cls: string; hint: string }> = {
  write: { label: "Write", cls: "bg-ok/12 text-ok", hint: "Replace the file with the revision's copy." },
  merge: { label: "Set keys", cls: "bg-ok/12 text-ok", hint: "Set only the profile's keys; other keys stay yours." },
  install: { label: "Install", cls: "bg-[oklch(0.72_0.12_240)]/14 text-[oklch(0.78_0.1_240)]", hint: "Run the tool's install recipe for this system, then check it runs." },
  "skip-drift": { label: "Paused", cls: "bg-warn/12 text-warn", hint: "You edited this copy. Canonfig won't touch it until you decide." },
  "keep-local": { label: "Keep yours", cls: "bg-raised text-muted-foreground", hint: "Your edit stays. Recorded so it isn't flagged again." },
  decide: { label: "Paused", cls: "bg-act/12 text-act", hint: "You keep a key here that the Source also sets. Canonfig won't touch this file until you decide which wins." },
};

const DEFAULT_TIME = "09:00";
const SOURCE = machine.hostname;

/**
 * Shared-state keys this file owns (see FIXLIST shared contracts). Every reader passes the same
 * initial. `null` schedule means none is set: onboarding seeds it when the schedule was turned off.
 */
const SCHEDULE_KEY = "follower-schedule";
const SCHEDULE_INITIAL: Schedule = { cadence: "default", days: [], time: DEFAULT_TIME };
const TUNNEL_KEY = "tunnel-up";
const TUNNEL_STARTED_KEY = "tunnel-started-here";
const PROFILE_KEY = "selected-profile";
const PROFILE_INITIAL = FOLLOWER_PROFILES[0].id;
/**
 * Operations in flight and their results. Shared rather than page-local so leaving and returning
 * to a page within the role keeps a running operation busy and its finished result; the timers
 * that settle them are `ws.later`, which the workspace cancels when the role changes.
 */
const CHECKING_KEY = "sync-checking";
const TUNNEL_BUSY_KEY = "tunnel-busy";
const SECRETS_KEY = "secrets-refresh";
const SECRETS_INITIAL = { busy: false, updated: "today at 08:45" };
/**
 * Where the plan under review came from: the Source's new revision, switching profile on This
 * machine, or reopening what a finished run skipped (see `useReopenSkipped`). Only this file reads it.
 */
type PlanOrigin = "revision" | "profile" | "finish";
const ORIGIN_KEY = "plan-origin";
const ORIGIN_INITIAL: PlanOrigin = "revision";

/** One plan step as Sync shows it: the stored item, plus any kept keys the Source also sets. */
interface Step extends Omit<PlanItem, "action"> {
  action: Shown;
  conflict: string[];
}

/**
 * Why this machine can't sync right now, or null. `stopped`: Stop syncing ended it, which blocks
 * every sync action (apply, checking, recovery, profile, schedule, secrets). `connection`: anything
 * that must reach the Source (apply, checking, secret refresh) is also blocked while the SSH tunnel
 * is stopped. `unreachable` reads both when called, for an operation already waiting when one stops.
 */
function useSyncBlocks() {
  const ws = useWorkspace();
  const [tunnelUp] = useSharedState(TUNNEL_KEY, true);
  const readTunnelUp = useSharedReader(TUNNEL_KEY, true);
  const stopped = ws.unenrolled ? `Syncing is stopped on this machine. Joining again needs a new invitation from ${SOURCE}.` : null;
  const tunnelDown = ws.tunnelConfigured && !tunnelUp ? `The SSH tunnel is stopped, so this machine can't reach ${SOURCE}. Start it in Settings, SSH tunnel.` : null;
  const unreachable = () => ws.isStopped() || (ws.tunnelConfigured && !readTunnelUp());
  return { stopped, connection: stopped ?? tunnelDown, unreachable };
}

/**
 * The plan with conflicts applied. Derived at render rather than stored, so keeping or
 * releasing a key in Local settings changes the plan at once, with nothing to keep in sync.
 */
function useSteps(): Step[] {
  const { plan, overlays } = useWorkspace();
  return plan.map((p) => {
    const conflict = conflictsIn(p.resource, overlays);
    if (conflict.length === 0) return { ...p, conflict };
    return { ...p, action: "decide", conflict, reason: `You keep ${conflict.join(", ")} here, but ${SOURCE} sets ${conflict.length === 1 ? "it" : "them"}. Decide which wins.` };
  });
}

/** Paused steps wait for a person; applying the plan skips them. */
const isPaused = (s: Step) => s.action === "skip-drift" || s.action === "decide";

/**
 * A run skips paused items, so a revision can be applied with items still waiting. Settling one
 * after the run reopens the plan with what the run skipped, so it can be applied now instead of
 * waiting for a newer revision that may never touch that file.
 */
function useReopenSkipped() {
  const ws = useWorkspace();
  const steps = useSteps();
  const [, setOrigin] = useSharedState<PlanOrigin>(ORIGIN_KEY, ORIGIN_INITIAL);
  return (settled: string) => {
    if (ws.phase !== "done") return;
    const skipped = steps.filter(isPaused).map((s) => s.resource);
    setOrigin("finish");
    ws.replan(ws.plan.filter((p) => p.resource === settled || skipped.includes(p.resource)));
  };
}

/**
 * Every change to kept keys goes through here, so releasing a conflicting key after a finished
 * run reopens what the run skipped wherever it happens: Sync's conflict panel or Local settings.
 */
function useSetOverlays() {
  const ws = useWorkspace();
  const reopen = useReopenSkipped();
  return (next: Overlay[]) => {
    const released = ws.plan.find((p) => conflictsIn(p.resource, ws.overlays).length > 0 && conflictsIn(p.resource, next).length === 0);
    ws.setOverlays(next);
    // reopen reads the plan as it was, with the released item still paused, so it stays in.
    if (released) reopen(released.resource);
  };
}

export function ActionTag({ action }: { action: Shown }) {
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
                  <Term term="Synchronization Run">Update</Term> #41 was interrupted
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
              It stopped yesterday at 21:14 after 3 of 5 steps, when this machine went to sleep. Recover finishes the other 2. Abandon closes it and leaves the 3 finished steps in
              place; nothing is rolled back.{stopped && ` ${stopped}`}
            </Attention>
          </AnimatedRow>
        )}
      </RowPresence>
      <ConfirmDialog
        open={confirming === "recover"}
        onOpenChange={(o) => !o && setConfirming(null)}
        title="Recover update #41?"
        body="Canonfig runs the 2 remaining steps from the run's journal and writes them to this machine. The 3 finished steps stay as they are."
        confirm="Recover"
        onConfirm={ws.recover}
      />
      <ConfirmDialog
        open={confirming === "abandon"}
        onOpenChange={(o) => !o && setConfirming(null)}
        title="Abandon update #41?"
        body="3 finished steps stay; nothing is rolled back. The remaining 2 don't run."
        confirm="Abandon"
        onConfirm={ws.abandon}
      />
    </>
  );
}

function HumanActionItem() {
  const ws = useWorkspace();
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
  const [schedule] = useSharedState<Schedule | null>(SCHEDULE_KEY, SCHEDULE_INITIAL);
  const [tunnelUp] = useSharedState(TUNNEL_KEY, true);
  const [profileId] = useSharedState(PROFILE_KEY, PROFILE_INITIAL);
  const [origin] = useSharedState<PlanOrigin>(ORIGIN_KEY, ORIGIN_INITIAL);
  const steps = useSteps();
  const conflicts = steps.filter((s) => s.action === "decide");
  const paused = steps.filter(isPaused).length;
  const changes = steps.filter((s) => !isPaused(s) && s.action !== "keep-local").length;
  const profileName = followerProfile(profileId).name;
  const ready = ws.phase !== "done";
  const running = ws.phase === "running";
  // After a run: each paused item and a pending sign-in is one step for a person.
  const needs = paused + (ws.humanAction ? 1 : 0);
  const tone = ws.unenrolled ? "muted" : running ? "ok" : ready ? "warn" : needs > 0 ? "act" : "ok";
  const kept = ws.overlays.reduce((n, o) => n + o.keys.length, 0);
  const pausedText = paused > 0 ? ` and pauses ${paused === 1 ? "one" : paused} until you decide` : "";
  return (
    <>
      <PageHeader
        crumbs={["Overview"]}
        actions={
          ready && !ws.unenrolled && (
            <Button size="sm" variant="primary" onClick={() => ws.setView("sync")}>
              Review what will change
            </Button>
          )
        }
      />
      <Body>
        <StateHeader
          tone={tone}
          running={running}
          title={
            ws.unenrolled
              ? "Syncing stopped"
              : running
              ? `Applying revision ${rev}…`
              : ready
                ? origin === "profile"
                  ? `${profileName} is ready to apply`
                  : origin === "finish"
                    ? `Finish applying revision ${rev}`
                    : `Revision ${rev} is ready to apply`
                : needs === 0
                  ? `Up to date on revision ${rev}`
                  : needs === 1
                    ? "One step needs you"
                    : `${needs} steps need you`
          }
          body={
            ws.unenrolled ? (
              <>This machine no longer gets revisions and has no schedule. Files Canonfig placed stay as they are. Joining again needs a new invitation from {SOURCE}.</>
            ) : ready ? (
              origin === "finish" ? (
                <>
                  Revision {rev} is applied except the items its update skipped. Applying now changes {changes} {changes === 1 ? "item" : "items"}
                  {pausedText}.
                </>
              ) : (
                <>
                  {ws.appliedRevision === 0 ? (
                    "Nothing is applied on this machine yet."
                  ) : (
                    <>
                      This machine is on revision <AnimatedNumber value={ws.appliedRevision} />.
                    </>
                  )}{" "}
                  {origin === "profile" ? `Profile ${profileName}` : `Revision ${rev}`} changes {changes} {changes === 1 ? "item" : "items"}
                  {pausedText}.
                </>
              )
            ) : needs === 0 ? (
              <>Everything this machine should have matches revision {rev} and passed its check.</>
            ) : paused === 0 ? (
              <>
                Revision {rev} is applied. Sign in to the GitHub CLI and this machine is <Term term="Convergence">up to date</Term>.
              </>
            ) : (
              <>
                Revision {rev} is applied, except {paused === 1 ? "one item" : `${paused} items`} paused until you decide. Once you do, apply {paused === 1 ? "it" : "them"} from
                Sync.
              </>
            )
          }
        />
        {/* Same columns as the Source overview: the side column joins at @3xl, 320px wide. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 px-4 pt-6 pb-20 @3xl:grid-cols-[minmax(0,1fr)_320px] @3xl:gap-12 @3xl:px-8">
          <div className="min-w-0 space-y-8">
            <GetStarted rowInset={4} />
            <section data-tour="follower-needs">
              <SectionLabel>Needs you</SectionLabel>
              <div className="border-t border-border">
                <InterruptedNotice />
                <RowPresence>
                  {ws.driftOpen && (
                    <AnimatedRow key="drift">
                      <Attention
                        tone="warn"
                        title={
                          <>
                            <Term term="Follower Drift">You edited</Term> claude-review-skill
                          </>
                        }
                        actions={
                          <Button variant="outline" size="xs" onClick={() => ws.go("sync", "claude-review-skill")}>
                            Decide <ArrowRight />
                          </Button>
                        }
                      >
                        You changed <Mono>~/.claude/skills/code-review/SKILL.md</Mono>. Keep your edit or take revision {rev}'s copy.
                      </Attention>
                    </AnimatedRow>
                  )}
                  {conflicts.map((s) => (
                    <AnimatedRow key={`conflict:${s.resource}`}>
                      <Attention
                        tone="act"
                        title={`${s.resource} is paused`}
                        actions={
                          <Button variant="outline" size="xs" onClick={() => ws.go("sync", s.resource)}>
                            Decide <ArrowRight />
                          </Button>
                        }
                      >
                        {s.reason}
                      </Attention>
                    </AnimatedRow>
                  ))}
                </RowPresence>
                <HumanActionItem />
                {!ws.interrupted && !ws.driftOpen && !ws.humanAction && conflicts.length === 0 && (
                  <div className="flex h-9 items-center gap-2 px-1 text-base text-muted-foreground">
                    <Check className="size-3.5 text-ok" /> Nothing needs you.
                  </div>
                )}
              </div>
            </section>
          </div>
          <aside className="min-w-0 space-y-8">
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
                      <DropdownMenuItem onSelect={() => ws.go("overlays", "new")}>Keep a key on this machine…</DropdownMenuItem>
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
                  value={ws.appliedRevision === 0 ? "None applied yet" : <AnimatedNumber value={ws.appliedRevision} />}
                  onClick={() => ws.setView("sync")}
                />
                <StatusRow label="Profile" value={profileName} onClick={() => ws.setView("machine")} />
                <StatusRow label="Next check" value={schedule ? nextCheck(schedule, DEFAULT_TIME) : "Not scheduled"} onClick={() => ws.setView("schedule")} />
                <StatusRow
                  label="Kept here"
                  value={
                    <>
                      <AnimatedNumber value={kept} /> {kept === 1 ? "key" : "keys"}
                    </>
                  }
                  onClick={() => ws.setView("overlays")}
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
          </aside>
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
function StepIcon({ step }: { step: Step }) {
  // A paused step is skipped by the run, so it never shows as done; it waits for a person like other "needs you" states.
  const [kind, label]: [StatusKind, string] = isPaused(step) ? ["act", "Paused"] : step.status === "done" ? ["ok", "Done"] : step.status === "running" ? ["warn", "Running"] : ["off", "Not started"];
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
  const ws = useWorkspace();
  const rev = ws.targetRevision;
  const steps = useSteps();
  const [profileId] = useSharedState(PROFILE_KEY, PROFILE_INITIAL);
  const [origin] = useSharedState<PlanOrigin>(ORIGIN_KEY, ORIGIN_INITIAL);
  const paused = steps.filter(isPaused).length;
  const selectedProfile = followerProfile(profileId);
  const sideBySide = useSyncExternalStore(
    subscribeSyncDetailLayout,
    () => window.matchMedia(SYNC_DETAIL_QUERY).matches,
    () => false,
  );
  // Explicit URL selections (including Overview's "Decide") work at every width.
  // An empty focus means the user closed the panel, so it must not select the default.
  const selected = ws.focus ?? (sideBySide ? "claude-review-skill" : null);
  const setSelected = (id: string | null) => ws.go("sync", id ?? "");
  const [checking, setChecking] = useSharedState(CHECKING_KEY, false);
  const blocks = useSyncBlocks();
  const cols = "18px 92px minmax(150px,240px) minmax(200px,360px) minmax(220px,1fr)";
  // Column minimums + 4 gaps + row inset padding; narrower screens scroll the list sideways instead of clipping it.
  const colsMin = 18 + 92 + 150 + 200 + 220 + 4 * 12 + 20;
  const current = steps.find((p) => p.resource === selected);
  const unchanged = selectedProfile.sends.length - steps.length;
  const running = ws.phase === "running";
  const step = Math.min(steps.length, Math.floor((ws.progress / 100) * steps.length) + 1);

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
              disabled={running || checking || blocks.connection !== null}
              onClick={() => {
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
              <Button size="sm" variant="primary" disabled={running || ws.interrupted || blocks.connection !== null} onClick={ws.applyPlan} data-tour="sync-apply">
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
          current?.action === "decide" ? (
            <ConflictPanel step={current} onClose={() => setSelected(null)} />
          ) : current?.drift &&
            // After a run only a still-paused edit is open to decide; a decided one was applied.
            (ws.phase === "plan" || (ws.phase === "done" && current.action === "skip-drift")) ? (
            <DriftPanel item={ws.plan.find((p) => p.resource === current.resource)!} onClose={() => setSelected(null)} />
          ) : undefined
        }
      >
        <section data-tour="sync-summary" className="relative isolate overflow-hidden border-b border-border" aria-live="polite">
          <StateBand tone={ws.phase === "plan" || paused > 0 ? "warn" : "ok"} mode={running ? "running" : "idle"} className="-z-10 opacity-70" />
          <div className="px-[18px] py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 text-base">
              <h2 className="font-medium">
                {running ? (
                  <>
                    Applying step <AnimatedNumber value={step} /> of {steps.length}
                  </>
                ) : ws.phase === "done" ? (
                  paused > 0 ? (
                    // `paused` is live (a key kept after the run also pauses), while the run record keeps
                    // the count at completion, so this heading must not attribute it to the run.
                    `Update #${ws.runs[0].n} finished: revision ${rev} applied. ${paused} ${paused === 1 ? "item is" : "items are"} paused now`
                  ) : (
                    `Update #${ws.runs[0].n} finished`
                  )
                ) : origin === "finish" ? (
                  `Revision ${rev}, what its last update skipped`
                ) : origin === "profile" ? (
                  `From profile ${selectedProfile.name}`
                ) : ws.appliedRevision === 0 ? (
                  `Revision ${rev} from profile ${selectedProfile.name}`
                ) : (
                  `From revision ${ws.appliedRevision} to ${rev}`
                )}
              </h2>
              <span className="text-muted-foreground">
                {!running && blocks.connection
                  ? blocks.connection
                  : ws.phase === "plan"
                    ? ws.interrupted
                      ? "Recover or abandon the interrupted update first."
                      : "Nothing changes until you apply."
                    : ws.phase === "done" && paused > 0
                      ? "Once you decide, you can apply what's left."
                      : null}
              </span>
              <span className="ml-auto shrink-0 rounded bg-background px-2 py-1 font-mono text-xs text-foreground tabular-nums">
                {running ? `${ws.progress}%` : `${steps.length} ${steps.length === 1 ? "change" : "changes"}`}
              </span>
            </div>
            <DitherProgress value={ws.progress} running={running} label={`Applying revision ${rev}`} className={cn("mt-3", !running && "invisible")} />
          </div>
        </section>
        {(ws.interrupted || ws.humanAction) && (
          // 14px plus Attention's own 4px row inset puts the notice text on the list's 18px line.
          <div data-tour="sync-recover" className="px-[14px]">
            <InterruptedNotice />
            <HumanActionItem />
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
          const Icon = KIND_ICON[p.kind];
          return (
            <ListRow key={p.resource} cols={cols} minWidth={colsMin} selected={selected === p.resource} onClick={() => setSelected(p.resource)} data-tour={isPaused(p) ? "sync-paused" : "sync-plan"}>
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
        {(unchanged > 0 || selectedProfile.notSent > 0) && (
          <div className="mx-[8px] flex h-[36px] items-center gap-2 px-[10px] text-sm text-faint">
            <Check className="size-3.5" />
            {[
              unchanged > 0 && `${unchanged} other ${unchanged === 1 ? "item already matches" : "items already match"}.`,
              selectedProfile.notSent > 0 && `${selectedProfile.notSent} ${selectedProfile.notSent === 1 ? "isn't" : "aren't"} sent to this machine.`,
            ]
              .filter(Boolean)
              .join(" ")}
          </div>
        )}
        <div className="pb-16" />
      </Body>
    </>
  );
}

/**
 * A kept key the Source also sets. This machine can only settle it one way, by no longer keeping
 * the key; the other way (the Source stops setting it) is a profile change on the Source.
 */
function ConflictPanel({ step, onClose }: { step: Step; onClose: () => void }) {
  const ws = useWorkspace();
  const setOverlays = useSetOverlays();
  const fromSource = resources.find((r) => r.id === step.resource)?.keys ?? {};
  const local = LOCAL_VALUES[step.resource] ?? {};
  const rest = ws.overlays.find((o) => o.resource === step.resource)?.keys.filter((k) => !step.conflict.includes(k)) ?? [];
  const release = () => {
    setOverlays(rest.length ? ws.overlays.map((o) => (o.resource === step.resource ? { ...o, keys: rest } : o)) : ws.overlays.filter((o) => o.resource !== step.resource));
    toast(`${SOURCE}'s value wins for ${step.conflict.join(", ")}`, {
      description: ws.phase === "done" ? "Apply changes to set it now." : "Canonfig sets it from the profile when you apply.",
    });
  };
  return (
    <DetailPanel title={step.resource} subtitle={<span className="text-sm text-act">Paused until you decide</span>} onClose={onClose}>
      <p className="px-4 py-3 text-base text-pretty text-muted-foreground">
        {step.reason} Canonfig won't touch <Mono className="text-foreground">{step.target}</Mono> until then.
      </p>
      <dl className="mx-4 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-1 rounded-md border border-border px-3 py-2 font-mono text-xs">
        <dt className="font-sans text-faint">Key</dt>
        <dd className="font-sans text-faint">This machine</dd>
        <dd className="font-sans text-faint">{SOURCE}</dd>
        {step.conflict.map((k) => (
          <div key={k} className="contents">
            <dt className="truncate text-foreground">{k}</dt>
            <dd>{local[k] ?? "not in the file"}</dd>
            <dd>{fromSource[k]}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-3 px-4 py-4">
        <Button variant="secondary" size="sm" className="justify-self-start" onClick={release}>
          Use {SOURCE}'s value
        </Button>
        <p className="text-sm text-pretty text-faint">
          This stops keeping {step.conflict.length === 1 ? "it" : "them"} here. To keep this machine's value instead, {SOURCE} has to stop setting{" "}
          {step.conflict.length === 1 ? "it" : "them"} in the profile; the file stays paused until then.
        </p>
      </div>
    </DetailPanel>
  );
}

function DriftChoice({ pressed, onClick, title, children }: { pressed: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        "rounded-md border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        pressed ? "border-border-strong bg-raised" : "border-border hover:bg-raised/50",
      )}
    >
      <span className="flex items-center gap-2 text-base font-medium">
        {title} {pressed && <Check className="size-3.5 text-ok" />}
      </span>
      <span className="mt-0.5 block text-sm text-pretty text-muted-foreground">{children}</span>
    </button>
  );
}

function DriftPanel({ item, onClose }: { item: PlanItem; onClose: () => void }) {
  const ws = useWorkspace();
  const reopen = useReopenSkipped();
  const rev = ws.targetRevision;
  const decided = item.action !== "skip-drift";
  // After a run the file was skipped and left as you edited it, so keeping the edit needs no apply.
  const afterRun = ws.phase === "done";
  return (
    <DetailPanel title={item.resource} subtitle={<StateLabel state="drift" self />} onClose={onClose}>
      <p className="px-4 py-3 text-base text-pretty text-muted-foreground">
        You changed <Mono className="text-foreground">SKILL.md</Mono> after Canonfig last wrote it. Its <Term term="Apply Policy">update rule</Term> is “
        <span title="Canonfig calls this replace-if-unmodified.">{POLICY_TITLE["replace-if-unmodified"]}</span>”, so Canonfig pauses it instead of overwriting your edit.
      </p>
      <div className="px-4">
        <div className="flex items-center gap-4 pb-1.5 font-mono text-xs text-faint">
          <span>
            <span className="text-bad">−</span> Revision {rev}
          </span>
          <span>
            <span className="text-ok">+</span> Your edit
          </span>
        </div>
        <pre tabIndex={0} aria-label={`Difference between revision ${rev} and your edit`} className="overflow-x-auto rounded-md border border-border bg-canvas/70 py-2 font-mono text-xs leading-relaxed">
          {DIFF.map((l, i) => (
            <div key={i} className={cn("px-3", l.t === "-" && "bg-bad/8 text-bad", l.t === "+" && "bg-ok/8 text-ok", l.t === " " && "text-muted-foreground")}>
              <span className="mr-2 text-faint select-none">{l.t === "-" ? "−" : l.t}</span>
              {l.s}
            </div>
          ))}
        </pre>
      </div>
      <div className="grid gap-2 px-4 py-4" role="group" aria-label={`Keep your edit or take revision ${rev}`}>
        <DriftChoice pressed={item.action === "keep-local"} onClick={() => ws.resolveDrift(item.resource, "keep")} title="Keep my edit">
          Your version stays. Canonfig records it and stops flagging this until the Source changes the skill again.
        </DriftChoice>
        <DriftChoice
          pressed={item.action === "write"}
          // Reopen first: resolveDrift updates the plan from the previous value, so it lands on the reopened plan.
          onClick={() => (reopen(item.resource), ws.resolveDrift(item.resource, "canonical"))}
          title={`Use revision ${rev}`}
        >
          Canonfig backs up your version to its state folder, then writes revision {rev}.
        </DriftChoice>
        <p className={cn("text-sm text-faint", !afterRun && !decided && "invisible")}>
          {afterRun
            ? `The last update skipped this file. Keep my edit settles it at once, with nothing to apply. Use revision ${rev} reopens the update so you can apply it.`
            : "Takes effect when you apply the changes."}
        </p>
      </div>
    </DetailPanel>
  );
}

export function ScheduleView() {
  const ws = useWorkspace();
  const [saved, setSaved] = useSharedState<Schedule | null>(SCHEDULE_KEY, SCHEDULE_INITIAL);
  // With no schedule set, the form starts from the Source's default, so Save sets one.
  const [draft, setDraft] = useState<Schedule>(saved ?? SCHEDULE_INITIAL);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  // With nothing saved, the untouched form is only the Source's default on offer, not an edit to lose.
  const { dialog: leaveDialog } = useLeaveGuard(JSON.stringify(draft) !== JSON.stringify(saved ?? SCHEDULE_INITIAL), "the schedule");
  const error = scheduleError(draft);
  const defaultLabel = "every day at 09:00";
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
            disabled={!dirty || error !== null || stopped !== null}
            onClick={() =>
              (setSaved(draft),
              ws.reach("schedule"),
              toast.success("Schedule saved", { description: `${scheduleSummary(draft, `Same as the Source: ${defaultLabel}`)}.${DEMO ? " Saved in this demo workspace." : ""}` }))
            }
          >
            Save schedule
          </Button>
        }
      />
      <Body>
        <Column>
          <Lede>
            On this <Term term="Synchronization Schedule">schedule</Term>, the system's scheduler checks for a new revision and applies it. You can still update by hand from Sync.
            {stopped
              ? ` ${stopped} Its schedule was removed.`
              : saved === null && " No schedule is set yet, so this machine only updates when you apply from Sync. Save one to turn it on."}
          </Lede>
          <ScheduleFields idPrefix="sch" value={draft} onChange={setDraft} defaultLabel={defaultLabel} />
          <div data-tour="schedule-next" className={cn("mt-8", settingsGroup)}>
            {/* Only a saved schedule has a real next check; an edited or never-saved one is a preview. */}
            <SettingRow title={!stopped && dirty ? "If you save this" : "Next check"}>{stopped ? "None" : nextCheck(draft, DEFAULT_TIME)}</SettingRow>
            <SettingRow title="Runs through" description="launchd agent">
              <Mono className="text-foreground">com.canonfig.follower</Mono>
            </SettingRow>
            <SettingRow title="If asleep">Runs when it wakes up</SettingRow>
          </div>
        </Column>
      </Body>
      {leaveDialog}
    </>
  );
}

const CONFIGS = resources.filter((r) => r.kind === "config");

export function OverlaysView() {
  const ws = useWorkspace();
  const setOverlays = useSetOverlays();
  const selected = ws.focus;
  const setSelected = (id: string | null) => ws.go("overlays", id ?? undefined);
  const cols = "minmax(160px,240px) minmax(180px,360px) minmax(160px,1fr)";
  const colsMin = 160 + 180 + 160 + 2 * 12 + 20;
  const current = ws.overlays.find((o) => o.resource === selected);
  const startResource = CONFIGS.find((r) => !ws.overlays.some((x) => x.resource === r.id)) ?? CONFIGS[0];
  const adding = selected === "new";
  const startAdding = () => ws.go("overlays", "new");

  return (
    <>
      <PageHeader
        crumbs={[PLAIN.localNav]}
        actions={
          // One gold action per view: while the editor is open its Save is the commit, so this steps down, like Profile's Add item.
          <Button size="sm" variant={adding || current ? "outline" : "primary"} onClick={startAdding} data-tour="overlays-add">
            Keep a key on this machine
          </Button>
        }
      />
      <Body
        detail={
          (adding || current) && (
            <OverlayEditor
              key={adding ? "new" : selected}
              // A new panel holds only new picks; OverlayEditor adds them to keys the file already keeps.
              initial={adding ? { resource: startResource.id, target: startResource.target, keys: [] } : current!}
              isNew={adding}
              onClose={() => setSelected(null)}
              onSave={(o) => {
                const existed = ws.overlays.some((x) => x.resource === o.resource);
                setOverlays(existed ? ws.overlays.map((x) => (x.resource === o.resource ? o : x)) : [...ws.overlays, o]);
                toast.success(`Keeping ${o.keys.length} ${o.keys.length === 1 ? "key" : "keys"} in ${o.target}`, { description: "Canonfig leaves them alone from the next update." });
                // Replace the creation URL so Back does not reopen an already saved draft.
                ws.go("overlays", o.resource, { replace: adding });
              }}
              onRemove={() => {
                setOverlays(ws.overlays.filter((o) => o.resource !== selected));
                setSelected(null);
                toast("Keys handed back to the Source");
              }}
            />
          )
        }
      >
        <p className="border-b border-border px-[18px] py-3 text-sm text-pretty text-muted-foreground">
          Keys you keep here stay as this machine has them: Canonfig doesn't overwrite them and never sends their values to the Source. Canonfig calls this a{" "}
          <Term term="Local Overlay">local overlay</Term>.
        </p>
        {ws.overlays.length === 0 ? (
          <EmptyState
            title="Nothing kept on this machine"
            body="Keep a key, like a model or editor setting, to hold this machine's own value in the file."
            action={
              <Button variant="outline" size="sm" onClick={startAdding}>
                Keep a key on this machine
              </Button>
            }
          />
        ) : (
          <>
            <ListHead cols={cols} minWidth={colsMin} data-tour="overlays-list">
              <span>Item</span>
              <span>File</span>
              <span>Keys kept here</span>
            </ListHead>
            <RowPresence>
              {ws.overlays.map((o) => (
                <AnimatedRow key={o.resource}>
                  <ListRow cols={cols} minWidth={colsMin} selected={selected === o.resource && !adding} onClick={() => setSelected(o.resource)} data-tour="overlays-list">
                    <span className="truncate font-medium">{o.resource}</span>
                    <Mono className="truncate">{o.target}</Mono>
                    <Mono className="truncate text-foreground">{o.keys.join(", ")}</Mono>
                  </ListRow>
                </AnimatedRow>
              ))}
            </RowPresence>
          </>
        )}
      </Body>
    </>
  );
}

/**
 * Pick a config file, then the keys to keep. Suggestions are the keys this
 * machine's file holds and the keys the profile sets; any other key path can
 * be typed. One overlay per file, like `canonfig overlay set`. A new panel only
 * adds: picking a file that already keeps keys shows them as kept, and Save adds
 * the new picks to them. Releasing a kept key happens in that file's own panel.
 */
function OverlayEditor({
  initial,
  isNew,
  onClose,
  onSave,
  onRemove,
}: {
  initial: Overlay;
  isNew: boolean;
  onClose: () => void;
  onSave: (o: Overlay) => void;
  /** Removes the overlay and closes the panel; the editor confirms first. */
  onRemove: () => void;
}) {
  const ws = useWorkspace();
  const [o, setO] = useState(initial);
  const [newKey, setNewKey] = useState("");
  const [tried, setTried] = useState(false);
  const [addTried, setAddTried] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const declared = configKeysFor(o.resource);
  const local = LOCAL_VALUES[o.resource] ?? {};
  const existing = ws.overlays.find((x) => x.resource === o.resource);
  // Keys this file already keeps; a new panel shows them fixed, since it cannot release them.
  const kept = isNew ? (existing?.keys ?? []) : [];
  const suggestions = [...new Set([...kept, ...Object.keys(local), ...declared, ...o.keys])];
  const keysError = tried && o.keys.length === 0 ? "Pick at least one key." : null;
  // What Save stores: the new picks added to what the file already keeps.
  const result = { ...o, keys: [...kept, ...o.keys.filter((k) => !kept.includes(k))] };
  const toggle = (k: string, on: boolean) => setO({ ...o, keys: on ? [...o.keys, k] : o.keys.filter((x) => x !== k) });
  const typedKey = newKey.trim();
  // A key path is dot-separated parts, so `.a`, `a.` and `a..b` each name an empty part.
  const newKeyError = typedKey !== "" && typedKey.split(".").some((part) => part.trim() === "") ? "Use dots only between parts of the path, like env.EDITOR." : null;
  // Like Writable paths (forms.md, Validation 3): the error waits for Add, so "env." mid-word isn't flagged.
  const shownKeyError = addTried ? newKeyError : null;
  const addKey = () => {
    if (!typedKey) return;
    setAddTried(true);
    if (newKeyError) {
      document.getElementById("ov-key")?.focus();
      return;
    }
    if (!o.keys.includes(typedKey) && !kept.includes(typedKey)) setO({ ...o, keys: [...o.keys, typedKey] });
    setNewKey("");
    setAddTried(false);
  };
  // Only a new panel can pick a file; its picks start empty because existing keys stay kept anyway.
  const pickResource = (id: string) => {
    const r = CONFIGS.find((x) => x.id === id)!;
    setO({ resource: id, target: r.target, keys: [] });
  };
  // Compared with the overlay as saved now, not as the panel opened, so Save turns off once it lands.
  const dirty = JSON.stringify(o) !== JSON.stringify(existing);
  // A new panel holds only new picks, so it has edits once it has any; an unadded typed key counts too.
  // Save and confirmed removal settle the draft, so they leave through leaveWithoutAsking.
  const { dialog: leaveDialog, leaveWithoutAsking } = useLeaveGuard((isNew ? o.keys.length > 0 : dirty) || typedKey !== "", isNew ? "the keys to keep" : o.resource);

  return (
    <DetailPanel
      title={isNew ? "Keep a key on this machine" : o.resource}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button variant="destructive" size="sm" onClick={() => setConfirmRemove(true)}>
              Stop keeping all…
            </Button>
          )}
          {/* Same footer as Profile's item editor: Cancel or Discard beside the one gold commit. */}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={!isNew && !dirty && typedKey === ""}
              onClick={isNew ? () => leaveWithoutAsking(onClose) : () => (setO(existing ?? initial), setNewKey(""), setAddTried(false), setTried(false))}
            >
              {isNew ? "Cancel" : "Discard"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!isNew && !dirty}
              onClick={() => {
                setTried(true);
                if (o.keys.length > 0) leaveWithoutAsking(() => onSave(result));
              }}
            >
              {isNew ? "Keep on this machine" : "Save"}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid gap-4 px-4 py-4">
        <Field label="In which file" htmlFor="ov-res" description={kept.length > 0 ? `This file already keeps ${kept.join(", ")} here. Your picks are added to them.` : undefined}>
          <Select value={o.resource} disabled={!isNew} onValueChange={pickResource}>
            <SelectTrigger id="ov-res" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONFIGS.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  <span className="font-mono text-sm">{r.target}</span>
                  <span className="text-xs text-faint">{r.id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Keys to keep" hint="The value on the right is what this machine's file holds now. Canonfig keeps it as it is." error={keysError}>
          <div className="grid gap-0.5">
            {suggestions.map((k) => {
              const isKept = kept.includes(k);
              const on = isKept || o.keys.includes(k);
              const fromProfile = declared.includes(k);
              return (
                <div key={k} className="rounded-md px-1 py-0.5 hover:bg-raised/40">
                  <Label htmlFor={`ov-${k}`} className="flex min-h-7 flex-wrap cursor-pointer items-center gap-x-2 gap-y-1 py-1 font-normal">
                    <Checkbox id={`ov-${k}`} checked={on} disabled={isKept} onCheckedChange={(c) => toggle(k, !!c)} />
                    <Mono className="min-w-0 break-all text-foreground">{k}</Mono>
                    {isKept && <span className="shrink-0 text-xs whitespace-nowrap text-faint">kept already</span>}
                    {fromProfile && <span className="shrink-0 text-xs whitespace-nowrap text-faint">set by the Source</span>}
                    <span className="ml-auto truncate font-mono text-xs text-faint" title="Current value in the file on this machine">
                      {local[k] ?? "not in the file"}
                    </span>
                  </Label>
                  {on && !isKept && fromProfile && (
                    <p className="pb-1 pl-6 text-xs text-pretty text-act">
                      The Source sets this key too, so this file pauses and needs you until you stop keeping it here or the Source stops setting it.
                    </p>
                  )}
                </div>
              );
            })}
            <form
              className="mt-1.5 flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                addKey();
              }}
            >
              <Input
                id="ov-key"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                aria-label="Another key path"
                aria-invalid={shownKeyError ? true : undefined}
                aria-describedby={shownKeyError ? "ov-key-note" : undefined}
                placeholder="Another key, like approval_policy"
                autoComplete="off"
                spellCheck={false}
                className="h-[28px] font-mono text-sm"
              />
              <Button type="submit" variant="outline" size="sm" disabled={!typedKey}>
                <Plus /> Add
              </Button>
            </form>
            {shownKeyError && (
              <p id="ov-key-note" role="alert" className="mt-1 flex items-center gap-1.5 text-sm text-bad">
                <WarningCircle className="size-3.5 shrink-0" />
                {shownKeyError}
              </p>
            )}
          </div>
        </Field>
        {o.keys.length > 0 && (
          <div className="flex flex-wrap gap-1" aria-live="polite">
            {o.keys.map((k) => (
              <span key={k} className="inline-flex min-h-7 max-w-full items-center gap-1 rounded border border-border pr-0.5 pl-1.5 font-mono text-xs break-all text-foreground">
                {k}
                <button type="button" data-remove="kept-keys" aria-label={`Stop keeping ${k}`} className="flex size-6 shrink-0 items-center justify-center rounded text-faint outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60" onClick={(e) => removeKeepingFocus(e.currentTarget, () => toggle(k, false), "ov-key")}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Stop keeping keys in ${o.resource}?`}
        body="Canonfig manages these keys again from the next update. Keys the profile sets go back to the Source's value."
        confirm="Stop keeping them"
        onConfirm={() => leaveWithoutAsking(onRemove)}
      />
      {leaveDialog}
    </DetailPanel>
  );
}

export function FollowerSecretsView() {
  const ws = useWorkspace();
  const [refresh, setRefresh] = useSharedState(SECRETS_KEY, SECRETS_INITIAL);
  const { connection, unreachable } = useSyncBlocks();
  const cols = "minmax(180px,240px) minmax(140px,1fr)";
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
            disabled={refresh.busy || connection !== null}
            onClick={() => {
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
            {refresh.busy ? "Updating…" : "Update secrets"}
          </Button>
        }
      />
      <Body reloading={refresh.busy}>
        <p data-tour="secrets-about" className="border-b border-border px-[18px] py-3 text-sm text-pretty text-muted-foreground">
          This machine{" "}
          <Term term="Follower Group">
            <span className="lowercase">{PLAIN.secretsGroup}</span>
          </Term>{" "}
          (group <Mono className="text-foreground">{SECRETS_GROUP}</Mono>), so it gets shared secrets from atlas
          into the macOS Keychain. Last updated {refresh.updated}.{connection && ` ${connection}`}
        </p>
        <ListHead cols={cols} minWidth={colsMin} data-tour="secrets-list">
          <span>Name</span>
          <span>Updated on atlas</span>
        </ListHead>
        {seedSecrets.map((s) => (
          <ListRow key={s.name} cols={cols} minWidth={colsMin} data-tour="secrets-list">
            <span className="flex min-w-0 items-center gap-2">
              <Key className="size-3.5 shrink-0 text-faint" />
              <span className="truncate font-mono text-sm">{s.name}</span>
            </span>
            <span className="text-sm text-muted-foreground tabular-nums">{s.updated}</span>
          </ListRow>
        ))}
      </Body>
    </>
  );
}

export function TunnelView() {
  const ws = useWorkspace();
  const [up, setUp] = useSharedState(TUNNEL_KEY, true);
  // Started from this screen (or just now at enrollment), so the seeded uptime would be wrong.
  const [startedHere, setStartedHere] = useSharedState(TUNNEL_STARTED_KEY, false);
  const [busy, setBusy] = useSharedState(TUNNEL_BUSY_KEY, false);
  const toggle = () => {
    const next = !up;
    setBusy(true);
    ws.later(() => {
      setUp(next);
      if (next) setStartedHere(true);
      setBusy(false);
      // Like the Source service: a completed start is a success; stopping is neutral, as removals are.
      if (next) toast.success("Tunnel started", { description: `${DEMO ? "In this demo workspace: forwarding" : "Forwarding"} 127.0.0.1:17342 to ${SOURCE}.` });
      else toast("Tunnel stopped", { description: "Applying changes, checking for updates and updating secrets wait until you start it again." });
    }, 700);
  };
  if (!ws.tunnelConfigured) {
    return (
      <>
        <PageHeader crumbs={["Settings", "SSH tunnel"]} />
        <Body>
          <EmptyState title="No SSH tunnel" body={`This machine joined without a tunnel, so it connects to ${SOURCE}'s source service directly.`} />
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
          <Lede>
            This machine reaches the <Term term="Source Machine">Source</Term> through an SSH tunnel: it connects to 127.0.0.1 here, and the tunnel carries that to {SOURCE}. So the
            source service never has to listen on the network.
          </Lede>
          <SectionLabel>Status</SectionLabel>
          <div data-tour="tunnel-status" className={cn("mt-1", settingsGroup)}>
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
          </div>
        </Column>
      </Body>
    </>
  );
}

/** "Stop syncing this machine", reachable from the Overview's machine menu, the sidebar menu and Enrollment; always confirmed. */
export function UnenrollDialog() {
  const ws = useWorkspace();
  const [, setSchedule] = useSharedState<Schedule | null>(SCHEDULE_KEY, SCHEDULE_INITIAL);
  return (
    <ConfirmDialog
      open={ws.unenrollOpen}
      onOpenChange={ws.setUnenrollOpen}
      title={`Stop syncing ${ws.machineName}?`}
      body={`This machine stops getting revisions, an update in progress stops, its schedule is removed, and its identity is deleted. Files Canonfig placed stay as they are but aren't managed any more. Joining again needs a new invitation from ${SOURCE}.`}
      confirm={PLAIN.unenroll}
      onConfirm={() => {
        ws.unenroll();
        setSchedule(null);
      }}
    />
  );
}

export function MachineView() {
  const ws = useWorkspace();
  const [selectedId, setSelectedId] = useSharedState(PROFILE_KEY, PROFILE_INITIAL);
  const [, setOrigin] = useSharedState<PlanOrigin>(ORIGIN_KEY, ORIGIN_INITIAL);
  const [prof, setProf] = useState(selectedId);
  const { stopped } = useSyncBlocks();
  const { dialog: leaveDialog } = useLeaveGuard(prof !== selectedId, "the profile choice");
  const switchProfile = () => {
    setSelectedId(prof);
    setOrigin("profile");
    // A fresh plan for the new profile, back in review. replan restores drift decisions made
    // earlier in the session (like keeping your edit), even for items the last profile left out.
    const next = profilePlan(ws.justJoined ? JOINED_PLAN : FOLLOWER_PLAN, prof);
    ws.replan(next);
    toast.success(`Switched to ${followerProfile(prof).name}`, { description: "Review what changes in Sync.", action: { label: "Open Sync", onClick: () => ws.setView("sync") } });
  };
  return (
    <>
      <PageHeader crumbs={["Settings", "Enrollment"]} />
      <Body>
        <Column>
          <SectionLabel>How it joined</SectionLabel>
          <div className={cn("mt-1", settingsGroup)}>
            <SettingRow title="Name">{ws.machineName}</SettingRow>
            <SettingRow title="Source">
              {SOURCE}
              {ws.tunnelConfigured ? " (via SSH tunnel)" : ""}
            </SettingRow>
            <SettingRow title="Identity">{ws.unenrolled ? "Deleted" : <Mono className="text-foreground">f_8c21</Mono>}</SettingRow>
            <SettingRow title={PLAIN.groups} description={`Groups come from the invitation. To change them, ${SOURCE} makes a new invitation and this machine joins again with it.`}>
              {/* Name over id keeps the value narrow, so the description keeps its width on a phone. */}
              <span className="grid justify-items-end">
                {PLAIN.secretsGroup} <Mono>{SECRETS_GROUP}</Mono>
              </span>
            </SettingRow>
          </div>

          <SectionLabel className="mt-6">Profile</SectionLabel>
          <div data-tour="enrollment-profile" className="border-t border-border pt-3">
            <Field
              label={<Term term="Machine Profile">Profile</Term>}
              htmlFor="m-prof"
              description={stopped ?? "Takes effect on the next update, after you review what changes."}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select value={prof} onValueChange={setProf}>
                  <SelectTrigger id="m-prof" className="w-56 max-w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FOLLOWER_PROFILES.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* The view's one commit, so it takes the gold primary like Save schedule and Save policy. */}
                <Button variant="primary" size="sm" disabled={prof === selectedId || ws.phase === "running" || stopped !== null} onClick={switchProfile}>
                  Switch profile
                </Button>
              </div>
            </Field>
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
      {leaveDialog}
    </>
  );
}
