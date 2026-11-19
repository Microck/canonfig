import { asJson } from "../profile/profile-codec.ts";
import { basename } from "node:path";
import { normalizeToolResourceSpec, type PublishedResource, type PublishedResourceSpec, type AuthoredVerificationInput } from "../domain/profile.ts";
import type { ConfigValue } from "../domain/resource.ts";
import { decodeFolderConfig, decodeLocalConfig, folderToolResource, type FolderHook, type FolderMcpServer, type FolderTool, type GuardFolderFile } from "../projection/folder.ts";
import { mirrorItem } from "../projection/mirror.ts";
import { type GuardFile, type GuardItem } from "./guard.ts";

export const declarationGuardItem = (
  kind: "mcp" | "hooks", name: string,
  declaration: ConfigValue | FolderMcpServer | { readonly position: number; readonly hook: FolderHook | ConfigValue },
  local = false,
): GuardItem => ({ kind, id: `${local ? "local/" : ""}${kind}:${name}`, files: [], declaration: asJson(declaration) });

const hookGuardItem = (name: string, position: number, hook: FolderHook | ConfigValue): GuardItem =>
  declarationGuardItem("hooks", name, { position, hook });

function toolGuardItem(
  id: string,
  { target, spec, verify }: {
    readonly target: string;
    readonly spec: Extract<PublishedResourceSpec, { kind: "tool" }>;
    readonly verify: AuthoredVerificationInput;
  },
): GuardItem {
  return { kind: "tools", id, files: [], declaration: asJson({ target, spec, verify }) };
}

export function folderToolGuardItem(name: string, tool: FolderTool): GuardItem {
  const { target, spec, verify } = folderToolResource(name, tool);
  return toolGuardItem(`tools:${name}`, { target, spec: normalizeToolResourceSpec(spec), verify });
}

/** Group each whole skill tree. Keep JSONC declarations local and scan raw
 * document bytes so frontmatter and bundled references remain visible. */
export function folderGuardItems(
  files: Iterable<readonly [string, GuardFolderFile]>,
  signedHookPositions: readonly number[] = [],
): GuardItem[] {
  const items = new Map<string, { kind: string; id: string; files: GuardFile[] }>();
  const declarations: GuardItem[] = [];
  for (const [path, file] of files) {
    if (path === "canonfig.jsonc") {
      const config = decodeFolderConfig(path, new TextDecoder("utf-8", { fatal: true }).decode(file.content));
      declarations.push(
        ...Object.entries(config.mcp ?? {}).map(([name, server]) => declarationGuardItem("mcp", name, server)),
        ...(config.hooks ?? []).map((hook, index) => hookGuardItem(hook.id, signedHookPositions[index] ?? index, hook)),
        ...Object.entries(config.tools ?? {}).map(([name, tool]) => folderToolGuardItem(name, tool)),
      );
      continue;
    }
    if (path === "local/local.jsonc") {
      const config = decodeLocalConfig(path, new TextDecoder("utf-8", { fatal: true }).decode(file.content));
      declarations.push(...Object.entries(config.mcp ?? {}).map(([name, server]) => declarationGuardItem("mcp", name, server, true)));
      continue;
    }
    const local = path.startsWith("local/");
    const [category, name, ...children] = (local ? path.slice(6) : path).split("/");
    const kind = category === "AGENTS.md" ? "instructions" : category === "hooks" ? "hook-scripts" : category!;
    const id = kind === "instructions" ? kind : kind === "files" || kind === "hook-scripts"
      ? [kind, name, ...children].join(":") : `${kind}:${name?.replace(/\.md$/u, "")}`;
    const qualified = local ? `local/${id}` : id;
    const item = items.get(qualified) ?? { kind, id: qualified, files: [] };
    item.files.push({
      path: category === "skills" ? children.join("/") : basename(path),
      executable: file.executable,
      mode: file.mode,
      ...(file.content === undefined ? { oversized: file.oversized } : { bytes: file.content }),
    });
    items.set(qualified, item);
  }
  return [...items.values(), ...declarations];
}

export function publishedGuardItem(
  resource: { readonly id: PublishedResource["id"]; readonly target: string; readonly spec: PublishedResourceSpec; readonly verify: AuthoredVerificationInput },
  readBlob: (blob: string) => Pick<GuardFile, "bytes" | "oversized">,
): GuardItem | undefined {
  const { id, spec, target, verify } = resource;
  const [kind = id, name] = id.split(":");
  const file = (path: string, { blob, executable, mode }: { blob: string; executable: boolean; mode?: number | undefined }): GuardFile =>
    ({ path, executable, mode, ...readBlob(blob) });
  if (spec.kind === "skill") {
    return { kind: "skills", id, files: spec.files.map((entry) => file(entry.path, entry)) };
  }
  if (spec.kind === "file") return { kind, id, files: [file(basename(target), spec)] };
  if (spec.kind === "tool") return toolGuardItem(id, { target, spec, verify });
  if (spec.kind === "config" && name !== undefined && (kind === "mcp" || kind === "hooks")) {
    const entry = mirrorItem({ id, target, kind: spec.kind, spec });
    if (entry?.kind === "entry") {
      return entry.position === undefined ? declarationGuardItem(kind, name, entry.value) : hookGuardItem(name, entry.position, entry.value);
    }
  }
  return undefined;
}
