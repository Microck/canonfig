import { Schema } from "effect";
import { parseDocument } from "yaml";
import type { Resource, ItemCategory } from "@/shared/metadata";
import type { GuiProfileSnapshot, GuiProfileConfigWrite } from "../../../src/gui/contract/profile";

export const object = (value: Schema.Json | undefined): Record<string, Schema.Json> => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
export const strings = (value: Schema.Json | undefined): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
export function encodeText(text: string) {
  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(chunks.join(""));
}
export const decodeText = (base64: string) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
export interface DraftFile { path: string; content: string; encoding: "text" | "base64"; executable: boolean }
export interface ExactDraft { json?: string; files: DraftFile[] }
export interface AuthoredItem { resource: Resource; configPath?: (string | number)[]; value?: Schema.Json; itemPath?: string; exact?: ExactDraft }
const fields: Partial<Record<ItemCategory, Record<string, string>>> = {
  rules: { description: "Description", paths: "Paths", activation: "Activation" },
  skills: { name: "Name", description: "Description" },
  agents: { description: "Description", model: "Model", tools: "Tools", writable: "Writable" },
  commands: { description: "Description", argumentHint: "Argument hint" },
  mcp: { transport: "Transport", command: "Command", args: "Args", url: "URL" },
  hooks: { id: "Name", event: "Event", run: "Run", matcher: "Capabilities", onFailure: "On failure" },
  credentials: { reference: "Reference" },
  resources: { kind: "Type", target: "Target", source: "Source", policy: "Policy", format: "Format", keys: "Keys" },
};
const listFields: Record<string, true> = { paths: true, tools: true, capabilities: true };
function representable(category: ItemCategory, value: Record<string, Schema.Json>) {
  const known = fields[category];
  return known !== undefined && Object.entries(value).every(([key, entry]) => {
    if (!(key in known)) return false;
    if (key === "keys") return entry !== null && typeof entry === "object" && !Array.isArray(entry);
    if (key === "matcher") return entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.entries(entry).every(([name, values]) => name === "capabilities" && Array.isArray(values) && values.every((value) => typeof value === "string" && !value.includes(",") && value.trim() === value));
    if (key === "writable") return typeof entry === "boolean";
    if (listFields[key]) return Array.isArray(entry) && entry.every((part) => typeof part === "string" && !part.includes(",") && part.trim() === part);
    if (key === "args" || key === "run") return Array.isArray(entry) && entry.every((part) => typeof part === "string" && part.length > 0 && !/\s/.test(part));
    return typeof entry === "string" && entry.trim() === entry;
  });
}
function details(category: ItemCategory, value: Record<string, Schema.Json>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => fields[category]?.[key] && key !== "keys" && key !== "name" && key !== "id" ? [[fields[category]![key], key === "matcher" ? strings(object(entry).capabilities).join(", ") : Array.isArray(entry) ? entry.join(key === "args" || key === "run" ? " " : ", ") : String(entry)]] : []));
}
export function draftFiles(files: GuiProfileSnapshot["items"][number]["files"]): DraftFile[] {
  return files.map((file) => { try { return { path: file.path, content: decodeText(file.base64), encoding: "text", executable: file.executable }; } catch { return { path: file.path, content: file.base64, encoding: "base64", executable: file.executable }; } });
}
export function authoredItems(snapshot: GuiProfileSnapshot): AuthoredItem[] {
  const membership = (id: string) => Object.entries(object(snapshot.config.groups)).filter(([, members]) => strings(members).includes(id)).map(([group]) => group);
  const items: AuthoredItem[] = snapshot.items.filter((item) => item.path !== "canonfig.jsonc").map((item) => {
    const category = (item.path === "AGENTS.md" ? "instructions" : item.path.startsWith("files/") ? "resources" : item.path.split("/")[0]) as ItemCategory;
    const id = category === "instructions" ? "instructions" : item.path.replace(/\.md$/, "");
    const files = draftFiles(item.files);
    let detail: Record<string, string> = {};
    let exact = true;
    if (files.length === 1 && files[0]!.encoding === "text" && (category === "instructions" || category in fields && !["hooks", "resources"].includes(category))) {
      const text = files[0]!.content;
      if (category === "instructions") { detail = { Body: text }; exact = false; }
      else {
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
        const document = parseDocument(match?.[1] ?? "{}");
        const decoded = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(document.toJS());
        if (!document.errors.length && decoded._tag === "Success" && representable(category, decoded.success)) {
          detail = { ...details(category, decoded.success), Body: match?.[2] ?? text }; exact = false;
        }
      }
    }
    return { itemPath: item.path, resource: { id, category, path: category === "skills" || category === "plugins" ? `${item.path}/` : item.path, groups: membership(id), detail, summary: `${files.length} ${files.length === 1 ? "file" : "files"}` }, ...(exact ? { exact: { files } } : {}) };
  });
  for (const category of ["mcp", "hooks", "settings", "tools", "credentials", "resources"] as const) {
    const value = snapshot.config[category];
    const entries = category === "hooks" && Array.isArray(value) ? value.map((hook, index) => ({ name: String(object(hook).id), value: hook, path: [category, index] })) : Object.entries(object(value)).map(([name, value]) => ({ name, value, path: [category, name] }));
    for (const entry of entries) {
      const id = `${category}/${entry.name}`;
      const values = object(entry.value);
      const fieldEditor = entry.value !== null && typeof entry.value === "object" && !Array.isArray(entry.value) && (category === "settings" || representable(category, values) && (category !== "resources" || values.kind === "config"));
      const keys = category === "settings" ? values : category === "resources" ? object(values.keys) : undefined;
      const sourcePath = typeof values.source === "string" ? values.source : undefined;
      const associated = sourcePath ? snapshot.items.filter((item) => item.path === sourcePath || item.path.startsWith(`${sourcePath}/`)).flatMap((item) => item.files) : [];
      items.push({ configPath: entry.path, value: entry.value, resource: { id, category, path: `canonfig.jsonc → ${category}.${entry.name}`, groups: membership(id), detail: details(category, values), summary: category === "settings" ? `${Object.keys(values).length} keys` : "Authored configuration", ...(keys ? { keys: Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, JSON.stringify(value)])) } : {}) }, ...(fieldEditor ? {} : { exact: { json: JSON.stringify(entry.value, null, 2), files: draftFiles(associated) } }) });
    }
  }
  return items;
}
export function configEdits(path: readonly (string | number)[], before: Schema.Json | undefined, after: Schema.Json | undefined): typeof GuiProfileConfigWrite.Type.edits[number][] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before !== null && after !== null && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const left = object(before), right = object(after);
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) => configEdits([...path, key], left[key], right[key]));
  }
  return [{ path, ...(after === undefined ? {} : { value: after }) }];
}
function fieldValue(resource: Resource): Record<string, Schema.Json> {
  const values: Record<string, Schema.Json> = {};
  for (const [key, label] of Object.entries(fields[resource.category] ?? {})) {
    const text = resource.detail[label];
    if (text === undefined || text === "" || key === "keys") continue;
    values[key] = key === "matcher" ? { capabilities: text.split(",").map((value) => value.trim()).filter(Boolean) } : listFields[key] ? text.split(",").map((value) => value.trim()).filter(Boolean) : key === "args" || key === "run" ? text.trim().split(/\s+/) : key === "writable" ? text === "true" : text;
  }
  if (resource.category === "skills") values.name = resource.id.slice(7);
  if (resource.category === "hooks") values.id = resource.id.slice(6);
  const keys = Object.fromEntries(Object.entries(resource.keys ?? {}).map(([key, text]) => { try { return [key, Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text))]; } catch { return [key, text]; } }));
  if (resource.category === "settings") return keys;
  if (resource.category === "resources" && values.kind === "config") values.keys = keys;
  return values;
}
export function itemWrite(snapshot: GuiProfileSnapshot, before: Resource | undefined, next: Resource, exact?: ExactDraft, remove = false): typeof GuiProfileConfigWrite.Type {
  const original = before && authoredItems(snapshot).find((entry) => entry.resource.id === before.id);
  const config = original?.configPath !== undefined || !original?.itemPath && ["mcp", "hooks", "settings", "tools", "credentials", "resources"].includes(next.category);
  const edits: typeof GuiProfileConfigWrite.Type.edits[number][] = [];
  const changes: typeof GuiProfileConfigWrite.Type.changes[number][] = [];
  if (config) {
    const name = next.id.slice(next.category.length + 1);
    const path = original?.configPath ?? (next.category === "hooks" ? ["hooks", Array.isArray(snapshot.config.hooks) ? snapshot.config.hooks.length : 0] : [next.category, name]);
    let value = remove ? undefined : exact?.json !== undefined ? Schema.decodeUnknownSync(Schema.Json)(JSON.parse(exact.json)) : fieldValue(next);
    if (!remove && exact?.json === undefined && before && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const prior = object(original?.value);
      const updated = object(value);
      for (const [key, label] of Object.entries(fields[next.category] ?? {})) {
        if (key !== "id" && key !== "keys" && Object.hasOwn(prior, key) && before.detail[label] === next.detail[label]) updated[key] = prior[key]!;
      }
      value = updated;
    }
    if (original && before?.id !== next.id && next.category !== "hooks") { edits.push({ path }); edits.push({ path: [next.category, name], value }); }
    else edits.push(...configEdits(path, original?.value, value));
    if (exact && !remove) {
      const originalFiles = original?.exact?.files ?? [];
      for (const filePath of new Set([...originalFiles.map((file) => file.path), ...exact.files.map((file) => file.path)])) {
        const file = exact.files.find((file) => file.path === filePath);
        changes.push({ path: filePath, expectedDigest: snapshot.items.find((item) => item.path === filePath)?.digest ?? null, files: file ? [{ path: filePath, base64: file.encoding === "text" ? encodeText(file.content) : file.content, executable: file.executable }] : [] });
      }
    }
  } else {
    const path = next.category === "instructions" ? "AGENTS.md" : next.category === "skills" || next.category === "plugins" ? next.id : original?.exact ? original.itemPath! : `${next.id}.md`;
    const previous = snapshot.items.find((item) => item.path === original?.itemPath);
    let files = exact?.files;
    if (!files) {
      const oldText = previous?.files[0] ? decodeText(previous.files[0].base64) : "";
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(oldText);
      const document = parseDocument(match?.[1] ?? "{}");
      const values = fieldValue(next);
      for (const [key, label] of Object.entries(fields[next.category] ?? {})) {
        if (before && next.detail[label] === before.detail[label] && key !== "name") continue;
        if (values[key] === undefined) document.delete(key); else document.set(key, values[key]);
      }
      const content = before && before.id === next.id && JSON.stringify(before.detail) === JSON.stringify(next.detail) ? oldText : next.category === "instructions" ? next.detail.Body ?? "" : `${Object.keys(values).length || match ? `---\n${document.toString()}---\n` : ""}${next.detail.Body ?? ""}`;
      files = [{ path: next.category === "skills" ? `${path}/SKILL.md` : path, content, encoding: "text", executable: previous?.files[0]?.executable ?? false }];
    }
    if (exact && next.category !== "skills" && next.category !== "plugins") {
      for (const filePath of new Set([...(previous?.files.map((file) => file.path) ?? []), ...files.map((file) => file.path)])) {
        const file = remove ? undefined : files.find((file) => file.path === filePath);
        changes.push({ path: filePath, expectedDigest: snapshot.items.find((item) => item.path === filePath)?.digest ?? null, files: file ? [{ path: filePath, base64: file.encoding === "text" ? encodeText(file.content) : file.content, executable: file.executable }] : [] });
      }
    } else {
      if (previous && previous.path !== path) changes.push({ path: previous.path, expectedDigest: previous.digest, files: [] });
      changes.push({ path, expectedDigest: previous?.path === path ? previous.digest : null, files: remove ? [] : files.map((file) => ({ path: previous && previous.path !== path ? file.path.replace(previous.path, path) : file.path, base64: file.encoding === "text" ? encodeText(file.content) : file.content, executable: file.executable })) });
    }
  }
  for (const [group, members] of Object.entries(object(snapshot.config.groups))) {
    const current = strings(members);
    const nextMembers = current.flatMap((id) => id === before?.id || id === next.id ? !remove && next.groups.includes(group) ? [next.id] : [] : [id]);
    if (!remove && next.groups.includes(group) && !nextMembers.includes(next.id)) nextMembers.push(next.id);
    if (JSON.stringify(current) !== JSON.stringify(nextMembers)) edits.push({ path: ["groups", group], value: nextMembers });
  }
  return { expectedDigest: snapshot.items.find((item) => item.path === "canonfig.jsonc")?.digest ?? null, edits, changes };
}
