import { Option, Schema } from "effect";

import type { PublishedResource, PublishedResourceSpec } from "../domain/profile.ts";
import { ConfigValue } from "../domain/resource.ts";
import { canonicalJson } from "../profile/profile-codec.ts";

/**
 * A follower's managed mirror of the Canonical Folder. Each published item
 * is either a file the follower writes at the same place in its own
 * `~/.canonfig/`, an entry of the `canonfig.jsonc` it renders from the items
 * it is authorized to see, or a tool or credential it applies directly.
 * Anything else is not a Canonical Folder item and is refused, so a revision
 * can never make a follower write outside the authoring allowlist.
 */

export type MirrorItem =
  /** A file or skill directory at `path`, relative to the folder. */
  | { readonly kind: "file"; readonly path: string }
  /**
   * The `canonfig.jsonc` entry at `key`. A hook also carries its position in
   * the Source's `hooks` array, since hooks run in authored order.
   */
  | { readonly kind: "entry"; readonly key: string; readonly value: ConfigValue; readonly position?: number }
  /** A tool or credential the follower applies as published. */
  | { readonly kind: "apply" };

export type MirrorEntry = Extract<MirrorItem, { readonly kind: "entry" }>;

/**
 * How a hook item travels: the hook as authored plus its index in the
 * Source's `hooks` array. Each hook is its own item (so groups can hide it),
 * and resource order is not authored order, so the index travels with it.
 */
export const PublishedHook = Schema.Struct({
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hook: ConfigValue,
});

const name = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const scriptPath = /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*$/u;

/** The one key of a JSON item, when the item is exactly that. */
const entryOf = (spec: PublishedResourceSpec, key: string): MirrorEntry | undefined => {
  if (spec.kind !== "config" || spec.format !== "json" || spec.keys.length !== 1 || spec.keys[0]!.path !== key) return undefined;
  return { kind: "entry", key, value: spec.keys[0]!.value };
};

/**
 * What a follower does with one published resource, or undefined when it is
 * not a Canonical Folder item. A file item's target must be exactly the path
 * its id names.
 */
export const mirrorItem = (
  resource: Pick<PublishedResource, "id" | "kind" | "target"> & { readonly spec: PublishedResourceSpec },
): MirrorItem | undefined => {
  const separator = resource.id.indexOf(":");
  const category = separator < 0 ? resource.id : resource.id.slice(0, separator);
  const rest = separator < 0 ? undefined : resource.id.slice(separator + 1);
  const file = (path: string, kind: "file" | "skill"): MirrorItem | undefined =>
    resource.kind === kind && resource.spec.kind === kind && resource.target === path ? { kind: "file", path } : undefined;
  if (rest === undefined) {
    if (category === "instructions") return file("AGENTS.md", "file");
    if (category === "harnesses") return entryOf(resource.spec, "harnesses");
    if (category === "local-policy") return entryOf(resource.spec, "local");
    if (category === "surfaces") return entryOf(resource.spec, "surfaces");
    return undefined;
  }
  // A path item names a file by its segments: `hook-scripts:lib:run.sh` is
  // `hooks/lib/run.sh`, `files:a:b` is `files/a/b`. No segment is `.` or `..`.
  const directory = category === "hook-scripts" ? "hooks" : category === "files" ? "files" : undefined;
  if (directory !== undefined) {
    return scriptPath.test(rest) && !rest.split(":").some((segment) => /^\.+$/u.test(segment))
      ? file(`${directory}/${rest.split(":").join("/")}`, "file")
      : undefined;
  }
  if (!name.test(rest)) return undefined;
  switch (category) {
    case "rules":
    case "agents":
    case "commands":
      return file(`${category}/${rest}.md`, "file");
    case "skills":
      return file(`skills/${rest}`, "skill");
    case "hooks": {
      const entry = entryOf(resource.spec, `hooks.${rest}`);
      if (entry === undefined) return undefined;
      return Option.match(Schema.decodeUnknownOption(PublishedHook)(entry.value), {
        onNone: () => undefined,
        onSome: (published): MirrorItem => ({ kind: "entry", key: entry.key, value: published.hook, position: published.position }),
      });
    }
    case "mcp":
    case "settings":
    case "resources":
      return entryOf(resource.spec, `${category}.${rest}`);
    case "tools":
      return resource.kind === "tool" && resource.spec.kind === "tool" ? { kind: "apply" } : undefined;
    case "credentials":
      return resource.kind === "credential" && resource.spec.kind === "credential" ? { kind: "apply" } : undefined;
    default:
      return undefined;
  }
};

/**
 * The follower's `canonfig.jsonc`, rendered canonically (sorted keys, two
 * spaces) from its authorized entries, so equal items always render equal
 * bytes. Hooks keep the Source's order: by published position, then id.
 */
export const renderMirrorConfig = (entries: ReadonlyArray<MirrorEntry>): string => {
  const topLevel: Array<readonly [string, ConfigValue]> = [];
  const sections = new Map<string, Array<readonly [string, ConfigValue]>>();
  const hooks: Array<{ readonly id: string; readonly position: number; readonly value: ConfigValue }> = [];
  for (const entry of entries) {
    const dot = entry.key.indexOf(".");
    if (dot < 0) {
      topLevel.push([entry.key, entry.value]);
      continue;
    }
    const section = entry.key.slice(0, dot);
    const item = entry.key.slice(dot + 1);
    if (section === "hooks") {
      hooks.push({ id: item, position: entry.position ?? 0, value: entry.value });
      continue;
    }
    sections.set(section, [...sections.get(section) ?? [], [item, entry.value]]);
  }
  hooks.sort((left, right) => left.position - right.position || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const config = Object.fromEntries([
    ["version", 1],
    ...topLevel,
    ...[...sections].map(([section, items]) => [section, Object.fromEntries(items)] as const),
    ...(hooks.length === 0 ? [] : [["hooks", hooks.map((hook) => hook.value)] as const]),
  ]);
  // canonicalJson sorts object keys (arrays keep their order); parsing it
  // back keeps that order for printing.
  const sorted: unknown = JSON.parse(canonicalJson(JSON.parse(JSON.stringify(config))));
  return [
    "// Managed by Canonfig: what this machine's Source publishes to it. Edits",
    "// here are Follower Drift and stop synchronization; add your own items under local/.",
    JSON.stringify(sorted, undefined, 2),
    "",
  ].join("\n");
};
