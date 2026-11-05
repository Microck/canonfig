import { cloneElement, lazy, Suspense, useEffect, useId, useRef, useState, type ReactElement } from "react";
import * as Schema from "effect/Schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field as SharedField, ListHead, ListRow } from "../workspace/kit";
import { GuiRequestError, type GuiSession, type WorkspaceBackend } from "../gui-client";
import { GuiEnrollment, GuiInvitationDownload, GuiInvitationInspection, GuiMachines, GuiSetupJournal, GuiSetupStatus } from "../../../src/gui/contract/enrollment";
import { GuiOperationTicket } from "../../../src/gui/contract/operations";
import { GuiHarnessReport } from "../../../src/gui/contract/synchronization";
import { TARGET_IDS } from "../../../src/projection/model";
import { ErrorNotice } from "./session";
import type { LiveScreen } from "./routes";

const MachineMap = lazy(() => import("../shared/machine-map/map-view").then((module) => ({ default: module.MachineMap })));

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <SharedField label={label} htmlFor={id}>{cloneElement(children, { id })}</SharedField>;
}
function Evidence({ value }: { value: unknown }) {
  return <pre className="max-h-96 overflow-auto rounded border border-border p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(value, null, 2)}</pre>;
}

/** Requests and polling belong to this mounted screen; server operations retain their own scope. */
function useActions(backend: WorkspaceBackend) {
  const controller = useRef(new AbortController());
  const [error, setError] = useState<GuiRequestError>();
  const [busy, setBusy] = useState(false);
  const [journal, setJournal] = useState<unknown>();
  const journalText = useRef<string | undefined>(undefined);
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await action(); }
    catch (cause) {
      if (!controller.current.signal.aborted) setError(cause instanceof GuiRequestError ? cause : new GuiRequestError({ category: "internal", exitCode: 1, message: cause instanceof Error ? cause.message : "The operation failed." }));
    } finally { if (!controller.current.signal.aborted) setBusy(false); }
  }
  function request<T>(path: string, schema: Schema.Codec<T, unknown>, body?: unknown, method: "POST" | "PUT" = "POST") {
    return backend.request(path, schema, controller.current.signal, body === undefined ? undefined : { method, body });
  }
  async function operation(path: string, body: unknown) {
    const ticket = await request(path, GuiOperationTicket, body);
    while (!controller.current.signal.aborted) {
      const snapshot = await backend.operation(ticket.id, controller.current.signal);
      const encodedJournal = JSON.stringify(snapshot.journal);
      if (journalText.current !== encodedJournal) {
        journalText.current = encodedJournal;
        setJournal(snapshot.journal);
      }
      if (snapshot.state === "failed" && snapshot.failure) throw new GuiRequestError(snapshot.failure);
      if (snapshot.state === "succeeded") return snapshot.result;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    }
  }
  return { run, request, operation, busy, error, journal };
}

function InvitationForm({ backend, groups = "", onClose }: { backend: WorkspaceBackend; groups?: string; onClose: () => void }) {
  const action = useActions(backend);
  const [endpoint, setEndpoint] = useState("https://127.0.0.1:7341");
  const [expiry, setExpiry] = useState("24");
  const [selectedGroups, setSelectedGroups] = useState(groups);
  const [download, setDownload] = useState<GuiInvitationDownload>();
  function save() {
    if (!download) return;
    const url = URL.createObjectURL(new Blob([download.envelope], { type: "text/plain" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = download.filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="my-5 grid gap-4 border-y border-border py-5" aria-label="Add machine">
    <h2 className="font-semibold">{groups ? "Replacement invitation" : "Add machine"}</h2>
    <p className="text-sm text-muted-foreground">Transfer this private, single-use file to the follower. Its name is chosen during enrollment, not reserved here.</p>
    {action.error && <ErrorNotice error={action.error} />}
    <form className="grid gap-4" onSubmit={(event) => {
      event.preventDefault();
      void action.run(async () => setDownload(await action.request("/api/invitations", GuiInvitationDownload, {
        endpoint, expiresInMilliseconds: Number(expiry) * 3_600_000,
        groups: selectedGroups.split(",").map((group) => group.trim()).filter(Boolean),
      })));
    }}>
    <Field label="Source endpoint"><Input type="url" required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></Field>
    <Field label="Expires in hours"><Input type="number" min="1" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></Field>
    <Field label="Groups (comma separated)"><Input value={selectedGroups} onChange={(event) => setSelectedGroups(event.target.value)} /></Field>
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={action.busy}>Create invitation</Button><Button type="button" variant="outline" onClick={onClose}>Close</Button></div>
    </form>
    {download && <><p>Invitation expires {download.expiresAt}.</p><Button onClick={save}>Download invitation file</Button><p className="text-sm">On the follower, open Setup or Join a Source, inspect the file, verify both fingerprints, and enroll. To change groups, explicitly select Replace enrollment. This does not change the existing identity until the follower enrolls.</p><pre className="overflow-auto text-xs">canonfig follower enroll --stdin --name &lt;name&gt; --replace &lt; canonfig-invitation.txt</pre><p className="text-sm text-muted-foreground">If the Source is remote, start its SSH tunnel first using the invitation file and a verified host key.</p></>}
  </section>;
}

function Machines({ backend, session, list = false }: { backend: WorkspaceBackend; session: GuiSession; list?: boolean }) {
  const action = useActions(backend);
  const [machines, setMachines] = useState<GuiMachines>();
  const [enrollment, setEnrollment] = useState<GuiEnrollment>();
  const [selected, setSelected] = useState<string>();
  const [invite, setInvite] = useState<string | null>(null);
  async function reload() {
    if (session.role === "source") setMachines(await action.request("/api/machines", GuiMachines));
    else setEnrollment(await action.request("/api/enrollment", GuiEnrollment));
  }
  useEffect(() => { void action.run(reload); }, [backend, session.role]);
  const followers = machines?.followers ?? (enrollment ? [enrollment.follower] : []);
  const current = followers.find((entry) => entry.id === selected);
  const sourceName = session.role === "source" ? session.machineName : enrollment?.source.endpoint ?? "Source";
  return <div className="grid gap-4">
    <div className="flex flex-wrap items-center gap-2"><Button asChild variant="outline"><a href={`/${session.role}/machines`}>Map</a></Button><Button asChild variant="outline"><a href={`/${session.role}/machines/list`}>List</a></Button><Button variant="outline" disabled={action.busy} onClick={() => void action.run(reload)}>Refresh machines</Button>{session.role === "source" && <Button onClick={() => setInvite("")}>Add machine</Button>}</div>
    <p className="text-sm text-muted-foreground">Enrollment records do not report remote health, revision, platform or schedule.{session.role === "follower" && " Only this machine and its Source are visible."}</p>
    {action.error && <ErrorNotice error={action.error} />}
    {invite !== null && <InvitationForm backend={backend} groups={invite} onClose={() => { setInvite(null); void action.run(reload); }} />}
    {!list && <div className="h-[540px]"><Suspense fallback={<p>Loading map…</p>}><MachineMap role={session.role === "source" ? "source" : "follower"} source={{ hostname: sourceName }} followers={followers} selfId={enrollment?.follower.id} onOpenMachine={setSelected} onInvite={() => setInvite("")} /></Suspense></div>}
    {list && <div>
      <ListHead cols="minmax(100px,1fr) 90px minmax(80px,1fr)"><span>Name</span><span>Role</span><span>Groups</span></ListHead>
      <ListRow cols="minmax(100px,1fr) 90px minmax(80px,1fr)" selected={selected === "source"} onClick={() => setSelected("source")}><span className="truncate">{sourceName}</span><span>Source</span><span /></ListRow>
      {followers.map((entry) => <ListRow key={entry.id} cols="minmax(100px,1fr) 90px minmax(80px,1fr)" selected={selected === entry.id} onClick={() => setSelected(entry.id)}><span className="truncate">{entry.name}</span><span>{entry.revoked ? "Revoked" : "Follower"}</span><span className="truncate">{entry.groups.join(", ") || "None"}</span></ListRow>)}
    </div>}
    {selected === "source" && <section><h2 className="font-semibold">Source Machine</h2><Evidence value={enrollment?.source ?? { name: session.machineName, folder: session.folderPath }} /></section>}
    {current && <section className="grid gap-3 border-t border-border pt-4"><h2 className="font-semibold">{current.name}</h2><Evidence value={current} />{session.role === "source" && <><Button variant="outline" onClick={() => setInvite(current.groups.join(", "))}>Change groups with a new invitation</Button><Button variant="outline" disabled={action.busy || current.revoked} onClick={() => { if (window.confirm(`Revoke ${current.name}? This removes its access to this Source.`)) void action.run(async () => { await action.request("/api/machines/revoke", Schema.Json, { follower: current.id }); await reload(); }); }}>Revoke follower</Button></>}<p className="text-sm">Run <code>canonfig status</code> on this follower to inspect its local state.</p><Button variant="outline" onClick={() => void navigator.clipboard.writeText("canonfig status")}>Copy status command</Button></section>}
    {machines && <section><h2 className="font-semibold">Stored invitations</h2>{machines.invitations.length === 0 ? <p className="py-3 text-sm">No stored invitations.</p> : <ul className="divide-y divide-border">{machines.invitations.map((entry, index) => <li key={index} className="py-3 text-sm [overflow-wrap:anywhere]">{entry.endpoint}<br />{entry.consumed ? "Consumed" : new Date(entry.expiresAt).getTime() <= Date.now() ? "Expired" : "Pending"} · expires {entry.expiresAt} · {entry.groups.join(", ") || "No groups"}</li>)}</ul>}<p className="text-sm text-muted-foreground">Invitation cancellation is not supported by the CLI.</p></section>}
  </div>;
}

function Join({ backend, session }: { backend: WorkspaceBackend; session: GuiSession }) {
  const action = useActions(backend);
  const [envelope, setEnvelope] = useState("");
  const [inspection, setInspection] = useState<GuiInvitationInspection>();
  const [name, setName] = useState(session.machineName);
  const [replace, setReplace] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [sshHost, setHost] = useState("");
  const [sshUser, setUser] = useState("");
  const [sshPort, setPort] = useState("22");
  const [localPort, setLocalPort] = useState("7341");
  const [hostKey, setHostKey] = useState("");
  const [joined, setJoined] = useState(false);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [savedHarnesses, setSavedHarnesses] = useState<GuiHarnessReport>();
  const [defaultSchedule, setDefaultSchedule] = useState(false);
  const [preferencesSaved, setPreferencesSaved] = useState(false);
  function changeEnvelope(value: string) { setEnvelope(value); setInspection(undefined); setTrusted(false); }
  async function loadHarnesses() {
    const report = await action.request("/api/harnesses", GuiHarnessReport);
    setSavedHarnesses(report);
    setExclusions([...report.excluded]);
    setPreferencesSaved(false);
  }
  return <section className="grid gap-4">
    <h2 className="font-semibold">Join a Source</h2>
    {action.error && <ErrorNotice error={action.error} />}
    <Field label="Invitation file"><input type="file" accept=".txt,.canonfig" onChange={(event) => { const file = event.target.files?.[0]; if (file) void action.run(async () => changeEnvelope(await file.text())); }} /></Field>
    <Field label="Or paste the complete invitation, including its EOF line"><textarea className="min-h-24 w-full rounded border border-border bg-transparent p-3 font-mono text-xs" value={envelope} onChange={(event) => changeEnvelope(event.target.value)} autoComplete="off" spellCheck={false} /></Field>
    <Button disabled={action.busy || !envelope} onClick={() => void action.run(async () => setInspection(await action.request("/api/enrollment/inspect", GuiInvitationInspection, { envelope })))}>Inspect invitation</Button>
    {inspection && <><Evidence value={inspection} /><label className="flex gap-2 text-sm"><input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />I verified the Source and TLS fingerprints through a trusted channel.</label>
      <details className="grid gap-3"><summary className="cursor-pointer py-3">Start an SSH tunnel for a remote Source</summary><div className="grid gap-3 py-3"><Field label="SSH host"><Input value={sshHost} onChange={(event) => setHost(event.target.value)} /></Field><Field label="SSH user"><Input value={sshUser} onChange={(event) => setUser(event.target.value)} /></Field><Field label="SSH port"><Input type="number" value={sshPort} onChange={(event) => setPort(event.target.value)} /></Field><Field label="Verified SSH host key file on this machine"><Input value={hostKey} onChange={(event) => setHostKey(event.target.value)} /></Field><Field label="Local tunnel port"><Input type="number" value={localPort} onChange={(event) => setLocalPort(event.target.value)} /></Field><p className="text-sm">Verify the SSH host key out of band before using this file. Canonfig does not accept unknown host keys.</p><Button disabled={action.busy || !trusted} onClick={() => void action.run(async () => { await action.operation("/api/enrollment/tunnel", { envelope, sshHost, sshUser, sshPort: Number(sshPort), sshHostKeyPath: hostKey, localPort: Number(localPort), trustConfirmed: true }); })}>Start verified tunnel</Button></div></details>
      <Field label="Follower name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
      {session.role === "follower" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />Replace this machine's current enrollment with this invitation.</label>}
      <Button disabled={action.busy || !trusted || (session.role === "follower" && !replace)} onClick={() => void action.run(async () => { await action.operation("/api/enrollment", { envelope, followerName: name, replace }); setJoined(true); setEnvelope(""); setInspection(undefined); await loadHarnesses(); })}>Enroll this machine</Button>
    </>}
    {joined && <>
      <p role="status">Enrollment completed. Choose this machine's preferences before opening the workspace.</p>
      <Button variant="outline" disabled={action.busy} onClick={() => void action.run(loadHarnesses)}>Reload local preferences</Button>
      {savedHarnesses && <>
        <fieldset className="grid gap-2"><legend className="mb-2 text-sm font-medium">Exclude harnesses on this machine</legend>{TARGET_IDS.map((harness) => <label key={harness} className="flex gap-2 text-sm"><input type="checkbox" checked={exclusions.includes(harness)} onChange={(event) => { setExclusions(event.target.checked ? [...exclusions, harness] : exclusions.filter((item) => item !== harness)); setPreferencesSaved(false); }} />{harness}</label>)}</fieldset>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={defaultSchedule} onChange={(event) => { setDefaultSchedule(event.target.checked); setPreferencesSaved(false); }} />Use the profile's default synchronization schedule when available.</label>
        <p className="text-sm text-muted-foreground">The CLI requires an applied profile before a default schedule can be selected. If it refuses, apply the profile from Sync, then select the default on Schedule.</p>
        <Button disabled={action.busy} onClick={() => void action.run(async () => {
          setPreferencesSaved(false);
          for (const harness of TARGET_IDS) {
            if (exclusions.includes(harness) === savedHarnesses.excluded.includes(harness)) continue;
            const report = await action.request("/api/harnesses", GuiHarnessReport, { harness, action: exclusions.includes(harness) ? "exclude" : "include" }, "PUT");
            setSavedHarnesses(report);
          }
          if (defaultSchedule) await action.request("/api/schedule", Schema.Json, { profileDefault: true }, "PUT");
          setPreferencesSaved(true);
        })}>Save local preferences</Button>
        {preferencesSaved && <p role="status">Local preferences saved.</p>}
      </>}
      <Button asChild><a href="/follower/overview">Open workspace</a></Button>
    </>}
    {action.busy && <p role="status">Operation running…</p>}{action.journal != null && <Evidence value={action.journal} />}
  </section>;
}

export function Setup({ backend, session }: { backend: WorkspaceBackend; session: GuiSession }) {
  const action = useActions(backend);
  const [role, setRole] = useState<"source" | "follower">("source");
  const [status, setStatus] = useState<GuiSetupStatus>();
  const [plan, setPlan] = useState<GuiSetupJournal>();
  const [harnesses, setHarnesses] = useState<string[] | undefined>();
  const [imports, setImports] = useState<string[]>([]);
  const [secrets, setSecrets] = useState(false);
  const [approver, setApprover] = useState("");
  const [approved, setApproved] = useState(false);
  const [applied, setApplied] = useState(false);
  const [draftChanged, setDraftChanged] = useState(false);
  useEffect(() => { void action.run(async () => setStatus(await action.request("/api/setup", GuiSetupStatus))); }, [backend]);
  async function makePlan(review: boolean) {
    const journal = await action.request("/api/setup/plan", GuiSetupJournal, { role, scope: "full", mode: "simple", files: [], ...(harnesses === undefined ? {} : { harnesses }), imports: review ? { kind: "offer" } : imports.length ? { kind: "some", requested: imports } : { kind: "none" } });
    setPlan(journal); setApproved(false); setApplied(false); setDraftChanged(false);
    if (review) setImports([]);
    const chosen = journal.items.find((item) => item.kind === "folder-scaffold")?.detail.harnesses;
    if (Array.isArray(chosen) && chosen.every((item) => typeof item === "string")) setHarnesses(chosen);
    setStatus(await action.request("/api/setup", GuiSetupStatus));
  }
  return <div className="grid gap-5">
    <p>Plan this machine's setup, review its changes, then explicitly approve and apply.</p>
    {action.error && <ErrorNotice error={action.error} />}
    {status && <details><summary className="cursor-pointer py-2">Current setup status: {status.stage}</summary><Evidence value={status} /></details>}
    <Field label="Machine role"><select className="min-h-11 rounded border border-border bg-panel p-2" value={role} disabled={action.busy} onChange={(event) => { setRole(event.target.value === "source" ? "source" : "follower"); setPlan(undefined); setApproved(false); setApplied(false); setImports([]); setHarnesses(undefined); }}><option value="source">Source Machine</option><option value="follower">Follower Machine</option></select></Field>
    <Button disabled={action.busy} onClick={() => void action.run(() => makePlan(true))}>Inspect machine and plan setup</Button>
    {plan && <>
      {role === "source" && <div className="grid gap-3" onChange={() => { setDraftChanged(true); setApproved(false); }}>
        <h2 className="font-semibold">Harnesses and import review</h2>
        <p className="text-sm">Installed harnesses are selected by the real setup planner. Change the selection and inspect again to refresh import offers.</p>
        <fieldset className="grid grid-cols-2 gap-2">
          {TARGET_IDS.map((harness) => <label key={harness} className="flex gap-2 text-sm">
            <input type="checkbox" checked={harnesses?.includes(harness) ?? false} onChange={(event) => setHarnesses(event.target.checked ? [...(harnesses ?? []), harness] : harnesses?.filter((item) => item !== harness))} />{harness}
          </label>)}
        </fieldset>
        <label className="flex gap-2 text-sm">
          <input type="checkbox" checked={secrets} onChange={(event) => {
            setSecrets(event.target.checked);
            if (!event.target.checked) setImports(imports.filter((id) => !plan.imports?.offered.find((offer) => offer.id === id)?.secrets.length));
          }} />
          Allow selecting imports that replace literal secrets with environment references.
        </label>
        {plan.imports?.offered.map((offer) => <label key={offer.id} className="flex items-start gap-2 border-b border-border py-2 text-sm">
          <input type="checkbox" disabled={offer.secrets.length > 0 && !secrets} checked={imports.includes(offer.id)} onChange={(event) => setImports(event.target.checked ? [...imports, offer.id] : imports.filter((id) => id !== offer.id))} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{offer.id} → {offer.target}
            {offer.secrets.length > 0 && <span className="block">{offer.secrets.join(", ")}</span>}
            {offer.notes.map((note) => <span key={note} className="block text-muted-foreground">{note}</span>)}
          </span>
        </label>)}
        <Button disabled={action.busy} variant="outline" onClick={() => void action.run(() => makePlan(false))}>Create plan with these import choices</Button>
      </div>}
      <section className="grid gap-3"><h2 className="font-semibold">Review exact plan</h2><p className="font-mono text-xs [overflow-wrap:anywhere]">{plan.planDigest}</p><Evidence value={{ items: plan.items, decisions: plan.decisions, exclusions: plan.exclusions, imports: plan.imports }} /><p className="text-sm">The profile name comes from the hostname. Service installation and tool scanning are separate operations available after setup.</p></section>
      {draftChanged && <p role="status">Create a new plan with these choices before approving.</p>}
      <Field label="Approver name"><Input value={approver} onChange={(event) => setApprover(event.target.value)} /></Field><Button disabled={action.busy || draftChanged || !approver.trim()} onClick={() => void action.run(async () => { const journal = await action.request("/api/setup/approve", GuiSetupJournal, { approver, planDigest: plan.planDigest }); setPlan(journal); setApproved(true); })}>I reviewed and approve this plan</Button>
      <Button disabled={action.busy || !approved} onClick={() => void action.run(async () => { await action.operation("/api/setup/apply", { planDigest: plan.planDigest }); setStatus(await action.request("/api/setup", GuiSetupStatus)); setApplied(true); })}>Apply approved setup</Button>
      {applied && <><p role="status">Setup apply finished. Review its actual status below.</p><Evidence value={status} />{role === "source" && <Button asChild><a href="/source/overview">Open workspace</a></Button>}</>}
    </>}
    {role === "follower" && <Join backend={backend} session={session} />}
    {action.busy && <p role="status">Setup operation running…</p>}{action.journal != null && <Evidence value={action.journal} />}
  </div>;
}

export const enrollmentScreens: ReadonlyArray<LiveScreen> = [
  { title: "Machines", path: (role) => role === "unconfigured" ? undefined : `/${role}/machines`, render: ({ session, backend }) => <Machines session={session} backend={backend} /> },
  { title: "Machine list", path: (role) => role === "unconfigured" ? undefined : `/${role}/machines/list`, render: ({ session, backend }) => <Machines session={session} backend={backend} list /> },
  { title: "Setup", path: (role) => role === "unconfigured" ? "/setup" : undefined, render: ({ session, backend }) => <Setup session={session} backend={backend} /> },
  { title: "Join a Source", path: (role) => role === "follower" ? "/follower/enrollment/join" : undefined, render: ({ session, backend }) => <Join session={session} backend={backend} /> },
];
