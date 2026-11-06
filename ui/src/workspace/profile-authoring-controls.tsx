import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "../live/session";
import { Field } from "./kit";
import { useWorkspace } from "./store";
import type { ExactDraft } from "./profile-authoring";

export function ProfileActionNotice() {
  const { profileLive } = useWorkspace();
  return profileLive?.error ? <div className="grid gap-2 p-4"><ErrorNotice error={profileLive.error} /><Button type="button" variant="outline" size="sm" disabled={profileLive.busy} onClick={profileLive.reload}>Reload</Button></div> : null;
}

/** Exact bytes stay editable beside the ordinary field form, including binary skill assets. */
export function ExactItemFields({ value, onChange, path }: { value: ExactDraft; onChange: (value: ExactDraft) => void; path: string }) {
  return <div className="grid gap-4">
    {value.json !== undefined && <Field label="As written (JSON value)" htmlFor="item-exact-json"><Textarea id="item-exact-json" className="min-h-64 font-mono text-sm" spellCheck={false} value={value.json} onChange={(event) => onChange({ ...value, json: event.target.value })} /></Field>}
    {value.files.map((file, index) => <fieldset key={index} className="grid gap-3 border-b border-border pb-4">
      <Field label="File path" htmlFor={`exact-path-${index}`}><Input id={`exact-path-${index}`} className="font-mono text-sm" value={file.path} onChange={(event) => onChange({ ...value, files: value.files.map((entry, i) => i === index ? { ...entry, path: event.target.value } : entry) })} /></Field>
      <Field label={`As written (${file.encoding})`} htmlFor={`exact-content-${index}`}><Textarea id={`exact-content-${index}`} className="min-h-56 font-mono text-sm" spellCheck={false} value={file.content} onChange={(event) => onChange({ ...value, files: value.files.map((entry, i) => i === index ? { ...entry, content: event.target.value } : entry) })} /></Field>
      <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={file.executable} onCheckedChange={(checked) => onChange({ ...value, files: value.files.map((entry, i) => i === index ? { ...entry, executable: checked === true } : entry) })} />Executable</label>
      <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...value, files: value.files.filter((_, i) => i !== index) })}>Remove file from draft</Button>
    </fieldset>)}
    <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...value, files: [...value.files, { path: value.json === undefined ? path : "files/", content: "", encoding: "text", executable: false }] })}>Add file</Button>
  </div>;
}
