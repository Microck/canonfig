import { asJson } from "../profile/profile-codec.ts";
import { basename } from "node:path";
import type { PublishedResourceSpec, AuthoredVerificationInput } from "../domain/profile.ts";
import { decodeFolderConfig, decodeLocalConfig, type FolderConfig, type GuardFolderFile } from "../projection/folder.ts";
import { type GuardFile, type GuardItem } from "./guard.ts";

const declarationItems = (kind: string, entries: NonNullable<FolderConfig["mcp"] | FolderConfig["tools"] | FolderConfig["hooks"]> | undefined, prefix = ""): GuardItem[] =>
  Object.entries(entries ?? {}).map(([id, declaration]) => ({ kind, id: `${prefix}${kind}:${id}`, files: [], declaration: asJson(declaration) }));

/** Group each whole skill tree. Keep JSONC declarations local and scan raw
 * document bytes so frontmatter and bundled references remain visible. */
export function folderGuardItems(files: Iterable<readonly [string, GuardFolderFile]>): GuardItem[] {
  const items = new Map<string, { kind: string; id: string; files: GuardFile[] }>();
  const declarations: GuardItem[] = [];
  for (const [path, file] of files) {
    if (path === "canonfig.jsonc") {
      const config = decodeFolderConfig(path, new TextDecoder("utf-8", { fatal: true }).decode(file.content));
      declarations.push(...declarationItems("mcp", config.mcp), ...declarationItems("hooks", config.hooks),
        ...declarationItems("tools", config.tools));
      continue;
    }
    if (path === "local/local.jsonc") {
      const config = decodeLocalConfig(path, new TextDecoder("utf-8", { fatal: true }).decode(file.content));
      declarations.push(...declarationItems("mcp", config.mcp, "local/"));
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
      ...(file.content === undefined ? { oversized: file.oversized } : { bytes: file.content }),
    });
    items.set(qualified, item);
  }
  return [...items.values(), ...declarations];
}

export function publishedGuardItem(
  resource: { readonly id: string; readonly target: string; readonly spec: PublishedResourceSpec; readonly verify: AuthoredVerificationInput },
  file: (path: string, blob: string, executable: boolean) => GuardFile,
): GuardItem | undefined {
  const { id, spec, target, verify } = resource;
  const kind = id.split(":")[0]!;
  if (spec.kind === "skill") {
    return { kind: "skills", id, files: spec.files.map((entry) => file(entry.path, entry.blob, entry.executable)) };
  }
  if (spec.kind === "file") return { kind, id, files: [file(basename(target), spec.blob, spec.executable)] };
  if (spec.kind === "tool") return { kind, id, files: [], declaration: asJson({ target, spec, verify }) };
  if (spec.kind === "config" && ["mcp", "hooks"].includes(kind)) {
    return { kind, id, files: [], declaration: asJson(spec.keys.map(({ value }) => value)) };
  }
  return undefined;
}
