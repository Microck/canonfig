import { pathToFileURL } from "node:url";
import { formatConfigPath } from "../domain/config-path.ts";
import type { HarnessLayout, HarnessProjection, RootContext, SurfaceContent } from "./harness.ts";
import type { CanonicalModel, TargetId } from "./model.ts";
import { Schema } from "effect";
import { Platform } from "../domain/resource.ts";
import { canonicalJson, sha256BytesHex, sha256Hex } from "../profile/profile-codec.ts";
import type { SkillFile } from "./model.ts";

/** Native loaders whose package and registration contracts Canonfig implements. */
export const NATIVE_PLUGIN_HARNESSES = ["claude-code", "codex", "oh-my-pi", "pi", "opencode", "kilo", "amp", "qwen"] as const;
const relativePath = Schema.String.check(Schema.isPattern(
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/u,
  { expected: "a relative path without empty, . or .. segments" },
));
const identifier = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u));
const Variant = Schema.Struct({
  id: identifier,
  harness: Schema.Literals(NATIVE_PLUGIN_HARNESSES),
  platforms: Schema.Array(Platform).check(Schema.isMinLength(1)),
  directory: relativePath,
  entry: Schema.optional(relativePath),
  requires: Schema.optional(Schema.Array(Schema.String.check(Schema.isPattern(/^tools\/[A-Za-z0-9][A-Za-z0-9_-]*$/u)))),
});
export const NativePluginManifest = Schema.Struct({
  version: Schema.Literal(1),
  variants: Schema.Array(Variant).check(Schema.isMinLength(1)),
  review: Schema.optional(Schema.Struct({
    reviewer: Schema.NonEmptyString,
    digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  })),
});
export type NativePluginManifest = typeof NativePluginManifest.Type;
export type NativePluginVariant = typeof Variant.Type;
export interface NativePlugin {
  readonly id: string;
  readonly manifest: NativePluginManifest;
  readonly files: ReadonlyArray<SkillFile>;
  readonly digest: string;
  readonly reviewed: boolean;
}

/** Review pins both the loader declaration and every payload byte and executable bit. */
export const nativePluginDigest = (manifest: NativePluginManifest, files: ReadonlyArray<SkillFile>): string =>
  sha256Hex(canonicalJson({
    version: manifest.version,
    variants: JSON.parse(JSON.stringify(manifest.variants)),
    files: files.filter((file) => file.path !== "plugin.jsonc")
      .map((file) => ({ path: file.path, executable: file.executable, digest: sha256BytesHex(file.content) }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  }));

const PackageManifest = Schema.Struct({ name: Schema.NonEmptyString, version: Schema.optional(Schema.NonEmptyString) });
export const nativeManifestPath = (harness: NativePluginVariant["harness"]): string => {
  switch (harness) {
    case "claude-code": return ".claude-plugin/plugin.json";
    case "codex": return ".codex-plugin/plugin.json";
    // Installed Qwen extensions carry qwen-extension.json; Qwen's installer converts Gemini and Claude manifests to it.
    case "qwen": return "qwen-extension.json";
    default: return "package.json";
  }
};

/** The native package identity, not the Canonfig item id or npm install expression. */
export const nativePackage = (plugin: Pick<NativePlugin, "files">, variant: NativePluginVariant) => {
  const path = `${variant.directory}/${nativeManifestPath(variant.harness)}`;
  const file = plugin.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${variant.id}: missing native manifest ${path}`);
  return Schema.decodeUnknownSync(PackageManifest)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.content)));
};

/** A package cannot ambiguously select two variants for one harness and platform. */
export const nativePluginIssue = (manifest: NativePluginManifest, files: ReadonlyArray<SkillFile>): string | undefined => {
  const variants = new Set<string>();
  const selections = new Set<string>();
  for (const variant of manifest.variants) {
    if (variants.has(variant.id)) return `variant ${variant.id} is repeated`;
    variants.add(variant.id);
    for (const platform of variant.platforms) {
      const key = `${variant.harness}/${platform}`;
      if (selections.has(key)) return `more than one variant selects ${key}`;
      selections.add(key);
    }
    if (!files.some((file) => file.path.startsWith(`${variant.directory}/`))) return `variant ${variant.id} has no package files`;
    if (variant.entry !== undefined && !files.some((file) => file.path === `${variant.directory}/${variant.entry}`)) {
      return `variant ${variant.id} entry ${variant.entry} does not exist`;
    }
    if (["amp", "opencode", "kilo", "oh-my-pi", "pi"].includes(variant.harness) && variant.entry === undefined) {
      return `variant ${variant.id} needs an entry module`;
    }
    const pkg = nativePackage({ files }, variant);
    if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(pkg.name)) return `variant ${variant.id} has an unsafe native package name`;
    if (pkg.name.includes("/") && ["claude-code", "codex", "qwen"].includes(variant.harness)) {
      return `variant ${variant.id} needs an unscoped native package name`;
    }
  }
  return undefined;
};

/** Register reviewed packages with native loaders; no network or package manager runs here. */
export const projectNativePlugins = (
  model: CanonicalModel, harness: TargetId, context: RootContext,
  layout: HarnessLayout, projection: HarnessProjection,
) => {
  const surfaces = [...layout.surfaces];
  const contents = [...projection.contents];
  const diagnostics = [...projection.diagnostics];
  const add = (surface: HarnessLayout["surfaces"][number], content: SurfaceContent) => {
    const existing = contents.findIndex((entry) => entry.surface === content.surface);
    if (existing >= 0) {
      const previous = contents[existing]!;
      if (previous.kind === "directory" && content.kind === "directory") {
        const paths = new Set(previous.files.map((file) => file.path.split("/")[0]));
        if (content.files.some((file) => paths.has(file.path.split("/")[0]))) throw new Error(`Native Plugin collides with ${harness} ${surface.id}`);
        contents[existing] = { ...previous, files: [...previous.files, ...content.files] };
      } else if (previous.kind === "config" && content.kind === "config") {
        contents[existing] = { ...previous, keys: [...previous.keys, ...content.keys] };
      } else throw new Error(`Native Plugin cannot share ${harness} ${surface.id}`);
    } else contents.push(content);
    if (!surfaces.some((entry) => entry.id === surface.id)) surfaces.push(surface);
  };
  for (const plugin of model.plugins) {
    const variants = plugin.manifest.variants.filter((variant) => variant.harness === harness);
    if (variants.length === 0) continue;
    const variant = variants.find((entry) => entry.platforms.includes(context.platform));
    if (!plugin.reviewed || variant === undefined) {
      diagnostics.push({ level: "warning", harness, code: !plugin.reviewed ? "PLUGIN_REVIEW_REQUIRED" : "PLUGIN_PLATFORM_UNSUPPORTED",
        message: !plugin.reviewed ? `plugins/${plugin.id} is not active; review digest ${plugin.digest} first` : `plugins/${plugin.id} has no ${harness} variant for ${context.platform}` });
      continue;
    }
    const pkg = nativePackage(plugin, variant);
    const files = plugin.files.filter((file) => file.path.startsWith(`${variant.directory}/`))
      .map((file) => ({ ...file, path: file.path.slice(variant.directory.length + 1) }));
    const id = `native-plugin-${plugin.id}`;
    if (harness === "claude-code") {
      // Claude's native skills-directory loader preserves hooks, MCP and namespaces.
      const surface = surfaces.find((entry) => entry.id === "skills");
      if (surface?.kind !== "directory") throw new Error("Claude skills directory is unavailable");
      add(surface, { kind: "directory", surface: surface.id, files: files.map((file) => ({ ...file, path: `${pkg.name}/${file.path}` })) });
      continue;
    }
    if (harness === "amp" && variant.entry !== undefined) {
      // Amp resolves a plugin's relative registerSkill paths against a directory plugin's root, never a single-file
      // plugin's, so the package itself becomes <plugins>/canonfig-<id>/ with index.ts as Amp's entry.
      const native = surfaces.find((entry) => entry.id === "plugin");
      if (native?.kind !== "file") throw new Error("amp has no native module loader");
      const directory = native.target.replace(/canonfig\.ts$/u, `canonfig-${plugin.id}`);
      if (directory === native.target) throw new Error("amp has an unknown module discovery path");
      const own = variant.entry === "index.ts" || (variant.entry === "index.js" && !files.some((file) => file.path === "index.ts"));
      if (!own && files.some((file) => file.path === "index.ts")) throw new Error(`plugins/${plugin.id}: Amp would load the package's index.ts instead of ${variant.entry}`);
      const loader = own ? [] : [{ path: "index.ts", content: new TextEncoder().encode(`export { default } from ${JSON.stringify(`./${variant.entry}`)};\n`), executable: false }];
      add({ id, kind: "directory", target: directory }, { kind: "directory", surface: id, files: [...files, ...loader] });
      continue;
    }
    const target = harness === "codex" ? context.join(layout.root, "plugins", "cache", "canonfig", pkg.name, "local")
      : harness === "qwen" ? context.join(layout.root, "extensions", pkg.name)
      : context.join(layout.root, ".canonfig-plugins", plugin.id);
    add({ id, kind: "directory", target }, { kind: "directory", surface: id, files });
    if (harness === "codex") {
      const surface = surfaces.find((entry) => entry.id === "config");
      if (surface?.kind !== "config") throw new Error("Codex configuration is unavailable");
      add(surface, { kind: "config", surface: surface.id, keys: [{ path: formatConfigPath(["plugins", `${pkg.name}@canonfig`, "enabled"]), value: true }] });
    } else if (variant.entry !== undefined) {
      const native = surfaces.find((entry) => entry.id === "plugin" || entry.id === "extension");
      if (native?.kind !== "file") throw new Error(`${harness} has no native module loader`);
      const module = pathToFileURL(context.join(target, variant.entry), { windows: context.platform === "windows" }).href;
      const targetFile = native.target.replace(/canonfig\.ts$/u, `canonfig-${plugin.id}.ts`);
      if (targetFile === native.target) throw new Error(`${harness} has an unknown module discovery path`);
      const content = harness === "kilo"
        ? `export * from ${JSON.stringify(module)};\n` : `export { default } from ${JSON.stringify(module)};\n`;
      add({ id: `${id}-loader`, kind: "file", target: targetFile }, { kind: "file", surface: `${id}-loader`, content });
    }
  }
  return { layout: { ...layout, surfaces }, projection: { contents, diagnostics } } satisfies { readonly layout: HarnessLayout; readonly projection: HarnessProjection };
};
