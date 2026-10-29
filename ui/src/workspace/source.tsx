// Source screens use simulated data for overview, revisions, secrets, and publishing.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, CalendarDots, Check, DotsThree, Key, UsersThree, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatedNumber, DitherProgress, Hint, Mono, StateCell, StateLabel, Term, goldButton } from "@/shared/shared";
import { PLAIN, SECRETS_GROUP, STATE_META, type Revision } from "@/shared/data";
import { shq } from "@/shared/shell";
import { useSharedState, useWorkspace, type PendingChange, type Workspace } from "./store";
import { GetStarted } from "./guide";
import { whyBehind } from "./machines";
import { useAgentPolicy, useChecks, warningName } from "./settings";
import { workspaceHref } from "./routes";
import {
  AnimatedRow,
  Body,
  ChangeMark,
  Cli,
  DetailPanel,
  EmptyState,
  Field,
  KIND_ICON,
  ListHead,
  ListRow,
  PageHeader,
  Prop,
  PublishButton,
  RowPresence,
  SectionLabel,
  StateHeader,
  WithCode,
  copy,
  useLeaveGuard,
} from "./kit";

const AGENT_MODE_LABEL: Record<string, string> = { "deterministic-only": "Off", "agent-propose": "Proposes only", "agent-apply": "Applies fixes" };

/** How one unpublished change reads in review lists, and where it is edited: items in their editor, groups and defaults on their Profile tab. */
function pendingRow(ws: Workspace, p: PendingChange): { icon: PhosphorIcon; name: string; what: React.ReactNode; open: () => void } {
  if (p.area === "item") return { icon: KIND_ICON[p.resource.kind], name: p.id, what: <Mono className="ml-auto truncate">{p.resource.target}</Mono>, open: () => ws.go("profile", p.id) };
  const what = (text: string) => <span className="ml-auto truncate text-sm text-faint">{text}</span>;
  if (p.area === "group")
    return { icon: UsersThree, name: p.id, what: what("New group"), open: () => ws.navigate(workspaceHref("source", "profile", { profileTab: "groups", focus: p.id })) };
  return { icon: CalendarDots, name: "Profile defaults", what: what("Display name and default schedule"), open: () => ws.navigate(workspaceHref("source", "profile", { profileTab: "defaults" })) };
}

/**
 * The seeded demo Source's recent history. Each line names the machine or revision it is about and shows only
 * while that machine or revision is in this session, so a new Source does not borrow the demo's past.
 */
const SEED_ACTIVITY: { follower?: string; revision?: number; what: string; when: string }[] = [
  { follower: "f_8c21", what: "applied revision 7", when: "12 min ago" },
  { follower: "f_3b90", what: "has a local edit to claude-review-skill, waiting for a decision there", when: "2 h ago" },
  { revision: 7, what: "published revision 7", when: "Today 08:41" },
  { follower: "f_d417", what: "is waiting for someone to run `gh auth login`", when: "Yesterday" },
  { follower: "f_71ea", what: "stopped reaching the Source", when: "Sat" },
];

function SectionLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onClick}>
      {children} <ArrowRight />
    </Button>
  );
}

/** A row in the overview's side column that opens the matching settings page. */
function StatusRow({ dot, label, value, title, onClick }: { dot?: string; label: string; value: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex min-h-9 w-full items-center gap-2 border-b border-border/70 px-1 py-1.5 text-left text-base outline-none hover:bg-raised/50 focus-visible:bg-raised"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      <span className="shrink-0 whitespace-nowrap">{label}</span>
      {/* Wraps instead of truncating: a health warning cut mid-word is worse than a second line. */}
      <span className="ml-auto pl-3 text-right text-sm text-pretty text-muted-foreground">{value}</span>
    </button>
  );
}

function OverviewState() {
  const ws = useWorkspace();
  const onLatest = ws.followers.filter((f) => f.revision === ws.latest).length;
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
  const [agent] = useAgentPolicy();
  const gridResources = ws.resources.filter((r) => r.change !== "added");
  const [serviceInstalled] = useSharedState("service-installed", true);

  return (
    <>
      <PageHeader crumbs={["Overview"]} actions={<PublishButton />} />
      <Body>
        <OverviewState />
        <GetStarted />

        {/* Two columns only when the page has room; narrower, the side column moves below instead of squeezing the main one to nothing. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 px-4 pt-6 pb-20 @3xl:grid-cols-[minmax(0,1fr)_320px] @3xl:gap-12 @3xl:px-8">
          <div className="min-w-0 space-y-8">
            <section>
              <SectionLabel action={<SectionLink onClick={() => ws.setView("profile")}>Profile</SectionLink>}>Unpublished changes</SectionLabel>
              <div className="border-t border-border">
                <RowPresence>
                  {ws.pending.length === 0 && (
                    <AnimatedRow key="none">
                      <div className="flex h-9 items-center gap-2 px-1 text-base text-muted-foreground">
                        <Check className="size-3.5 text-ok" />
                        {ws.latest === 0 ? "The profile is empty, so there is nothing to publish yet." : `The profile file matches revision ${ws.latest}.`}
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
            </section>

            {ws.followers.length > 0 && (
              <section>
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
                              <StateLabel state={f.state} />
                              <span className="shrink-0 text-sm text-faint tabular-nums">
                                {f.revision === null ? (
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

            {ws.followers.length > 0 && gridResources.length > 0 && (
              <section>
                <SectionLabel>
                  <span className="inline-flex items-center gap-1.5">
                    Each item on each machine
                    <Hint label="each item on each machine">
                      One square per item and machine. Solid: up to date. Striped: needs attention. Dotted: not applied yet, or not sent to that machine. Canonfig calls this
                      Convergence.
                    </Hint>
                  </span>
                </SectionLabel>
                <div className="overflow-x-auto border-t border-border pt-2">
                  <table className="border-separate border-spacing-[3px] text-sm">
                    <thead>
                      <tr>
                        <th scope="col" className="sr-only">
                          Item
                        </th>
                        {ws.followers.map((f) => (
                          <th key={f.id} scope="col" className="w-[72px] px-0.5 pb-1 text-left font-normal">
                            <button
                              type="button"
                              onClick={() => ws.go("machines", f.id)}
                              className="block max-w-[72px] truncate rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
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
                          <th scope="row" className="pr-4 text-left font-normal">
                            <span className="block max-w-[180px] truncate text-muted-foreground">{r.id}</span>
                          </th>
                          {ws.followers.map((f) => {
                            const s = f.resources[r.id] ?? "never-synced";
                            return (
                              <td key={f.id} className="p-0">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span role="img" className="block h-4 w-[72px]" aria-label={`${r.id} on ${f.name}: ${STATE_META[s].label}`}>
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

            {ws.latest > 0 && (
              <section>
                <SectionLabel>Activity</SectionLabel>
                <ol className="border-t border-border">
                  {[
                    // Publishing records receipt of the revision, not the outcome of applying it on that machine.
                    ...ws.followers.filter((f) => f.lastRun === "Just now").map((f) => ({ who: f.name, what: `received revision ${f.revision}`, when: "Just now" })),
                    ...(latest?.publishedAt === "Just now" ? [{ who: latest.reviewer, what: `published revision ${latest.sequence}`, when: "Just now" }] : []),
                    ...SEED_ACTIVITY.flatMap((a) => {
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

          <aside className="min-w-0 space-y-8">
            <section>
              <SectionLabel action={latest && <SectionLink onClick={() => ws.setView("revisions")}>History</SectionLink>}>Latest revision</SectionLabel>
              <div className="border-t border-border px-1 pt-2.5">
                {!latest ? (
                  <p className="text-base text-muted-foreground">None yet. Your first publish creates revision 1.</p>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[15px] font-semibold tabular-nums">
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
            <section>
              <SectionLabel>This machine</SectionLabel>
              <div className="border-t border-border">
                <StatusRow
                  dot={serviceInstalled ? "bg-ok" : "bg-faint"}
                  label="Source service"
                  value={serviceInstalled ? "Running" : "Not installed"}
                  onClick={() => ws.setView("service")}
                />
                <StatusRow
                  dot={warn.length ? "bg-warn" : "bg-ok"}
                  label="Health check"
                  title="Canonfig calls this doctor (canonfig doctor)."
                  value={warn.length ? warn.map(warningName).join(", ") : "All checks pass"}
                  onClick={() => ws.setView("doctor")}
                />
                <StatusRow
                  label="AI agent"
                  value={agent.mode === "deterministic-only" ? AGENT_MODE_LABEL[agent.mode] : `${AGENT_MODE_LABEL[agent.mode]} (${agent.harness})`}
                  onClick={() => ws.setView("agent")}
                />
              </div>
            </section>
          </aside>
        </div>
      </Body>
    </>
  );
}

export function PublishDialog() {
  const ws = useWorkspace();
  const [check, setCheck] = useState(0);
  const [reviewer, setReviewer] = useState("marcos");
  const [tried, setTried] = useState(false);
  const open = ws.publishOpen;

  useEffect(() => {
    if (!open) return;
    setCheck(0);
    setTried(false);
    const t = window.setInterval(() => setCheck((c) => (c >= 100 ? 100 : c + 8)), 90);
    return () => window.clearInterval(t);
  }, [open]);

  const checked = check >= 100;
  const reviewerError = tried && !reviewer.trim() ? "Enter the name of the person who reviewed these changes." : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !ws.publishing && ws.setPublishOpen(o)}>
      <DialogContent
        className="grid-cols-[minmax(0,1fr)] gap-5 sm:max-w-[540px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.getElementById("pub-reviewer")?.focus();
        }}
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (!checked || ws.publishing || !reviewer.trim()) return;
            ws.publish(reviewer.trim(), () => ws.setPublishOpen(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Publish revision {ws.nextSequence}</DialogTitle>
            <DialogDescription className="text-base text-pretty">
              Machines apply it at their next check. A published <Term term="Profile Revision">revision</Term> can't be edited afterwards; you publish a new one instead.
            </DialogDescription>
          </DialogHeader>

          <section>
            <SectionLabel>
              {ws.pending.length} {ws.pending.length === 1 ? "change" : "changes"}
              {ws.latest > 0 ? ` since revision ${ws.latest}` : ", your first revision"}
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
          </section>

          <section className="grid gap-2" aria-live="polite">
            <div className="flex items-center gap-2 text-base">
              {checked ? <Check className="size-3.5 text-ok" /> : <span className="size-3.5 animate-spin rounded-full border border-faint border-t-foreground" />}
              <span className={checked ? "text-foreground" : "text-muted-foreground"}>
                {checked ? `Checked ${ws.pending.length} ${ws.pending.length === 1 ? "change" : "changes"}: no problems` : "Checking the files first (about a second)…"}
              </span>
            </div>
            <DitherProgress value={ws.publishing ? 100 : check} running={!checked || ws.publishing} tone="ok" label="File check" />
            <p className="text-sm text-pretty text-faint">
              Canonfig reads every file in this change and records a fingerprint of it, so each machine can confirm it got exactly these files. This demo reads no files: the
              check is a short wait, and the fingerprint is a stand-in made from the revision number and change list. Publish unlocks when the check finishes.
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

          <DialogFooter className="items-center sm:justify-between">
            <Cli className="flex-1">{`canonfig source publish --profile-file ${shq(ws.profileFile)} --reviewer ${reviewer.trim() ? shq(reviewer.trim()) : "<name>"}`}</Cli>
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="ghost" disabled={ws.publishing} onClick={() => ws.setPublishOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className={goldButton} disabled={!checked || ws.publishing}>
                {ws.publishing ? "Publishing…" : !checked ? "Checking files…" : `Publish revision ${ws.nextSequence}`}
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
  const cols = "72px minmax(200px,2fr) 140px 110px 120px";
  return (
    <>
      <PageHeader crumbs={["Revisions"]} actions={<PublishButton />} />
      <Body detail={current && <RevisionDetail key={current.sequence} revision={current} onClose={() => ws.go("revisions")} />}>
        {ws.revisions.length === 0 && ws.pending.length === 0 ? (
          <EmptyState title="No revisions yet" body="Each time you publish the profile, it becomes a numbered revision here that machines can apply." />
        ) : (
          <>
            <ListHead cols={cols}>
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
                  <ListRow cols={cols} onClick={() => ws.setPublishOpen(true)} className="text-muted-foreground">
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
                  <ListRow cols={cols} selected={selected === String(r.sequence)} onClick={() => ws.go("revisions", String(r.sequence))}>
                    <span className="font-medium tabular-nums">{r.sequence}</span>
                    <span className="truncate">{r.changes}</span>
                    <Mono className="truncate">{r.digest}</Mono>
                    <span className="text-sm text-muted-foreground">{r.reviewer}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">{r.publishedAt}</span>
                  </ListRow>
                </AnimatedRow>
              ))}
            </RowPresence>
          </>
        )}
        <div className="px-4 pt-5 pb-16">
          <Cli>canonfig profile list</Cli>
        </div>
      </Body>
    </>
  );
}

function RevisionDetail({ revision: r, onClose }: { revision: Revision; onClose: () => void }) {
  const ws = useWorkspace();
  const on = ws.followers.filter((f) => f.revision === r.sequence);
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
        <Prop label="Published">{r.publishedAt}</Prop>
        <Prop label="Reviewed by">{r.reviewer}</Prop>
        <Prop
          label={
            <span className="inline-flex items-center gap-1">
              Fingerprint{" "}
              <Hint label="Fingerprint">
                The digest of everything in this revision. Each machine checks it, so it knows the files weren't changed on the way. In this demo it is a stand-in value,
                and no machine checks it.
              </Hint>
            </span>
          }
        >
          <Mono className="text-foreground">{r.digest}</Mono>
        </Prop>
        <Prop label="Changes">{r.changes}</Prop>
      </div>
      <div className="border-t border-border px-4 pt-3">
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
                <StateLabel state={f.state} />
              </span>
            </div>
          ))}
        </div>
      )}
    </DetailPanel>
  );
}

export function SecretsView() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [tried, setTried] = useState(false);
  const receivers = ws.followers.filter((f) => f.groups.includes(SECRETS_GROUP));
  const others = ws.followers.length - receivers.length;
  const cols = "minmax(180px,1.5fr) 120px minmax(160px,1fr) 40px";
  const share = () => ws.setChangeGroups({ addGroup: SECRETS_GROUP });

  const openSet = (n?: string) => {
    setEditing(n ?? null);
    setName(n ?? "");
    setValue("");
    setTried(false);
    setOpen(true);
  };

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
            <Button variant="outline" size="sm" disabled={others === 0} onClick={share}>
              Share with more machines
            </Button>
            <Button size="sm" className={goldButton} onClick={() => openSet()}>
              Set secret
            </Button>
          </>
        }
      />
      <Body>
        <p className="border-b border-border px-4 py-3 text-sm text-pretty text-muted-foreground">
          Canonfig keeps these in this machine's credential store and sends them only to machines that{" "}
          <Term term="Follower Group">
            <span className="lowercase">{PLAIN.secretsGroup}</span>
          </Term>{" "}
          (group <Mono className="text-foreground">{SECRETS_GROUP}</Mono>): {receivers.length ? receivers.map((f) => f.name).join(", ") : "none yet"}. A value can't be viewed
          again after you set it. This demo keeps only each secret's name and discards the value.
        </p>
        {ws.secrets.length === 0 ? (
          <EmptyState
            title="No shared secrets"
            body="Set one to make it available to the machines that can receive secrets."
            action={
              <Button variant="outline" size="sm" onClick={() => openSet()}>
                Set secret
              </Button>
            }
          />
        ) : (
          <>
            <ListHead cols={cols}>
              <span>Name</span>
              <span>Updated</span>
              <span>Eligible machines</span>
              <span />
            </ListHead>
            <RowPresence>
              {ws.secrets.map((s) => (
                <AnimatedRow key={s.name}>
                  <ListRow cols={cols}>
                    <span className="flex min-w-0 items-center gap-2">
                      <Key className="size-3.5 shrink-0 text-faint" />
                      <span className="truncate font-mono text-sm">{s.name}</span>
                    </span>
                    <span className="text-sm text-muted-foreground tabular-nums">{s.updated}</span>
                    <span className="truncate text-sm text-muted-foreground">{receivers.map((f) => f.name).join(", ") || "No machines yet"}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" className="justify-self-end" aria-label={`Actions for ${s.name}`}>
                          <DotsThree weight="bold" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => openSet(s.name)}>Replace value…</DropdownMenuItem>
                        <DropdownMenuItem disabled={others === 0} onSelect={share}>
                          Share with more machines…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(s.name)}>
                          Remove…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ListRow>
                </AnimatedRow>
              ))}
            </RowPresence>
          </>
        )}
        <div className="px-4 pt-5 pb-16">
          <Cli>canonfig secrets list</Cli>
        </div>
      </Body>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              const bad = !value || (!editing && (!trimmed || ws.secrets.some((s) => s.name === trimmed)));
              if (bad) return;
              ws.setSecrets((p) => (editing ? p.map((s) => (s.name === editing ? { ...s, updated: "Today" } : s)) : [...p, { name: trimmed, updated: "Today", sharedWith: receivers.length }]));
              setOpen(false);
              toast.success(editing ? `Replaced ${editing}` : `Saved ${trimmed}`, { description: "Saved in this demo workspace." });
            }}
          >
            <DialogHeader>
              <DialogTitle>{editing ? `Replace ${editing}` : "Set a shared secret"}</DialogTitle>
              <DialogDescription className="text-base text-pretty">
                Machines that can receive secrets get it on their next update{receivers.length ? `: ${receivers.map((f) => f.name).join(", ")}` : ""}.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              {!editing && (
                <Field label="Name" htmlFor="sec-name" error={nameError}>
                  <Input
                    id="sec-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
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
                description="Canonfig keeps it in the credential store, never in the profile file. This demo discards it."
                error={valueError}
              >
                <Input
                  id="sec-value"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  aria-invalid={!!valueError}
                  aria-describedby="sec-value-note"
                  autoComplete="off"
                  data-1p-ignore
                />
              </Field>
            </div>
            <Cli>{`printf '%s' "$VALUE" | canonfig secrets set ${(editing ?? trimmed) ? shq(editing ?? trimmed) : "<name>"}`}</Cli>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="secondary">
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
              This demo only removes the name from the list.
            </DialogDescription>
          </DialogHeader>
          <Cli>{`canonfig secrets remove ${removing ? shq(removing) : "<name>"}`}</Cli>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                ws.setSecrets((p) => p.filter((s) => s.name !== removing));
                toast(`Removed ${removing}`, { description: "Removed from this demo workspace." });
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
