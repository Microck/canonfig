import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HARNESS_NAMES } from "@/shared/metadata";
import { defaultBackupPolicy, type BackupPolicy } from "../../../src/backup/backup.types";
import type { GuiBackupRequest } from "../../../src/gui/contract/backup";
import { TARGET_IDS } from "../../../src/projection/model";
import { ErrorNotice } from "../live/session";
import { Field } from "./kit";
import { ScheduleFields, type Schedule } from "./schedule";
import { ConfirmDialog } from "./settings";
import type { Workspace } from "./workspace-types";

type LiveBackups = NonNullable<Workspace["backupLive"]>;
const namePattern = "[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,63}";

function Choice<T extends string>({ id, label, value, options, onChange }: {
  id: string; label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  return <Field label={label} htmlFor={id}><Select value={value} onValueChange={next => {
    const option = options.find(candidate => candidate.value === next);
    if (option) onChange(option.value);
  }}><SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger><SelectContent>
    {options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
  </SelectContent></Select></Field>;
}
function Toggle({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return <Label htmlFor={id} className="flex min-h-9 cursor-pointer items-center gap-2 text-base font-normal">
    <Checkbox id={id} checked={checked} onCheckedChange={value => onChange(value === true)} />{children}
  </Label>;
}

function PolicySchedule({ id, label, value, onChange }: {
  id: string; label: string; value: BackupPolicy["schedule"]; onChange: (value: BackupPolicy["schedule"]) => void;
}) {
  const draft: Schedule = value === undefined ? { cadence: "daily", days: [], time: "09:00" }
    : value.kind === "custom" ? { cadence: "custom", expression: value.expression, timezone: value.timezone, time: "09:00", days: [] }
    : { cadence: value.kind === "daily" ? "daily" : "days", time: value.localTime, timezone: value.timezone,
      days: value.kind === "weekly" ? "weekdays" in value ? [...value.weekdays] : [value.weekday] : [] };
  const change = (next: Schedule) => onChange(next.cadence === "custom"
    ? { kind: "custom", expression: next.expression ?? "", timezone: next.timezone }
    : next.cadence === "daily" ? { kind: "daily", localTime: next.time, timezone: next.timezone }
    : { kind: "weekly", localTime: next.time, timezone: next.timezone,
      weekdays: next.cadence === "weekdays" ? ["Mon", "Tue", "Wed", "Thu", "Fri"] : next.days });
  return <fieldset className="grid gap-3"><legend className="mb-2 text-sm font-medium">{label}</legend>
    <Toggle id={`${id}-enabled`} checked={value !== undefined} onChange={enabled => enabled ? change(draft) : onChange(undefined)}>Scheduled</Toggle>
    {value !== undefined && <><ScheduleFields idPrefix={id} value={draft} onChange={change} allowCustom />
      <Field label="Timezone (blank uses this machine)" htmlFor={`${id}-timezone`}><Input id={`${id}-timezone`} value={value.timezone ?? ""}
        onChange={event => onChange({ ...value, timezone: event.target.value || undefined })} /></Field></>}
  </fieldset>;
}

function PolicyEditor({ live, initialName, initial, allowed, onClose }: {
  live: LiveBackups; initialName: string; initial: BackupPolicy; allowed: boolean; onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [policy, setPolicy] = useState(initial);
  const [allowCredentials, setAllowCredentials] = useState(allowed);
  const destination = policy.destination;
  const destinationValue = destination.kind === "local" ? destination.path : destination.remote;
  const update = (patch: Partial<BackupPolicy>) => setPolicy(current => ({ ...current, ...patch }));
  return <form className="grid gap-5 border-y border-border py-5" onSubmit={event => {
    event.preventDefault();
    void live.run({ action: "configure", name, policy: { ...policy,
      include: policy.include.filter(pattern => pattern.trim() !== ""), exclude: policy.exclude.filter(pattern => pattern.trim() !== ""),
    }, allowCredentials }).then(saved => { if (saved) onClose(); });
  }}>
    <fieldset disabled={live.action.loading} className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Policy name" htmlFor="backup-name"><Input id="backup-name" value={name} required pattern={namePattern} disabled={initialName !== ""} onChange={event => setName(event.target.value)} /></Field>
        <Choice id="backup-destination-kind" label="Destination" value={destination.kind} options={[
          { value: "local", label: "Local folder" }, { value: "git", label: "Git repository" }, { value: "rclone", label: "Cloud drive / rclone" },
        ]} onChange={kind => update({ destination: kind === "local" ? { kind, path: "" } : { kind, remote: "" } })} />
      </div>
      <Field label={destination.kind === "local" ? "Absolute folder path" : destination.kind === "git" ? "Git remote URL" : "Configured rclone remote and path"}
        htmlFor="backup-destination" description={destination.kind === "git" ? "Use your Git credential helper. Plaintext pushes require gitleaks." : destination.kind === "rclone" ? "For example, drive:canonfig. Configure authentication with rclone on this machine." : undefined}>
        <Input id="backup-destination" value={destinationValue} required autoComplete="off" spellCheck={false} onChange={event => update({ destination: destination.kind === "local" ? { kind: "local", path: event.target.value } : { kind: destination.kind, remote: event.target.value } })} />
      </Field>
      <fieldset className="grid gap-3"><legend className="mb-2 text-sm font-medium">Contents</legend>
        <Toggle id="backup-folder" checked={policy.folder} onChange={folder => update({ folder })}>Canonical Folder</Toggle>
        <Choice id="backup-harness-mode" label="Harness files" value={policy.harnesses.mode} options={[
          { value: "none", label: "None" }, { value: "managed", label: "Managed configuration" }, { value: "full", label: "Full harness folders (encryption required)" },
        ]} onChange={mode => update({ harnesses: { ...policy.harnesses, mode } })} />
        {policy.harnesses.mode !== "none" && <div className="grid gap-x-4 sm:grid-cols-2">{TARGET_IDS.map(target => <Toggle key={target} id={`backup-target-${target}`} checked={policy.harnesses.targets.includes(target)}
          onChange={checked => update({ harnesses: { ...policy.harnesses, targets: checked ? [...policy.harnesses.targets, target] : policy.harnesses.targets.filter(item => item !== target) } })}>{HARNESS_NAMES[target]}</Toggle>)}</div>}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice id="backup-compression" label="Compression" value={policy.compression} options={[
          { value: "fast", label: "Fast · Zstandard 1" }, { value: "balanced", label: "Balanced · Zstandard 6" },
          { value: "small", label: "Small · xz 9e" }, { value: "max", label: "Max · smallest of xz / ZPAQ" },
        ]} onChange={compression => update({ compression })} />
        <Field label="Password alias (blank means unencrypted)" htmlFor="backup-password-reference"><Input id="backup-password-reference" value={policy.passwordReference ?? ""} pattern={namePattern}
          autoComplete="off" onChange={event => update({ passwordReference: event.target.value || undefined })} /></Field>
      </div>
      {(policy.compression === "small" || policy.compression === "max") && <p className="text-sm text-muted-foreground">{policy.compression === "small" ? "Requires xz on every machine that creates or restores this backup." : "Requires xz and zpaq-stream. Max compares both and can take minutes to compress and restore; see the backup documentation before scheduling it."}</p>}
      <fieldset className="grid gap-2"><legend className="mb-2 text-sm font-medium">Encrypted extras</legend>
        <Toggle id="backup-identity" checked={policy.sourceIdentity} onChange={sourceIdentity => update({ sourceIdentity })}>Source signing key, TLS identity and Follower registry</Toggle>
        <Toggle id="backup-secrets" checked={policy.sharedSecrets} onChange={sharedSecrets => update({ sharedSecrets })}>Shared secrets</Toggle>
        <Toggle id="backup-credentials" checked={policy.includeCredentials} onChange={includeCredentials => update({ includeCredentials })}>Include known harness credential files</Toggle>
        <Toggle id="backup-consent" checked={allowCredentials} onChange={setAllowCredentials}>Allow credential capture on this machine</Toggle>
      </fieldset>
      <details><summary className="cursor-pointer text-sm font-medium">Filters and capture limits</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">
        {(["include", "exclude"] as const).map(key => <Field key={key} label={`${key === "include" ? "Include" : "Exclude"} globs (one per line)`} htmlFor={`backup-${key}`}><Textarea id={`backup-${key}`} spellCheck={false}
          value={policy[key].join("\n")} onChange={event => update({ [key]: event.target.value.split("\n") })} /></Field>)}
        <Field label="Maximum bytes" htmlFor="backup-max-bytes"><Input id="backup-max-bytes" type="number" min={1} step={1} required value={policy.maximumBytes} onChange={event => update({ maximumBytes: event.target.valueAsNumber })} /></Field>
        <Field label="Maximum files" htmlFor="backup-max-files"><Input id="backup-max-files" type="number" min={1} step={1} required value={policy.maximumFiles} onChange={event => update({ maximumFiles: event.target.valueAsNumber })} /></Field>
      </div></details>
      <fieldset><legend className="mb-3 text-sm font-medium">Retention</legend><div className="grid grid-cols-3 gap-3">
        {(["last", "daily", "weekly"] as const).map(key => <Field key={key} label={key === "last" ? "Last snapshots" : key === "daily" ? "Daily copies" : "Weekly copies"} htmlFor={`backup-retain-${key}`}>
          <Input id={`backup-retain-${key}`} type="number" min={key === "last" ? 1 : 0} step={1} required value={policy.retention[key]} onChange={event => update({ retention: { ...policy.retention, [key]: event.target.valueAsNumber } })} />
        </Field>)}
      </div></fieldset>
      <div className="grid gap-6 sm:grid-cols-2"><PolicySchedule id="backup-run-schedule" label="Backup schedule" value={policy.schedule} onChange={schedule => update({ schedule })} />
        <PolicySchedule id="backup-drill-schedule" label="Restore drill schedule" value={policy.drillSchedule} onChange={drillSchedule => update({ drillSchedule })} /></div>
    </fieldset>
    <div className="flex gap-2"><Button type="submit" disabled={live.action.loading}>{live.action.loading ? "Saving…" : "Save policy"}</Button>
      <Button type="button" variant="ghost" disabled={live.action.loading} onClick={onClose}>Cancel</Button></div>
  </form>;
}

function PasswordEditor({ live, onClose }: { live: LiveBackups; onClose: () => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  return <form className="grid gap-4 border-y border-border py-5" onSubmit={event => {
    event.preventDefault();
    void live.run({ action: "password", name, password }).then(saved => { setPassword(""); if (saved) onClose(); });
  }}>
    <Field label="Password alias" htmlFor="backup-alias"><Input id="backup-alias" value={name} required pattern={namePattern} onChange={event => setName(event.target.value)} /></Field>
    <Field label="Password" htmlFor="backup-password" description="Keep a separate copy. Canonfig cannot recover this password, and losing it makes your encrypted backups unrecoverable.">
      <Input id="backup-password" type="password" autoComplete="new-password" value={password} required maxLength={4096} onChange={event => setPassword(event.target.value)} /></Field>
    <div className="flex gap-2"><Button type="submit" disabled={live.action.loading}>{live.action.loading ? "Saving…" : "Save password"}</Button><Button type="button" variant="ghost" onClick={onClose} disabled={live.action.loading}>Cancel</Button></div>
  </form>;
}

function SnapshotBrowser({ live, name }: { live: LiveBackups; name: string }) {
  const [owner, setOwner] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const [expectKey, setExpectKey] = useState("");
  const [path, setPath] = useState("");
  const [recoverCredentials, setRecoverCredentials] = useState(false);
  const [replace, setReplace] = useState(false);
  const [confirmation, setConfirmation] = useState<GuiBackupRequest | null>(null);
  const listing = live.listing?.name === name && (owner === "" || live.listing.value.owner === owner) ? live.listing.value : null;
  const selection = { name, owner: owner || undefined, snapshot: snapshot || undefined, expectKey: expectKey || undefined };
  const busy = live.action.loading;
  return <section className="grid gap-4 border-t border-border py-5" aria-label={`Snapshots for ${name}`}>
    <h3 className="font-medium">Snapshots · {name}</h3>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setSnapshot(""); void live.run({ action: "list", name, owner: owner || undefined }); }}>
      <Field label="Owner (blank uses this machine)" htmlFor="backup-owner"><Input id="backup-owner" value={owner} pattern={namePattern} onChange={event => { setOwner(event.target.value); setSnapshot(""); }} /></Field>
      <Button type="submit" variant="outline" disabled={busy}>List snapshots</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { void live.run({ action: "owners", name }); }}>Discover owners</Button>
    </form>
    {listing && <><p className="text-sm text-muted-foreground break-all">Owner: {listing.owner}</p>
      {listing.snapshots.length === 0 ? <p className="text-sm text-muted-foreground">No snapshots for this owner.</p> : <Choice id="backup-snapshot" label="Snapshot" value={snapshot || "latest"} onChange={value => setSnapshot(value === "latest" ? "" : value)}
        options={[{ value: "latest", label: "Latest snapshot" }, ...listing.snapshots.map(item => ({ value: item.id, label: `${item.createdAt} · ${item.files} files · ${(item.bytes / 1024).toFixed(1)} KiB · ${item.encrypted ? "encrypted" : "plaintext"}` }))]} />}
    </>}
    <Field label="Expected Source key fingerprint (optional)" htmlFor="backup-expect-key"><Input id="backup-expect-key" value={expectKey} pattern="[0-9a-f]{64}" onChange={event => setExpectKey(event.target.value)} /></Field>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { void live.run({ action: "verify", ...selection }); }}>Verify</Button>
      <Button variant="outline" disabled={busy} onClick={() => { void live.run({ action: "drill", ...selection }); }}>Run restore drill</Button>
      <Button variant="ghost" disabled={busy} onClick={() => { void live.run({ action: "prune", name, apply: false }); }}>Preview retention</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setConfirmation({ action: "prune", name, apply: true })}>Apply retention…</Button></div>
    <form className="grid gap-3" onSubmit={event => { event.preventDefault(); setConfirmation({ action: "restore", ...selection, target: { kind: "home", path, recoverCredentials } }); }}>
      <Field label="Restore into a new HOME directory" htmlFor="backup-restore-home" description="The directory must not exist. Source identity recovery is offline; stop the old Source before using the recovered identity.">
        <Input id="backup-restore-home" value={path} required onChange={event => setPath(event.target.value)} /></Field>
      <Toggle id="backup-recover-credentials" checked={recoverCredentials} onChange={setRecoverCredentials}>Recover encrypted identity and shared secrets</Toggle>
      <div><Button type="submit" variant="outline" disabled={busy}>Restore into new HOME…</Button></div>
    </form>
    <details><summary className="cursor-pointer text-sm font-medium">Apply the Canonical Folder here</summary><div className="mt-3 grid gap-3">
      <Toggle id="backup-replace" checked={replace} onChange={setReplace}>Replace the current Canonical Folder instead of merging</Toggle>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { void live.run({ action: "restore", ...selection, target: { kind: "apply", replace, dryRun: true } }); }}>Preview folder restore</Button>
        <Button variant="outline" disabled={busy} onClick={() => setConfirmation({ action: "restore", ...selection, target: { kind: "apply", replace, dryRun: false } })}>Apply folder restore…</Button></div>
    </div></details>
    <ConfirmDialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }} title={confirmation?.action === "prune" ? "Delete snapshots outside retention?" : "Restore this snapshot?"}
      body={confirmation?.action === "prune" ? "This deletes snapshots outside the current retention policy for this machine's owner namespace. Remote trash and Git objects may remain with the provider."
        : confirmation?.action === "restore" && confirmation.target.kind === "apply" ? "Canonfig applies the backed-up Canonical Folder on this machine through the normal import and Projection checks." : "Canonfig verifies the entire snapshot before writing the new HOME directory."}
      confirm={confirmation?.action === "prune" ? "Apply retention" : "Restore"} onConfirm={() => { if (confirmation) void live.run(confirmation); }} />
  </section>;
}

export function PortableBackups({ live }: { live: LiveBackups }) {
  const [editor, setEditor] = useState<{ name: string; policy: BackupPolicy } | null>(null);
  const [passwordEditor, setPasswordEditor] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const status = live.status.data;
  const busy = live.action.loading || live.status.loading;
  return <section className="grid gap-4 border-b border-border px-[18px] py-4" aria-label="Portable backups">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">Portable backups</h2><div className="flex flex-wrap gap-2">
      {!editor && !passwordEditor && <Button size="sm" disabled={busy} onClick={() => setEditor({ name: "", policy: defaultBackupPolicy({ kind: "local", path: "" }) })}>New policy</Button>}
      <Button size="sm" variant="outline" disabled={busy || editor !== null || passwordEditor} onClick={() => setPasswordEditor(true)}>Add password</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void live.run({ action: "schedule" }); }}>Reconcile schedules</Button>
    </div></div>
    {live.action.loading && <p role="status" className="text-sm text-muted-foreground">Backup operation running. It continues if you leave this page.</p>}
    {live.action.error && <ErrorNotice error={live.action.error} />}
    {editor && <PolicyEditor key={editor.name} live={live} initialName={editor.name} initial={editor.policy} allowed={status?.local.allowCredentials.includes(editor.name) ?? false} onClose={() => setEditor(null)} />}
    {passwordEditor && <PasswordEditor live={live} onClose={() => setPasswordEditor(false)} />}
    {status && Object.keys(status.policies).length === 0 && !editor && <p className="text-sm text-muted-foreground">Create a policy to choose what to back up and where to store it.</p>}
    {status && Object.entries(status.policies).map(([name, policy]) => <div key={name} className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3">
      <div className="min-w-0"><h3 className="font-medium">{name}</h3><p className="text-sm text-muted-foreground break-all">{policy.destination.kind === "local" ? policy.destination.path : policy.destination.remote}</p>
        <p className="text-sm text-muted-foreground">{status.local.disabled.includes(name) ? "Disabled" : "Enabled"} · {name in status.local.policies ? "Local policy" : "Source policy"} · {policy.compression} · {policy.passwordReference ? "Encrypted" : "Plaintext"}</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || status.local.disabled.includes(name)} onClick={() => { void live.run({ action: "run", name }); }}>Back up now</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setSelected(name); void live.run({ action: "list", name }); }}>Snapshots</Button>
        <Button size="sm" variant="ghost" disabled={busy || passwordEditor} onClick={() => setEditor({ name, policy })}>{name in status.local.policies ? "Edit" : "Override locally"}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void live.run({ action: status.local.disabled.includes(name) ? "enable" : "disable", name }); }}>{status.local.disabled.includes(name) ? "Enable" : "Disable"}</Button>
        {(policy.includeCredentials || policy.sourceIdentity || policy.sharedSecrets) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
          if (status.local.allowCredentials.includes(name)) void live.run({ action: "deny-credentials", name }); else setConsent(name);
        }}>{status.local.allowCredentials.includes(name) ? "Revoke credential capture" : "Allow credential capture…"}</Button>}
      </div>
    </div>)}
    {selected && <SnapshotBrowser key={selected} live={live} name={selected} />}
    {live.report && <details open className="text-sm"><summary className="cursor-pointer font-medium">{live.report.action} {live.report.name ?? ""}: completed</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(live.report.value, null, 2)}</pre></details>}
    {status && status.schedules.length > 0 && <details className="text-sm"><summary className="cursor-pointer">Native schedule status</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(status.schedules, null, 2)}</pre></details>}
    <ConfirmDialog open={consent !== null} onOpenChange={open => { if (!open) setConsent(null); }} title="Allow credential capture on this machine?"
      body="This policy may copy harness tokens, Source identity or shared secrets to its destination. It must use encryption. Review the policy and keep its password separately."
      confirm="Allow capture" onConfirm={() => { if (consent) void live.run({ action: "allow-credentials", name: consent }); }} />
  </section>;
}
