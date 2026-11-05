import { useId, useState } from "react";
import { Schema } from "effect";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Field } from "../../workspace/kit";

type Json = Schema.Json;
const record = (value: Json | undefined): Record<string, Json> => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const list = (value: Json | undefined): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export function DefaultsFields({ value, onChange }: { value: Record<string, Json>; onChange: (value: Record<string, Json>) => void }) {
  const id = useId();
  const profile = record(value.profile);
  const local = record(value.local);
  const [existingId] = useState(typeof profile.id === "string");
  return <div className="grid gap-5">
    <Field label="Profile name" htmlFor={`${id}-name`}><Input id={`${id}-name`} className="text-base" value={typeof profile.name === "string" ? profile.name : ""} onChange={(event) => onChange({ ...value, profile: { ...profile, name: event.target.value } })} /></Field>
    <Field label="Profile ID" htmlFor={`${id}-profile-id`} description="The ID must stay unchanged after the first publication."><Input id={`${id}-profile-id`} className="text-base" required readOnly={existingId} value={typeof profile.id === "string" ? profile.id : ""} onChange={(event) => onChange({ ...value, profile: { ...profile, id: event.target.value } })} /></Field>
    <Field label="Default schedule" htmlFor={`${id}-schedule`} description="Use daily@09:00 or weekly:Mon,Thu@09:00. Times use each follower's local time."><Input id={`${id}-schedule`} className="text-base" value={typeof value.scheduleDefault === "string" ? value.scheduleDefault : ""} onChange={(event) => onChange({ ...value, scheduleDefault: event.target.value })} /></Field>
    <fieldset><legend className="text-sm font-medium text-muted-foreground">Allow local items</legend>{["instructions", "rules", "skills", "agents", "commands", "mcp", "settings"].map((category) => <label key={category} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={list(local.allow).includes(category)} onChange={(event) => onChange({ ...value, local: { ...local, allow: event.target.checked ? [...list(local.allow), category] : list(local.allow).filter((item) => item !== category) } })} />{category}</label>)}</fieldset>
    <fieldset><legend className="text-sm font-medium text-muted-foreground">Append-local</legend>{["instructions", "skills"].map((category) => <label key={category} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={list(local.appendLocal).includes(category)} onChange={(event) => onChange({ ...value, local: { ...local, appendLocal: event.target.checked ? [...list(local.appendLocal), category] : list(local.appendLocal).filter((item) => item !== category) } })} />{category}</label>)}</fieldset>
  </div>;
}
export function GroupsFields({ value, references, onChange }: { value: Record<string, Json>; references: readonly string[]; onChange: (value: Record<string, Json>) => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const groups = record(value.groups);
  return <div className="grid gap-5"><p className="text-sm text-muted-foreground">Ungrouped items reach every follower. Existing enrollment groups are immutable. Issue a replacement invitation and re-enroll to change membership.</p>
    {Object.entries(groups).map(([group, members]) => <fieldset key={group} className="border-b border-border pb-4"><legend className="font-medium">{group}</legend>{[...new Set([...references, ...list(members)])].map((reference) => <label key={reference} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={list(members).includes(reference)} onChange={(event) => onChange({ ...value, groups: { ...groups, [group]: event.target.checked ? [...list(members), reference] : list(members).filter((item) => item !== reference) } })} /><span className="break-all font-mono text-sm">{reference}</span></label>)}<Button type="button" variant="outline" onClick={() => { if (!confirm(`Remove group ${group}? Its items will no longer be restricted by this group.`)) return; const next = { ...groups }; delete next[group]; onChange({ ...value, groups: next }); }}>Remove group</Button></fieldset>)}
    <Field label="New group name" htmlFor={`${id}-name`}><Input id={`${id}-name`} className="text-base" value={name} onChange={(event) => setName(event.target.value)} /></Field><Button type="button" variant="outline" disabled={!name.trim() || Object.hasOwn(groups, name)} onClick={() => { onChange({ ...value, groups: { ...groups, [name]: [] } }); setName(""); }}>Add group</Button>
  </div>;
}
