// The Shield page: this machine's switch, what Shield caught in the last 30 days, the plugins waiting for review,
// and which listed harnesses it protects. Live data comes from /api/shield (src/gui/routes/shield.ts); the demo
// uses simulated-shield.ts with the same shape.
//
// Copy shows only what differs from "redirected", which is the page's job: a log row names the item, who tried to
// install it and where, and only plugin rows carry an outcome. The harness list explains only harnesses that are
// not fully protected.
//
// Motion (an occasional page, so standard UI motion on --ease-snap, 120-200ms, transform and opacity only): rows
// enter with a 4px rise and stagger 30ms when the filter changes, siblings slide instead of jumping, the filter pill
// slides, a resolved review crossfades, and notices fold open and closed. Reduced motion keeps only the fades.
import { useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { HARNESS_NAMES, SURFACE_SUPPORT, type HarnessId } from "@/shared/metadata";
import { CliText, Mono, StatusMark } from "@/shared/shared";
import { usePrefersReducedMotion } from "@/lib/dither";
import { cn, SNAP } from "@/lib/utils";
import type { GuiShield, GuiShieldPlugin } from "../../../src/gui/contract/shield";
import { Body, PageHeader } from "./kit";
import { useWorkspace } from "./store";

const ENTER = { duration: 0.2, ease: SNAP };
const EXIT = { duration: 0.12, ease: [0.23, 1, 0.32, 1] as const };

const harnessName = (id: string | undefined) => (id !== undefined && id in HARNESS_NAMES ? HARNESS_NAMES[id as HarnessId] : id) ?? "An agent";

/** `skills/pdf-tools` reads as "skill pdf-tools"; the folder path is the item's identity, the label is for people. */
const ITEM_NOUN: Record<string, string> = { skills: "skill", rules: "rule", agents: "agent", commands: "command", plugins: "plugin", mcp: "MCP server" };
function itemLabel(item: string) {
  if (item === "AGENTS.md") return "instructions";
  const [category, ...rest] = item.split("/");
  const noun = category === undefined ? undefined : ITEM_NOUN[category];
  return noun === undefined || rest.length === 0 ? item : `${noun} ${rest.join("/")}`;
}

/** A refused write names the skill when the path says so (`.../skills/<name>/...`), otherwise the file. */
function blockedLabel(path: string) {
  const skill = /[/\\]skills[/\\]([^/\\]+)/u.exec(path)?.[1];
  return skill !== undefined ? `skill ${skill}` : path.split(/[/\\]/u).pop() ?? path;
}

const INSTALLER_LABEL = { skills: "skills add", mcp: "mcp add", plugin: "plugin install" } as const;

/** A log row has a time; a "Needs review" row is a plugin's current state, so it has none. */
interface Row { key: string; at?: Date; what: string; who: string; where?: string; plugin?: GuiShieldPlugin }

/** One row per thing a person would recognise: an installer that produced two items shows two rows. */
function logRows(shield: GuiShield): Row[] {
  const plugin = (item: string) => item.startsWith("plugins/") ? shield.plugins.find((entry) => entry.id === item.slice("plugins/".length)) : undefined;
  return shield.log.flatMap((entry, index): Row[] => {
    const at = new Date(entry.at);
    if (entry.kind === "blocked") return [{ key: `${index}`, at, what: entry.path !== undefined ? blockedLabel(entry.path) : entry.installer ?? "install", who: harnessName(entry.harness), where: entry.path }];
    if (entry.kind === "installed") return entry.items.map((item) => ({ key: `${index}-${item}`, at, what: itemLabel(item), who: INSTALLER_LABEL[entry.installer], plugin: plugin(item) }));
    return [{ key: `${index}`, at, what: itemLabel(entry.item), who: "found at sync", where: entry.path, plugin: plugin(entry.item) }];
  });
}

const sameDay = (left: Date, right: Date) => left.toDateString() === right.toDateString();
function dayLabel(at: Date) {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (sameDay(at, today)) return "Today";
  if (sameDay(at, yesterday)) return "Yesterday";
  return at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
const time = (at: Date) => at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** A notice that folds open and closed in place, so what is below slides instead of jumping. */
function Fold({ show, reduced, children }: { show: boolean; reduced: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: reduced ? { duration: 0 } : ENTER }} exit={{ height: 0, opacity: 0, transition: reduced ? { duration: 0 } : EXIT }} className="overflow-hidden">
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Outcome({ plugin, onReview }: { plugin: GuiShieldPlugin | undefined; onReview: (plugin: GuiShieldPlugin) => void }) {
  const outcome = plugin === undefined ? null : plugin.excluded ? "Kept off" : plugin.reviewed ? "Approved" : "review";
  return (
    <AnimatePresence mode="wait" initial={false}>
      {outcome === "review" ? (
        <motion.span key="review" exit={{ opacity: 0, transition: EXIT }}>
          <Button size="xs" variant="primary" onClick={() => onReview(plugin!)}>Review</Button>
        </motion.span>
      ) : outcome !== null ? (
        <motion.span key={outcome} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: ENTER }} className="text-sm text-muted-foreground">{outcome}</motion.span>
      ) : null}
    </AnimatePresence>
  );
}

function LogRow({ row, index, reduced, onReview }: { row: Row; index: number; reduced: boolean; onReview: (plugin: GuiShieldPlugin) => void }) {
  return (
    <motion.li layout={reduced ? false : "position"}
      initial={{ opacity: 0, transform: reduced ? "none" : "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)", transition: { ...ENTER, delay: Math.min(index, 8) * 0.03 } }}
      exit={{ opacity: 0, transition: EXIT }}
      className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-baseline gap-3 py-2.5">
      <span className="font-mono text-sm text-faint">{row.at !== undefined && time(row.at)}</span>
      <div className="grid min-w-0 gap-0.5">
        <p className="text-base"><span className="font-medium">{row.what}</span> <span className="text-sm text-muted-foreground">{row.who}</span></p>
        {row.where !== undefined && <Mono className="truncate text-sm text-faint">{row.where}</Mono>}
      </div>
      <Outcome plugin={row.plugin} onReview={onReview} />
    </motion.li>
  );
}

function ReviewDialog({ plugin, busy, onClose, onDecide }: { plugin: GuiShieldPlugin; busy: boolean; onClose: () => void; onDecide: (approve: boolean) => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] gap-5 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Review {plugin.id}</DialogTitle>
          <DialogDescription>A {plugin.harnesses.map(harnessName).join(" and ")} plugin. It runs code on this machine.</DialogDescription>
        </DialogHeader>
        {(plugin.entries.length > 0 || plugin.requires.length > 0) && (
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            {plugin.entries.length > 0 && <><dt className="text-faint">Runs</dt><dd className="grid gap-1">{plugin.entries.map((entry) => <Mono key={entry} className="[overflow-wrap:anywhere]">{entry}</Mono>)}</dd></>}
            {plugin.requires.length > 0 && <><dt className="text-faint">Needs</dt><dd className="grid gap-1">{plugin.requires.map((tool) => <Mono key={tool}>{tool}</Mono>)}</dd></>}
          </dl>
        )}
        <p className="text-sm text-muted-foreground">If these files change, Shield asks again.</p>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onDecide(false)}>Keep it off</Button>
          <Button variant="primary" disabled={busy} onClick={() => onDecide(true)}>{busy ? "Saving…" : "Approve"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShieldView() {
  const ws = useWorkspace();
  const reduced = usePrefersReducedMotion();
  const [filter, setFilter] = useState<"all" | "review">("all");
  const [reviewing, setReviewing] = useState<GuiShieldPlugin | null>(null);
  const shield = ws.shield.data;
  const busy = ws.shield.action.loading;
  if (shield === null) return <PageHeader crumbs={["Shield"]} />;
  const { status } = shield;
  const pending = shield.plugins.filter((plugin) => !plugin.reviewed && !plugin.excluded);
  const rows: Row[] = filter === "all" ? logRows(shield)
    : pending.map((plugin) => ({ key: plugin.id, what: `plugin ${plugin.id}`, who: plugin.harnesses.map(harnessName).join(", "), plugin }));
  const dayOf = (row: Row) => row.at === undefined ? "" : dayLabel(row.at);
  const days = [...new Set(rows.map(dayOf))];
  const listed = ws.harnesses.filter((harness) => harness.listed && !harness.excluded);
  const hooked = (id: HarnessId) => SURFACE_SUPPORT[id].includes("hooks");
  const covered = listed.filter((harness) => status.enabled && status.projected && hooked(harness.id)).length;
  const decide = async (plugin: GuiShieldPlugin, approve: boolean) => {
    const done = await ws.shield.run(approve ? { action: "review", id: plugin.id, digest: plugin.digest } : { action: "exclude", id: plugin.id });
    if (done) setReviewing(null);
  };

  return (
    <>
      <PageHeader crumbs={["Shield"]} />
      <Body>
        <div className="grid gap-8 px-[18px] py-5 @4xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="grid min-w-0 content-start gap-5">
            <div className="grid gap-3" data-tour="shield-switch">
              <label className="flex cursor-pointer items-center justify-between gap-4">
                <span className="grid gap-0.5">
                  <span className="text-base font-medium">Shield</span>
                  <span className="text-sm text-muted-foreground">{status.enabled ? <>Installs go to <Mono className="text-foreground">{status.destination}</Mono> instead of harness folders.</> : "Off. Installs can land in harness folders."}</span>
                </span>
                <Switch checked={status.enabled} disabled={busy} aria-label="Shield" onCheckedChange={(on) => void ws.shield.run(on ? { action: "enable", hard: false } : { action: "disable" })} />
              </label>
              <Fold show={status.enabled !== status.projected} reduced={reduced}>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warn/10 px-3 py-2 text-sm">
                  {ws.role === "follower"
                    ? <><span>Takes effect after the next sync and a harness restart.</span><Button size="xs" variant="outline" onClick={() => ws.setView("sync")}>Open Sync</Button></>
                    : <span><CliText>{"Takes effect after `canonfig sync --apply` and a harness restart."}</CliText></span>}
                </div>
              </Fold>
              <Fold show={ws.shield.action.error !== null} reduced={reduced}>
                <p role="alert" className="flex items-start gap-2 rounded-lg bg-bad/10 px-3 py-2 text-sm"><StatusMark kind="bad" className="mt-0.5" /><CliText>{ws.shield.action.error?.message ?? ""}</CliText></p>
              </Fold>
            </div>

            <LayoutGroup id="shield-filter">
              <div role="radiogroup" aria-label="Show" className="flex w-fit gap-1 rounded-lg bg-raised/50 p-0.5">
                {([["all", "All"], ["review", `Needs review${pending.length > 0 ? ` · ${pending.length}` : ""}`]] as const).map(([key, label]) => (
                  <button key={key} type="button" role="radio" aria-checked={filter === key} onClick={() => setFilter(key)}
                    className={cn("relative h-7 rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", filter === key ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {filter === key && <motion.span layoutId="shield-filter-pill" transition={reduced ? { duration: 0 } : ENTER} className="absolute inset-0 rounded-md bg-raised" />}
                    <span className="relative">{label}</span>
                  </button>
                ))}
              </div>
            </LayoutGroup>

            {rows.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{filter === "all" ? "Nothing caught in the last 30 days." : "Nothing to review."}</p>}
            <div className="grid gap-4" data-tour="shield-log">
              <AnimatePresence initial={false} mode="popLayout">
                {days.map((day) => (
                  <motion.section key={`${filter}-${day}`} layout={reduced ? false : "position"} exit={{ opacity: 0, transition: EXIT }} aria-label={day || "Needs review"}>
                    {filter === "all" && <h3 className="pb-1 text-sm text-faint">{day}</h3>}
                    <ul className="grid divide-y divide-border/70">
                      <AnimatePresence initial={false} mode="popLayout">
                        {rows.filter((row) => dayOf(row) === day).map((row, index) => (
                          <LogRow key={`${filter}-${row.key}`} row={row} index={index} reduced={reduced} onReview={setReviewing} />
                        ))}
                      </AnimatePresence>
                    </ul>
                  </motion.section>
                ))}
              </AnimatePresence>
            </div>
          </div>

          <aside className="grid content-start gap-6">
            <section aria-labelledby="shield-harnesses" className="grid gap-2" data-tour="shield-harnesses">
              <div className="flex items-baseline justify-between"><h2 id="shield-harnesses" className="text-sm font-semibold">Harnesses</h2><span className="text-sm text-muted-foreground tabular-nums">{covered} of {listed.length}</span></div>
              <ul className="grid">
                {listed.map((harness) => {
                  const kind = !status.enabled ? "off" : !hooked(harness.id) ? "off" : status.projected ? "ok" : "warn";
                  const note = !status.enabled ? null : !hooked(harness.id) ? "No hook support. Sync moves strays." : status.projected ? null : "Protected after the next sync.";
                  return (
                    <li key={harness.id} className="grid py-1.5">
                      <span className="flex items-center gap-2 text-base">
                        <AnimatePresence mode="wait" initial={false}>
                          <motion.span key={kind} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: ENTER }} exit={{ opacity: 0, transition: EXIT }} className="flex"><StatusMark kind={kind} /></motion.span>
                        </AnimatePresence>
                        {harness.name}
                      </span>
                      <Fold show={note !== null} reduced={reduced}><p className="pt-0.5 pl-[22px] text-sm text-muted-foreground">{note}</p></Fold>
                    </li>
                  );
                })}
              </ul>
            </section>
            <label className="flex cursor-pointer items-center justify-between gap-4 border-t border-border pt-4">
              <span className="grid gap-0.5">
                <span className="text-base font-medium">Hard mode <span className="text-sm font-normal text-faint">Linux</span></span>
                <span className="text-sm text-muted-foreground">Read-only harness folders for <Mono className="text-foreground">canonfig shield run</Mono>.</span>
              </span>
              <Switch checked={status.hard} disabled={!status.enabled || busy} aria-label="Hard mode" onCheckedChange={(hard) => void ws.shield.run({ action: "enable", hard })} />
            </label>
          </aside>
        </div>
        {reviewing && <ReviewDialog plugin={reviewing} busy={busy} onClose={() => setReviewing(null)} onDecide={(approve) => void decide(reviewing, approve)} />}
      </Body>
    </>
  );
}
