// Machines: the map or list, the machine detail panel,
// adding a machine (invite), changing a machine's groups (new invitation + `enroll --replace`), and revoke.
import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import { CaretRight, ListBullets, TreeStructure } from "@/components/icons";
import { cn, isCoarsePointer } from "@/lib/utils";
import { workspaceHref } from "./routes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AnimatedNumber, Hint, Mono, StateLabel, Term } from "@/shared/shared";
import { DEMO, PLAIN, SECRETS_GROUP, type Follower } from "@/shared/metadata";
import { SOURCE_ID } from "@/shared/machine-map/model";
import { shq } from "@/shared/shell";
import { useSharedState, useWorkspace, type Invitation } from "./store";
import { ErrorNotice } from "../live/session";
import { requestError } from "./live/resource";
import type { GuiRequestError } from "../gui-client";
import type { GuiInvitationDownload } from "../../../src/gui/contract/enrollment";
import { EnrollmentOnboarding } from "@/onboarding/enrollment-controller";
import {
  AnimatedRow,
  Body,
  Cli,
  CommandBox,
  DetailPanel,
  EmptyState,
  Field,
  GroupChips,
  CATEGORY_ICON,
  ListHead,
  ListRow,
  PageHeader,
  Prop,
  ROW_FILL,
  RowPresence,
  SectionLabel,
  Toolbar,
  ToolbarTab,
  groupLabel,
  useGroups,
} from "./kit";


// @xyflow/react and the map's motion/shader code only load when a map is shown, keeping them out of the
// initial bundle. The fallback takes the map's className so the flex layout does not shift while it loads.
const LazyMachineMap = lazy(() => import("@/shared/machine-map/machine-map").then((m) => ({ default: m.MachineMap })));
function MachineMap(props: ComponentProps<typeof LazyMachineMap>) {
  return <Suspense fallback={<div className={props.className} />}><LazyMachineMap {...props} /></Suspense>;
}

const PLATFORM = { macos: "macOS", linux: "Linux", windows: "Windows" } as const;

// Keep names and groups readable without spreading them across a wide screen; the final column takes surplus.
const COLS = "minmax(112px,240px) 90px minmax(140px,360px) 72px 180px 100px minmax(130px,1fr)";
const COLS_NARROW = "minmax(112px,240px) 90px minmax(120px,360px) 72px 180px minmax(100px,1fr)";
// Column minimums + 12px gaps + 32px padding. Narrower than this, the list scrolls sideways with the name pinned,
// instead of squeezing state and revision out of view.
const COLS_MIN = 112 + 90 + 140 + 72 + 180 + 100 + 130 + 6 * 12 + 32;
const COLS_NARROW_MIN = 112 + 90 + 120 + 72 + 180 + 100 + 5 * 12 + 32;
/**
 * The name cell stays put while the rest scrolls. It covers the row's full height in the panel colour so columns
 * pass under it cleanly, and draws the row's 36px fill band (kit ROW_FILL) over that, left corners only.
 * The negative margin and padding cover the row's 10px inset (kit LIST_INSET).
 */
const PINNED = cn("sticky left-0 z-[1] -ml-[10px] self-stretch flex items-center bg-panel pl-[10px]", ROW_FILL, "before:rounded-r-none");

/** What someone has to do for a follower that needs attention, and where. The Source can only explain it. */
export function nextStep(f: Follower): { title: string; body: ReactNode; command: string } | null {
  switch (f.state) {
    case "drift":
      return {
        title: `Settle the local edit on ${f.name}`,
        body: (
          <>
            Someone edited skills/code-review in ~/.canonfig on {f.name}. Canonfig keeps that edit and holds the skill there at its last revision. Publish the change from here
            to share it, or move it into {f.name}'s local folder to keep it there only. Run this on {f.name} to see what it holds.
          </>
        ),
        command: "canonfig sync --plan",
      };
    case "human-action":
      return {
        title: `Sign in on ${f.name}`,
        body: <>The GitHub CLI on {f.name} needs someone to sign in. Run this on {f.name}; syncing continues on its own after that.</>,
        command: "gh auth login",
      };
    case "offline":
      return {
        title: `Restart the tunnel on ${f.name}`,
        body: <>{f.name} reaches this machine through an SSH tunnel that's down. Run this on {f.name}.</>,
        command: "canonfig tunnel start",
      };
    case "failed":
      return {
        title: `Look at the failed update on ${f.name}`,
        body: <>Canonfig put back what it changed. Run this on {f.name} to see what it would do next.</>,
        command: "canonfig sync --plan",
      };
    default:
      return null;
  }
}

/** One plain sentence for why a machine isn't up to date on the latest revision, or null when it is. */
export function whyBehind(f: Follower, latest: number | undefined, syncing: boolean): string | null {
  if (latest === undefined || f.revision === undefined || f.state === undefined) return null;
  const behind = f.revision === null || f.revision < latest;
  if (f.state === "offline") return `Can't reach the Source${f.note ? ` (${f.note.charAt(0).toLowerCase()}${f.note.slice(1)})` : ""}. On revision ${f.revision ?? "none"} of ${latest}.`;
  if (f.state === "drift") return `${f.note ?? "Someone edited a managed file"} on ${f.name}. Canonfig keeps that edit there and holds the item until it's settled on ${f.name}.`;
  if (f.state === "human-action") return `${(f.note ?? "Waiting for a person").replace("this machine", f.name)}. Syncing continues after that.`;
  if (f.state === "failed") return `Its last update failed and was put back. On revision ${f.revision ?? "none"}.`;
  if (!behind) return null;
  if (syncing) return `Getting revision ${latest} now.`;
  return `On revision ${f.revision ?? "none"}. Gets revision ${latest} at its next check${f.schedule ? ` (${f.schedule})` : ""}.`;
}

export function MachinesView() {
  const ws = useWorkspace();
  if (ws.role !== "source") return <FollowerMachinesView />;
  return <SourceMachinesView />;
}

function SourceMachinesView() {
  const ws = useWorkspace();
  const selected = ws.focus;
  const setSelected = (focus: string | null) => ws.navigate(workspaceHref(ws.role, "machines", { machinesMode: ws.machinesMode, focus }));
  const current = ws.followers.find((f) => f.id === selected);
  const cols = current ? COLS_NARROW : COLS;
  const colsMin = current ? COLS_NARROW_MIN : COLS_MIN;
  const upToDate = ws.followers.filter((f) => f.state === "converged" && f.revision === ws.latest).length;
  const map = ws.machinesMode === "map";
  const [customizeId, setCustomizeId] = useState<string | null>(null);
  const close = () => setSelected(null);
  // "Customize look" lives on the map, so the list switches to it first.
  const customize = (id: string) => {
    ws.navigate(workspaceHref(ws.role, "machines", { focus: selected }));
    setCustomizeId(id);
  };

  const detail =
    selected === SOURCE_ID ? (
      <SourceDetail onClose={close} onCustomize={() => customize(SOURCE_ID)} />
    ) : (
      current && <FollowerDetail key={current.id} follower={current} onClose={close} onCustomize={() => customize(current.id)} />
    );

  return (
    <>
      <PageHeader
        crumbs={["Machines"]}
        actions={
          <Button size="sm" variant="primary" onClick={() => ws.setInviteOpen(true)} data-tour="machines-add">
            Add machine
          </Button>
        }
      />
      <Toolbar
        right={
          ws.followers.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {ws.capabilities.simulatedTelemetry && ws.latest !== undefined && <><AnimatedNumber value={upToDate} /> of <AnimatedNumber value={ws.followers.length} /> up to date on revision <AnimatedNumber value={ws.latest} /></>}
            </span>
          )
        }
      >
        <ToolbarTab active={map} href={workspaceHref(ws.role, "machines", { focus: selected })}>
          <TreeStructure bold={map} className="size-3.5" /> Map
        </ToolbarTab>
        <ToolbarTab active={!map} href={workspaceHref(ws.role, "machines", { machinesMode: "list", focus: selected })}>
          <ListBullets bold={!map} className="size-3.5" /> List
        </ToolbarTab>
      </Toolbar>
      <Body detail={detail}>
        {map ? (
          <div data-tour="machine-map" className="flex h-full flex-col">
            <MachineMap
              role="source"
              followers={ws.followers}
              latestRevision={ws.latest}
              syncing={ws.syncing}
              publishing={ws.publishing}
              onOpenMachine={setSelected}
              onInvite={() => ws.setInviteOpen(true)}
              customizeId={customizeId}
              onCustomizeChange={setCustomizeId}
              className="min-h-0 flex-1"
            />
            <Invitations />
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {ws.followers.length === 0 ? (
              <EmptyState
                title="No other machines yet"
                body="Add a machine to start sending it your profile. It gets a single-use invitation file."
                action={
                  <Button variant="outline" size="sm" onClick={() => ws.setInviteOpen(true)}>
                    Add machine
                  </Button>
                }
              />
            ) : (
              // The list is its own scroll box on both axes, sized to its rows up to the space left above the invitations.
              // Inside it the header sticks to the top and names stick to the left; the header row (z-10) stays above the
              // pinned name cells (z-[1]), so its corner covers both while scrolling.
              <div data-tour="machines-list" className="min-h-0 overflow-auto">
                <ListHead cols={cols} minWidth={colsMin}>
                  <span className={PINNED}>
                    <Term term="Follower Machine">Machine</Term>
                  </span>
                  <span>System</span>
                  <span>{PLAIN.groups}</span>
                  <span>Revision</span>
                  <span>State</span>
                  <span>Last update</span>
                  {!current && <span>Checks</span>}
                </ListHead>
                <RowPresence>
                  {ws.followers.map((f) => {
                    const behind = f.revision != null && ws.latest !== undefined && f.revision < ws.latest;
                    return (
                      <AnimatedRow key={f.id}>
                        <ListRow cols={cols} minWidth={colsMin} selected={selected === f.id} onClick={() => setSelected(f.id)} className="group">
                          <span
                            title={f.name}
                            className={cn(
                              PINNED,
                              "min-w-0 font-medium",
                              selected === f.id
                                ? "before:bg-raised"
                                : "group-hover:before:bg-raised/50 group-focus-visible:before:bg-raised group-focus-visible:before:shadow-[inset_2px_0_0_var(--ring)]",
                            )}
                          >
                            <span className="truncate">{f.name}</span>
                          </span>
                          <span className="text-sm text-muted-foreground">{f.platform ? PLATFORM[f.platform] : "Not reported"}</span>
                          <GroupChips groups={f.groups} empty="None" />
                          <span className={behind ? "text-sm text-warn tabular-nums" : "text-sm text-muted-foreground tabular-nums"}>
                            {f.revision === undefined ? "Not reported" : f.revision === null ? "None" : <AnimatedNumber value={f.revision} />}
                          </span>
                          {f.state ? <StateLabel state={f.state} /> : <span className="text-sm text-faint">Not reported</span>}
                          <span className="text-sm text-muted-foreground tabular-nums">{f.lastRun}</span>
                          {!current && <span className="truncate text-sm text-faint tabular-nums">{f.schedule}</span>}
                        </ListRow>
                      </AnimatedRow>
                    );
                  })}
                </RowPresence>
              </div>
            )}
            <Invitations />
            <div className="shrink-0 pb-16" />
          </div>
        )}
      </Body>
    </>
  );
}

function Invitations() {
  const ws = useWorkspace();
  const name = (inv: Invitation) => {
    const replaced = inv.replaces ? ws.followers.find((f) => f.id === inv.replaces)?.name : undefined;
    return replaced ? `${replaced}, new groups` : inv.name || "Unnamed machine";
  };
  return (
    <RowPresence>
      {ws.invitations.length > 0 && (
        <AnimatedRow key="invitations" className="shrink-0">
          <section className="border-t border-border pt-3">
            <div className="px-[18px]">
              <SectionLabel>Invitations waiting to be used</SectionLabel>
            </div>
            <RowPresence>
              {ws.invitations.map((inv) => (
                <AnimatedRow key={inv.id}>
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-[18px] py-2 sm:grid-cols-[minmax(100px,1fr)_minmax(0,2fr)_auto_auto]">
                    <span className="min-w-0 truncate font-medium" title={name(inv)}>{name(inv)}</span>
                    <Mono className="col-start-1 row-start-2 min-w-0 break-all text-sm sm:col-start-auto sm:row-start-auto">{inv.file}</Mono>
                    <span className="col-start-1 text-sm text-muted-foreground sm:col-start-auto">Expires {inv.expires}</span>
                    {ws.capabilities.invitationCancel && <Button
                      variant="destructive"
                      size="xs"
                      className="col-start-2 row-span-3 row-start-1 min-h-11 justify-self-end sm:col-start-auto sm:row-span-1 sm:row-start-auto sm:min-h-0"
                      aria-label={`Cancel invitation for ${name(inv)}`}
                      onClick={() => {
                        ws.setInvitations!((p) => p.filter((x) => x.id !== inv.id));
                        toast("Invitation cancelled", { description: "It can no longer be used to join." });
                      }}
                    >
                      Cancel
                    </Button>}
                  </div>
                </AnimatedRow>
              ))}
            </RowPresence>
          </section>
        </AnimatedRow>
      )}
    </RowPresence>
  );
}

/** Follower role: the Source and this machine. Other followers aren't visible from here. */
function FollowerMachinesView() {
  const ws = useWorkspace();
  const map = ws.machinesMode === "map";
  const [joining, setJoining] = useState(false);
  const [customizeId, setCustomizeId] = useState<string | null>(null);
  const open = (id: string) => ws.enrollment
    ? ws.navigate(workspaceHref("follower", "machines", { machinesMode: ws.machinesMode, focus: id }))
    : ws.setView(id === SOURCE_ID ? "tunnel" : "machine");
  if (joining && ws.enrollmentBackend && ws.session) return <EnrollmentOnboarding backend={ws.enrollmentBackend} session={ws.session} onCancel={() => setJoining(false)} />;
  const self = ws.selfFollower;
  return (
    <>
      <PageHeader crumbs={["Machines"]} actions={ws.enrollment && <Button size="sm" variant="outline" onClick={() => setJoining(true)}>Replace enrollment</Button>} />
      <Toolbar>
        <ToolbarTab active={map} href={workspaceHref("follower", "machines")}>
          <TreeStructure bold={map} className="size-3.5" /> Map
        </ToolbarTab>
        <ToolbarTab active={!map} href={workspaceHref("follower", "machines", { machinesMode: "list" })}>
          <ListBullets bold={!map} className="size-3.5" /> List
        </ToolbarTab>
      </Toolbar>
      <Body detail={ws.enrollment && ws.focus ? <EnrollmentDetail source={ws.focus === SOURCE_ID} onClose={() => ws.navigate(workspaceHref("follower", "machines", { machinesMode: ws.machinesMode }))} onCustomize={() => {
        setCustomizeId(ws.focus);
        ws.navigate(workspaceHref("follower", "machines", { focus: ws.focus }));
      }} /> : undefined}>
        {!self ? <EmptyState title="Enrollment unavailable" body="Reload to read this machine's enrollment." /> : map ? <div data-tour="machine-map" className="flex h-full flex-col">
          <MachineMap
            role="follower"
            followers={[self]}
            selfId={self.id}
            latestRevision={ws.targetRevision}
            syncing={ws.phase === "running" ? [self.id] : []}
            onOpenMachine={open}
            customizeId={customizeId}
            onCustomizeChange={setCustomizeId}
            className="min-h-0 flex-1"
          />
        </div> : (
          <div className="min-h-0 overflow-auto">
            <ListHead cols="minmax(112px,240px) 140px minmax(200px,1fr)" minWidth={508}>
              <span>Machine</span><span>Role</span><span>Details</span>
            </ListHead>
            <ListRow cols="minmax(112px,240px) 140px minmax(200px,1fr)" minWidth={508} onClick={() => open(SOURCE_ID)}>
              <span className="truncate font-medium">{ws.sourceMachine.hostname}</span>
              <span className="text-muted-foreground">Source</span>
              <Mono className="truncate">{ws.endpoint}</Mono>
            </ListRow>
            <ListRow cols="minmax(112px,240px) 140px minmax(200px,1fr)" minWidth={508} onClick={() => open(self.id)}>
              <span className="truncate font-medium">{self.name}</span>
              <span className="text-muted-foreground">This follower</span>
              {self.state && <StateLabel state={self.state} />}
            </ListRow>
          </div>
        )}
      </Body>
    </>
  );
}

function EnrollmentDetail({ source, onClose, onCustomize }: { source: boolean; onClose: () => void; onCustomize: () => void }) {
  const ws = useWorkspace();
  const enrollment = ws.enrollment!;
  return <DetailPanel title={source ? "Source Machine" : enrollment.follower.name} subtitle={<span className="text-sm text-muted-foreground">{source ? "The Source this machine follows" : "This machine"}</span>} onClose={onClose} footer={<Button variant="ghost" size="sm" onClick={onCustomize}>Customize look</Button>}>
    <div className="px-4 py-3">
      {source ? <>
        <Prop label="Address"><Mono className="break-all">{enrollment.source.endpoint}</Mono></Prop>
        {([["Signing fingerprint", enrollment.source.signingFingerprint], ["TLS fingerprint", enrollment.source.tlsFingerprint]] as const).map(([label, value]) => <Prop key={label} label={label}>
          <Mono className="break-all">{value}</Mono>
          <Button variant="ghost" size="xs" onClick={async () => { try { await navigator.clipboard.writeText(value); toast(`${label} copied`); } catch { toast.error("Clipboard unavailable. Select and copy the fingerprint."); } }}>Copy {label.toLowerCase()}</Button>
        </Prop>)}
      </> : <>
        <Prop label="Identity"><Mono className="break-all">{enrollment.follower.id}</Mono></Prop>
        <Prop label="Groups"><GroupChips groups={[...enrollment.follower.groups]} empty="Base profile only" /></Prop>
        <Prop label="Enrolled">{enrollment.follower.enrolledAt}</Prop>
        <Prop label="Enrollment">{enrollment.follower.revoked ? "Revoked" : enrollment.pending ? "Pending" : "Enrolled"}</Prop>
        <Prop label="Revision">Revision not reported</Prop>
      </>}
    </div>
  </DetailPanel>;
}

function SourceDetail({ onClose, onCustomize }: { onClose: () => void; onCustomize: () => void }) {
  const ws = useWorkspace();
  // Same key and initial as the Source service page that owns it, so a removal shows here too.
  const [serviceInstalled] = useSharedState("service-installed", ws.serviceInstalled);
  return (
    <DetailPanel
      title={ws.machineName}
      subtitle={<span className="text-xs text-muted-foreground">The Source, this machine</span>}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => ws.setView("service")}>
            Source service
          </Button>
          <Button variant="ghost" size="sm" onClick={onCustomize}>
            Customize look
          </Button>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => ws.setView("revisions")}>
            Revisions
          </Button>
        </>
      }
    >
      <p className="border-b border-border px-4 py-3 text-base text-pretty text-muted-foreground">
        You edit the profile here and publish revisions. Every other machine copies from it.
      </p>
      <div className="px-4 py-3">
        {ws.latest !== undefined && <Prop label="Latest revision">{ws.latest === 0 ? "None published yet" : <>Revision <AnimatedNumber value={ws.latest} /></>}</Prop>}
        {ws.capabilities.simulatedTelemetry && <Prop label="Unpublished">
          <AnimatedNumber value={ws.pending.length} /> {ws.pending.length === 1 ? "change" : "changes"}
        </Prop>}
        <Prop label="Address">
          <Mono className="break-all text-foreground">{ws.endpoint}</Mono>
        </Prop>
        {ws.capabilities.simulatedTelemetry && <Prop label="Service">{serviceInstalled ? "Running" : "Not installed"}</Prop>}
      </div>
    </DetailPanel>
  );
}

function FollowerDetail({ follower: f, onClose, onCustomize }: { follower: Follower; onClose: () => void; onCustomize: () => void }) {
  const ws = useWorkspace();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const step = nextStep(f);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GuiRequestError | null>(null);
  const why = whyBehind(f, ws.latest, ws.syncing.includes(f.id));
  return (
    <DetailPanel
      title={f.name}
      subtitle={f.state ? <StateLabel state={f.state} /> : <span className="text-sm text-muted-foreground">{f.note}</span>}
      onClose={onClose}
      footer={
        <>
          <Button variant="destructive" size="sm" disabled={f.note === "Revoked"} onClick={() => setRevokeOpen(true)}>
            Revoke…
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onCustomize}>
            Customize look
          </Button>
          <Button variant="outline" size="sm" onClick={() => ws.setChangeGroups({ followerId: f.id })}>
            Change groups…
          </Button>
        </>
      }
    >
      {why && (!step || f.state === "offline") && <p className="border-b border-border px-4 py-3 text-base text-pretty text-muted-foreground">{why}</p>}
      {step && (
        <section className="grid gap-2 border-b border-border px-4 py-3" aria-label="What to do">
          <h3 className="text-base font-medium">{step.title}</h3>
          <p className="text-sm text-pretty text-muted-foreground">{step.body}</p>
          <CommandBox>{step.command}</CommandBox>
        </section>
      )}
      <div className="px-4 py-3">
        {f.platform && <Prop label="System">{PLATFORM[f.platform]}</Prop>}
        <Prop label={<Term term="Profile Revision">Revision</Term>}>
          {f.revision === undefined ? "Revision not reported" : f.revision === null ? "None yet" : <AnimatedNumber value={f.revision} />}
          {f.revision != null && ws.latest !== undefined && f.revision < ws.latest && <span className="text-muted-foreground"> of {ws.latest}</span>}
        </Prop>
        <Prop label={<Term term="Follower Group">{PLAIN.groups}</Term>}>
          <span className="flex flex-wrap items-center gap-2">
            <GroupChips groups={f.groups} empty="None, base profile only" />
            <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground" onClick={() => ws.setChangeGroups({ followerId: f.id })}>
              Change…
            </Button>
          </span>
        </Prop>
        {f.schedule && <Prop label="Checks">{f.schedule}</Prop>}
        {f.lastRun && <Prop label="Last update">{f.lastRun}</Prop>}
        <Prop
          label={
            <span className="inline-flex items-center gap-1">
              Identity <Hint label="Identity">{"This machine's own revocable identity, given when it joined.\nRevoking it cuts off this machine only."}</Hint>
            </span>
          }
        >
          <Mono className="break-all text-foreground">{f.id}</Mono>
        </Prop>
      </div>
      {f.resources && <div className="border-t border-border px-4 pt-3">
        <SectionLabel>What it has</SectionLabel>
      </div>}
      <div className="pb-3">
        {ws.resources
          .filter((r) => r.change !== "added")
          .map((r) => {
            const state = f.resources?.[r.id];
            if (!state) return null;
            const Icon = CATEGORY_ICON[r.category];
            const problem = state === "drift" || state === "human-action";
            return (
              <div key={r.id} className="px-4 py-1.5 text-base">
                <div className="flex items-center gap-2">
                  <Icon className="size-3.5 shrink-0 text-faint" />
                  <span className={state === "excluded" ? "truncate text-faint" : "truncate"}>{r.id}</span>
                  <span className="ml-auto">
                    <StateLabel state={state} />
                  </span>
                </div>
                {problem && step && <p className="mt-1 ml-5.5 text-sm text-pretty text-muted-foreground">{step.title}: see above. The Source can't change this item on {f.name}.</p>}
              </div>
            );
          })}
      </div>

      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-md"
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) returnFocus.current = active;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Revocation removes the detail panel and its opener.
            const target = returnFocus.current?.isConnected && returnFocus.current !== document.body
              ? returnFocus.current
              : document.querySelector<HTMLElement>("main h1");
            if (target && !target.matches("button, a, [tabindex]")) target.tabIndex = -1;
            target?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Revoke {f.name}?</DialogTitle>
            <DialogDescription className="text-base text-pretty">
              {f.name} stops getting revisions right away and can't reconnect with its current identity. Files already on it stay as they are. Adding it again needs a new invitation.
              {ws.capabilities.invitationCancel && ws.invitations.some((inv) => inv.replaces === f.id) && " Its waiting group-change invitation is cancelled too."}
            </DialogDescription>
          </DialogHeader>
          {error && <ErrorNotice error={error} />}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  if (ws.revokeFollower) await ws.revokeFollower(f.id);
                  else {
                    ws.setFollowers!((prev) => prev.filter((x) => x.id !== f.id));
                    ws.setInvitations!((prev) => prev.filter((inv) => inv.replaces !== f.id));
                  }
                  setRevokeOpen(false);
                  onClose();
                  toast(`Revoked ${f.name}`, { description: `Identity ${f.id} no longer works.` });
                } catch (cause) { setError(requestError(cause)); }
                finally { setBusy(false); }
              }}
            >
              Revoke {f.name}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DetailPanel>
  );
}

const EXPIRY = { "15m": { label: "15 minutes", at: "in 15 min" }, "1h": { label: "1 hour", at: "in 1 hour" }, "24h": { label: "24 hours", at: "tomorrow" } } as const;

/** The address another machine connects to, parsed once so validation and guidance read the same host and port. Null unless https. */
function parseEndpoint(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Loopback hostnames, matched exactly so "localhost.example.test" doesn't count. URL keeps the brackets on IPv6 hosts. */
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Why a loopback endpoint works for another machine; the port is the one in that endpoint. */
function tunnelNote(url: URL) {
  // URL drops a port equal to the scheme's default, so an https address without one uses 443.
  return `${url.hostname} works because the other machine connects through Canonfig's SSH tunnel, which forwards its own port ${url.port || "443"} to this machine.`;
}

/** An invitation exactly as submitted. The ready screen reads only this, never the still-editable form fields. */
interface SubmittedInvitation {
  file: string;
  /** Trimmed; empty when no name was given. */
  name: string;
  groups: string[];
  endpoint: string;
  url: URL;
  expiry: keyof typeof EXPIRY;
  download?: GuiInvitationDownload;
}

const ID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A fresh 4-character invitation id for the file name. Each invitation needs its own, since cancelling one goes by id. */
function newInvitationId(taken: Invitation[]) {
  for (;;) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ID_CHARS[b % ID_CHARS.length]).join("");
    if (!taken.some((inv) => inv.id === id)) return id;
  }
}

/** One checkbox row per group; the secrets group shows what it does, with its real name in mono. */
function GroupChecks({ idPrefix, value, onChange, disabled }: { idPrefix: string; value: string[]; onChange: (groups: string[]) => void; disabled?: boolean }) {
  const [groups] = useGroups();
  // Secret sharing is an enrollment permission, even when no authored group uses it.
  const choices = [{ name: SECRETS_GROUP, description: "" }, ...groups.filter((group) => group.name !== SECRETS_GROUP)];
  return (
    <div className="grid gap-0.5">
      {choices.map((g) => (
        <Label key={g.name} htmlFor={`${idPrefix}-${g.name}`} className="flex min-h-11 cursor-pointer items-center gap-2 text-base font-normal sm:min-h-8">
          <Checkbox
            id={`${idPrefix}-${g.name}`}
            checked={value.includes(g.name)}
            disabled={disabled}
            onCheckedChange={(c) => onChange(c ? [...value, g.name] : value.filter((x) => x !== g.name))}
          />
          {g.name === SECRETS_GROUP ? (
            <>
              <span>{PLAIN.secretsGroup}</span>
              <span className="truncate font-mono text-xs text-faint">{g.name}</span>
            </>
          ) : (
            <>
              <span className="font-mono text-sm">{g.name}</span>
              <span className="truncate text-sm text-faint">{g.description}</span>
            </>
          )}
        </Label>
      ))}
    </div>
  );
}

/** Numbered steps for the person moving an invitation file to another machine. */
function Steps({ children }: { children: ReactNode }) {
  return <ol className="grid grid-cols-[minmax(0,1fr)] gap-3 text-base [counter-reset:step]">{children}</ol>;
}

function Step({ title, note, command }: { title: ReactNode; note?: ReactNode; command: string }) {
  return (
    <li className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-x-2 gap-y-1.5 [counter-increment:step] before:row-span-3 before:pt-px before:text-sm before:text-faint before:tabular-nums before:content-[counter(step)'.']">
      <span>{title}</span>
      <div className="min-w-0 rounded-md border border-border bg-canvas/60 px-2.5 py-2">
        <Cli wrap>{command}</Cli>
      </div>
      {note && <span className="text-sm text-pretty text-faint">{note}</span>}
    </li>
  );
}

export function InviteDialog() {
  return <InviteForm />;
}

function downloadInvitation(invitation: GuiInvitationDownload) {
  const url = URL.createObjectURL(new Blob([invitation.envelope], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = invitation.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function InviteForm() {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState(ws.endpoint);
  const [expiry, setExpiry] = useState<keyof typeof EXPIRY>("1h");
  const [groups, setGroups] = useState<string[]>([]);
  const [outDir, setOutDir] = useState("~");
  const [inviteId, setInviteId] = useState(() => newInvitationId(ws.invitations));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmittedInvitation | null>(null);
  const [error, setError] = useState<GuiRequestError | null>(null);
  const [tried, setTried] = useState(false);
  const creating = useRef<number | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);

  const reset = () => {
    setName("");
    setGroups([]);
    setExpiry("1h");
    setInviteId(newInvitationId(ws.invitations));
    setResult(null);
    setBusy(false);
    setTried(false);
    setError(null);
  };

  // Each opening starts fresh. Resetting on open, not on a timer after closing, means a quick reopen can't
  // cancel the reset and show the previous result. Adjusting state during render avoids a frame of old content.
  const [wasOpen, setWasOpen] = useState(ws.inviteOpen);
  if (ws.inviteOpen !== wasOpen) {
    setWasOpen(ws.inviteOpen);
    if (ws.inviteOpen) reset();
  }

  useEffect(() => {
    // However the dialog closes, a creation still running is abandoned, so a reopened dialog never receives its result.
    if (!ws.inviteOpen) window.clearTimeout(creating.current);
  }, [ws.inviteOpen]);

  const url = parseEndpoint(endpoint);
  const endpointError = tried && !url ? "Use an https:// address the other machine can reach." : null;
  const file = `${outDir.replace(/\/+$/, "")}/canonfig-invite-${inviteId}.json`;
  // Normalized once: the pending record and every command use the same name, or none.
  const trimmedName = name.trim();
  // Everything below for the ready screen comes from `result`, the submitted invitation.
  const host = result?.name || "<other-machine>";
  const resultFileName = result?.file.split("/").pop();
  const resultLocal = !!result && LOOPBACK.includes(result.url.hostname);
  const sshHost = `${ws.machineName}.local`;

  const create = async () => {
    setTried(true);
    if (!url) {
      document.getElementById("inv-ep")?.focus();
      return;
    }
    const submitted: SubmittedInvitation = { file, name: trimmedName, groups, endpoint: endpoint.trim(), url, expiry };
    setBusy(true);
    setError(null);
    if (ws.createInvitation) {
      try {
        const download = await ws.createInvitation({ endpoint: submitted.endpoint, groups, expiresInMilliseconds: { "15m": 900_000, "1h": 3_600_000, "24h": 86_400_000 }[expiry] });
        setResult({ ...submitted, file: download.filename, download });
      } catch (cause) { setError(requestError(cause)); }
      finally { setBusy(false); }
    } else {
      creating.current = window.setTimeout(() => {
        ws.setInvitations!((p) => [...p, { id: inviteId, file: submitted.file, name: submitted.name, groups: submitted.groups, expires: EXPIRY[submitted.expiry].at }]);
        setResult(submitted);
        setBusy(false);
      }, 700);
    }
  };

  return (
    <Dialog open={ws.inviteOpen} onOpenChange={(open) => { if (!busy || !ws.createInvitation) ws.setInviteOpen(open); }}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto sm:max-w-[540px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const active = document.activeElement;
          if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) returnFocus.current = active;
          // On touch, focus the dialog itself rather than raise the keyboard for an optional name.
          if (isCoarsePointer()) (event.target as HTMLElement).focus();
          else document.getElementById(ws.createInvitation ? "inv-ep" : "inv-name")?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        {!result ? (
          <form
            className="contents"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) create();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add a machine</DialogTitle>
              <DialogDescription className="text-base text-pretty">
                Creates a single-use invitation file. The other machine uses it to join and gets its own identity, as a{" "}
                <Term term="Follower Machine">follower</Term>.
              </DialogDescription>
            </DialogHeader>
            {/* While Creating, the invitation was already submitted from these values, so the fields lock until the result shows. */}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
              {!ws.createInvitation && <Field label="Machine name" htmlFor="inv-name" description="Optional. Fills in the commands below; the machine can pick another name.">
                <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="work-laptop" aria-describedby="inv-name-note" autoComplete="off" spellCheck={false} />
              </Field>}
              <Field
                label="Address it connects to"
                htmlFor="inv-ep"
                description={url && LOOPBACK.includes(url.hostname) ? tunnelNote(url) : "The other machine must be able to reach this address."}
                error={endpointError}
              >
                <Input
                  id="inv-ep"
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  disabled={busy}
                  aria-invalid={!!endpointError}
                  aria-describedby="inv-ep-note"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Expires after" htmlFor="inv-exp">
                <Select value={expiry} onValueChange={(v: keyof typeof EXPIRY) => setExpiry(v)} disabled={busy}>
                  <SelectTrigger id="inv-exp" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(EXPIRY).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={<Term term="Follower Group">{PLAIN.groups}</Term>} description="Groups add items on top of the base profile. Leave empty for the base profile only.">
                <GroupChecks idPrefix="inv" value={groups} onChange={setGroups} disabled={busy} />
              </Field>
              {!ws.createInvitation && <Collapsible>
                <CollapsibleTrigger className="group flex min-h-11 items-center gap-1 rounded text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:min-h-8">
                  <CaretRight className="size-3.5 transition-transform duration-150 ease-snap group-data-[state=open]:rotate-90" />
                  Advanced
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 pl-4">
                  <Field label="Save the file in" htmlFor="inv-out">
                    <Input id="inv-out" value={outDir} onChange={(e) => setOutDir(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} className="font-mono text-sm" />
                  </Field>
                </CollapsibleContent>
              </Collapsible>}
            </div>
            {error && <ErrorNotice error={error} />}
            <DialogFooter className="flex-col items-stretch gap-3 sm:flex-col">
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={busy && !!ws.createInvitation} onClick={() => ws.setInviteOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? "Creating…" : "Create invitation"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invitation ready</DialogTitle>
              <DialogDescription className="text-base text-pretty">
                {result.download ? "Download " : `Saved ${DEMO ? "in this demo workspace " : ""}as `}<Mono className="break-all text-sm text-foreground">{result.file}</Mono>
                {result.download ? `. It works once and expires ${result.download.expiresAt}.` : `${DEMO ? "; no file was written. A real invitation works" : ". It works"} once and expires ${EXPIRY[result.expiry].at}.`} Anyone holding it can join a machine, so move it privately.
              </DialogDescription>
            </DialogHeader>
            {result.download && <Button variant="primary" onClick={() => downloadInvitation(result.download!)}>Download invitation</Button>}
            <Steps>
              <Step
                title="Copy the file to the other machine, for example with scp:"
                command={`scp ${shq(result.file)} ${result.name ? shq(result.name) : host}:~/`}
                note="A USB stick or any private file transfer works too. The steps below expect it in the home folder there."
              />
              {resultLocal && (
                <>
                  <Step
                    title={<>On {host}, in the home folder, fetch {ws.machineName}'s SSH host key:</>}
                    command={`scp ${shq(`${sshHost}:/etc/ssh/ssh_host_ed25519_key.pub`)} ./source-host-key.pub`}
                    note={<>The tunnel checks this key every time it connects, so it only ever talks to the real {ws.machineName}.</>}
                  />
                  <Step
                    title={<>Still on {host}, start the SSH tunnel to {ws.machineName}:</>}
                    command={`canonfig tunnel start --invitation ${shq(`~/${resultFileName}`)} --ssh-host ${shq(sshHost)} --ssh-user ${ws.createInvitation ? "<ssh-user>" : "maria"} --ssh-host-key-file ./source-host-key.pub`}
                    note={tunnelNote(result.url)}
                  />
                </>
              )}
              <Step
                title={<>On {host}, join:</>}
                command={`cat ${shq(`~/${resultFileName}`)} | canonfig follower enroll --stdin --name ${result.name ? shq(result.name) : "<name>"}`}
                note="Or open Canonfig there and choose the file."
              />
            </Steps>
            <div className="grid gap-1 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
              <div className="flex justify-between gap-4">
                <span>Connects to</span>
                <Mono className="min-w-0 break-all text-right">{result.endpoint}</Mono>
              </div>
              <div className="flex justify-between gap-4">
                <span>{PLAIN.groups}</span>
                <span className="min-w-0 break-words text-right">{result.groups.length ? result.groups.map(groupLabel).join(", ") : "Base profile only"}</span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={reset}>
                Invite another
              </Button>
              <Button variant="secondary" onClick={() => ws.setInviteOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Groups come from the invitation and there's no command to edit them later,
 * so changing them is a new invitation with the new groups plus
 * `follower enroll --replace` on that machine. This dialog builds exactly that.
 */
export function ChangeGroupsDialog() {
  return <ChangeGroupsForm />;
}

function ChangeGroupsForm() {
  const ws = useWorkspace();
  const req = ws.changeGroups;
  const open = req !== null;
  const [followerId, setFollowerId] = useState<string>("");
  const [groups, setGroups] = useState<string[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [download, setDownload] = useState<GuiInvitationDownload | null>(null);
  const [endpoint, setEndpoint] = useState(ws.endpoint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GuiRequestError | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const pickFollower = (id: string) => {
    const next = ws.followers.find((x) => x.id === id);
    setFollowerId(id);
    setGroups(next ? [...new Set([...next.groups, ...(req?.addGroup ? [req.addGroup] : [])])] : []);
  };

  // Each opening starts from the request: a given machine, or "add a machine to this group".
  useEffect(() => {
    if (!req) return;
    pickFollower(req.followerId ?? ws.followers.find((x) => !req.addGroup || !x.groups.includes(req.addGroup))?.id ?? ws.followers[0]?.id ?? "");
    setFile(null);
    setDownload(null);
    setEndpoint(ws.endpoint);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  const f = ws.followers.find((x) => x.id === followerId);
  const before = f?.groups ?? [];
  const added = groups.filter((g) => !before.includes(g));
  const removed = before.filter((g) => !groups.includes(g));
  const unchanged = added.length === 0 && removed.length === 0;
  const out = `~/canonfig-invite-${f?.name ?? "machine"}-groups.json`;
  const fileName = file?.split("/").pop() ?? out.split("/").pop()!;
  const close = () => { if (!busy) ws.setChangeGroups(null); };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto sm:max-w-[540px]"
        onKeyDownCapture={(event) => {
          // A focused glossary tooltip otherwise consumes Escape before the dialog can close.
          if (event.key === "Escape" && document.querySelector('[role="tooltip"]')) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) returnFocus.current = active;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        {!file || !f ? (
          <form
            className="contents"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!f || unchanged || busy) return;
              setBusy(true);
              setError(null);
              try {
                if (ws.createInvitation) {
                  const invitation = await ws.createInvitation({ endpoint, groups, expiresInMilliseconds: 3_600_000 });
                  setDownload(invitation);
                  setFile(invitation.filename);
                } else {
                  ws.setInvitations!((p) => [...p.filter((x) => x.replaces !== f.id), { id: `G-${f.id}`, file: out, name: f.name, groups, expires: "in 1 hour", replaces: f.id }]);
                  setFile(out);
                }
              } catch (cause) { setError(requestError(cause)); }
              finally { setBusy(false); }
            }}
          >
            <DialogHeader>
              <DialogTitle>{req?.followerId && f ? `Change ${f.name}'s groups` : "Change a machine's groups"}</DialogTitle>
              <DialogDescription className="text-base text-pretty">
                A machine's groups come from the invitation it joined with. To change them, Canonfig makes a new invitation with the groups below, and you re-join the machine with it. It
                keeps its files and gets what the new groups add on its next update.
              </DialogDescription>
            </DialogHeader>
            {!req?.followerId && (
              <Field label="Machine" htmlFor="cg-machine">
                <Select value={followerId} onValueChange={pickFollower} disabled={busy}>
                  <SelectTrigger id="cg-machine" className="w-56">
                    <SelectValue placeholder="Pick a machine" />
                  </SelectTrigger>
                  <SelectContent>
                    {ws.followers.map((x) => (
                      <SelectItem key={x.id} value={x.id}>
                        {x.name}
                        <span className="text-xs text-faint">{x.groups.length ? x.groups.map(groupLabel).join(", ") : "no groups"}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label={<Term term="Follower Group">{PLAIN.groups}</Term>}>
              <GroupChecks idPrefix="cg" value={groups} onChange={setGroups} disabled={busy} />
            </Field>
            {ws.createInvitation && <Field label="Address it connects to" htmlFor="cg-endpoint">
              <Input id="cg-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} disabled={busy} />
            </Field>}
            {error && <ErrorNotice error={error} />}
            <p className="text-sm text-pretty text-muted-foreground" aria-live="polite">
              {unchanged
                ? "No change yet. Tick or untick a group."
                : [added.length ? `Adds ${added.map(groupLabel).join(", ")}` : "", removed.length ? `Removes ${removed.map(groupLabel).join(", ")}` : ""].filter(Boolean).join(". ") + "."}
              {added.includes(SECRETS_GROUP) && " It gets the shared secrets on its next update."}
            </p>
            <DialogFooter className="flex-col items-stretch gap-3 sm:flex-col">
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={!f || unchanged || busy}>
                  Create invitation
                </Button>
              </div>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Re-join {f.name} with its new groups</DialogTitle>
              <DialogDescription className="text-base text-pretty">
                {download ? "Download " : `Saved ${DEMO ? "in this demo workspace " : ""}as `}<Mono className="break-all text-sm text-foreground">{file}</Mono>
                {download ? `. It works once and expires ${download.expiresAt}.` : `${DEMO ? "; no file was written. A real invitation works" : ". It works"} once and expires in 1 hour.`} Until {f.name} re-joins, it keeps its old groups.
              </DialogDescription>
            </DialogHeader>
            {download && <Button variant="primary" onClick={() => downloadInvitation(download)}>Download invitation</Button>}
            <Steps>
              <Step title={<>Copy the file to {f.name}, for example with scp:</>} command={`scp ${shq(file)} ${shq(f.name)}:~/`} />
              <Step
                title={<>On {f.name}, re-join with the new invitation:</>}
                command={`cat ${shq(`~/${fileName}`)} | canonfig follower enroll --stdin --name ${shq(f.name)} --replace`}
                note={<>--replace swaps {f.name}'s current enrollment for this one. It already reaches {ws.machineName} through its tunnel, so 127.0.0.1 works there.</>}
              />
            </Steps>
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
