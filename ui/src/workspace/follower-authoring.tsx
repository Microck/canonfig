import { useState } from "react";
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
import type { GuiLocalFile } from "../../../src/gui/contract/synchronization";

interface FileDraft { path: string; base64: string; text: string | undefined; executable: boolean }
const encode = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));
function draftFile(file: Pick<typeof GuiLocalFile.Type, "path" | "base64" | "executable">): FileDraft {
  let text: string | undefined;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0))); }
  catch { /* Keep binary skill assets unchanged unless the person replaces them. */ }
  return { ...file, text };
}

/** The Local screen's detail panel keeps full file trees and config values, including unknown fields. */
export function LocalAuthoringEditor({ live, item, onClose }: { live: FollowerLive; item: LocalItem | null; onClose: () => void }) {
  const original = live.local?.items.find((entry) => entry.path === item?.path);
  const [configDigest] = useState(() => live.local?.items.find((entry) => entry.path === "local.jsonc")?.digest ?? null);
  const [category, setCategory] = useState<LocalCategory>(item?.category ?? live.allowed[0] ?? "instructions");
  const [name, setName] = useState(item?.id.slice(item.category.length + 1) ?? "");
  const [path, setPath] = useState(original?.path ?? (category === "instructions" ? "AGENTS.md" : category === "skills" ? "skills/new-skill" : `${category}/new-item.md`));
  const [files, setFiles] = useState<FileDraft[]>(() => original?.files.map(draftFile) ?? [{ path: category === "skills" ? `${path}/SKILL.md` : path, base64: "", text: "", executable: false }]);
  const [value, setValue] = useState(() => JSON.stringify(item ? record(live.local?.config[item.category])[item.id.slice(item.category.length + 1)] ?? {} : {}, null, 2));
  const [problem, setProblem] = useState("");
  const [removing, setRemoving] = useState(false);
  const [initial] = useState(() => ({ path, files, name, category, value }));
  const dirty = JSON.stringify({ path, files, name, category, value }) !== JSON.stringify(initial);
  const { dialog, leaveWithoutAsking } = useLeaveGuard(dirty, item?.id ?? "the new local item");
  const configItem = category === "mcp" || category === "settings";
  const selectCategory = (next: LocalCategory) => {
    setCategory(next);
    const nextPath = next === "instructions" ? "AGENTS.md" : next === "skills" ? "skills/new-skill" : `${next}/new-item.md`;
    setPath(nextPath);
    setFiles([{ path: next === "skills" ? `${nextPath}/SKILL.md` : nextPath, base64: "", text: "", executable: false }]);
  };
  const save = async (remove = false) => {
    setProblem("");
    let saved: boolean;
    if (remove && item) {
      saved = original
        ? await live.saveItems({ changes: [{ path: original.path, expectedDigest: original.digest, files: [] }] })
        : await live.savePreferences({ expectedDigest: configDigest, edits: [{ path: [item.category, item.id.slice(item.category.length + 1)] }] });
    } else if (configItem) {
      if (!name.trim()) { setProblem("Enter a name."); return; }
      let parsed: Schema.Json | undefined;
      try { parsed = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(value)); }
      catch { setProblem("Enter a valid JSON value. Nothing was saved."); return; }
      const oldName = item?.id.slice(item.category.length + 1);
      if (name !== oldName && Object.hasOwn(record(live.local?.config[category]), name)) { setProblem("That name already exists. Choose another name."); return; }
      const edits: { path: string[]; value?: Schema.Json }[] = [{ path: [category, name], value: parsed }];
      if (oldName && oldName !== name) edits.push({ path: [category, oldName] });
      saved = await live.savePreferences({ expectedDigest: configDigest, edits });
    } else {
      if (!path.trim()) { setProblem("Enter an item path."); return; }
      if (path !== original?.path && live.local?.items.some((entry) => entry.path === path)) { setProblem("That item already exists. Choose another path."); return; }
      const changes = [{ path, expectedDigest: path === original?.path ? original.digest : null, files: files.map((file) => ({
        path: file.path,
        executable: file.executable, base64: file.text === undefined ? file.base64 : encode(file.text),
      })) }];
      if (original && path !== original.path) changes.push({ path: original.path, expectedDigest: original.digest, files: [] });
      saved = await live.saveItems({ changes });
    }
    if (saved) leaveWithoutAsking(onClose);
  };
  return <DetailPanel title={item ? item.id : "Add a local item"} onClose={onClose} footer={<>
    {item && <Button variant="destructive" size="sm" disabled={live.action.loading} onClick={() => setRemoving(true)}>Remove…</Button>}
    <div className="ml-auto flex gap-2"><Button variant="ghost" size="sm" onClick={() => leaveWithoutAsking(onClose)}>Discard</Button><Button variant="primary" size="sm" disabled={live.action.loading || (!dirty && item !== null) || (!configItem && files.length === 0)} onClick={() => { void save(); }}>Save</Button></div>
  </>}>
    <div className="space-y-5 p-4">
      {live.action.error && <ErrorNotice error={live.action.error} />}
      {problem && <p role="alert" className="text-sm text-bad">{problem}</p>}
      {!item && <Field label="Kind" htmlFor="local-kind"><select id="local-kind" className="min-h-10 w-full rounded border border-border bg-background px-3" value={category} onChange={(event) => { const selected = live.allowed.find((entry) => entry === event.target.value); if (selected) selectCategory(selected); }}>{live.allowed.map((entry) => <option key={entry} value={entry}>{CATEGORY_LABEL[entry].label}</option>)}</select></Field>}
      {configItem ? <><Field label={category === "mcp" ? "Server name" : "Harness"} htmlFor="local-name"><Input id="local-name" value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label={category === "mcp" ? "Server configuration" : "Settings keys"} htmlFor="local-value"><Textarea id="local-value" className="min-h-48 font-mono" value={value} onChange={(event) => setValue(event.target.value)} /></Field><p className="text-sm text-muted-foreground">Enter JSON. Canonfig preserves other keys and comments in local.jsonc.</p></> : <>
        <Field label="Item path" htmlFor="local-path"><Input id="local-path" value={path} onChange={(event) => {
          const nextPath = event.target.value;
          setFiles((current) => current.map((file) => ({ ...file, path: file.path === path ? nextPath : file.path.startsWith(`${path}/`) ? nextPath + file.path.slice(path.length) : file.path })));
          setPath(nextPath);
        }} /></Field>
        {files.map((file, index) => <div key={index} className="space-y-3 border-t border-border pt-4">
          {category === "skills" && <Field label="File path" htmlFor={`local-file-${index}`}><Input id={`local-file-${index}`} value={file.path} onChange={(event) => setFiles(files.map((entry, position) => position === index ? { ...entry, path: event.target.value } : entry))} /></Field>}
          {file.text === undefined ? <p className="text-sm text-muted-foreground">Binary asset. Original bytes are kept.</p> : <Field label="Content" htmlFor={`local-content-${index}`}><Textarea id={`local-content-${index}`} className="min-h-48 font-mono" value={file.text} onChange={(event) => setFiles(files.map((entry, position) => position === index ? { ...entry, text: event.target.value } : entry))} /></Field>}
          <Field label="Replace with file" htmlFor={`local-upload-${index}`}><Input id={`local-upload-${index}`} type="file" onChange={async (event) => { const upload = event.target.files?.[0]; if (!upload) return; const base64 = btoa(Array.from(new Uint8Array(await upload.arrayBuffer()), (byte) => String.fromCharCode(byte)).join("")); setFiles((current) => current.map((entry, position) => position === index ? draftFile({ ...entry, base64 }) : entry)); }} /></Field>
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={file.executable} onChange={(event) => setFiles(files.map((entry, position) => position === index ? { ...entry, executable: event.target.checked } : entry))} />Executable</label>
          {category === "skills" && <Button variant="outline" size="sm" onClick={() => setFiles(files.filter((_, position) => position !== index))}>Remove file</Button>}
        </div>)}
        {category === "skills" && <><Button variant="outline" size="sm" onClick={() => setFiles([...files, { path: `${path}/`, base64: "", text: "", executable: false }])}>Add file</Button>{files.length === 0 && <p className="text-sm text-muted-foreground">Add a file to save this skill. Use Remove to delete the item.</p>}</>}
        <p className="text-sm text-muted-foreground">Save checks the complete item and its digest. Reload after a conflict before retrying.</p>
      </>}
    </div>
    <ConfirmDialog open={removing} onOpenChange={setRemoving} title={`Remove ${item?.id}?`} body="This deletes the item from the Local folder. The next sync stops projecting it." confirm="Remove" onConfirm={() => { void save(true); }} />
    {dialog}
  </DetailPanel>;
}
