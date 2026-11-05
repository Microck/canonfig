import { useEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { Schema } from "effect";
import { parse } from "jsonc-parser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { GuiRequestError, type WorkspaceBackend } from "../../gui-client";
import { ErrorNotice } from "../../live/session";
import { GuiOperationTicket, type GuiOperation } from "../../../../src/gui/contract/operations";
import { GuiArchiveDownload, GuiBackups, GuiLocalItems, GuiSecrets, GuiSecretSync, type GuiLocalItem } from "../../../../src/gui/contract/synchronization";
import { GuiEnrollment } from "../../../../src/gui/contract/enrollment";
import { TARGET_IDS } from "../../../../src/projection/model";
import { scheduleWeekdays, normalizeSyncSchedule, SyncScheduleSchema, type NormalizedSyncSchedule, type ScheduleWeekday } from "../../../../src/schedule/schedule-manager.types";
import { useLeaveGuard } from "../kit";

type Mutation = { method: "POST" | "PUT" | "DELETE"; body: unknown };
type ScreenProps = { backend: WorkspaceBackend };
const inputClass = "min-h-11 text-base";

interface AreaState {
  report: Schema.Json | undefined;
  snapshot: Schema.Json | undefined;
  error: GuiRequestError | undefined;
  busy: boolean;
  operation: GuiOperation | undefined;
  execute: (path: string, mutation?: Mutation, long?: boolean) => Promise<Schema.Json | undefined>;
  setError: Dispatch<SetStateAction<GuiRequestError | undefined>>;
}

function failure(error: unknown): GuiRequestError {
  return error instanceof GuiRequestError ? error : new GuiRequestError({ category: "internal", exitCode: 1, message: error instanceof Error ? error.message : "The operation failed. Reload before retrying." });
}

/** The connection and polling timer are external resources, cancelled when this screen unmounts. */
function useArea(backend: WorkspaceBackend, initialPath?: string): AreaState {
  const controller = useRef(new AbortController());
  const pending = useRef(false);
  const [report, setReport] = useState<Schema.Json | undefined>();
  const [snapshot, setSnapshot] = useState<Schema.Json>();
  const [error, setError] = useState<GuiRequestError>();
  const [busy, setBusy] = useState(initialPath !== undefined);
  const [operation, setOperation] = useState<GuiOperation>();
  const execute = async (path: string, mutation?: Mutation, long = false) => {
    if (pending.current) return;
    const signal = controller.current.signal;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setOperation(undefined);
    try {
      if (!long) {
        const result = await backend.request(path, Schema.Json, signal, mutation);
        setReport(result);
        if (path === initialPath) setSnapshot(result);
        if (initialPath === "/api/local/items" && mutation) {
          const items = path === "/api/local/items" || path === "/api/local/preferences"
            ? Schema.decodeUnknownSync(GuiLocalItems)(result)
            : await backend.request(initialPath, GuiLocalItems, signal);
          setSnapshot(items);
        }
        if (initialPath === "/api/secrets" && mutation) {
          setSnapshot(await backend.request(initialPath, GuiSecrets, signal));
        }
        return result;
      }
      setReport(undefined);
      const ticket = await backend.request(path, GuiOperationTicket, signal, mutation);
      let current = await backend.operation(ticket.id, signal);
      setOperation(current);
      while (current.state === "running") {
        signal.throwIfAborted();
        // The browser target is ES2022, before Promise.withResolvers.
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
          signal.addEventListener("abort", abort, { once: true });
        });
        current = await backend.operation(ticket.id, signal);
        setOperation(current);
      }
      setReport(current.result ?? current.journal);
      if (current.failure) throw new GuiRequestError(current.failure);
      return current.result;
    } catch (cause) {
      if (!signal.aborted) setError(failure(cause));
    } finally {
      if (!signal.aborted) { pending.current = false; setBusy(false); }
    }
  };
  useEffect(() => {
    const connection = new AbortController();
    controller.current = connection;
    pending.current = false;
    if (initialPath) {
      pending.current = true;
      void backend.request(initialPath, Schema.Json, connection.signal).then((value) => {
        if (!connection.signal.aborted) { setReport(value); setSnapshot(value); }
      }).catch((cause) => {
        if (!connection.signal.aborted) setError(failure(cause));
      }).finally(() => {
        if (!connection.signal.aborted) { pending.current = false; setBusy(false); }
      });
    }
    return () => connection.abort();
  }, [backend, initialPath]);
  return { report, snapshot, error, busy, operation, execute, setError };
}

function Evidence({ value }: { value: Schema.Json | undefined }) {
  if (value === undefined) return null;
  if (value === null) return <p className="py-2 text-muted-foreground">None</p>;
  if (typeof value !== "object") return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{String(value)}</span>;
  if (Array.isArray(value)) return value.length === 0 ? <p className="py-2 text-muted-foreground">None</p> : <ul className="divide-y divide-border">{value.map((entry, index) => <li className="py-2" key={index}><Evidence value={entry} /></li>)}</ul>;
  return <dl className="divide-y divide-border">{Object.entries(value).map(([key, entry]) => <div key={key} className="grid gap-1 py-2 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4"><dt className="text-muted-foreground [overflow-wrap:anywhere]">{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd className="min-w-0"><Evidence value={entry} /></dd></div>)}</dl>;
}

function Panel({ area, children, reload }: { area: AreaState; children: ReactNode; reload?: string }) {
  return <div className="grid min-w-0 gap-5">
    {area.error && <ErrorNotice error={area.error} />}
    {children}
    <div className="flex flex-wrap items-center gap-3">
      {reload && <Button variant="outline" disabled={area.busy} onClick={() => void area.execute(reload)}>Reload</Button>}
      <p role="status" className="text-sm text-muted-foreground">{area.busy ? "Working…" : area.operation ? `Operation ${area.operation.state}` : ""}</p>
    </div>
    <Evidence value={area.report} />
  </div>;
}

export function SynchronizationScreen({ backend }: ScreenProps) {
  const area = useArea(backend);
  const run = (path: string) => void area.execute(path, { method: "POST", body: {} }, true);
  return <Panel area={area}>
    <div className="flex flex-wrap gap-2"><Button disabled={area.busy} onClick={() => run("/api/sync/plan")}>Check for updates</Button><Button variant="outline" disabled={area.busy || area.report === undefined} onClick={() => { if (confirm("Apply the current desired configuration? Canonfig checks drift again before writing.")) run("/api/sync/apply"); }}>Apply changes</Button></div>
    <p className="max-w-prose text-sm text-muted-foreground">Held items keep their last applied state. Resolve drift by moving your edits into the Local folder, asking the Source to publish them, or restoring the published content. Canonfig does not force an overwrite.</p>
    <a className="w-fit underline" href="/follower/local-settings">Resolve local item collisions and overlays</a>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={area.busy} onClick={() => { if (confirm("Recover the interrupted run? This resumes its recorded writes.")) run("/api/recovery"); }}>Recover</Button><Button variant="outline" disabled={area.busy} onClick={() => { if (confirm("Abandon the interrupted run? Applied changes stay in place; nothing is rolled back.")) run("/api/recovery/abandon"); }}>Abandon</Button><Button variant="outline" disabled={area.busy} onClick={() => run("/api/sync/plan")}>Check again</Button></div>
    <section className="border-t border-border pt-4"><h2 className="font-medium">Adoption review</h2><p className="my-2 max-w-prose text-sm text-muted-foreground">Create the CLI's private review files before first adoption. Their contents stay on this machine and are not displayed here.</p><Button variant="outline" disabled={area.busy} onClick={() => run("/api/sync/reviews")}>Create private review</Button></section>
  </Panel>;
}

export function SynchronizationSchedule({ backend }: ScreenProps) {
  const area = useArea(backend, "/api/schedule");
  const status = Schema.decodeUnknownOption(Schema.Struct({ schedule: Schema.optionalKey(SyncScheduleSchema) }))(area.report);
  const schedule = status._tag === "Some" && status.value.schedule ? normalizeSyncSchedule(status.value.schedule) : undefined;
  return <Panel area={area} reload="/api/schedule">
    {area.report !== undefined && <ScheduleForm key={JSON.stringify(schedule)} area={area} schedule={schedule} />}
  </Panel>;
}

function ScheduleForm({ area, schedule }: { area: AreaState; schedule: NormalizedSyncSchedule | undefined }) {
  const [cadence, setCadence] = useState<"default" | NormalizedSyncSchedule["kind"]>(schedule?.kind ?? "default");
  const [time, setTime] = useState(schedule && schedule.kind !== "custom" ? schedule.localTime : "09:00");
  const [days, setDays] = useState<readonly ScheduleWeekday[]>(schedule?.kind === "weekly" ? schedule.weekdays : ["Mon"]);
  const [expression, setExpression] = useState(schedule?.kind === "custom" ? schedule.expression : "");
  const save = () => {
    if (cadence === "default") {
      void area.execute("/api/schedule", { method: "PUT", body: { profileDefault: true } });
      return;
    }
    let selected: NormalizedSyncSchedule;
    switch (cadence) {
      case "custom": selected = { kind: "custom", expression, timezone: schedule?.timezone }; break;
      case "weekly": selected = { kind: "weekly", weekdays: days, localTime: time, timezone: schedule?.timezone }; break;
      case "daily": selected = { kind: "daily", localTime: time, timezone: schedule?.timezone }; break;
    }
    void area.execute("/api/schedule", { method: "PUT", body: { schedule: selected } });
  };
  return <form className="grid max-w-xl gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
    <label className="grid gap-2">Cadence
      <select className="min-h-11 rounded border border-border bg-background px-3 text-base" value={cadence} onChange={(event) => {
        const selected = (["default", "daily", "weekly", "custom"] as const).find((value) => value === event.target.value);
        if (selected) setCadence(selected);
      }}>
        <option value="default">Source default</option><option value="daily">Daily</option>
        <option value="weekly">Weekly</option><option value="custom">Custom expression</option>
      </select>
    </label>
    {(cadence === "daily" || cadence === "weekly") && <label className="grid gap-2">Local time
      <Input className={inputClass} type="time" required value={time} onChange={(event) => setTime(event.target.value)} />
    </label>}
    {cadence === "weekly" && <fieldset>
      <legend className="mb-2">Days</legend>
      <div className="flex flex-wrap gap-3">{scheduleWeekdays.map((day) => <label className="flex min-h-11 items-center gap-2" key={day}>
        <input type="checkbox" checked={days.includes(day)} onChange={(event) => setDays(event.target.checked ? [...days, day] : days.filter((value) => value !== day))} />{day}
      </label>)}</div>
    </fieldset>}
    {cadence === "custom" && <label className="grid gap-2">Schedule expression
      <Input className={inputClass} required value={expression} onChange={(event) => setExpression(event.target.value)} />
    </label>}
    <Button variant="primary" className="w-fit" disabled={area.busy} type="submit">Save schedule</Button>
  </form>;
}

const encode = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));
const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
interface FileDraft { path: string; base64: string; text: string | undefined; executable: boolean }

function fileDraft(file: Pick<GuiLocalItem["files"][number], "path" | "base64" | "executable">): FileDraft {
  const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0));
  let text: string | undefined;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { /* Binary skill assets stay byte-for-byte intact unless replaced by an upload. */ }
  return { ...file, text };
}

function LocalEditor({ item, items, area, close }: { item: GuiLocalItem; items: readonly GuiLocalItem[]; area: AreaState; close: () => void }) {
  const [path, setPath] = useState(item.path);
  const [initialFiles] = useState<FileDraft[]>(() => item.files.length ? item.files.map(fileDraft) : [{ path: item.path, base64: "", text: "", executable: false }]);
  const [files, setFiles] = useState(initialFiles);
  const dirty = path !== item.path || files.length !== initialFiles.length || files.some((file, index) => {
    const original = initialFiles[index];
    return !original || file.path !== original.path || file.base64 !== original.base64 || file.text !== original.text || file.executable !== original.executable;
  });
  const { dialog } = useLeaveGuard(dirty, item.path || "this local item");
  const save = async () => {
    if (path !== item.path && items.some((entry) => entry.path === path)) {
      area.setError(new GuiRequestError({ category: "usage-or-configuration", exitCode: 2, message: `${path} already exists. Choose another name.` }));
      return;
    }
    const changes = [{
      path, expectedDigest: path === item.path ? item.digest : null,
      files: files.map((file) => ({
        path: file.path === item.path ? path : file.path.startsWith(`${item.path}/`) ? path + file.path.slice(item.path.length) : file.path,
        base64: file.text === undefined ? file.base64 : encode(file.text), executable: file.executable,
      })),
    }];
    if (path !== item.path && item.digest !== null) changes.push({ path: item.path, expectedDigest: item.digest, files: [] });
    if (files.length === 0 && !confirm(`Delete ${item.path}? The item has no files.`)) return;
    const saved = await area.execute("/api/local/items", { method: "PUT", body: { changes } });
    if (saved !== undefined) close();
  };
  return <form className="grid gap-4 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label className="grid gap-2">Item path<Input className={inputClass} required value={path} onChange={(event) => setPath(event.target.value)} placeholder="rules/my-rule.md" /></label>
    {files.map((file, index) => <fieldset key={index} className="grid gap-2">
      <label className="grid gap-2">File path<Input className={inputClass} required value={file.path} onChange={(event) => setFiles(files.map((value, position) => position === index ? { ...value, path: event.target.value } : value))} /></label>
      {file.text === undefined ? <p>Binary asset. Its original bytes will be preserved.</p> : <label className="grid gap-2">Content<Textarea className="min-h-48 font-mono text-base" value={file.text} onChange={(event) => setFiles(files.map((value, position) => position === index ? { ...value, text: event.target.value } : value))} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void save(); } }} /></label>}
      <label className="grid gap-2">Replace with file<Input type="file" className={inputClass} onChange={async (event) => {
        const uploaded = event.target.files?.[0];
        if (!uploaded) return;
        const base64 = btoa(Array.from(new Uint8Array(await uploaded.arrayBuffer()), (byte) => String.fromCharCode(byte)).join(""));
        setFiles((current) => current.map((entry, position) => position === index ? fileDraft({ ...entry, base64 }) : entry));
      }} /></label>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={file.executable} onChange={(event) => setFiles(files.map((value, position) => position === index ? { ...value, executable: event.target.checked } : value))} />Executable</label>
      <Button type="button" variant="outline" className="w-fit" onClick={() => setFiles(files.filter((_, position) => position !== index))}>Remove file from item</Button>
    </fieldset>)}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" onClick={() => setFiles([...files, { path: `${path}/`, base64: "", text: "", executable: false }])}>Add file to skill</Button>
      <Button type="submit" disabled={area.busy}>Save item</Button>
      <Button type="button" variant="outline" onClick={close}>Discard</Button>
    </div>
    {dialog}
  </form>;
}

export function SynchronizationLocal({ backend }: ScreenProps) {
  const area = useArea(backend, "/api/local/items");
  const decoded = Schema.decodeUnknownOption(GuiLocalItems)(area.snapshot);
  const items = decoded._tag === "Some" ? decoded.value.items : [];
  const config = items.find((item) => item.path === "local.jsonc");
  const [editing, setEditing] = useState<GuiLocalItem>();
  const [overlay, setOverlay] = useState("");
  const [configKey, setConfigKey] = useState("mcp");
  const [configValue, setConfigValue] = useState("{}");
  const [backupDraft, setBackup] = useState<boolean>();
  const localConfig = Schema.decodeUnknownOption(Schema.Struct({ backups: Schema.optionalKey(Schema.Boolean) }))(
    parse(config?.files[0] ? decode(config.files[0].base64) : "{}"),
  );
  const backup = backupDraft ?? (localConfig._tag === "Some" ? localConfig.value.backups ?? true : true);
  const [harness, setHarness] = useState<(typeof TARGET_IDS)[number]>("codex");
  const saveConfig = (path: string[], value: Schema.Json | undefined) => area.execute("/api/local/preferences", {
    method: "PUT",
    body: { expectedDigest: config?.digest ?? null, edits: [{ path, ...(value === undefined ? {} : { value }) }] },
  });
  return <div className="grid gap-6">
    {area.error && <ErrorNotice error={area.error} />}
    <div className="flex flex-wrap gap-2">
      <Button disabled={area.busy} onClick={() => setEditing({ path: "AGENTS.md", digest: null, files: [] })}>Add local item</Button>
      <Button variant="outline" disabled={area.busy} onClick={() => {
        setEditing(undefined); setBackup(undefined); void area.execute("/api/local/items");
      }}>Reload</Button>
      <ExportButton backend={backend} />
    </div>
    <p className="max-w-prose text-sm text-muted-foreground">
      Items stay in this machine's Local folder. The Source's local.allow policy applies to every save.
      A stale edit must be reloaded before saving.
    </p>
    <ul className="divide-y divide-border">{items.filter((item) => item.path !== "local.jsonc").map((item) =>
      <li key={item.path} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <span className="font-mono [overflow-wrap:anywhere]">{item.path}</span>
        <div className="flex gap-2">
          <Button variant="outline" disabled={area.busy} onClick={() => setEditing(item)}>Edit</Button>
          <Button variant="outline" disabled={area.busy} onClick={() => {
            if (confirm(`Delete ${item.path} from the Local folder?`)) {
              void area.execute("/api/local/items", { method: "PUT", body: {
                changes: [{ path: item.path, expectedDigest: item.digest, files: [] }],
              } });
            }
          }}>Delete</Button>
        </div>
      </li>,
    )}</ul>
    {editing && <LocalEditor key={editing.path + editing.digest} item={editing} items={items} area={area} close={() => setEditing(undefined)} />}
    <section className="grid gap-3 border-t border-border pt-4">
      <h2 className="font-medium">MCP servers and settings</h2>
      <p className="text-sm text-muted-foreground">
        Edit one local.jsonc key without replacing its comments. Use mcp or settings for the complete
        object, or a dotted key such as settings.codex.model.
      </p>
      <form className="grid gap-3" onSubmit={(event) => {
        event.preventDefault();
        try {
          const value = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(configValue));
          void saveConfig(configKey.split("."), value);
        } catch {
          area.setError(new GuiRequestError({
            category: "usage-or-configuration", exitCode: 2, message: "Enter valid JSON for the setting value.",
          }));
        }
      }}>
        <label className="grid gap-2">Configuration key
          <Input className={inputClass} required value={configKey} onChange={(event) => setConfigKey(event.target.value)} />
        </label>
        <label className="grid gap-2">JSON value
          <Textarea className="min-h-28 font-mono text-base" value={configValue} onChange={(event) => setConfigValue(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button disabled={area.busy} type="submit">Save configuration</Button>
          <Button variant="outline" disabled={area.busy} type="button" onClick={() => {
            if (confirm(`Remove ${configKey}?`)) void saveConfig(configKey.split("."), undefined);
          }}>Remove key</Button>
        </div>
      </form>
      {config && <details>
        <summary className="cursor-pointer py-3">As written</summary>
        <pre className="overflow-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{config.files.map((file) => decode(file.base64)).join("\n")}</pre>
      </details>}
    </section>
    <section className="grid gap-3 border-t border-border pt-4">
      <h2 className="font-medium">Overlays and key claims</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        An overlay replaces a published item with its local item. A key claim such as settings/codex#model
        leaves that harness key to you. Removing a claim lets the next sync write the published value.
      </p>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => {
        event.preventDefault();
        void area.execute("/api/local/overlays", { method: "PUT", body: { item: overlay } });
      }}>
        <label className="grid min-w-0 flex-1 gap-2">Item or key claim
          <Input className={inputClass} required value={overlay} onChange={(event) => setOverlay(event.target.value)} placeholder="rules/my-rule" />
        </label>
        <Button className="self-end" disabled={area.busy} type="submit">Set overlay</Button>
        <Button className="self-end" variant="outline" disabled={area.busy} type="button" onClick={() => {
          if (confirm(`Remove ${overlay}?`)) void area.execute("/api/local/overlays", { method: "DELETE", body: { item: overlay } });
        }}>Remove overlay</Button>
        <Button className="self-end" variant="outline" type="button" disabled={area.busy} onClick={() => void area.execute("/api/local/overlays")}>List overlays</Button>
      </form>
    </section>
    <section className="grid gap-3 border-t border-border pt-4">
      <h2 className="font-medium">Managed harnesses</h2>
      <label className="grid gap-2">Harness
        <select className="min-h-11 rounded border border-border bg-background px-3 text-base" value={harness} onChange={(event) => {
          const selected = TARGET_IDS.find((id) => id === event.target.value);
          if (selected) setHarness(selected);
        }}>{TARGET_IDS.map((id) => <option key={id}>{id}</option>)}</select>
      </label>
      <div className="flex flex-wrap gap-2">
        {(["include", "exclude"] as const).map((action) => <Button key={action} variant="outline" disabled={area.busy} onClick={() =>
          void area.execute("/api/harnesses", { method: "PUT", body: { harness, action } })
        }>{action === "include" ? "Include harness" : "Exclude harness"}</Button>)}
        <Button variant="outline" disabled={area.busy} onClick={() => void area.execute("/api/harnesses")}>Read harness status</Button>
      </div>
    </section>
    <section className="grid gap-3 border-t border-border pt-4">
      <h2 className="font-medium">Takeover backups</h2>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={backup} onChange={(event) => setBackup(event.target.checked)} />Keep takeover backups
      </label>
      <Button className="w-fit" disabled={area.busy} onClick={() => {
        if (backup || confirm("Disable takeover backups on this machine? Future takeovers will not preserve the prior content.")) {
          void saveConfig(["backups"], backup);
        }
      }}>Save backup preference</Button>
    </section>
    <p role="status" className="text-sm text-muted-foreground">{area.busy ? "Working…" : ""}</p>
    {!Schema.is(GuiLocalItems)(area.report) && <Evidence value={area.report} />}
  </div>;
}

export function ExportButton({ backend }: ScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GuiRequestError>();
  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const archive = await backend.request("/api/exports", GuiArchiveDownload, new AbortController().signal, {
        method: "POST", body: { includeHarnesses: false },
      });
      const bytes = Uint8Array.from(atob(archive.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: archive.mediaType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = archive.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };
  return <>
    <Button variant="outline" disabled={busy} onClick={() => void download()}>{busy ? "Exporting…" : "Export"}</Button>
    {error && <ErrorNotice error={error} />}
  </>;
}

export function SynchronizationBackups({ backend }: ScreenProps) {
  const area = useArea(backend, "/api/backups");
  const decoded = Schema.decodeUnknownOption(GuiBackups)(area.report);
  return <Panel area={{ ...area, report: decoded._tag === "Some" ? undefined : area.report }} reload="/api/backups"><p className="max-w-prose text-sm text-muted-foreground">Restore checks current ownership and drift. A successful harness restore excludes that harness so the next sync does not take it over again.</p>{decoded._tag === "Some" && <ul className="divide-y divide-border">{decoded.value.snapshots.length === 0 && <li>No takeover snapshots exist on this machine.</li>}{decoded.value.snapshots.map((snapshot) => <li key={snapshot} className="flex flex-wrap items-center justify-between gap-3 py-3"><span className="font-mono">{snapshot}</span><Button variant="outline" disabled={area.busy} onClick={() => { if (confirm(`Restore takeover snapshot ${snapshot}? This changes managed files and may exclude harnesses.`)) void area.execute("/api/backups/restore", { method: "POST", body: { snapshot } }, true); }}>Restore</Button></li>)}</ul>}</Panel>;
}

export function SynchronizationSecrets({ backend }: ScreenProps) {
  const area = useArea(backend, "/api/secrets");
  const decoded = Schema.decodeUnknownOption(GuiSecrets)(area.snapshot);
  return <Panel area={{ ...area, report: Schema.is(GuiSecretSync)(area.report) ? area.report : undefined }} reload="/api/secrets">
    <div><Button disabled={area.busy} onClick={() => void area.execute("/api/secrets/sync", { method: "POST", body: {} })}>Update secrets</Button></div>
    <p className="text-sm text-muted-foreground">Only secret names and origins appear here. Values stay in the credential store.</p>
    {decoded._tag === "Some" && <ul className="divide-y divide-border">
      {decoded.value.secrets.length === 0 && <li>No shared secrets are stored on this machine.</li>}
      {decoded.value.secrets.map((secret) => <li className="flex justify-between gap-4 py-3" key={secret.name}>
        <span className="font-mono">{secret.name}</span><span>{secret.origin}</span>
      </li>)}
    </ul>}
  </Panel>;
}

export function SynchronizationTunnel({ backend }: ScreenProps) {
  const area = useArea(backend, "/api/tunnel");
  return <Panel area={area} reload="/api/tunnel"><p className="max-w-prose text-sm text-muted-foreground">Start uses the recorded tunnel configuration. First-time SSH configuration is part of enrollment. Stop keeps that configuration.</p><div className="flex flex-wrap gap-2"><Button disabled={area.busy} onClick={() => void area.execute("/api/tunnel/start", { method: "POST", body: {} })}>Start tunnel</Button><Button variant="outline" disabled={area.busy} onClick={() => { if (confirm("Stop this machine's managed tunnel? Synchronization cannot reach its Source through this tunnel until it starts again.")) void area.execute("/api/tunnel/stop", { method: "POST", body: {} }); }}>Stop tunnel</Button></div></Panel>;
}

export function SynchronizationEnrollment({ backend }: ScreenProps) {
  const area = useArea(backend, "/api/enrollment");
  const enrollment = Schema.decodeUnknownOption(GuiEnrollment)(area.report);
  const [copied, setCopied] = useState<string>();
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch (cause) {
      area.setError(failure(cause));
    }
  };
  return <Panel area={area} reload="/api/enrollment">
    <p className="max-w-prose text-sm text-muted-foreground">
      Unenroll revokes the follower when its Source answers, removes the local credential and received
      secrets, and deletes its enrollment record. Applied files, the native schedule and tunnel
      configuration stay in place. Use canonfig schedule remove and canonfig tunnel stop --forget separately.
    </p>
    {enrollment._tag === "Some" && <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => void copy("Signing fingerprint", enrollment.value.source.signingFingerprint)}>Copy signing fingerprint</Button>
      <Button variant="outline" onClick={() => void copy("TLS fingerprint", enrollment.value.source.tlsFingerprint)}>Copy TLS fingerprint</Button>
      {copied && <p role="status">{copied} copied</p>}
    </div>}
    <div><Button variant="outline" disabled={area.busy} onClick={() => {
      if (confirm("Unenroll this machine? Its applied files, native schedule and tunnel configuration stay in place.")) {
        void area.execute("/api/enrollment", { method: "DELETE", body: {} });
      }
    }}>Unenroll this machine</Button></div>
  </Panel>;
}
