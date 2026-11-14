// Shared Source screens read data and operations from the workspace provider.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, CalendarDots, Check, Cpu, DotsThree, HourglassMedium, Key, UsersThree, type IconComponent } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isCoarsePointer } from "@/lib/utils";
import { AnimatedNumber, CliText, DitherProgress, Hint, Mono, StateCell, StateLabel, StatusMark, Term } from "@/shared/shared";
import { DEMO, SECRETS_GROUP, STATE_META, type Revision } from "@/shared/metadata";
import { ErrorNotice } from "../live/session";
import { GuiRequestError } from "../gui-client";
import { useSharedState, useWorkspace, type PendingChange, type Workspace } from "./store";
import { GetStarted } from "./guide";
import { whyBehind } from "./machines";
import { useChecks, warningName } from "./settings";
import { workspaceHref } from "./routes";
import { ProfileActionNotice } from "./profile-authoring-controls";
import { object } from "./profile-authoring";
import {
  AnimatedRow,
  Body,
  ChangeMark,
  DetailPanel,
  EmptyState,
  Field,
  CATEGORY_ICON,
  ListHead,
  ListRow,
  PageHeader,
  Prop,
  PublishButton,
  RowPresence,
  SectionLabel,
  StateHeader,
  StatusRow,
  WithCode,
  copy,
  useLeaveGuard,
} from "./kit";
import { TunnelEvidence } from "./follower-evidence";

/** How one unpublished change reads in review lists, and where it is edited: items in their editor, the rest on their Profile tab. */
function pendingRow(ws: Workspace, p: PendingChange): { icon: IconComponent; name: string; what: React.ReactNode; open: () => void } {
  if (p.area === "item") return { icon: CATEGORY_ICON[p.resource.category], name: p.id, what: <Mono className="ml-auto truncate">{p.resource.path}</Mono>, open: () => ws.go("profile", p.id) };
  const what = (text: string) => <span className="ml-auto truncate text-sm text-faint">{text}</span>;
  if (p.area === "group")
    return { icon: UsersThree, name: p.id, what: what("New group"), open: () => ws.navigate(workspaceHref("source", "profile", { profileTab: "groups", focus: p.id })) };
  if (p.area === "harnesses")
    return { icon: Cpu, name: "Harness list", what: what(`${ws.listed.length} listed`), open: () => ws.navigate(workspaceHref("source", "profile", { profileTab: "harnesses" })) };
  return { icon: CalendarDots, name: "Profile defaults", what: what("Display name, default schedule and local items"), open: () => ws.navigate(workspaceHref("source", "profile", { profileTab: "defaults" })) };
}


function SectionLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onClick}>
      {children} <ArrowRight />
    </Button>
  );
}

function OverviewState() {
  const ws = useWorkspace();
  const onLatest = ws.followers.filter((f) => f.revision === ws.latest).length;
  // The service state outranks publishing: a fully published Source that nobody can reach is not "fine".
  const service = ws.admin.service.data;
  if (service && !service.serving) {
    return <StateHeader tone="bad" title="Other machines can't reach this Source" body="They keep their current revision until the Source service runs again." />;
  }
  if (!ws.capabilities.simulatedTelemetry || ws.latest === undefined) {
    return <StateHeader tone="muted" title={ws.session?.machineName ?? ws.machineName} body="Publish the profile to send it to your other machines." />;
  }
  const unreachable = ws.followers.filter((f) => f.state === "offline" && f.revision !== ws.latest);
  const reachable = ws.followers.length - unreachable.length;
  const tone = ws.publishing || ws.syncing.length > 0 ? "ok" : ws.pending.length === 0 ? "ok" : "warn";
  // Before revision 1, onboarding's proposed tools are what needs review; other edits are only counted as changes.
  const proposed = ws.proposed.filter((id) => ws.resources.some((r) => r.id === id)).length;
  if (ws.latest === 0 && !ws.publishing)
    return (
      <StateHeader
        tone="warn"
        title="Nothing published yet"
        body={
          proposed > 0 ? (
            <>
              Review the <AnimatedNumber value={proposed} /> proposed {proposed === 1 ? "item" : "items"} in Profile, then publish revision 1. Machines you add get nothing
              until you publish.
            </>
          ) : ws.pending.length > 0 ? (
            <>
              <AnimatedNumber value={ws.pending.length} /> unpublished {ws.pending.length === 1 ? "change waits" : "changes wait"} for revision 1. Machines you add get
              nothing until you publish.
            </>
          ) : (
            "Add what your machines need in Profile, then publish revision 1. Machines you add get nothing until you publish."
          )
        }
      />
    );
  return (
    <StateHeader
      tone={tone}
      running={ws.publishing || ws.syncing.length > 0}
      title={
        ws.publishing ? (
          <>Publishing revision {ws.nextSequence}…</>
        ) : ws.syncing.length > 0 ? (
          <>
            Sending revision <AnimatedNumber value={ws.latest} />: <AnimatedNumber value={onLatest} /> of <AnimatedNumber value={reachable} /> reachable machines have it
          </>
        ) : ws.pending.length === 0 ? (
          "Everything is published"
        ) : (
          <>
            <AnimatedNumber value={ws.pending.length} /> unpublished {ws.pending.length === 1 ? "change" : "changes"}
          </>
        )
      }
      body={
        ws.syncing.length > 0 ? (
          <>
            The rest arrive in a moment.{unreachable.length > 0 && ` ${unreachable.map((f) => f.name).join(", ")} can't reach the Source, so ${unreachable.length === 1 ? "it gets" : "they get"} revision ${ws.latest} once ${unreachable.length === 1 ? "it reconnects" : "they reconnect"}.`}
          </>
        ) : ws.pending.length === 0 || ws.publishing ? (
          <>
            <AnimatedNumber value={onLatest} /> of <AnimatedNumber value={ws.followers.length} /> machines have revision <AnimatedNumber value={ws.latest} />.
            {unreachable.length > 0
              ? ` ${unreachable.map((f) => f.name).join(", ")} can't reach the Source, so ${unreachable.length === 1 ? "it gets" : "they get"} it once ${unreachable.length === 1 ? "it reconnects" : "they reconnect"}.`
              : " The rest get it at their next check."}
          </>
        ) : (
          <>
            Machines stay on revision {ws.latest} until you publish <Term term="Profile Revision">revision {ws.nextSequence}</Term>.
          </>
        )
      }
    />
  );
}

export function SourceOverview() {
  const ws = useWorkspace();
  const latest = ws.revisions[0] as Revision | undefined;
  const onLatest = ws.followers.filter((f) => f.revision === ws.latest).length;
  const behind = ws.followers.map((f) => ({ f, why: whyBehind(f, ws.latest, ws.syncing.includes(f.id)) })).filter((x) => x.why !== null);
  // The same checks the Health page shows, so a removed service or resolved linger reads the same here.
  const warn = useChecks().filter((d) => d.result === "warn");
  const gridResources = ws.resources.filter((r) => r.change !== "added");
  const [serviceInstalled] = useSharedState("service-installed", ws.serviceInstalled);

  return (
    <>
      <PageHeader crumbs={["Overview"]} actions={ws.capabilities.simulatedTelemetry ? <PublishButton /> : <Button size="sm" variant="outline" onClick={ws.reload}>Reload</Button>} />
      <Body>
        <OverviewState />
        {/* Two columns only when the page has room; narrower, the side column moves below instead of squeezing the main one to nothing. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 px-4 pt-6 pb-20 @3xl:grid-cols-[minmax(0,1fr)_320px] @3xl:gap-12 @3xl:px-8">
          <div className="min-w-0 space-y-8">
            {ws.capabilities.simulatedTelemetry && <GetStarted rowInset={4} />}
            <WorkspaceEvidence />
            {ws.capabilities.simulatedTelemetry && <section data-tour="overview-pending">
              <SectionLabel action={<SectionLink onClick={() => ws.setView("profile")}>Profile</SectionLink>}>Unpublished changes</SectionLabel>
              <div className="border-t border-border">
                <RowPresence>
                  {ws.pending.length === 0 && (
                    <AnimatedRow key="none">
                      <div className="flex h-9 items-center gap-2 px-1 text-base text-muted-foreground">
                        <Check className="size-3.5 text-ok" />
                        {ws.latest === 0 ? "The folder is empty, so there is nothing to publish yet." : `The folder matches revision ${ws.latest}.`}
                      </div>
                    </AnimatedRow>
                  )}
                  {ws.pending.map((p) => {
                    const row = pendingRow(ws, p);
                    return (
                      <AnimatedRow key={`${p.area}:${p.id}`}>
                        <button
                          type="button"
                          onClick={row.open}
                          className="flex h-9 w-full items-center gap-3 border-b border-border/70 px-1 text-left text-base outline-none hover:bg-raised/50 focus-visible:bg-raised"
                        >
                          <ChangeMark change={p.change} />
                          <row.icon className="size-3.5 shrink-0 text-faint" />
                          <span className="font-medium">{row.name}</span>
                          {row.what}
                        </button>
                      </AnimatedRow>
                    );
                  })}
                </RowPresence>
              </div>
            </section>}

            {ws.capabilities.simulatedTelemetry && ws.followers.length > 0 && (
              <section data-tour="overview-behind">
                <SectionLabel action={<SectionLink onClick={() => ws.setView("machines")}>All machines</SectionLink>}>Not up to date, and why</SectionLabel>
                <div className="border-t border-border">
                  <RowPresence>
                    {behind.length === 0 && (
                      <AnimatedRow key="none">
                        <div className="flex h-9 items-center gap-2 px-1 text-base text-muted-foreground">
                          <Check className="size-3.5 text-ok" /> Every machine is <Term term="Convergence">up to date</Term> on revision {ws.latest}.
                        </div>
                      </AnimatedRow>
                    )}
                    {behind.map(({ f, why }) => (
                      <AnimatedRow key={f.id}>
                        {/* Wraps at narrow widths: name and state on one line, the reason below, the action under both. */}
                        <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-border/70 px-1 py-2.5 text-base">
                          <div className="min-w-0 flex-1 basis-56">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                              <span title={f.name} className="min-w-0 truncate font-medium">
                                {f.name}
                              </span>
                              {f.state && <StateLabel state={f.state} />}
                              <span className="shrink-0 text-sm text-faint tabular-nums">
                                {f.revision == null ? (
                                  "no revision yet"
                                ) : (
                                  <>
                                    on revision <AnimatedNumber value={f.revision} />
                                  </>
                                )}
                              </span>
                            </div>
                            <p className="mt-0.5 text-sm text-pretty text-muted-foreground [overflow-wrap:anywhere]">
                              <WithCode text={why!} />
                            </p>
                          </div>
                          {f.state !== "converged" && (
                            <Button variant="outline" size="xs" className="mt-0.5 shrink-0" onClick={() => ws.go("machines", f.id)}>
                              What to do <ArrowRight />
                            </Button>
                          )}
                        </div>
                      </AnimatedRow>
                    ))}
                  </RowPresence>
                </div>
              </section>
            )}

            {ws.capabilities.simulatedTelemetry && ws.followers.length > 0 && gridResources.length > 0 && (
              <section data-tour="overview-grid">
                <SectionLabel>
                  <span className="inline-flex items-center gap-1.5">
                    Each item on each machine
                    <Hint label="each item on each machine">
                      {"One square per item and machine.\nSolid: up to date.\nStriped: needs attention.\nDotted: not applied yet, or not sent to that machine.\nCanonfig calls this Convergence."}
                    </Hint>
                  </span>
                </SectionLabel>
                <div className="overflow-x-auto border-t border-border pt-2">
                  {/* Columns stretch to fill the column, so the table ends where the lists above it do. */}
                  <table className="w-full border-separate border-spacing-[3px] text-sm">
                    <thead>
                      <tr>
                        <th scope="col" className="sr-only">
                          Item
                        </th>
                        {ws.followers.map((f) => (
                          <th key={f.id} scope="col" className="min-w-[72px] px-0.5 pb-1 text-left font-normal">
                            <button
                              type="button"
                              onClick={() => ws.go("machines", f.id)}
                              className="block max-w-full truncate rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                            >
                              {f.name}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {gridResources.map((r) => (
                        <tr key={r.id}>
                          <th scope="row" className="w-[1%] pr-4 text-left font-normal whitespace-nowrap">
                            <span className="block max-w-[180px] truncate text-muted-foreground">{r.id}</span>
                          </th>
                          {ws.followers.map((f) => {
                            const s = f.resources?.[r.id];
                            if (!s) return <td key={f.id} className="p-0" />;
                            return (
                              <td key={f.id} className="p-0">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span role="img" className="block h-4 w-full min-w-[72px]" aria-label={`${r.id} on ${f.name}: ${STATE_META[s].label}`}>
                                      <StateCell state={s} />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <span className="font-medium">{r.id}</span> on {f.name}: {STATE_META[s].label}
                                  </TooltipContent>
                                </Tooltip>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {ws.capabilities.simulatedTelemetry && ws.latest !== undefined && ws.latest > 0 && (
              <section>
                <SectionLabel>Activity</SectionLabel>
                <ol className="border-t border-border">
                  {[
                    // Publishing records receipt of the revision, not the outcome of applying it on that machine.
                    ...ws.followers.filter((f) => f.lastRun === "Just now").map((f) => ({ who: f.name, what: `received revision ${f.revision}`, when: "Just now" })),
                    ...(latest?.publishedAt === "Just now" ? [{ who: latest.reviewer, what: `published revision ${latest.sequence}`, when: "Just now" }] : []),
                    ...ws.sourceActivity.flatMap((a) => {
                      const who = a.follower
                        ? ws.followers.find((f) => f.id === a.follower)?.name
                        : ws.revisions.find((r) => r.sequence === a.revision && r.publishedAt === a.when)?.reviewer;
                      return who ? [{ who, what: a.what, when: a.when }] : [];
                    }),
                  ].map((a, i) => (
                    <li key={i} className="flex h-8 items-center gap-1.5 px-1 text-base">
                      <span title={a.who} className="max-w-[40%] shrink-0 truncate font-medium">
                        {a.who}
                      </span>
                      <span className="truncate text-muted-foreground">
                        <WithCode text={a.what} />
                      </span>
                      <span className="ml-auto shrink-0 pl-3 text-sm text-faint tabular-nums">{a.when}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>

          {ws.capabilities.simulatedTelemetry && <aside className="min-w-0 space-y-8">
            <section>
              <SectionLabel action={latest && <SectionLink onClick={() => ws.setView("revisions")}>History</SectionLink>}>Latest revision</SectionLabel>
              <div className="border-t border-border px-1 pt-2.5">
                {!latest ? (
                  <p className="text-base text-muted-foreground">None yet. Your first publish creates revision 1.</p>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-semibold tabular-nums">
                        Revision <AnimatedNumber value={latest.sequence} />
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {latest.publishedAt} by {latest.reviewer}
                      </span>
                    </div>
                    <p className="mt-1 text-base text-muted-foreground">{latest.changes}</p>
                    <p className="mt-1 text-sm text-faint tabular-nums">
                      On <AnimatedNumber value={onLatest} /> of <AnimatedNumber value={ws.followers.length} /> machines
                    </p>
                  </>
                )}
              </div>
            </section>
            <section data-tour="overview-this-machine">
              <SectionLabel>This machine</SectionLabel>
              <div className="border-t border-border">
                <StatusRow
                  status={serviceInstalled ? "ok" : "off"}
                  label="Source service"
                  value={serviceInstalled ? "Running" : "Not installed"}
                  onClick={() => ws.setView("service")}
                />
                <StatusRow
                  status={warn.length ? "warn" : "ok"}
                  label="Health check"
                  title="Canonfig calls this doctor (canonfig doctor)."
                  value={warn.length ? warn.map(warningName).join(", ") : "All checks pass"}
                  onClick={() => ws.setView("doctor")}
                />
                <StatusRow
                  label="Harnesses"
                  title="Listed in canonfig.jsonc, installed here and not excluded."
                  value={`${ws.harnesses.filter((h) => h.listed && h.installed && !h.excluded).length} managed`}
                  onClick={() => ws.navigate(workspaceHref("source", "profile", { profileTab: "harnesses" }))}
                />
                <StatusRow
                  label="Backups"
                  value={`${ws.snapshots.length} ${ws.snapshots.length === 1 ? "snapshot" : "snapshots"}`}
                  onClick={() => ws.setView("backups")}
                />
              </div>
            </section>
          </aside>}
        </div>
      </Body>
    </>
  );
}

/** A Follower's lifecycle states in the CLI's order (`canonfig status`), named in plain words. */
const LIFECYCLE_STEPS = [
  ["discovered", "Source address set"],
  ["enrolled", "Joined"],
  ["selected", "Profile chosen"],
  ["reachable", "Source reachable"],
  ["converged", "Up to date"],
] as const;

/** Only recorded session and status evidence belongs on a live Overview. */
export function WorkspaceEvidence() {
  const { session, status, setView } = useWorkspace();
  if (!session || !status) return null;
  const { machineRole, lifecycle, tunnel } = status;
  return (
    <>
      <section>
        <SectionLabel>This machine</SectionLabel>
        <div className="border-t border-border">
          <Prop label="Name">{session.machineName}</Prop>
          <Prop label="Canonfig version"><Mono>{session.version}</Mono></Prop>
          <Prop label="Canonical Folder"><Mono>{session.folderPath}</Mono></Prop>
          {machineRole.follower !== undefined && <Prop label="Follower identity"><Mono>{machineRole.follower}</Mono></Prop>}
        </div>
        {(machineRole.sourceFingerprint !== undefined || machineRole.tlsFingerprint !== undefined) && <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
          <div className="mt-1 border-t border-border">
            {machineRole.sourceFingerprint !== undefined && <Prop label="Source fingerprint"><Mono>{machineRole.sourceFingerprint}</Mono></Prop>}
            {machineRole.tlsFingerprint !== undefined && <Prop label="TLS fingerprint"><Mono>{machineRole.tlsFingerprint}</Mono></Prop>}
          </div>
        </details>}
      </section>
      {/* Enrollment lifecycle and the tunnel belong to a Follower; a Source has neither. */}
      {session.role === "follower" && <>
        <section>
          <SectionLabel>Sync status</SectionLabel>
          <div className="border-t border-border">
            {/* The CLI's lifecycle order, in plain words; a mark carries reached or not, and only a missed step explains itself. */}
            {LIFECYCLE_STEPS.filter(([key]) => key in lifecycle).map(([key, label]) => {
              const { reached, detail } = lifecycle[key]!;
              return (
                <div key={key} className="border-b border-border/70 py-2">
                  <div className="flex items-center gap-2.5 text-base"><StatusMark kind={reached ? "ok" : "warn"} /><span>{label}<span className="sr-only">{reached ? ": done" : ": not yet"}</span></span></div>
                  {!reached && <p className="mt-1 pl-6 text-sm text-muted-foreground"><CliText>{detail}</CliText></p>}
                </div>
              );
            })}
          </div>
        </section>
        <Button variant="outline" size="sm" onClick={() => setView("sync")}>Open synchronization details</Button>
        {/* A follower that joined without a tunnel has nothing to show here. */}
        {(tunnel as { lifecycle?: unknown } | null)?.lifecycle !== "not-configured" && <section><SectionLabel>SSH tunnel</SectionLabel><TunnelEvidence report={tunnel} /></section>}
      </>}
    </>
  );
}

export function PublishDialog() {
  const ws = useWorkspace();
  if (ws.capabilities.profileWrite) return <PublishForm />;
  return (
    <Dialog open={ws.publishOpen} onOpenChange={ws.setPublishOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publication is not available yet</DialogTitle>
          <DialogDescription>Not implemented: profile.validate, profile.publish. Publish through the Canonfig CLI.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
function validationMessage(error: string) {
  try {
    const value = object(JSON.parse(error));
    const label = typeof value._tag === "string" ? value._tag.replace(/Error$/, "").replace(/([a-z])([A-Z])/g, "$1 $2") : "Validation failed";
    return [label, ...Object.entries(value).filter(([key]) => key !== "_tag").map(([key, value]) => `${key.replace(/([a-z])([A-Z])/g, "$1 $2")}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)].join(". ");
  } catch { return error; }
}


function PublishForm() {
  const ws = useWorkspace();
  const [check, setCheck] = useState(0);
  const [reviewer, setReviewer] = useState(ws.publicationReviewer);
  const [tried, setTried] = useState(false);
  const open = ws.publishOpen;
  const returnFocus = useRef<HTMLElement | null>(null);
  const live = ws.profileLive !== undefined;
  const validate = useEffectEvent(() => ws.profileLive?.validate());

  useEffect(() => {
    if (!open || !ws.capabilities.profileWrite) return;
    if (live) { void validate(); return; }
    setCheck(0);
    setTried(false);
    const t = window.setInterval(() => setCheck((c) => (c >= 100 ? 100 : c + 8)), 90);
    return () => window.clearInterval(t);
  }, [open, ws.capabilities.profileWrite, live]);

  const checked = ws.profileLive ? ws.profileLive.publication.kind === "Validated" : check >= 100;
  const reviewerError = tried && !reviewer.trim() ? "Enter the name of the person who reviewed these changes." : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !ws.publishing && ws.setPublishOpen(o)}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto sm:max-w-[540px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const active = document.activeElement;
          if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) returnFocus.current = active;
          // On touch, focus the dialog itself: the reviewer is filled in, and focusing it would raise the keyboard.
          if (isCoarsePointer()) (e.target as HTMLElement).focus();
          else document.getElementById("pub-reviewer")?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          // Publishing removes its trigger; cancellation returns to the actual opener.
          const target = returnFocus.current?.isConnected && returnFocus.current !== document.body
            ? returnFocus.current
            : document.querySelector<HTMLElement>('main [data-tour="publish"], main h1');
          if (target && !target.matches("button, a, [tabindex]")) target.tabIndex = -1;
          target?.focus();
        }}
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ws.capabilities.profileWrite) return ws.notImplemented("profile.publish");
            setTried(true);
            if (!checked || ws.publishing || !reviewer.trim()) return;
            ws.publish(reviewer.trim(), () => { ws.setPublishOpen(false); if (ws.profileLive) ws.go("revisions"); });
          }}
        >
          <DialogHeader>
            <DialogTitle>Publish revision {ws.nextSequence}</DialogTitle>
            <DialogDescription className="text-base text-pretty">
              Machines apply it at their next check. A published <Term term="Profile Revision">revision</Term> can't be edited afterwards; you publish a new one instead.
            </DialogDescription>
          </DialogHeader>

          <ProfileActionNotice />
          {ws.capabilities.simulatedTelemetry && <section>
            <SectionLabel>
              {ws.pending.length} {ws.pending.length === 1 ? "change" : "changes"}
              {ws.latest !== undefined && ws.latest > 0 ? ` since revision ${ws.latest}` : ", your first revision"}
            </SectionLabel>
            <div className="-mx-4 border-y border-border">
              {ws.pending.map((p) => {
                const row = pendingRow(ws, p);
                return (
                  <div key={`${p.area}:${p.id}`} className="flex h-9 items-center gap-2.5 border-b border-border/70 px-4 text-base last:border-b-0">
                    <ChangeMark change={p.change} />
                    <row.icon className="size-3.5 shrink-0 text-faint" />
                    <span className="font-medium">{row.name}</span>
                    {row.what}
                  </div>
                );
              })}
            </div>
          </section>}

          <section className="grid gap-2" aria-live="polite">
            <div className="flex items-center gap-2 text-base">
              {checked ? <Check className="size-3.5 text-ok" /> : <HourglassMedium className="size-3.5 text-muted-foreground" />}
              <span className={checked ? "text-foreground" : "text-muted-foreground"}>
                {ws.profileLive ? ws.profileLive.validation ? checked ? "Folder and resource validation passed" : "Validation failed" : ws.profileLive.busy ? "Checking the Canonical Folder…" : "Validate the Canonical Folder before publishing" : checked ? `Checked ${ws.pending.length} ${ws.pending.length === 1 ? "change" : "changes"}: no problems` : "Checking the files first (about a second)…"}
              </span>
            </div>
            {ws.capabilities.simulatedTelemetry && <DitherProgress value={ws.publishing ? 100 : check} running={!checked || ws.publishing} tone="ok" label="File check" />}
            {ws.profileLive?.validation?.errors.map((error, index) => <p key={index} className="text-sm text-bad">{validationMessage(error)}</p>)}
            {ws.profileLive && <Button type="button" variant="outline" size="sm" disabled={ws.profileLive.busy} onClick={() => void ws.profileLive?.validate()}>Validate folder</Button>}
            <p className="text-sm text-pretty text-faint">
              Canonfig reads every file in this change and records a fingerprint of it, so each machine can confirm it got exactly these files.
              {DEMO && " This demo reads no files: the check is a short wait, and the fingerprint is a stand-in made from the revision number and change list."} Publish
              unlocks when the check finishes.
            </p>
          </section>

          <Field
            label="Reviewed by"
            htmlFor="pub-reviewer"
            description="Recorded in the revision, so later you can see who published it."
            error={reviewerError}
          >
            <Input
              id="pub-reviewer"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              aria-invalid={!!reviewerError}
              aria-describedby="pub-reviewer-note"
              autoComplete="name"
              spellCheck={false}
              className="w-56"
            />
          </Field>
          <DialogFooter>
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="ghost" disabled={ws.publishing} onClick={() => ws.setPublishOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!checked || ws.publishing || ws.profileLive?.busy}>
                {ws.publishing ? "Publishing…" : !checked ? "Checking files…" : <>Publish revision {ws.nextSequence}</>}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RevisionsView() {
  const ws = useWorkspace();
  const selected = ws.focus;
  const current = ws.revisions.find((r) => String(r.sequence) === selected);
  const cols = "72px minmax(200px,360px) 140px 110px minmax(120px,1fr)";
  // Column minimums + 4 gaps + row inset padding; narrower screens scroll the list sideways instead of clipping it.
  const colsMin = 72 + 200 + 140 + 110 + 120 + 4 * 12 + 20;
  return (
    <>
      <PageHeader crumbs={["Revisions"]} actions={ws.profileLive ? <Button size="sm" onClick={() => ws.setPublishOpen(true)}>Publish revision</Button> : <PublishButton />} />
      <ProfileActionNotice />
      <Body detail={current && <RevisionDetail key={current.sequence} revision={current} onClose={() => ws.go("revisions")} />}>
        {ws.revisions.length === 0 && ws.pending.length === 0 ? (
          <EmptyState title="No revisions yet" body="Publish the profile to create revision 1." />
        ) : (
          <>
            <ListHead cols={cols} minWidth={colsMin} data-tour="revisions-list">
              <span>
                <Term term="Profile Revision">Revision</Term>
              </span>
              <span>Changes</span>
              <span>Fingerprint</span>
              <span>Reviewed by</span>
              <span>Published</span>
            </ListHead>
            <RowPresence>
              {ws.pending.length > 0 && (
                <AnimatedRow key="next">
                  <ListRow cols={cols} minWidth={colsMin} onClick={() => ws.setPublishOpen(true)} className="text-muted-foreground" data-tour="revisions-next">
                    <span className="text-warn tabular-nums">{ws.nextSequence}</span>
                    <span className="truncate">
                      {ws.pending.length} unpublished {ws.pending.length === 1 ? "change" : "changes"}
                    </span>
                    <span />
                    <span />
                    <span className="text-sm text-warn">Publish…</span>
                  </ListRow>
                </AnimatedRow>
              )}
              {ws.revisions.map((r) => (
                <AnimatedRow key={r.sequence}>
                  <ListRow cols={cols} minWidth={colsMin} selected={selected === String(r.sequence)} onClick={() => ws.go("revisions", String(r.sequence))} data-tour="revisions-list">
                    <span className="font-medium tabular-nums">{r.sequence}</span>
                    <span className="truncate">{r.changes}</span>
                    <Mono className="truncate">{r.digest}</Mono>
                    <span className="truncate text-sm text-muted-foreground">{r.reviewer}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">{r.publishedAt}</span>
                  </ListRow>
                </AnimatedRow>
              ))}
            </RowPresence>
            {/* Scroll room under the list only; an empty state needs the bottom edge for its dither. */}
            <div className="pb-16" />
          </>
        )}
      </Body>
    </>
  );
}

function RevisionDetail({ revision: r, onClose }: { revision: Revision; onClose: () => void }) {
  const ws = useWorkspace();
  const on = ws.followers.filter((f) => f.revision === r.sequence);
  const inspectRevision = useEffectEvent((sequence: number) => ws.profileLive?.inspectRevision(sequence));
  useEffect(() => inspectRevision(r.sequence), [r.sequence]);
  const detail = ws.profileLive?.revisionDetail?.sequence === r.sequence ? ws.profileLive.revisionDetail : null;
  const inspected = object(detail?.data ?? undefined);
  const publishedResources = Array.isArray(inspected.resources) ? inspected.resources.map(object) : [];
  return (
    <DetailPanel
      title={`Revision ${r.sequence}`}
      subtitle={r.sequence === ws.latest ? <span className="text-xs text-ok">Latest</span> : undefined}
      onClose={onClose}
      footer={
        <Button variant="ghost" size="sm" onClick={() => copy(r.digest, "Fingerprint copied")}>
          Copy fingerprint
        </Button>
      }
    >
      <div className="px-4 py-3">
        {r.publishedAt && <Prop label="Published">{r.publishedAt}</Prop>}
        {r.reviewer && <Prop label="Reviewed by">{r.reviewer}</Prop>}
        <Prop
          label={
            <span className="inline-flex items-center gap-1">
              Fingerprint{" "}
              <Hint label="Fingerprint">
                The digest of everything in this revision. Each machine checks it, so it knows the files weren't changed on the way.
                {DEMO && "\nIn this demo it is a stand-in value, and no machine checks it."}
              </Hint>
            </span>
          }
        >
          <Mono className="text-foreground">{r.digest}</Mono>
        </Prop>
        {r.changes && <Prop label="Changes">{r.changes}</Prop>}
      </div>
      {ws.profileLive && <div className="border-t border-border px-4 py-3" aria-busy={!detail || detail.loading}>
        <SectionLabel>Published resources</SectionLabel>
        {(!detail || detail.loading) && <p role="status">Loading revision…</p>}
        {detail?.error && <ErrorNotice error={detail.error} />}
        {publishedResources.map((resource, index) => <Prop key={index} label={String(resource.id ?? resource.kind ?? "Resource")}><Mono>{String(resource.digest ?? "")}</Mono></Prop>)}
        {typeof inspected.signature === "string" && <Prop label="Signature"><Mono>{inspected.signature}</Mono></Prop>}
      </div>}
      {ws.capabilities.simulatedTelemetry && <><div className="border-t border-border px-4 pt-3">
        <SectionLabel>Machines on this revision</SectionLabel>
      </div>
      {on.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No machine is on this revision now.</p>
      ) : (
        <div className="pb-3">
          {on.map((f) => (
            <div key={f.id} className="flex h-8 items-center px-4 text-base">
              {f.name}
              <span className="ml-auto">
                {f.state && <StateLabel state={f.state} />}
              </span>
            </div>
          ))}
        </div>
      )}</>}
    </DetailPanel>
  );
}

interface SecretDraft { name: string; value: string; replaces: string | null; tried: boolean }
type SecretFlow =
  | { kind: "Closed" | "Saved" }
  | { kind: "Editing"; id: number; draft: SecretDraft }
  | { kind: "Submitting"; id: number; draft: SecretDraft }
  | { kind: "Failed"; id: number; draft: SecretDraft };
type SecretEvent =
  | { kind: "Open"; id: number; name?: string }
  | { kind: "Change"; update: Partial<SecretDraft> }
  | { kind: "Submit" }
  | { kind: "Succeeded" | "Failed"; id: number }
  | { kind: "Close" };
function secretTransition(state: SecretFlow, event: SecretEvent): SecretFlow {
  if (event.kind === "Open" && state.kind !== "Submitting") return { kind: "Editing", id: event.id, draft: { name: event.name ?? "", replaces: event.name ?? null, value: "", tried: false } };
  if (event.kind === "Close" && state.kind !== "Submitting") return { kind: "Closed" };
  if ("draft" in state) {
    if (event.kind === "Change" && state.kind !== "Submitting") return { ...state, kind: "Editing", draft: { ...state.draft, ...event.update } };
    if (event.kind === "Submit" && state.kind !== "Submitting") return { ...state, kind: "Submitting" };
    if ((event.kind === "Succeeded" || event.kind === "Failed") && state.kind === "Submitting" && state.id === event.id) return event.kind === "Succeeded" ? { kind: "Saved" } : { ...state, kind: "Failed" };
  }
  throw new GuiRequestError({ category: "usage-or-configuration", exitCode: 2, message: `Cannot ${event.kind.toLowerCase()} the secret form while it is ${state.kind}.` });
}

export function SecretsView() {
  const ws = useWorkspace();
  const [flow, setFlow] = useState<SecretFlow>({ kind: "Closed" });
  const generation = useRef(0);
  const send = (event: SecretEvent) => setFlow((state) => secretTransition(state, event));
  const open = "draft" in flow;
  const submitting = flow.kind === "Submitting";
  const { name, value, replaces: editing, tried } = "draft" in flow ? flow.draft : { name: "", value: "", replaces: null, tried: false };
  const setOpen = (next: boolean) => { if (!next && !submitting) send({ kind: "Close" }); };
  const [removing, setRemoving] = useState<string | null>(null);
  const receivers = ws.followers.filter((f) => f.groups.includes(SECRETS_GROUP));
  const others = ws.followers.length - receivers.length;
  const cols = "minmax(180px,240px) 120px minmax(160px,360px) minmax(40px,1fr)";
  const colsMin = 180 + 120 + 160 + 40 + 3 * 12 + 20;
  const share = () => ws.setChangeGroups({ addGroup: SECRETS_GROUP });

  const openSet = (name?: string) => { if (!submitting) send({ kind: "Open", id: ++generation.current, name }); };

  const trimmed = name.trim();
  const nameError = !tried || editing ? null : !trimmed ? "Enter a name." : ws.secrets.some((s) => s.name === trimmed) ? `${trimmed} already exists. Use Replace value on its row.` : null;
  const valueError = tried && !value ? "Enter the secret value." : null;
  // Only an open form holds a draft: Cancel, Escape and Save secret all close it, and reopening starts blank.
  // Replacing a value has no name field, so only the value counts there.
  const { dialog: leaveDialog } = useLeaveGuard(open && (value !== "" || (!editing && name !== "")), editing ?? "this new secret");

  return (
    <>
      <PageHeader
        crumbs={["Secrets"]}
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!ws.capabilities.enrollmentWrite || others === 0} onClick={share} data-tour="secrets-share">
              Share with more machines
            </Button>
            <Button size="sm" variant="primary" disabled={!ws.capabilities.profileWrite} onClick={() => openSet()} data-tour="secrets-set">
              Set secret
            </Button>
          </>
        }
      />
      <ProfileActionNotice />
      <Body>
        {ws.secrets.length > 0 && <p data-tour="secrets-about" className="border-b border-border px-[18px] py-3 text-sm text-pretty text-muted-foreground">
          Sent to: {receivers.length ? receivers.map((f) => f.name).join(", ") : "no machines yet"}
        </p>}
        {ws.secrets.length === 0 ? (
          <EmptyState
            title="No shared secrets"
            body="Machines that can receive secrets get each one you set."
            action={
              <Button variant="outline" size="sm" disabled={!ws.capabilities.profileWrite} onClick={() => openSet()}>
                Set secret
              </Button>
            }
          />
        ) : (
          <>
            <ListHead cols={cols} minWidth={colsMin} data-tour="secrets-list">
              <span>Name</span>
              <span>Updated</span>
              <span>Eligible machines</span>
              <span />
            </ListHead>
            <RowPresence>
              {ws.secrets.map((s) => (
                <AnimatedRow key={s.name}>
                  <ListRow cols={cols} minWidth={colsMin} data-tour="secrets-list">
                    <span className="flex min-w-0 items-center gap-2">
                      <Key className="size-3.5 shrink-0 text-faint" />
                      <span className="truncate font-mono text-sm">{s.name}</span>
                    </span>
                    <span className="text-sm text-muted-foreground tabular-nums">{s.updated}</span>
                    <span className="truncate text-sm text-muted-foreground">{receivers.map((f) => f.name).join(", ") || "No machines yet"}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" className="justify-self-end" aria-label={`Actions for ${s.name}`}>
                          <DotsThree />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled={!ws.capabilities.profileWrite} onSelect={() => openSet(s.name)}>Replace value…</DropdownMenuItem>
                        <DropdownMenuItem disabled={!ws.capabilities.enrollmentWrite || others === 0} onSelect={share}>
                          Share with more machines…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" disabled={!ws.capabilities.profileWrite} onSelect={() => setRemoving(s.name)}>
                          Remove…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ListRow>
                </AnimatedRow>
              ))}
            </RowPresence>
            {/* Scroll room under the list only; an empty state needs the bottom edge for its dither. */}
            <div className="pb-16" />
          </>
        )}
      </Body>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
          <form
            className="contents"
            onSubmit={async (e) => {
              e.preventDefault();
              send({ kind: "Change", update: { tried: true } });
              const badName = !editing && (!trimmed || ws.secrets.some((s) => s.name === trimmed));
              if (badName || !value) {
                document.getElementById(badName ? "sec-name" : "sec-value")?.focus();
                return;
              }
              if (!("id" in flow) || submitting) return;
              const id = flow.id;
              send({ kind: "Submit" });
              if (ws.profileLive) {
                if (!await ws.profileLive.setSecret(editing ?? trimmed, value)) { send({ kind: "Failed", id }); return; }
              } else {
              ws.setSecrets((p) => (editing ? p.map((s) => (s.name === editing ? { ...s, updated: "Today" } : s)) : [...p, { name: trimmed, updated: "Today", sharedWith: receivers.length }]));
              }
              send({ kind: "Succeeded", id });
              toast.success(editing ? `Replaced ${editing}` : `Saved ${trimmed}`, { description: DEMO ? "Saved in this demo workspace." : undefined });
            }}
          >
            <DialogHeader>
              <DialogTitle>{editing ? `Replace ${editing}` : "Set a shared secret"}</DialogTitle>
              <DialogDescription className="text-base text-pretty">
                Machines that can receive secrets get it on their next update{receivers.length ? `: ${receivers.map((f) => f.name).join(", ")}` : ""}.
              </DialogDescription>
            </DialogHeader>
            <ProfileActionNotice />
            <fieldset disabled={submitting} className="grid gap-3">
              {!editing && (
                <Field label="Name" htmlFor="sec-name" error={nameError}>
                  <Input
                    id="sec-name"
                    value={name}
                    onChange={(e) => send({ kind: "Change", update: { name: e.target.value } })}
                    aria-invalid={!!nameError}
                    aria-describedby={nameError ? "sec-name-note" : undefined}
                    placeholder="anthropic-api-key"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-sm"
                  />
                </Field>
              )}
              <Field
                label="Value"
                htmlFor="sec-value"
                description={`Canonfig keeps it in the credential store, never in the folder.${DEMO ? " This demo discards it." : ""}`}
                error={valueError}
              >
                <Input
                  id="sec-value"
                  type="password"
                  value={value}
                  onChange={(e) => send({ kind: "Change", update: { value: e.target.value } })}
                  aria-invalid={!!valueError}
                  aria-describedby="sec-value-note"
                  autoComplete="off"
                  data-1p-ignore
                />
              </Field>
            </fieldset>
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={submitting} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={submitting || ws.profileLive?.busy}>
                Save secret
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {removing}?</DialogTitle>
            <DialogDescription className="text-base text-pretty">
              Canonfig deletes it from this machine's credential store, and machines delete their copy on their next update. Tools that read it stop working until you set it again.
              {DEMO && " This demo only removes the name from the list."}
            </DialogDescription>
          </DialogHeader>
          <ProfileActionNotice />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={ws.profileLive?.busy}
              onClick={async () => {
                if (ws.profileLive) { if (!removing || !await ws.profileLive.removeSecret(removing)) return; }
                else ws.setSecrets((p) => p.filter((s) => s.name !== removing));
                toast(`Removed ${removing}`, { description: DEMO ? "Removed from this demo workspace." : undefined });
                setRemoving(null);
              }}
            >
              Remove secret
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {leaveDialog}
    </>
  );
}
