import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { CATEGORY_LABEL, type LocalCategory, type LocalItem } from "../shared/metadata";
import type { FollowerLive } from "./follower-types";
import { DetailPanel, Field, useLeaveGuard } from "./kit";
import { ConfirmDialog } from "./settings";
import { ErrorNotice } from "../live/session";
import { record } from "./live/follower";
import { holdNavigation } from "./routes";
import type { GuiLocalFile, GuiLocalItem } from "../../../src/gui/contract/synchronization";
import { localId } from "../lib/utils";

type FileContent = { kind: "text"; text: string } | { kind: "binary"; base64: string };
type FileDraft = { id: string; path: string; executable: boolean; upload: string | null } & FileContent;
type ConfigCategory = Extract<LocalCategory, "mcp" | "settings">;
type LocalDraft =
  | { kind: "config-entry"; category: ConfigCategory; name: string; json: string }
  | { kind: "file-item"; category: Exclude<LocalCategory, ConfigCategory>; path: string; files: FileDraft[] };
interface DraftBaseline {
  draft: LocalDraft;
  original: GuiLocalItem | undefined;
  configDigest: string | null;
  revision: string | null;
  signature: string;
}
type DraftStatus =
  | { tag: "editing" | "confirming-removal"; draft: LocalDraft }
  | { tag: "failed"; draft: LocalDraft; error: string }
  | { tag: "submitting"; draft: LocalDraft; request: string }
  | { tag: "saved" }
  | { tag: "cancelled" };
type DraftFlow = DraftStatus & { baseline: DraftBaseline };
type DraftEvent =
  | { type: "refresh"; baseline: DraftBaseline }
  | { type: "category"; category: LocalCategory }
  | { type: "name" | "json" | "path"; value: string }
  | { type: "file-path" | "file-text"; id: string; value: string }
  | { type: "executable"; id: string; value: boolean }
  | { type: "add-file" }
  | { type: "remove-file"; id: string }
  | { type: "upload-start"; id: string; request: string }
  | { type: "upload-complete"; id: string; request: string; content: FileContent }
  | { type: "upload-failed"; id: string; request: string; error: string }
  | { type: "confirm-removal" | "keep-item" | "cancel" }
  | { type: "submit"; request: string }
  | { type: "invalid"; error: string }
  | { type: "settled"; request: string; saved: boolean; error: string };

class LocalEditorTransitionError extends Error {
  readonly _tag = "LocalEditorTransitionError";
  constructor(flow: DraftStatus, event: DraftEvent) {
    super(`Cannot ${event.type} in local editor state ${flow.tag}.`);
  }
}
const encode = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));
function fileContent(base64: string): FileContent {
  try { return { kind: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))) }; }
  catch { return { kind: "binary", base64 }; } // Preserve binary skill assets until the person replaces them.
}
function draftFile(file: Pick<typeof GuiLocalFile.Type, "path" | "base64" | "executable">): FileDraft {
  return { id: localId(), path: file.path, executable: file.executable, upload: null, ...fileContent(file.base64) };
}
function newDraft(category: LocalCategory): LocalDraft {
  if (category === "mcp" || category === "settings") return { kind: "config-entry", category, name: "", json: "{}" };
  const path = category === "instructions" ? "AGENTS.md" : category === "skills" ? "skills/new-skill" : category === "plugins" ? "plugins/new-plugin" : `${category}/new-item.md`;
  return { kind: "file-item", category, path, files: [draftFile({ path: category === "skills" ? `${path}/SKILL.md` : category === "plugins" ? `${path}/plugin.jsonc` : path, base64: "", executable: false })] };
}
function draftSignature(draft: LocalDraft) {
  return JSON.stringify(draft.kind === "config-entry" ? draft : { ...draft, files: draft.files.map(({ id: _id, upload: _upload, ...file }) => file) });
}
function localBaseline(live: FollowerLive, item: LocalItem | null): DraftBaseline {
  const original = live.local?.items.find((entry) => entry.path === item?.path);
  const configDigest = live.local?.items.find((entry) => entry.path === "local.jsonc")?.digest ?? null;
  let draft = newDraft(item?.category ?? live.allowed[0] ?? "instructions");
  if (draft.kind === "config-entry" && item) draft = { ...draft, name: item.id.slice(item.category.length + 1), json: JSON.stringify(record(live.local?.config[item.category])[item.id.slice(item.category.length + 1)] ?? {}, null, 2) };
  if (draft.kind === "file-item" && original) draft = { ...draft, path: original.path, files: original.files.map(draftFile) };
  return { draft, original, configDigest, revision: !item || draft.kind === "config-entry" ? configDigest : original?.digest ?? null, signature: draftSignature(draft) };
}

/** Owns draft modes, file identities, pending reads and the submission lifecycle. */
function transition(flow: DraftFlow, event: DraftEvent): DraftFlow {
  const illegal = () => new LocalEditorTransitionError(flow, event);
  const next = (status: DraftStatus): DraftFlow => ({ ...status, baseline: flow.baseline });
  if (event.type === "refresh") {
    if (flow.tag !== "editing" && flow.tag !== "failed") throw illegal();
    return { tag: "editing", draft: event.baseline.draft, baseline: event.baseline };
  }
  if (event.type === "settled") {
    if (flow.tag !== "submitting" || flow.request !== event.request) throw illegal();
    return next(event.saved ? { tag: "saved" } : { tag: "failed", draft: flow.draft, error: event.error });
  }
  if (flow.tag === "saved" || flow.tag === "cancelled" || flow.tag === "submitting") throw illegal();
  const draft = flow.draft;
  if (event.type === "submit") {
    if (draft.kind === "file-item" && draft.files.some((file) => file.upload !== null)) throw illegal();
    return next({ tag: "submitting", draft, request: event.request });
  }
  if (event.type === "cancel") return next({ tag: "cancelled" });
  if (event.type === "keep-item") {
    if (flow.tag !== "confirming-removal") throw illegal();
    return next({ tag: "editing", draft });
  }
  if (flow.tag === "confirming-removal") throw illegal();
  if (event.type === "confirm-removal") return next({ tag: "confirming-removal", draft });
  if (event.type === "invalid") return next({ tag: "failed", draft, error: event.error });
  if (event.type === "category") return next({ tag: "editing", draft: newDraft(event.category) });
  if (event.type === "name" || event.type === "json") {
    if (draft.kind !== "config-entry") throw illegal();
    return next({ tag: "editing", draft: { ...draft, [event.type]: event.value } });
  }
  if (draft.kind !== "file-item") throw illegal();
  if (event.type === "path") return next({ tag: "editing", draft: { ...draft, path: event.value, files: draft.files.map((file) => ({ ...file, path: file.path === draft.path ? event.value : file.path.startsWith(`${draft.path}/`) ? event.value + file.path.slice(draft.path.length) : file.path })) } });
  if (event.type === "add-file") {
    if (draft.category !== "skills" && draft.category !== "plugins") throw illegal();
    return next({ tag: "editing", draft: { ...draft, files: [...draft.files, draftFile({ path: `${draft.path}/`, base64: "", executable: false })] } });
  }
  if (!("id" in event)) throw illegal();
  const file = draft.files.find((entry) => entry.id === event.id);
  if (!file) throw illegal();
  if (event.type === "remove-file") {
    if (draft.category !== "skills" && draft.category !== "plugins") throw illegal();
    return next({ tag: "editing", draft: { ...draft, files: draft.files.filter((entry) => entry.id !== event.id) } });
  }
  let updated: FileDraft;
  switch (event.type) {
    case "file-path":
      if (draft.category !== "skills" && draft.category !== "plugins") throw illegal();
      updated = { ...file, path: event.value }; break;
    case "file-text":
      if (file.kind !== "text") throw illegal();
      updated = { ...file, text: event.value, upload: null }; break;
    case "executable": updated = { ...file, executable: event.value }; break;
    case "upload-start": updated = { ...file, upload: event.request }; break;
    case "upload-complete":
      if (file.upload !== event.request) throw illegal();
      updated = { id: file.id, path: file.path, executable: file.executable, upload: null, ...event.content }; break;
    case "upload-failed":
      if (file.upload !== event.request) throw illegal();
      return next({ tag: "failed", draft: { ...draft, files: draft.files.map((entry) => entry.id === file.id ? { ...entry, upload: null } : entry) }, error: event.error });
  }
  return next({ tag: "editing", draft: { ...draft, files: draft.files.map((entry) => entry.id === file.id ? updated : entry) } });
}

/** The Local screen's detail panel keeps full file trees and config values, including unknown fields. */
export function LocalAuthoringEditor({ live, item, onClose }: { live: FollowerLive; item: LocalItem | null; onClose: () => void }) {
  const [flow, setFlow] = useState<DraftFlow>(() => {
    const baseline = localBaseline(live, item);
    return { tag: "editing", draft: baseline.draft, baseline };
  });
  const baseline = flow.baseline;
  // Event handlers and async completions consult the same synchronous transition owner, including before React renders.
  const current = useRef(flow);
  const send = (event: DraftEvent) => {
    const next = transition(current.current, event);
    current.current = next;
    setFlow(next);
  };
  const revision = live.local?.items.find((entry) => entry.path === (!item || item.category === "mcp" || item.category === "settings" ? "local.jsonc" : item.path))?.digest ?? null;
  // A refreshed disk revision resets an editable generation, never an in-flight submission.
  if ((flow.tag === "editing" || flow.tag === "failed") && revision !== baseline.revision) send({ type: "refresh", baseline: localBaseline(live, item) });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submitting = flow.tag === "submitting";
  const draft = "draft" in flow ? flow.draft : baseline.draft;
  const dirty = draftSignature(draft) !== baseline.signature;
  const { dialog, leaveWithoutAsking } = useLeaveGuard(dirty && !submitting, item?.id ?? "the new local item");
  // A submitting draft cannot be discarded through another route's leave confirmation either.
  useEffect(() => { if (submitting) return holdNavigation(() => current.current.tag === "submitting"); }, [submitting]);
  const close = () => {
    if (current.current.tag === "submitting" || current.current.tag === "saved" || current.current.tag === "cancelled") return;
    onClose();
  };
  const discard = () => {
    send({ type: "cancel" });
    leaveWithoutAsking(onClose);
  };
  const upload = async (id: string, file: File) => {
    const request = localId();
    send({ type: "upload-start", id, request });
    // Removal, a mode change, newer typing or another replacement cancels this read's ownership.
    const ownsRead = () => {
      const latest = current.current;
      return mounted.current && (latest.tag === "editing" || latest.tag === "failed") && latest.draft.kind === "file-item" && latest.draft.files.some((entry) => entry.id === id && entry.upload === request);
    };
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch (error) {
      if (ownsRead()) send({ type: "upload-failed", id, request, error: error instanceof Error ? error.message : "The file could not be read." });
      return;
    }
    if (ownsRead()) send({ type: "upload-complete", id, request, content: fileContent(btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))) });
  };
  const save = async (remove = false) => {
    const snapshot = current.current;
    if (snapshot.tag !== "editing" && snapshot.tag !== "failed" && snapshot.tag !== "confirming-removal") throw new LocalEditorTransitionError(snapshot, { type: "submit", request: "" });
    const submitted = snapshot.draft;
    const { original, configDigest } = baseline;
    let write: () => Promise<boolean>;
    if (remove && item) {
      write = original
        ? () => live.saveItems({ changes: [{ path: original.path, expectedDigest: original.digest, files: [] }] })
        : () => live.savePreferences({ expectedDigest: configDigest, edits: [{ path: [item.category, item.id.slice(item.category.length + 1)] }] });
    } else if (submitted.kind === "config-entry") {
      const { category, name, json } = submitted;
      if (!name.trim()) { send({ type: "invalid", error: "Enter a name." }); return; }
      let parsed: Schema.Json;
      try { parsed = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(json)); }
      catch { send({ type: "invalid", error: "Enter a valid JSON value. Nothing was saved." }); return; }
      const oldName = item?.id.slice(item.category.length + 1);
      if (name !== oldName && Object.hasOwn(record(live.local?.config[category]), name)) { send({ type: "invalid", error: "That name already exists. Choose another name." }); return; }
      const edits: { path: string[]; value?: Schema.Json }[] = [{ path: [category, name], value: parsed }];
      if (oldName && oldName !== name) edits.push({ path: [category, oldName] });
      write = () => live.savePreferences({ expectedDigest: configDigest, edits });
    } else {
      const { path, files } = submitted;
      if (!path.trim()) { send({ type: "invalid", error: "Enter an item path." }); return; }
      if (path !== original?.path && live.local?.items.some((entry) => entry.path === path)) { send({ type: "invalid", error: "That item already exists. Choose another path." }); return; }
      const changes = [{ path, expectedDigest: path === original?.path ? original.digest : null, files: files.map((file) => ({
        path: file.path, executable: file.executable, base64: file.kind === "binary" ? file.base64 : encode(file.text),
      })) }];
      if (original && path !== original.path) changes.push({ path: original.path, expectedDigest: original.digest, files: [] });
      write = () => live.saveItems({ changes });
    }
    const request = localId();
    send({ type: "submit", request });
    let saved: boolean;
    let error = "Nothing was saved. Check the error and retry.";
    try { saved = await write(); }
    catch (cause) { saved = false; error = cause instanceof Error ? cause.message : error; }
    if (!mounted.current) return;
    send({ type: "settled", request, saved, error });
    if (saved) leaveWithoutAsking(onClose);
  };
  if (flow.tag === "saved" || flow.tag === "cancelled") return null;
  const reading = draft.kind === "file-item" && draft.files.some((file) => file.upload !== null);
  return <DetailPanel title={item ? item.id : "Add a local item"} onClose={close} footer={<>
    {item && <Button variant="destructive" size="sm" disabled={submitting || reading || live.action.loading} onClick={() => send({ type: "confirm-removal" })}>Remove…</Button>}
    <div className="ml-auto flex gap-2"><Button variant="ghost" size="sm" disabled={submitting} onClick={discard}>Discard</Button><Button variant="primary" size="sm" disabled={submitting || reading || live.action.loading || (!dirty && item !== null) || (draft.kind === "file-item" && draft.files.length === 0)} onClick={() => { void save(); }}>Save</Button></div>
  </>}>
    <fieldset disabled={submitting} className="min-w-0 space-y-5 p-4">
      {live.action.error && <ErrorNotice error={live.action.error} />}
      {flow.tag === "failed" && <p role="alert" className="text-sm text-bad">{flow.error}</p>}
      {!item && <Field label="Kind" htmlFor="local-kind"><select id="local-kind" className="min-h-10 w-full rounded border border-border bg-background px-3" value={draft.category} onChange={(event) => { const selected = live.allowed.find((entry) => entry === event.target.value); if (selected) send({ type: "category", category: selected }); }}>{live.allowed.map((entry) => <option key={entry} value={entry}>{CATEGORY_LABEL[entry].label}</option>)}</select></Field>}
      {draft.kind === "config-entry" ? <><Field label={draft.category === "mcp" ? "Server name" : "Harness"} htmlFor="local-name"><Input id="local-name" value={draft.name} onChange={(event) => send({ type: "name", value: event.target.value })} /></Field><Field label={draft.category === "mcp" ? "Server configuration" : "Settings keys"} htmlFor="local-value"><Textarea id="local-value" className="min-h-48 font-mono" value={draft.json} onChange={(event) => send({ type: "json", value: event.target.value })} /></Field><p className="text-sm text-muted-foreground">Enter JSON. Canonfig preserves other keys and comments in local.jsonc.</p></> : <>
        <Field label="Item path" htmlFor="local-path"><Input id="local-path" value={draft.path} onChange={(event) => send({ type: "path", value: event.target.value })} /></Field>
        {draft.files.map((file, index) => <div key={file.id} className="space-y-3 border-t border-border pt-4">
          {(draft.category === "skills" || draft.category === "plugins") && <Field label="File path" htmlFor={`local-file-${index}`}><Input id={`local-file-${index}`} value={file.path} onChange={(event) => send({ type: "file-path", id: file.id, value: event.target.value })} /></Field>}
          {file.kind === "binary" ? <p className="text-sm text-muted-foreground">Binary asset. Original bytes are kept.</p> : <Field label="Content" htmlFor={`local-content-${index}`}><Textarea id={`local-content-${index}`} className="min-h-48 font-mono" value={file.text} onChange={(event) => send({ type: "file-text", id: file.id, value: event.target.value })} /></Field>}
          <Field label="Replace with file" htmlFor={`local-upload-${index}`}><Input id={`local-upload-${index}`} type="file" onChange={(event) => { const fileUpload = event.target.files?.[0]; if (fileUpload) void upload(file.id, fileUpload); }} /></Field>
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={file.executable} onChange={(event) => send({ type: "executable", id: file.id, value: event.target.checked })} />Executable</label>
          {(draft.category === "skills" || draft.category === "plugins") && <Button variant="outline" size="sm" onClick={() => send({ type: "remove-file", id: file.id })}>Remove file</Button>}
        </div>)}
        {(draft.category === "skills" || draft.category === "plugins") && <><Button variant="outline" size="sm" onClick={() => send({ type: "add-file" })}>Add file</Button>{draft.files.length === 0 && <p className="text-sm text-muted-foreground">Add a file to save this item. Use Remove to delete it.</p>}</>}
        {draft.category === "plugins" && <p className="text-sm text-muted-foreground">After changing package files, review the new digest with canonfig shield review before activation.</p>}
        <p className="text-sm text-muted-foreground">Save checks the complete item and its digest. Reload after a conflict before retrying.</p>
      </>}
    </fieldset>
    <ConfirmDialog open={flow.tag === "confirming-removal"} onOpenChange={(open) => { if (!open && current.current.tag === "confirming-removal") send({ type: "keep-item" }); }} title={`Remove ${item?.id}?`} body="This deletes the item from the Local folder. The next sync stops projecting it." confirm="Remove" onConfirm={() => { void save(true); }} />
    {dialog}
  </DetailPanel>;
}
