import { useId, useState } from "react";
import { parseDocument } from "yaml";
import { Schema } from "effect";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Field } from "../../workspace/kit";

type Json = Schema.Json;
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const docFields: Readonly<Record<string, ReadonlyArray<{ key: string; label: string; kind?: "list" | "boolean"; options?: readonly string[] }>>> = {
  rules: [{ key: "description", label: "Description" }, { key: "paths", label: "Paths", kind: "list" }, { key: "activation", label: "Activation", options: ["always", "path", "manual", "model"] }],
  agents: [{ key: "description", label: "Description" }, { key: "model", label: "Model" }, { key: "tools", label: "Tools", kind: "list" }, { key: "writable", label: "Writable", kind: "boolean" }],
  commands: [{ key: "description", label: "Description" }, { key: "argumentHint", label: "Argument hint" }],
};

/** Unknown frontmatter remains in the exact editor rather than disappearing during a form save. */
export function documentFields(category: string, text: string) {
  if (category === "instructions") {
    const metadata: Record<string, Json> = {};
    return { fields: [], metadata, body: text, document: undefined };
  }
  const fields = docFields[category];
  if (!fields) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  const document = parseDocument(match?.[1] ?? "{}");
  if (document.errors.length) return undefined;
  const parsed = Schema.decodeUnknownResult(JsonObject)(document.toJS());
  if (parsed._tag === "Failure") return undefined;
  if (Object.keys(parsed.success).some((key) => !fields.some((field) => field.key === key))) return undefined;
  return { fields, metadata: parsed.success, body: match?.[2] ?? text, document };
}
export function DocumentFields({ category, text, onChange }: { category: string; text: string; onChange: (text: string) => void }) {
  const id = useId();
  const parsed = documentFields(category, text);
  if (!parsed) return null;
  function change(key: string, value: Json | undefined) {
    if (!parsed) return;
    if (key === "body") {
      onChange(parsed.document === undefined ? String(value) : `---\n${parsed.document.toString()}---\n${String(value)}`);
      return;
    }
    if (value === undefined) parsed.document?.delete(key); else parsed.document?.set(key, value);
    onChange(`---\n${parsed.document?.toString() ?? ""}---\n${parsed.body}`);
  }
  return <div className="grid gap-4">{parsed.fields.map((field) => {
    const value = parsed.metadata[field.key];
    return <Field key={field.key} label={field.label} htmlFor={`${id}-${field.key}`}>
      {field.kind === "boolean" ? <select id={`${id}-${field.key}`} className="rounded border border-border bg-background p-2 text-base" value={value === undefined ? "" : String(value)} onChange={(event) => change(field.key, event.target.value === "" ? undefined : event.target.value === "true")}><option value="">Not specified</option><option value="false">false</option><option value="true">true</option></select>
        : field.options ? <select id={`${id}-${field.key}`} className="rounded border border-border bg-background p-2 text-base" value={typeof value === "string" ? value : ""} onChange={(event) => change(field.key, event.target.value || undefined)}><option value="">Not specified</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select>
          : <Input id={`${id}-${field.key}`} className="text-base" value={Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : ""} onChange={(event) => change(field.key, field.kind === "list" ? event.target.value.split(",").map((item) => item.trim()).filter(Boolean) : event.target.value || undefined)} />}
    </Field>;
  })}<Field label="Body" htmlFor={`${id}-body`}><Textarea id={`${id}-body`} className="min-h-64 text-base" value={parsed.body} onChange={(event) => change("body", event.target.value)} /></Field><details><summary>As written</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs">{text}</pre></details></div>;
}

export function ConfigFields({ category, text, onChange }: { category: string; text: string; onChange: (text: string) => void }) {
  const id = useId();
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(JsonObject))(text);
  const value = decoded._tag === "Success" ? decoded.success : undefined;
  const allowed = category === "mcp" ? ["transport", "command", "args", "url"] : category === "credentials" ? ["reference"] : [];
  if (!value || !allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) return <Field label="As written (JSON value)" htmlFor={id}><Textarea id={id} className="min-h-64 font-mono text-base" value={text} onChange={(event) => onChange(event.target.value)} spellCheck={false} /></Field>;
  const change = (key: string, next: Json) => onChange(JSON.stringify({ ...value, [key]: next }, null, 2));
  const transport = value.transport ?? "stdio";
  return <div className="grid gap-4">{category === "mcp" && <Field label="Transport" htmlFor={`${id}-transport`}><select id={`${id}-transport`} className="rounded border border-border bg-background p-2 text-base" value={String(transport)} onChange={(event) => onChange(JSON.stringify(event.target.value === "stdio" ? { transport: "stdio", command: "", args: [] } : { transport: event.target.value, url: "" }, null, 2))}><option>stdio</option><option>streamable-http</option><option>sse</option></select></Field>}
    {(category === "credentials" ? ["reference"] : transport === "stdio" ? ["command", "args"] : ["url"]).map((key) => <Field key={key} label={key === "args" ? "Arguments (one per line)" : key.charAt(0).toUpperCase() + key.slice(1)} htmlFor={`${id}-${key}`}>
      {key === "args" ? <Textarea id={`${id}-${key}`} className="text-base" value={Array.isArray(value.args) ? value.args.join("\n") : ""} onChange={(event) => change(key, event.target.value === "" ? [] : event.target.value.split("\n"))} /> : <Input id={`${id}-${key}`} className="text-base" value={typeof value[key] === "string" ? value[key] : ""} onChange={(event) => change(key, event.target.value)} />}
    </Field>)}<details><summary>As written</summary><pre className="overflow-auto whitespace-pre-wrap font-mono text-xs">{text}</pre></details></div>;
}

/** Values remain JSON text in the draft so strings, arrays and objects keep their actual types. */
export function SettingsFields({ initial, onChange }: { initial: Json; onChange: (text: string) => void }) {
  const id = useId();
  const [rows, setRows] = useState(() => Object.entries(Schema.decodeUnknownSync(JsonObject)(initial)).map(([key, value], index) => ({ id: index, key, text: JSON.stringify(value) })));
  function change(next: typeof rows) {
    setRows(next);
    onChange(`{${next.map((row) => `${JSON.stringify(row.key)}:${row.text}`).join(",")}}`);
  }
  return <div className="grid gap-4">{rows.map((row) => <fieldset key={row.id} className="grid gap-2 border-b border-border pb-3"><Field label="Key" htmlFor={`${id}-${row.id}-key`}><Input id={`${id}-${row.id}-key`} className="text-base" value={row.key} onChange={(event) => change(rows.map((candidate) => candidate.id === row.id ? { ...row, key: event.target.value } : candidate))} /></Field><Field label="Value (JSON)" htmlFor={`${id}-${row.id}-value`}><Textarea id={`${id}-${row.id}-value`} className="font-mono text-base" value={row.text} onChange={(event) => change(rows.map((candidate) => candidate.id === row.id ? { ...row, text: event.target.value } : candidate))} /></Field><Button type="button" variant="outline" onClick={() => change(rows.filter((candidate) => candidate.id !== row.id))}>Remove key</Button></fieldset>)}<Button type="button" variant="outline" onClick={() => change([...rows, { id: Math.max(-1, ...rows.map((row) => row.id)) + 1, key: "", text: '""' }])}>Add key</Button></div>;
}
