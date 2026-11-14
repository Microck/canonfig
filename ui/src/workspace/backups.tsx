// The Backups page ("History"): backups on the left, the selected backup's copies on the right, settings in one side
// sheet. "Before Canonfig" is a fixed last entry for the takeover snapshots Canonfig keeps on its own. Live data
// comes from /api/backup (src/gui/routes/backup.ts) and /api/backups; the demo uses simulated-backups.ts.
//
// Copy shows what a person needs to act: two buttons per backup, one Restore per copy (shown on hover or focus,
// always on the newest copy and on touch screens), and notices only for a failure, a pause or missing consent.
//
// Motion (an occasional page, so standard UI motion on --ease-snap, 120-200ms): the selection highlight slides
// between backups, the detail pane crossfades, new copies enter at the top while older rows slide down, and
// notices fold open and closed. Reduced motion keeps the fades and drops all movement.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CaretDown } from "@/components/icons";
import { HARNESS_NAMES, type HarnessId, type Snapshot as TakeoverSnapshot } from "@/shared/metadata";
import { Mono, StatusMark } from "@/shared/shared";
import { usePrefersReducedMotion } from "@/lib/dither";
import { cn, SNAP } from "@/lib/utils";
import { defaultBackupPolicy, type BackupCompression, type BackupDestination, type BackupOutcome, type BackupPolicy, type BackupSnapshot } from "../../../src/backup/backup.types";
import { TARGET_IDS } from "../../../src/projection/model";
import { ErrorNotice } from "../live/session";
import { Body, PageHeader } from "./kit";
import { WEEK, type Day } from "./schedule";
import { ConfirmDialog } from "./settings";
import { useWorkspace } from "./store";

const ENTER = { duration: 0.2, ease: SNAP };
const EXIT = { duration: 0.12, ease: [0.23, 1, 0.32, 1] as const };
/** Copies shown before "Show all": a week of nightlies fits without scrolling. */
const FIRST = 7;
/** Selection key for the fixed "Before Canonfig" entry; backup names can't contain spaces, so it never collides. */
const BEFORE = "before canonfig";
const namePattern = "[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,63}";

/** Decimal units, as backup sizes are usually quoted (49.8 MB). */
function bytes(count: number) {
  for (const [unit, size] of [["GB", 1e9], ["MB", 1e6], ["KB", 1e3]] as const) if (count >= size) return `${(count / size).toFixed(1)} ${unit}`;
  return `${count} B`;
}

/** "today 03:00", "yesterday 09:00", "Sun 04:00" this week, then "Sat 8 Nov 03:00". */
function whenAt(iso: string, sentence = false) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getMonth()];
  const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? weekday : `${weekday} ${at.getDate()} ${month}`;
  return `${sentence && days < 2 ? day.toLowerCase() : day} ${time}`;
}

function whenLabel(schedule: BackupPolicy["schedule"]) {
  if (schedule === undefined) return "Only when you run it";
  if (schedule.kind === "daily") return `Every day at ${schedule.localTime}`;
  if (schedule.kind === "custom") return "On a custom schedule";
  return `Every ${("weekdays" in schedule ? schedule.weekdays : [schedule.weekday]).join(", ")} at ${schedule.localTime}`;
}

function whatLabel(policy: BackupPolicy) {
  const parts = [
    policy.folder && "Canonfig folder",
    policy.harnesses.mode === "managed" && "harness settings",
    policy.harnesses.mode === "full" && "entire harness folders",
    policy.sourceIdentity && "Source identity",
    policy.sharedSecrets && "shared secrets",
  ].filter((part): part is string => typeof part === "string");
  const text = parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const destinationLabel = (destination: BackupDestination) => destination.kind === "local" ? destination.path : destination.remote;
/** Sign-in data or keys: these need encryption and this machine's consent before Canonfig captures them. */
const sensitive = (policy: BackupPolicy) => policy.includeCredentials || policy.sourceIdentity || policy.sharedSecrets;
const needsPassword = (policy: BackupPolicy) => policy.harnesses.mode === "full" || sensitive(policy);

function LastRun({ run, paused, running }: { run: BackupOutcome | undefined; paused: boolean; running: boolean }) {
  const line = "flex items-center gap-1.5 text-sm";
  if (running) return <span className={cn(line, "text-muted-foreground")}><StatusMark kind="act" />Backing up…</span>;
  if (paused) return <span className={cn(line, "text-muted-foreground")}><StatusMark kind="off" />Paused</span>;
  if (run === undefined) return <span className={cn(line, "text-muted-foreground")}><StatusMark kind="off" />Never run</span>;
  return run.ok
    ? <span className={cn(line, "text-muted-foreground")}><StatusMark kind="ok" />Backed up {whenAt(run.at, true)}{run.bytes !== undefined && <> · {bytes(run.bytes)}</>}</span>
    : <span className={cn(line, "text-bad")}><StatusMark kind="bad" />Failed {whenAt(run.at, true)}</span>;
}

/** A notice that folds open and closed in place, so the copies below slide instead of jumping. */
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="grid gap-3 border-t border-border pt-4"><h3 className="text-sm font-semibold">{title}</h3>{children}</section>;
}

/** One choice in a list of radio cards: the whole row is the label, so there is no dead zone. */
function Option({ name, checked, onChange, title, children }: { name: string; checked: boolean; onChange: () => void; title: ReactNode; children?: ReactNode }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-150", checked ? "border-foreground/40 bg-raised" : "border-border hover:border-border-strong")}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1 size-4 accent-[var(--foreground)]" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-base font-medium text-foreground">{title}</span>
        {children && <span className="text-sm text-pretty text-muted-foreground">{children}</span>}
      </span>
    </label>
  );
}

/** Every day, every week on one day, or only when run. A custom schedule saved elsewhere stays until replaced. */
function WhenFields({ value, onChange, id }: { value: BackupPolicy["schedule"]; onChange: (value: BackupPolicy["schedule"]) => void; id: string }) {
  const kind = value === undefined ? "manual" : value.kind;
  const time = value !== undefined && "localTime" in value ? value.localTime : "03:00";
  const timezone = value?.timezone;
  const day: Day = value?.kind === "weekly" ? ("weekdays" in value ? value.weekdays[0] : value.weekday) ?? "Sun" : "Sun";
  const set = (next: string, nextTime = time, nextDay = day): void => onChange(next === "manual" ? undefined
    : next === "daily" ? { kind: "daily", localTime: nextTime, timezone } : { kind: "weekly", weekdays: [nextDay], localTime: nextTime, timezone });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={kind === "custom" ? "custom" : kind} onValueChange={(next) => set(next)}>
        <SelectTrigger id={id} aria-label="How often" className="w-[180px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="daily">Every day</SelectItem>
          <SelectItem value="weekly">Every week</SelectItem>
          <SelectItem value="manual">Only when I run it</SelectItem>
          {kind === "custom" && <SelectItem value="custom">Custom</SelectItem>}
        </SelectContent>
      </Select>
      {kind === "weekly" && (
        <Select value={day} onValueChange={(next) => set("weekly", time, next as Day)}>
          <SelectTrigger aria-label="Day" className="w-[96px]"><SelectValue /></SelectTrigger>
          <SelectContent>{WEEK.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
        </Select>
      )}
      {(kind === "daily" || kind === "weekly") && <>
        <span className="text-sm text-muted-foreground">at</span>
        <Input type="time" aria-label="Time" value={time} onChange={(event) => set(kind, event.target.value)} className="w-[120px] text-base md:text-sm" />
      </>}
      {value?.kind === "custom" && <Mono className="text-sm text-muted-foreground">{value.expression}</Mono>}
    </div>
  );
}

const COMPRESSION: Record<BackupCompression, { label: string; detail: string }> = {
  fast: { label: "Fast", detail: "Zstandard 1." },
  balanced: { label: "Balanced", detail: "Zstandard 6." },
  small: { label: "Small", detail: "xz. Needs xz on every machine that backs up or restores it." },
  max: { label: "Smallest", detail: "The smaller of xz and ZPAQ. Needs xz and zpaq-stream, and can take minutes." },
};

function Settings({ name: initialName, initial, onClose }: { name: string; initial: BackupPolicy; onClose: () => void }) {
  const ws = useWorkspace();
  const backup = ws.backup;
  const status = backup.status;
  const isNew = initialName === "";
  const [name, setName] = useState(initialName);
  const [policy, setPolicy] = useState(initial);
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(!status?.local.disabled.includes(initialName));
  const set = (patch: Partial<BackupPolicy>) => setPolicy((current) => ({ ...current, ...patch }));
  const required = needsPassword(policy);
  const [encrypt, setEncrypt] = useState(initial.passwordReference !== undefined);
  const encrypted = encrypt || required;
  const savedAlias = policy.passwordReference !== undefined && status?.local.passwords[policy.passwordReference] !== undefined ? policy.passwordReference : undefined;
  const destination = policy.destination;
  const listed = ws.harnesses.filter((harness) => harness.listed).map((harness) => harness.id);
  const targetChoices = (listed.length > 0 ? listed : TARGET_IDS.filter((id): id is HarnessId => id in HARNESS_NAMES)) as HarnessId[];
  const declaredOnly = !isNew && status !== null && !(initialName in status.local.policies);
  const problem = !name ? "Enter a name." : destinationLabel(destination).trim() === "" ? "Enter where to keep it."
    : !policy.folder && policy.harnesses.mode === "none" && !policy.sourceIdentity && !policy.sharedSecrets ? "Choose what to back up."
    : policy.harnesses.mode !== "none" && policy.harnesses.targets.length === 0 ? "Choose at least one harness."
    : encrypted && savedAlias === undefined && password.length < 8 ? "Enter a password of at least 8 characters." : null;
  const save = async () => {
    // A new password is stored on this machine first; the policy then names it. Aliases are never replaced, because
    // existing copies stay encrypted with the old one.
    const alias = !encrypted ? undefined : savedAlias ?? (status?.local.passwords[name] === undefined ? name : `${name}-${Date.now()}`);
    if (encrypted && savedAlias === undefined && !(await backup.run({ action: "password", name: alias!, password }))) return;
    const next = { ...policy, passwordReference: alias, include: policy.include.filter((glob) => glob.trim()), exclude: policy.exclude.filter((glob) => glob.trim()) };
    if (!(await backup.run({ action: "configure", name, policy: next, allowCredentials: sensitive(next) }))) return;
    if (!isNew && enabled === status?.local.disabled.includes(initialName) && !(await backup.run({ action: enabled ? "enable" : "disable", name }))) return;
    toast.success(isNew ? `Created ${name}` : `Saved ${name}`);
    onClose();
  };
  return (
    <Sheet open onOpenChange={(open) => !open && !backup.action.loading && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-[520px]">
        <SheetHeader><SheetTitle>{isNew ? "New backup" : initialName}</SheetTitle></SheetHeader>
        <form id="backup-settings" className="grid flex-1 content-start gap-5 overflow-y-auto px-4 pb-6" onSubmit={(event) => { event.preventDefault(); if (problem === null) void save(); }}>
          {backup.action.error && <ErrorNotice error={backup.action.error} />}
          {isNew ? (
            <div className="grid gap-1.5">
              <Label htmlFor="backup-name" className="text-sm font-medium text-muted-foreground">Name</Label>
              <Input id="backup-name" value={name} required pattern={namePattern} onChange={(event) => setName(event.target.value.replace(/[^a-zA-Z0-9_-]/g, "-"))} placeholder="nightly" className="text-base md:text-sm" />
            </div>
          ) : (
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
              <span className="grid gap-0.5"><span className="text-base font-medium">Run on schedule</span>
                {declaredOnly && <span className="text-sm text-muted-foreground">Your Source set this backup. Changes here apply to this machine only.</span>}</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </label>
          )}
          <Section title="What">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5">
              <Checkbox checked={policy.folder} onCheckedChange={(value) => set({ folder: value === true })} className="mt-0.5" />
              <span className="grid gap-0.5"><span className="text-base font-medium">Your Canonfig folder</span><span className="text-sm text-muted-foreground">Instructions, skills, rules, MCP servers and settings.</span></span>
            </label>
            <div className="grid gap-2">
              <span className="text-sm font-medium text-muted-foreground">Harness files</span>
              <Option name="harness-mode" checked={policy.harnesses.mode === "none"} onChange={() => set({ harnesses: { ...policy.harnesses, mode: "none" } })} title="None" />
              <Option name="harness-mode" checked={policy.harnesses.mode === "managed"} onChange={() => set({ harnesses: { mode: "managed", targets: policy.harnesses.targets.length ? policy.harnesses.targets : targetChoices.slice(0, 2) } })} title="Settings Canonfig manages">Only the files Canonfig writes into each harness. No sign-in data.</Option>
              <Option name="harness-mode" checked={policy.harnesses.mode === "full"} onChange={() => set({ harnesses: { mode: "full", targets: policy.harnesses.targets.length ? policy.harnesses.targets : targetChoices.slice(0, 2) } })} title="Entire harness folders">Everything, including sessions and history. Needs a password.</Option>
            </div>
            {policy.harnesses.mode !== "none" && (
              <fieldset className="flex flex-wrap gap-2">
                <legend className="sr-only">Harnesses</legend>
                {targetChoices.map((id) => {
                  const on = policy.harnesses.targets.includes(id);
                  return (
                    <label key={id} className={cn("flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-sm", on ? "border-foreground/40 bg-raised" : "border-border")}>
                      <Checkbox checked={on} onCheckedChange={(value) => set({ harnesses: { ...policy.harnesses, targets: value === true ? [...policy.harnesses.targets, id] : policy.harnesses.targets.filter((target) => target !== id) } })} />
                      {HARNESS_NAMES[id]}
                    </label>
                  );
                })}
              </fieldset>
            )}
            {policy.harnesses.mode === "full" && (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5">
                <Checkbox checked={policy.includeCredentials} onCheckedChange={(value) => set({ includeCredentials: value === true })} className="mt-0.5" />
                <span className="grid gap-0.5"><span className="text-base font-medium">Include sign-in files</span><span className="text-sm text-muted-foreground">Restoring them signs the new machine in as this one.</span></span>
              </label>
            )}
            {ws.role === "source" && (
              <div className="grid gap-2">
                <span className="text-sm font-medium text-muted-foreground">To rebuild this Source if it dies</span>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5">
                  <Checkbox checked={policy.sourceIdentity} onCheckedChange={(value) => set({ sourceIdentity: value === true })} className="mt-0.5" />
                  <span className="grid gap-0.5"><span className="text-base font-medium">Source identity</span><span className="text-sm text-muted-foreground">Signing key, certificate and the list of your machines, so followers keep trusting a rebuilt Source.</span></span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5">
                  <Checkbox checked={policy.sharedSecrets} onCheckedChange={(value) => set({ sharedSecrets: value === true })} className="mt-0.5" />
                  <span className="grid gap-0.5"><span className="text-base font-medium">Shared secrets</span><span className="text-sm text-muted-foreground">Tokens you share with followers.</span></span>
                </label>
              </div>
            )}
          </Section>
          <Section title="Where">
            <div className="grid gap-2">
              <Option name="destination" checked={destination.kind === "local"} onChange={() => set({ destination: { kind: "local", path: "" } })} title="A folder">On this machine or a mounted drive.</Option>
              <Option name="destination" checked={destination.kind === "git"} onChange={() => set({ destination: { kind: "git", remote: "" } })} title="A Git repository">GitHub, GitLab, Forgejo or Gitea. Uses your existing Git sign-in.</Option>
              <Option name="destination" checked={destination.kind === "rclone"} onChange={() => set({ destination: { kind: "rclone", remote: "" } })} title="Cloud storage">Google Drive, S3, Backblaze, WebDAV or SFTP, through rclone.</Option>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="backup-destination" className="text-sm font-medium text-muted-foreground">{destination.kind === "local" ? "Folder" : destination.kind === "git" ? "Repository URL" : "rclone remote and path"}</Label>
              <Input id="backup-destination" value={destinationLabel(destination)} spellCheck={false} autoComplete="off" className="font-mono text-base md:text-sm"
                placeholder={destination.kind === "local" ? "/mnt/backup/canonfig" : destination.kind === "git" ? "git@github.com:you/canonfig-backup.git" : "gdrive:Backups/canonfig"}
                onChange={(event) => set({ destination: destination.kind === "local" ? { kind: "local", path: event.target.value } : { kind: destination.kind, remote: event.target.value } })} />
              {destination.kind === "rclone" && <p className="text-sm text-faint">Set up the remote once with rclone config on this machine.</p>}
            </div>
          </Section>
          <Section title="When"><WhenFields id="backup-when" value={policy.schedule} onChange={(schedule) => set({ schedule })} /></Section>
          <Section title="Password">
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
              <span className="grid gap-0.5"><span className="text-base font-medium">Encrypt with a password</span>
                {required && <span className="text-sm text-muted-foreground">Required: this backup can contain sign-in tokens or keys.</span>}</span>
              <Switch checked={encrypted} disabled={required || savedAlias !== undefined} onCheckedChange={setEncrypt} />
            </label>
            {encrypted && savedAlias === undefined && (
              <div className="grid gap-1.5">
                <Label htmlFor="backup-password" className="text-sm font-medium text-muted-foreground">Password</Label>
                <Input id="backup-password" type="password" autoComplete="new-password" value={password} maxLength={4096} onChange={(event) => setPassword(event.target.value)} className="text-base md:text-sm" />
                <p className="flex items-start gap-1.5 text-sm text-warn"><StatusMark kind="warn" className="mt-0.5" />Canonfig can't recover this password. Without it, these backups can't be restored.</p>
              </div>
            )}
          </Section>
          <Collapsible className="grid gap-5 border-t border-border pt-4">
            <CollapsibleTrigger className="group flex items-center gap-1.5 justify-self-start text-sm font-semibold outline-none focus-visible:underline">
              More options<CaretDown className="size-3.5 text-faint transition-transform duration-150 ease-snap group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-5 overflow-hidden">
              <Section title="Compression">
                <div className="grid gap-2">{(Object.keys(COMPRESSION) as BackupCompression[]).map((key) => (
                  <Option key={key} name="compression" checked={policy.compression === key} onChange={() => set({ compression: key })}
                    title={<>{COMPRESSION[key].label}{key === "balanced" && <span className="ml-2 text-sm font-normal text-faint">Recommended</span>}</>}>{COMPRESSION[key].detail}</Option>
                ))}</div>
              </Section>
              <Section title="Copies to keep">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  The last
                  <Input type="number" min={1} aria-label="Last copies" value={policy.retention.last} onChange={(event) => set({ retention: { ...policy.retention, last: event.target.valueAsNumber || 1 } })} className="w-16 text-base md:text-sm" />
                  , one a day for
                  <Input type="number" min={0} aria-label="Daily copies" value={policy.retention.daily} onChange={(event) => set({ retention: { ...policy.retention, daily: event.target.valueAsNumber || 0 } })} className="w-16 text-base md:text-sm" />
                  days, one a week for
                  <Input type="number" min={0} aria-label="Weekly copies" value={policy.retention.weekly} onChange={(event) => set({ retention: { ...policy.retention, weekly: event.target.valueAsNumber || 0 } })} className="w-16 text-base md:text-sm" />
                  weeks
                </div>
              </Section>
              <Section title="Restore test">
                <p className="text-sm text-muted-foreground">Unpacks a copy into a throwaway folder and checks every file.</p>
                <WhenFields id="backup-drill" value={policy.drillSchedule} onChange={(drillSchedule) => set({ drillSchedule })} />
              </Section>
              <Section title="Filters and limits">
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["include", "exclude"] as const).map((key) => (
                    <div key={key} className="grid gap-1.5">
                      <Label htmlFor={`backup-${key}`} className="text-sm font-medium text-muted-foreground">{key === "include" ? "Include" : "Leave out"} (one pattern per line)</Label>
                      <Textarea id={`backup-${key}`} spellCheck={false} value={policy[key].join("\n")} onChange={(event) => set({ [key]: event.target.value.split("\n") })} className="font-mono text-sm" />
                    </div>
                  ))}
                  <div className="grid gap-1.5">
                    <Label htmlFor="backup-max-gb" className="text-sm font-medium text-muted-foreground">Largest backup (GB)</Label>
                    <Input id="backup-max-gb" type="number" min={0.001} step="any" value={policy.maximumBytes / 1e9} onChange={(event) => set({ maximumBytes: Math.max(1, Math.round((event.target.valueAsNumber || 0) * 1e9)) })} className="text-base md:text-sm" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="backup-max-files" className="text-sm font-medium text-muted-foreground">Most files</Label>
                    <Input id="backup-max-files" type="number" min={1} step={1} value={policy.maximumFiles} onChange={(event) => set({ maximumFiles: Math.max(1, event.target.valueAsNumber || 1) })} className="text-base md:text-sm" />
                  </div>
                </div>
              </Section>
            </CollapsibleContent>
          </Collapsible>
        </form>
        <SheetFooter className="flex-row items-center justify-end gap-2 border-t border-border">
          {problem !== null && name !== "" && <span className="mr-auto text-sm text-muted-foreground">{problem}</span>}
          <Button type="button" variant="ghost" disabled={backup.action.loading} onClick={onClose}>Cancel</Button>
          <Button type="submit" form="backup-settings" variant="primary" disabled={problem !== null || backup.action.loading}>{backup.action.loading ? "Saving…" : isNew ? "Create backup" : "Save"}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function RestoreDialog({ name, policy, copies, initial, owner, onClose }: { name: string; policy: BackupPolicy; copies: ReadonlyArray<BackupSnapshot>; initial: string; owner: string | undefined; onClose: () => void }) {
  const ws = useWorkspace();
  const backup = ws.backup;
  const [id, setId] = useState(initial);
  const [target, setTarget] = useState<"test" | "folder" | "here">("test");
  const [folder, setFolder] = useState("");
  const [recover, setRecover] = useState(false);
  const busy = backup.action.loading;
  const selection = { name, snapshot: id, owner };
  const submit = async () => {
    const done = await backup.run(target === "test" ? { action: "drill", ...selection }
      : target === "folder" ? { action: "restore", ...selection, target: { kind: "home", path: folder.trim(), recoverCredentials: recover } }
      : { action: "restore", ...selection, target: { kind: "apply", replace: false, dryRun: false } });
    if (!done) return;
    toast.success(target === "test" ? "Restore test passed: every file matched." : target === "folder" ? `Restored into ${folder.trim()}.` : "Your Canonfig folder was restored. Publish to send it to your followers.");
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto sm:max-w-[520px]">
        <DialogHeader><DialogTitle>Restore from {name}</DialogTitle></DialogHeader>
        <form id="backup-restore" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (target !== "folder" || folder.trim()) void submit(); }}>
          {backup.action.error && <ErrorNotice error={backup.action.error} />}
          <div className="grid gap-1.5">
            <Label htmlFor="restore-copy" className="text-sm font-medium text-muted-foreground">Copy</Label>
            <Select value={id} onValueChange={setId}>
              <SelectTrigger id="restore-copy" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{copies.map((copy, index) => <SelectItem key={copy.id} value={copy.id}>{whenAt(copy.createdAt)}{index === 0 ? " (latest)" : ""} · {bytes(copy.bytes)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium text-muted-foreground">What to do with it</legend>
            <Option name="restore-target" checked={target === "test"} onChange={() => setTarget("test")} title="Test it">Checks every file in a throwaway folder. Nothing on this machine changes.</Option>
            <Option name="restore-target" checked={target === "folder"} onChange={() => setTarget("folder")} title="Restore into a new folder">The folder must not exist yet.</Option>
            {ws.role === "source" && policy.folder && <Option name="restore-target" checked={target === "here"} onChange={() => setTarget("here")} title="Put my Canonfig folder back">Restores ~/.canonfig here through the usual import checks. Followers get it after you publish.</Option>}
          </fieldset>
          {target === "folder" && <>
            <div className="grid gap-1.5">
              <Label htmlFor="restore-folder" className="text-sm font-medium text-muted-foreground">New folder</Label>
              <Input id="restore-folder" value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="/home/maria-new" spellCheck={false} className="font-mono text-base md:text-sm" />
            </div>
            {(policy.sourceIdentity || policy.sharedSecrets) && (
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox checked={recover} onCheckedChange={(value) => setRecover(value === true)} className="mt-0.5" />
                <span>Also put the Source identity and shared secrets into this machine's credential store.</span>
              </label>
            )}
          </>}
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" form="backup-restore" variant="primary" disabled={busy || (target === "folder" && !folder.trim())}>
            {busy ? "Checking…" : target === "test" ? "Test restore" : target === "folder" ? "Restore" : "Restore my folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Takeover snapshot ids are folder names like 2026-10-24T09-00-07-918Z. */
const snapshotDate = (id: string) => whenAt(id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"));

/**
 * The takeover snapshots (~/.canonfig/.backups/) as one more entry. Canonfig takes them itself the first time it
 * writes to a harness, so there is nothing to set up: restoring one puts that harness back and stops syncing it,
 * which is how a person undoes Canonfig for a harness.
 */
function BeforeCanonfig({ reduced }: { reduced: boolean }) {
  const ws = useWorkspace();
  const [restoring, setRestoring] = useState<TakeoverSnapshot | null>(null);
  // Newest first, like every other list of copies; the original stays last.
  const shown = [...ws.snapshots].reverse();
  const names = (snapshot: TakeoverSnapshot) => snapshot.harnesses.map((id) => HARNESS_NAMES[id]).join(", ");
  return (
    <>
      <div className="grid min-w-0 gap-1">
        <h2 className="text-lg font-semibold">Before Canonfig</h2>
        <p className="text-sm text-muted-foreground">Harness files as they were before Canonfig wrote to them.</p>
      </div>
      {!ws.backups && <p className="flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm"><StatusMark kind="warn" />Off on this machine: <Mono>local/local.jsonc</Mono> sets <Mono>"backups": false</Mono>.</p>}
      {/* Restore runs as a sync run, so Canonfig refuses it while an earlier run still needs recovering. */}
      {ws.interrupted && <p className="flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm"><StatusMark kind="warn" />Recover or abandon the interrupted sync before putting anything back.</p>}
      {shown.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">Canonfig saves one the first time it writes to a harness here.</p> : (
        <ul aria-label="Before Canonfig" className="grid">
          {shown.map((snapshot) => {
            const done = snapshot.harnesses.length > 0 && snapshot.harnesses.every((id) => ws.excluded.includes(id));
            return (
              <motion.li key={snapshot.id} layout={reduced ? false : "position"} className="flex min-h-11 items-center gap-3 border-t border-border/70 text-sm first:border-t-0">
                <span className="flex-1">{snapshotDate(snapshot.id)}{snapshot.first && <span className="ml-2 text-faint">original</span>}</span>
                {snapshot.harnesses.length > 0 && <span className="truncate text-muted-foreground" title={names(snapshot)}>{names(snapshot)}</span>}
                <AnimatePresence mode="wait" initial={false}>
                  {done
                    ? <motion.span key="done" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: ENTER }} className="text-muted-foreground">Restored</motion.span>
                    : <motion.span key="restore" exit={{ opacity: 0, transition: EXIT }}><Button size="xs" variant="outline" disabled={ws.interrupted || ws.followerLive?.action.loading} onClick={() => setRestoring(snapshot)}>Restore…</Button></motion.span>}
                </AnimatePresence>
              </motion.li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog open={restoring !== null} onOpenChange={(open) => !open && setRestoring(null)}
        title={restoring ? `Put ${restoring.harnesses.length > 0 ? names(restoring) : "these harnesses"} back?` : ""}
        body={restoring && <>Restores the files from {snapshotDate(restoring.id)} and stops syncing {restoring.harnesses.length === 1 ? "this harness" : "these harnesses"} here. Files you changed since Canonfig last wrote them stay as they are.</>}
        confirm="Put back" onConfirm={() => restoring && ws.restore(restoring.id)} />
    </>
  );
}

export function BackupsView() {
  const ws = useWorkspace();
  const backup = ws.backup;
  const status = backup.status;
  const reduced = usePrefersReducedMotion();
  const names = status === null ? [] : Object.keys(status.policies);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; policy: BackupPolicy } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const current = selected === BEFORE ? BEFORE : selected !== null && names.includes(selected) ? selected : names[0] ?? BEFORE;
  const policy = current === BEFORE || status === null ? undefined : status.policies[current];
  const listing = backup.listing?.name === current && backup.listing.owner === undefined ? backup.listing.value : null;
  const copies = listing?.snapshots ?? [];
  const shown = showAll ? copies : copies.slice(0, FIRST);
  const select = (name: string) => { setSelected(name); setShowAll(false); };

  // The copies live at the destination, so the selected backup lists them once when it opens and again after a run
  // clears the list. The ref keeps a failed listing from retrying in a loop.
  const listed = useRef<string | null>(null);
  const listKey = policy === undefined || listing !== null ? null : current;
  useEffect(() => {
    if (listKey === null || listed.current === listKey || backup.action.loading) return;
    listed.current = listKey;
    void backup.run({ action: "list", name: listKey });
  }, [listKey, backup]);

  if (status === null) return <PageHeader crumbs={["Backups"]} />;
  const run = status.runs[current]?.run;
  const drill = status.runs[current]?.drill;
  const paused = status.local.disabled.includes(current);
  const consentMissing = policy !== undefined && sensitive(policy) && !status.local.allowCredentials.includes(current);
  const backUp = async () => {
    setRunning(current);
    const done = await backup.run({ action: "run", name: current });
    setRunning(null);
    listed.current = null;
    if (done) toast.success(`Backed up ${current}`);
  };
  const testRestore = async () => { if (await backup.run({ action: "drill", name: current })) toast.success("Restore test passed: every file matched."); };

  return (
    <>
      <PageHeader crumbs={["Backups"]} />
      <Body>
        <section aria-label="Backups" className="grid border-b border-border @3xl:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Backups" data-tour="backups-list" className="grid content-start gap-1 border-border p-3 @3xl:border-r">
            <div className="flex items-center justify-between px-2 pb-2"><h2 className="text-sm font-semibold">Backups</h2>
              <Button size="xs" variant="outline" onClick={() => setEditing({ name: "", policy: defaultBackupPolicy({ kind: "local", path: "" }) })}>New</Button></div>
            <LayoutGroup id="backups-nav">
              {names.map((name) => (
                <button key={name} type="button" onClick={() => select(name)} aria-current={name === current ? "true" : undefined}
                  className={cn("relative grid gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", name !== current && "hover:bg-raised/50")}>
                  {name === current && <motion.span layoutId="backups-nav-pill" transition={reduced ? { duration: 0 } : ENTER} className="absolute inset-0 rounded-lg bg-raised" />}
                  <span className="relative truncate text-base font-medium" title={name}>{name}</span>
                  <span className="relative"><LastRun run={status.runs[name]?.run} paused={status.local.disabled.includes(name)} running={running === name} /></span>
                </button>
              ))}
              {/* Fixed last entry: takeover snapshots Canonfig keeps on its own, set apart from backups you created. */}
              <button type="button" data-tour="backups-before" onClick={() => select(BEFORE)} aria-current={current === BEFORE ? "true" : undefined}
                className={cn("relative mt-2 grid gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none before:absolute before:inset-x-2.5 before:-top-1.5 before:h-px before:bg-border focus-visible:ring-2 focus-visible:ring-ring", current !== BEFORE && "hover:bg-raised/50")}>
                {current === BEFORE && <motion.span layoutId="backups-nav-pill" transition={reduced ? { duration: 0 } : ENTER} className="absolute inset-0 rounded-lg bg-raised" />}
                <span className="relative text-base font-medium">Before Canonfig</span>
                <span className="relative text-sm text-muted-foreground">{ws.snapshots.length === 0 ? "Original harness files" : `${ws.snapshots.length} saved`}</span>
              </button>
            </LayoutGroup>
          </nav>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={current} initial={{ opacity: 0, transform: reduced ? "none" : "translateY(4px)" }} animate={{ opacity: 1, transform: "translateY(0px)", transition: ENTER }} exit={{ opacity: 0, transition: EXIT }}
              className="grid min-w-0 content-start gap-4 p-[18px]">
              {policy === undefined ? <BeforeCanonfig reduced={reduced} /> : <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid min-w-0 gap-1">
                    <h2 className="text-lg font-semibold break-all">{current}</h2>
                    <p className="text-sm text-muted-foreground">{whatLabel(policy)} · {paused ? "Paused" : whenLabel(policy.schedule)} · <Mono className="break-all text-foreground">{destinationLabel(policy.destination)}</Mono></p>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      {drill?.ok
                        ? <span className="flex items-center gap-1.5"><StatusMark kind="ok" />Restore tested {whenAt(drill.at, true)}</span>
                        : <span className="flex items-center gap-1.5"><StatusMark kind="warn" />{drill === undefined ? "Never test-restored" : "Last restore test failed"}<Button size="xs" variant="ghost" className="-my-1" disabled={backup.action.loading || copies.length === 0} onClick={() => void testRestore()}>Test now</Button></span>}
                      {policy.passwordReference !== undefined && <span>Encrypted</span>}
                      {!(current in status.local.policies) && <span>Set by your Source</span>}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" disabled={backup.action.loading || consentMissing} onClick={() => void backUp()}>{running === current ? "Backing up…" : "Back up now"}</Button>
                    <Button size="sm" variant="outline" disabled={backup.action.loading} onClick={() => setEditing({ name: current, policy })}>Settings</Button>
                  </div>
                </div>

                {backup.action.error && editing === null && restoring === null && <ErrorNotice error={backup.action.error} />}
                <Fold show={consentMissing} reduced={reduced}>
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-warn/10 px-3 py-2 text-sm">
                    <span>This backup includes sign-in data or keys. Allow it on this machine to run it.</span>
                    <Button size="xs" variant="outline" onClick={() => setConsent(true)}>Allow…</Button>
                  </div>
                </Fold>
                <Fold show={!consentMissing && run?.ok === false && running !== current} reduced={reduced}>
                  <div role="alert" className="flex items-start gap-2 rounded-lg bg-bad/10 p-3 text-sm"><StatusMark kind="bad" className="mt-0.5" /><p>{run?.message ?? "The last backup failed."}</p></div>
                </Fold>
                <Fold show={paused} reduced={reduced}>
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-raised/60 px-3 py-2 text-sm">
                    <span>Scheduled backups are paused.</span>
                    <Button size="xs" variant="outline" disabled={backup.action.loading} onClick={() => void backup.run({ action: "enable", name: current })}>Resume</Button>
                  </div>
                </Fold>

                {listing === null ? <p className="py-8 text-center text-sm text-muted-foreground">{backup.action.loading ? "Loading copies…" : "Copies couldn't be listed."}</p>
                  : copies.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No copies yet. Back up now to make the first one.</p> : (
                  <ul aria-label={`Copies of ${current}`} data-tour="backups-copies" className="grid">
                    <AnimatePresence initial={false} mode="popLayout">
                      {shown.map((copy, index) => (
                        <motion.li key={copy.id} layout={reduced ? false : "position"}
                          initial={{ opacity: 0, transform: reduced ? "none" : "translateY(-4px)" }}
                          animate={{ opacity: 1, transform: "translateY(0px)", transition: { ...ENTER, delay: index >= FIRST ? Math.min(index - FIRST, 8) * 0.03 : 0 } }}
                          exit={{ opacity: 0, transition: EXIT }}
                          className="group flex min-h-11 items-center gap-3 border-t border-border/70 text-sm first:border-t-0">
                          <span className="flex-1">{whenAt(copy.createdAt)}{index === 0 && <span className="ml-2 text-faint">latest</span>}</span>
                          <span className="text-muted-foreground tabular-nums">{bytes(copy.bytes)}</span>
                          {/* Hidden until hover or focus on pointer devices; always visible on the newest copy and on touch. */}
                          <Button size="xs" variant="outline" disabled={backup.action.loading} onClick={() => setRestoring(copy.id)}
                            className={cn(index > 0 && "transition-opacity duration-150 ease-snap [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100")}>Restore…</Button>
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                )}
                {copies.length > FIRST && <Button size="xs" variant="ghost" className="justify-self-start" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer" : `Show all ${copies.length}`}</Button>}
              </>}
            </motion.div>
          </AnimatePresence>
        </section>
      </Body>
      {editing && <Settings key={editing.name} name={editing.name} initial={editing.policy} onClose={() => { if (editing.name === "") listed.current = null; setEditing(null); }} />}
      {restoring && policy && <RestoreDialog name={current} policy={policy} copies={copies} initial={restoring} owner={undefined} onClose={() => setRestoring(null)} />}
      <ConfirmDialog open={consent} onOpenChange={setConsent} title={`Allow ${current} on this machine?`}
        body="It copies sign-in data or keys to its destination, encrypted with its password."
        confirm="Allow" onConfirm={() => void backup.run({ action: "allow-credentials", name: current })} />
    </>
  );
}
