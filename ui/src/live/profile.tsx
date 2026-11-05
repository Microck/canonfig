import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Schema } from "effect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Body, DetailPanel, Field as KitField, ListHead, ListRow, PageHeader, copy, useLeaveGuard } from "../workspace/kit";
import { StatusMark } from "../shared/shared";
import { ConfigFields, DocumentFields, SettingsFields, documentFields } from "./profile/fields";
import { DefaultsFields, GroupsFields } from "./profile/settings";
import { GuiRequestError, type WorkspaceBackend } from "../gui-client";
import { ErrorNotice } from "./session";
import type { LiveScreen, LiveScreenProps } from "./routes";
import { GuiProfileSnapshot, GuiProfileSaved, GuiProfileConfigWrite, GuiProfileWrite, GuiProfileValidation, GuiRevisions, GuiSkills, GuiTrackedSkill, GuiSkillChecks, profileEndpoints } from "../../../src/gui/contract/profile";
import { GuiOperationTicket, type GuiOperation } from "../../../src/gui/contract/operations";
import { GuiSecrets, GuiSecretSummary, GuiSecretRemoval, GuiArchiveDownload } from "../../../src/gui/contract/synchronization";
import { TARGET_IDS, SURFACE_CATEGORIES } from "../../../src/projection/model";

type Json = Schema.Json;
const object = (value: Json | undefined): Record<string, Json> => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const strings = (value: Json | undefined) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const format = (value: unknown) => JSON.stringify(value, null, 2);
const encode = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));
const decode = (base64: string) => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));

/** Edit changed leaves only, keeping comments on untouched JSONC keys. Arrays are authored as one value. */
function configEdits(path: readonly (string | number)[], before: Json | undefined, after: Json | undefined): typeof GuiProfileConfigWrite.Type.edits[number][] {
  if (format(before) === format(after)) return [];
  if (before !== null && after !== null && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const left = object(before), right = object(after);
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) => configEdits([...path, key], left[key], right[key]));
  }
  return [{ path, ...(after === undefined ? {} : { value: after }) }];
}

/** Requests and polling synchronize with the local server; no simulated store enters this module. */
function useRequest(backend: WorkspaceBackend) {
  const [error, setError] = useState<GuiRequestError>();
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (active.current) return undefined;
    active.current = true; setBusy(true); setError(undefined);
    try { return await action(); }
    catch (cause) { setError(cause instanceof GuiRequestError ? cause : new GuiRequestError({ category: "usage-or-configuration", exitCode: 2, message: cause instanceof Error ? cause.message : String(cause) })); }
    finally { active.current = false; setBusy(false); }
  }
  function request<T>(path: string, schema: Schema.Codec<T>, method?: "POST" | "PUT" | "DELETE", body?: unknown) {
    return backend.request(path, schema, new AbortController().signal, method ? { method, body } : undefined);
  }
  return { run, request, busy, error };
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <KitField label={label} htmlFor={id}>{isValidElement<{ id?: string }>(children) ? cloneElement(children, { id }) : children}</KitField>;
}
function JsonView({ value }: { value: unknown }) {
  return <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded border border-border p-3 font-mono text-xs">{format(value)}</pre>;
}
function useLoad<T>(backend: WorkspaceBackend, path: string, schema: Schema.Codec<T>) {
  const api = useRequest(backend);
  const [value, setValue] = useState<T>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<GuiRequestError>();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(undefined);
    void backend.request(path, schema, controller.signal).then(
      (next) => { if (!controller.signal.aborted) { setValue(next); setLoading(false); } },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(cause instanceof GuiRequestError ? cause : new GuiRequestError({ category: "internal", exitCode: 1, message: String(cause) }));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [backend, path, schema, revision]);
  return { ...api, busy: loading || api.busy, error: api.error ?? loadError, value, reload: () => setRevision((n) => n + 1) };
}

const CONFIG_CATEGORIES = ["mcp", "hooks", "settings", "tools", "credentials", "resources"] as const;
const FILE_CATEGORIES = ["instructions", "rules", "skills", "agents", "commands", "hook-scripts", "files"] as const;
type Entry = { id: string; category: string; path?: string; configPath?: (string | number)[]; value?: Json };
function entriesOf(snapshot: GuiProfileSnapshot): Entry[] {
  const entries: Entry[] = snapshot.items.filter((item) => item.path !== "canonfig.jsonc").map((item) => ({ id: item.path === "AGENTS.md" ? "instructions" : item.path.replace(/\.md$/, ""), category: item.path === "AGENTS.md" ? "instructions" : item.path.startsWith("hooks/") ? "hook-scripts" : item.path.split("/")[0]!, path: item.path }));
  for (const category of CONFIG_CATEGORIES) {
    const value = snapshot.config[category];
    if (category === "hooks" && Array.isArray(value)) value.forEach((hook, index) => entries.push({ id: `hooks/${String(object(hook).id)}`, category, configPath: [category, index], value: hook }));
    else for (const [name, item] of Object.entries(object(value))) entries.push({ id: `${category}/${name}`, category, configPath: [category, name], value: item });
  }
  return entries;
}

function Profile({ backend, tab = "items" }: LiveScreenProps & { tab?: string }) {
  const load = useLoad(backend, profileEndpoints.items, GuiProfileSnapshot);
  const [selected, updateSelection] = useState<Entry>();
  const editDirty = useRef(false);
  function setSelected(next: Entry | undefined) {
    if (editDirty.current && !confirm("Discard this item's unsaved changes?")) return false;
    editDirty.current = false;
    updateSelection(next);
    return true;
  }
  const [filter, setFilter] = useState("");
  const [publish, setPublish] = useState(false);
  const [scan, setScan] = useState<Json>();
  const [archive, setArchive] = useState<GuiArchiveDownload>();
  const snapshot = load.value;
  async function exportArchive() {
    const result = await load.run(() => load.request("/api/exports", GuiArchiveDownload, "POST", { includeHarnesses: false }));
    if (!result) return;
    const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mediaType }));
    const link = document.createElement("a"); link.href = url; link.download = result.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setArchive(result);
  }
  return <>
    <PageHeader crumbs={["Profile", tab]} actions={<><Button variant="outline" size="sm" disabled={load.busy} onClick={() => void exportArchive()}>Export</Button><Button variant="outline" size="sm" disabled={load.busy} onClick={() => void load.run(async () => setScan(await load.request(profileEndpoints.scan, Schema.Json, "POST", {})))}>Discover tools</Button><Button size="sm" onClick={() => setPublish(true)}>Publish revision</Button></>} />
    <nav aria-label="Profile sections" className="flex flex-wrap gap-4 border-b border-border py-3">{["items", "harnesses", "groups", "defaults"].map((name) => <a key={name} aria-current={name === tab ? "page" : undefined} className="rounded px-2 py-2 capitalize hover:bg-muted focus-visible:outline-2" href={name === "items" ? "/source/profile" : `/source/profile/${name}`}>{name}</a>)}</nav>
    <div className="grid gap-4 py-4">
      {load.error && <ErrorNotice error={load.error} />}
      <div><Button variant="outline" size="sm" disabled={load.busy} onClick={() => { if (setSelected(undefined)) load.reload(); }}>Reload</Button></div>
      {!snapshot && <p role="status">{load.busy ? "Reading the Canonical Folder…" : "Reload to read the Canonical Folder."}</p>}
      {snapshot && tab === "items" && <>
        <div className="flex flex-wrap items-end gap-3"><Field label="Filter items"><Input className="text-base" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} /></Field><Button variant="outline" onClick={() => setSelected({ id: "", category: "rules" })}>Add item</Button></div>
        <Body detail={selected ? <DetailPanel title={selected.id || "Add item"} onClose={() => setSelected(undefined)}>
          <ItemEditor key={`${selected.id}:${snapshot.items.find((item) => item.path === selected.path)?.digest}:${snapshot.items.find((item) => item.path === "canonfig.jsonc")?.digest}`} backend={backend} snapshot={snapshot} entry={selected} onDirty={(dirty) => { editDirty.current = dirty; }} onSaved={() => { setSelected(undefined); load.reload(); }} onClose={() => setSelected(undefined)} />
        </DetailPanel> : undefined}>
          <ListHead cols="minmax(160px,1fr) minmax(180px,2fr)" minWidth={360}><span>Item</span><span>In the Canonical Folder</span></ListHead>
          {entriesOf(snapshot).filter((entry) => entry.id.toLowerCase().includes(filter.toLowerCase())).map((entry) => <ListRow key={entry.id} cols="minmax(160px,1fr) minmax(180px,2fr)" minWidth={360} selected={selected?.id === entry.id} onClick={() => setSelected(entry)}><span className="truncate font-medium">{entry.id}</span><span className="truncate font-mono text-xs text-muted-foreground">{entry.path ?? `canonfig.jsonc ${entry.configPath?.join(".")}`}</span></ListRow>)}
        </Body>
      </>}
      {snapshot && tab !== "items" && <ConfigEditor key={snapshot.items.find((item) => item.path === "canonfig.jsonc")?.digest} backend={backend} snapshot={snapshot} tab={tab} reload={load.reload} />}
      {scan !== undefined && <section className="grid gap-3"><h2>Discovered tools</h2><p className="text-sm text-muted-foreground">Read-only scan. Selective writes are not supported by the CLI. Review these findings before editing tools.</p><JsonView value={scan} /><Button variant="outline" onClick={() => setScan(undefined)}>Close findings</Button></section>}
      {archive && <details><summary>Export verification</summary><JsonView value={{ filename: archive.filename, sha256: archive.sha256, manifestSha256: archive.manifestSha256, signer: archive.signer }} /></details>}
      {publish && <Publication backend={backend} close={() => setPublish(false)} />}
    </div>
  </>;
}

type DraftFile = { path: string; content: string; encoding: "text" | "base64"; executable: boolean };
function ItemEditor({ backend, snapshot, entry, onSaved, onClose, onDirty }: { backend: WorkspaceBackend; snapshot: GuiProfileSnapshot; entry: Entry; onSaved: () => void; onClose: () => void; onDirty: (dirty: boolean) => void }) {
  const api = useRequest(backend);
  const [category, setCategory] = useState(entry.category);
  const [name, setName] = useState(entry.id.split("/").slice(1).join("/"));
  const item = snapshot.items.find((candidate) => candidate.path === entry.path);
  const initialFiles: DraftFile[] = (item?.files ?? []).map((file) => { try { return { path: file.path, content: decode(file.base64), encoding: "text", executable: file.executable }; } catch { return { path: file.path, content: file.base64, encoding: "base64", executable: file.executable }; } });
  const [files, setFiles] = useState<DraftFile[]>(initialFiles);
  const [json, setJson] = useState(format(entry.value ?? {}));
  const [associated, setAssociated] = useState("[]");
  const groups = object(snapshot.config.groups);
  const [selectedGroups, setSelectedGroups] = useState(Object.entries(groups).filter(([, members]) => strings(members).includes(entry.id)).map(([group]) => group));
  const [dirty, updateDirty] = useState(false);
  const setDirty = (next: boolean) => { updateDirty(next); onDirty(next); };
  useLeaveGuard(dirty, "Discard this item's unsaved changes?");
  const isConfig = CONFIG_CATEGORIES.some((value) => value === category);
  const configDigest = snapshot.items.find((candidate) => candidate.path === "canonfig.jsonc")?.digest ?? null;
  async function save(remove = false) {
    const saved = await api.run(async () => {
      const path = entry.path ?? (category === "instructions" ? "AGENTS.md" : category === "hook-scripts" ? `hooks/${name}` : category === "files" ? `files/${name}` : category === "skills" ? `skills/${name}` : `${category}/${name}.md`);
      const id = entry.id || (category === "instructions" ? "instructions" : `${category}/${name}`);
      const edits: typeof GuiProfileConfigWrite.Type.edits[number][] = [];
      if (isConfig) edits.push(...configEdits(entry.configPath ?? (category === "hooks" ? ["hooks", Array.isArray(snapshot.config.hooks) ? snapshot.config.hooks.length : 0] : [category, name]), entry.value, remove ? undefined : Schema.decodeUnknownSync(Schema.Json)(JSON.parse(json))));
      for (const [group, members] of Object.entries(groups)) {
        const current = strings(members);
        const included = !remove && selectedGroups.includes(group);
        const next = included ? current.includes(id) ? current : [...current, id] : current.filter((member) => member !== id);
        if (format(next) !== format(members)) edits.push({ path: ["groups", group], value: next });
      }
      const changes: typeof GuiProfileWrite.Type.changes[number][] = isConfig ? [] : [{ path, expectedDigest: item?.digest ?? null, files: remove ? [] : files.map((file) => ({ path: file.path, base64: file.encoding === "text" ? encode(file.content) : file.content, executable: file.executable })) }];
      if (isConfig) changes.push(...Schema.decodeUnknownSync(GuiProfileWrite)(JSON.parse(`{"changes":${associated}}`)).changes);
      if (edits.length) await api.request(profileEndpoints.config, GuiProfileSaved, "PUT", { expectedDigest: configDigest, edits, changes });
      else await api.request(profileEndpoints.items, GuiProfileSaved, "PUT", { changes });
      return true;
    });
    if (saved) { setDirty(false); onSaved(); }
  }
  return <><form className="grid min-w-0 gap-4 self-start p-4" onSubmit={(event) => { event.preventDefault(); void save(); }} onChange={() => setDirty(true)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
    {api.error && <ErrorNotice error={api.error} />}
    {!entry.id && <><Field label="Category"><select className="rounded border border-border bg-background p-2 text-base" value={category} onChange={(event) => { setCategory(event.target.value); setFiles([]); setJson(format(event.target.value === "mcp" ? { transport: "stdio", command: "", args: [] } : {})); }}>{[...FILE_CATEGORIES, ...CONFIG_CATEGORIES].map((value) => <option key={value}>{value}</option>)}</select></Field>{category !== "instructions" && <Field label="Name"><Input className="text-base" required value={name} onChange={(event) => setName(event.target.value)} /></Field>}</>}
    {isConfig ? <>{category === "settings" ? <SettingsFields initial={entry.value ?? {}} onChange={setJson} /> : <ConfigFields category={category} text={json} onChange={setJson} />}<details><summary>Associated file changes</summary><p className="py-2 text-sm text-muted-foreground">For resources and hooks, add or remove files in the same save. Each change uses path, expectedDigest (null for a new file), and files with path, base64 and executable. A deletion has an empty files list.</p><Textarea aria-label="Associated file changes JSON" className="min-h-32 font-mono text-base" value={associated} onChange={(event) => setAssociated(event.target.value)} /></details></> : <>
      {files.map((file, index) => <fieldset key={index} className="grid gap-3 border-b border-border pb-4">
        <Field label="File path"><Input className="text-base" value={file.path} onChange={(event) => setFiles(files.map((value, i) => i === index ? { ...value, path: event.target.value } : value))} /></Field>
        {file.encoding === "text" && documentFields(category, file.content)
          ? <DocumentFields category={category} text={file.content} onChange={(content) => setFiles(files.map((value, i) => i === index ? { ...value, content } : value))} />
          : <Field label={`As written (${file.encoding})`}><Textarea className="min-h-56 font-mono text-base" spellCheck={false} value={file.content} onChange={(event) => setFiles(files.map((value, i) => i === index ? { ...value, content: event.target.value } : value))} /></Field>}
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={file.executable} onChange={(event) => setFiles(files.map((value, i) => i === index ? { ...value, executable: event.target.checked } : value))} />Executable</label>
        <Button type="button" variant="outline" onClick={() => { setFiles(files.filter((_, i) => i !== index)); setDirty(true); }}>Remove file from draft</Button>
      </fieldset>)}
      <Button type="button" variant="outline" onClick={() => { setFiles([...files, { path: category === "instructions" ? "AGENTS.md" : category === "skills" ? `skills/${name}/SKILL.md` : category === "hook-scripts" ? `hooks/${name}` : category === "files" ? `files/${name}` : `${category}/${name}.md`, content: "", encoding: "text", executable: false }]); setDirty(true); }}>Add file</Button>
    </>}
    {Object.keys(groups).length > 0 && <fieldset><legend>Follower Groups</legend>{Object.keys(groups).map((group) => <label key={group} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selectedGroups.includes(group)} onChange={(event) => setSelectedGroups(event.target.checked ? [...selectedGroups, group] : selectedGroups.filter((value) => value !== group))} />{group}</label>)}</fieldset>}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={api.busy}>{api.busy ? "Saving…" : "Save changes"}</Button><Button type="button" variant="outline" onClick={onClose}>Discard</Button></div>
    {entry.id && <Button type="button" variant="outline" disabled={api.busy} onClick={() => { if (confirm(`Remove ${entry.id} from the Canonical Folder?`)) void save(true); }}>Remove item</Button>}
  </form>
    {entry.category === "skills" && entry.id && <SkillUpstream backend={backend} name={entry.id.slice(7)} draftDirty={dirty} onUpdated={onSaved} />}
  </>;
}

function ConfigEditor({ backend, snapshot, tab, reload }: { backend: WorkspaceBackend; snapshot: GuiProfileSnapshot; tab: string; reload: () => void }) {
  const api = useRequest(backend);
  const keys = tab === "harnesses" ? ["harnesses", "surfaces"] : tab === "groups" ? ["groups"] : ["profile", "scheduleDefault", "local"];
  const initial = Object.fromEntries(keys.filter((key) => snapshot.config[key] !== undefined).map((key) => [key, snapshot.config[key]!]));
  const [draft, setDraft] = useState<Record<string, Json>>(initial);
  const [dirty, setDirty] = useState(false);
  useLeaveGuard(dirty, "Discard unsaved profile settings?");
  async function save() {
    const saved = await api.run(async () => {
      await api.request(profileEndpoints.config, GuiProfileSaved, "PUT", { expectedDigest: snapshot.items.find((item) => item.path === "canonfig.jsonc")?.digest ?? null, edits: keys.flatMap((key) => configEdits([key], snapshot.config[key], draft[key])), changes: [] });
      return true;
    });
    if (saved) { setDirty(false); reload(); }
  }
  return <form className="grid max-w-4xl gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }} onChange={() => setDirty(true)}>
    {api.error && <ErrorNotice error={api.error} />}
    {tab === "harnesses" ? TARGET_IDS.map((harness) => {
      const selected = strings(draft.harnesses).includes(harness);
      const surfaces = object(draft.surfaces);
      const supported = snapshot.supportedSurfaces[harness]!;
      const gets = surfaces[harness] === undefined ? supported : strings(surfaces[harness]);
      return <fieldset key={harness} className="border-b border-border py-2"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selected} onChange={(event) => { const nextSurfaces = { ...surfaces }; if (!event.target.checked) delete nextSurfaces[harness]; setDraft({ ...draft, harnesses: event.target.checked ? [...strings(draft.harnesses), harness] : strings(draft.harnesses).filter((value) => value !== harness), surfaces: nextSurfaces }); }} />{harness}</label>{selected && <div className="flex flex-wrap gap-x-4"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={supported.every((category) => gets.includes(category))} onChange={(event) => { const next = { ...surfaces }; if (event.target.checked) delete next[harness]; else next[harness] = []; setDraft({ ...draft, surfaces: next }); }} />Everything</label>{SURFACE_CATEGORIES.map((category) => <label key={category} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={!supported.includes(category) && !gets.includes(category)} checked={gets.includes(category)} onChange={(event) => setDraft({ ...draft, surfaces: { ...surfaces, [harness]: event.target.checked ? [...gets, category] : gets.filter((value) => value !== category) } })} />{category}</label>)}</div>}</fieldset>;
    }) : tab === "groups"
      ? <GroupsFields value={draft} references={entriesOf(snapshot).filter((entry) => !["files", "hook-scripts"].includes(entry.category)).map((entry) => entry.id)} onChange={(next) => { setDraft(next); setDirty(true); }} />
      : <DefaultsFields value={draft} onChange={(next) => { setDraft(next); setDirty(true); }} />}
    <div className="flex gap-2"><Button disabled={api.busy || !dirty} type="submit">Save changes</Button><Button variant="outline" type="button" onClick={() => { setDraft(initial); setDirty(false); }}>Discard</Button></div>
  </form>;
}

function Publication({ backend, close }: { backend: WorkspaceBackend; close: () => void }) {
  const api = useRequest(backend);
  const [reviewer, setReviewer] = useState("");
  const [validation, setValidation] = useState<GuiProfileValidation>();
  const [operation, setOperation] = useState<GuiOperation>();
  const [ticket, setTicket] = useState<string>();
  useEffect(() => {
    if (!ticket) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const next = await api.run(() => backend.operation(ticket, controller.signal));
      if (!next || controller.signal.aborted) return;
      setOperation(next);
      if (next.state === "running") timer = setTimeout(() => void poll(), 500);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [backend, ticket]);
  return <section aria-label="Publish revision" className="grid gap-4 border-t border-border py-4"><h2 className="font-medium">Review and publish</h2>{api.error && <ErrorNotice error={api.error} />}{operation?.failure && <ErrorNotice error={new GuiRequestError(operation.failure)} />}
    <Button variant="outline" disabled={api.busy || ticket !== undefined} onClick={() => void api.run(async () => setValidation(await api.request(profileEndpoints.validate, GuiProfileValidation, "POST", {})))}>Validate folder</Button>
    {validation && <><p role="status" className="flex items-center gap-2"><StatusMark kind={validation.valid ? "ok" : "bad"} />{validation.valid ? "Folder and resource validation passed. Publication revalidates content, credentials and signatures before committing." : "Validation failed."}</p><JsonView value={validation} /></>}
    <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void api.run(async () => { const started = await api.request(profileEndpoints.publications, GuiOperationTicket, "POST", { reviewer }); setTicket(started.id); }); }}><Field label="Reviewer"><Input className="text-base" required value={reviewer} onChange={(event) => setReviewer(event.target.value)} /></Field><div className="flex gap-2"><Button type="submit" disabled={api.busy || !validation?.valid || ticket !== undefined}>Confirm publication</Button><Button type="button" variant="outline" onClick={close}>{ticket ? "Close" : "Cancel"}</Button></div></form>
    {ticket && <p role="status" className="flex items-center gap-2"><StatusMark kind={operation?.state === "succeeded" ? "ok" : operation?.state === "failed" ? "bad" : "act"} />{operation?.state ?? "running"}</p>}{operation && <JsonView value={operation} />}
  </section>;
}
function Revisions({ backend }: LiveScreenProps) {
  const load = useLoad(backend, profileEndpoints.revisions, GuiRevisions);
  const [detail, setDetail] = useState<Json>();
  return <><PageHeader crumbs={["Revisions"]} /><div className="grid gap-4 py-4">{load.error && <ErrorNotice error={load.error} />}<Button variant="outline" disabled={load.busy} onClick={load.reload}>Reload</Button>{load.value?.revisions.length === 0 && <p>No revisions published.</p>}{load.value?.revisions.map((revision) => <div key={revision.id} className="grid gap-2 border-b border-border py-3"><button className="break-all text-left focus-visible:outline-2" onClick={() => void load.run(async () => setDetail(await load.request(profileEndpoints.revision, Schema.Json, "POST", { revision: revision.id })))}>Revision {revision.sequence} · {revision.publishedAt}</button><code className="break-all text-xs">{revision.digest}</code><Button variant="outline" size="sm" onClick={() => void copy(revision.digest, "Fingerprint copied")}>Copy fingerprint</Button></div>)}{detail !== undefined && <JsonView value={detail} />}</div></>;
}
function SkillUpstream({ backend, name, draftDirty, onUpdated }: { backend: WorkspaceBackend; name: string; draftDirty: boolean; onUpdated: () => void }) {
  const load = useLoad(backend, profileEndpoints.skills, GuiSkills);
  const [source, setSource] = useState(""); const [ref, setRef] = useState("main"); const [subdir, setSubdir] = useState(".");
  const [checks, setChecks] = useState<typeof GuiSkillChecks.Type>();
  const tracked = load.value?.skills.find((skill) => skill.name === name);
  return <section className="grid gap-3 border-t border-border p-4"><h3>Upstream</h3>{load.error && <ErrorNotice error={load.error} />}{draftDirty && <p className="text-sm">Save or discard this draft before updating from upstream.</p>}{tracked ? <><JsonView value={tracked} /><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={load.busy} onClick={() => void load.run(async () => setChecks(await load.request(profileEndpoints.check, GuiSkillChecks, "POST", { name })))}>Check upstream</Button><Button type="button" variant="outline" disabled={load.busy || draftDirty || !checks?.some((check) => check.status === "update-available")} onClick={() => { if (confirm("Update this skill from upstream? Local edits will block the update. Publish separately to share it.")) void load.run(async () => { await load.request(profileEndpoints.update, GuiSkillChecks, "POST", { name }); onUpdated(); }); }}>Update skill</Button></div></> : <><Field label="Repository URL or local path"><Input className="text-base" value={source} onChange={(event) => setSource(event.target.value)} /></Field><Field label="Branch, tag or commit"><Input className="text-base" value={ref} onChange={(event) => setRef(event.target.value)} /></Field><Field label="Repository subdirectory"><Input className="text-base" value={subdir} onChange={(event) => setSubdir(event.target.value)} /></Field><Button type="button" variant="outline" disabled={load.busy || !source} onClick={() => void load.run(async () => { await load.request(profileEndpoints.track, GuiTrackedSkill, "POST", { name, source, ref, subdir }); load.reload(); })}>Track upstream</Button></>}{checks && <JsonView value={checks} />}</section>;
}
function Secrets({ backend }: LiveScreenProps) {
  const load = useLoad(backend, "/api/secrets", GuiSecrets);
  const [name, setName] = useState(""); const [value, setValue] = useState("");
  return <><PageHeader crumbs={["Secrets"]} /><div className="grid max-w-4xl gap-4 py-4">{load.error && <ErrorNotice error={load.error} />}<Button variant="outline" disabled={load.busy} onClick={load.reload}>Reload</Button><p className="text-sm text-muted-foreground">Values are write-only. Sharing membership changes through a replacement invitation and re-enrollment.</p><ul className="divide-y divide-border">{load.value?.secrets.map((secret) => <li key={secret.name} className="flex flex-wrap items-center gap-3 py-3"><code className="break-all">{secret.name}</code><span className="text-sm text-muted-foreground">{secret.origin}</span><Button variant="outline" size="sm" onClick={() => { setName(secret.name); setValue(""); }}>Replace value</Button><Button variant="outline" size="sm" disabled={load.busy} onClick={() => { if (confirm(`Remove secret ${secret.name}?`)) void load.run(async () => { await load.request("/api/secrets", GuiSecretRemoval, "DELETE", { name: secret.name }); load.reload(); }); }}>Remove</Button></li>)}</ul><form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void load.run(async () => { const secret = value; setValue(""); await load.request("/api/secrets", GuiSecretSummary, "PUT", { name, value: secret }); setName(""); load.reload(); }); }}><Field label="Secret name"><Input className="text-base" value={name} required autoComplete="off" onChange={(event) => setName(event.target.value)} /></Field><Field label="Secret value"><Input className="text-base" type="password" value={value} required autoComplete="new-password" onChange={(event) => setValue(event.target.value)} /></Field><Button type="submit" disabled={load.busy}>Set secret</Button></form></div></>;
}
export const profileScreens: ReadonlyArray<LiveScreen> = [
  ...["items", "harnesses", "groups", "defaults"].map((tab): LiveScreen => ({ title: tab === "items" ? "Profile" : `Profile ${tab}`, path: (role) => role === "source" ? tab === "items" ? "/source/profile" : `/source/profile/${tab}` : undefined, render: (props) => <Profile {...props} tab={tab} /> })),
  { title: "Revisions", path: (role) => role === "source" ? "/source/revisions" : undefined, render: (props) => <Revisions {...props} /> },
  { title: "Secrets", path: (role) => role === "source" ? "/source/secrets" : undefined, render: (props) => <Secrets {...props} /> },
];
