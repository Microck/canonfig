import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Schema } from "effect";
import { formatConfigPath } from "../domain/config-path.ts";
import type { AppliedResourceRecord } from "../domain/synchronization.ts";
import type { AuthoringChange } from "./authoring.ts";
import { adapterFor } from "./adapters/index.ts";
import type { RootContext } from "./harness.ts";
import type { CanonicalModel, SkillFile } from "./model.ts";
import { NATIVE_PLUGIN_HARNESSES, nativeManifestPath, nativePluginDigest, nativePluginIssue, type NativePluginManifest, type NativePluginVariant } from "./native-plugin.ts";

/** Preserve executable intent and bundled dependencies without following links into private state. */
export const readNativePackage = async (directory: string): Promise<ReadonlyArray<SkillFile>> => {
  const files: SkillFile[] = [];
  let bytes = 0;
  const walk = async (root: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(root, entry.name);
      const relative = prefix + entry.name;
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(path, `${relative}/`);
      else {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${path}: plugin payloads require independent regular files, not links`);
        bytes += stat.size;
        if (bytes > 128 * 1024 * 1024 || files.length >= 10000) throw new Error(`${directory}: plugin exceeds 128 MiB or 10000 files`);
        files.push({ path: relative, content: await readFile(path), executable: (stat.mode & 0o100) !== 0 });
      }
    }
  };
  if (await realpath(directory) !== resolve(directory)) throw new Error(`${directory}: plugin root must not have linked ancestors`);
  await walk(directory, "");
  return files;
};

const packageIdentity = Schema.Struct({ name: Schema.NonEmptyString, main: Schema.optional(Schema.String) });
export interface NativeInstall {
  readonly path: string;
  readonly harness: NativePluginVariant["harness"];
  readonly entry?: string | undefined;
  readonly disable?: { readonly path: string; readonly format: "json" | "toml"; readonly key: string };
}

/** Every admission clears review, even if a package shipped its own Canonfig manifest. */
export const nativeInstallChange = async (install: NativeInstall, platform: RootContext["platform"]) => {
  const stat = await lstat(install.path);
  let files: ReadonlyArray<SkillFile>;
  if (stat.isFile()) {
    if (stat.nlink !== 1 || stat.size > 16 * 1024 * 1024 || await realpath(install.path) !== resolve(install.path)) throw new Error(`${install.path}: module must be an independent regular file under 16 MiB`);
    const name = basename(install.path).replace(/\.[^.]+$/u, "");
    files = [
      { path: "package.json", content: new TextEncoder().encode(JSON.stringify({ name })), executable: false },
      { path: basename(install.path), content: await readFile(install.path), executable: (stat.mode & 0o100) !== 0 },
    ];
  } else files = await readNativePackage(install.path);
  const manifest = files.find((file) => file.path === nativeManifestPath(install.harness));
  if (manifest === undefined) throw new Error(`${install.path}: missing ${nativeManifestPath(install.harness)}`);
  const pkg = Schema.decodeUnknownSync(packageIdentity)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.content)));
  const name = pkg.name.replace(/^@/u, "").replace(/[^a-z0-9-]/gu, "-");
  const path = `plugins/${install.harness}-${name}`;
  const moduleHarness = !["claude-code", "codex", "qwen"].includes(install.harness);
  const entry = moduleHarness ? install.entry ?? (stat.isFile() ? basename(install.path) : pkg.main ?? files.find((file) => /^(index|plugin)\.(ts|js|mjs)$/u.test(file.path))?.path) : undefined;
  const declaration = { version: 1, variants: [{ id: install.harness, harness: install.harness, platforms: [platform], directory: "package", entry }] } satisfies NativePluginManifest;
  const payload = files.map((file) => ({ ...file, path: `package/${file.path}` }));
  const issue = nativePluginIssue(declaration, payload);
  if (issue !== undefined) throw new Error(`${install.path}: ${issue}`);
  const digest = nativePluginDigest(declaration, payload);
  const change: AuthoringChange = { path, expectedDigest: null, files: [
    { path: `${path}/plugin.jsonc`, content: new TextEncoder().encode(JSON.stringify(declaration, null, 2) + "\n"), executable: false },
    ...payload.map((file) => ({ ...file, path: `${path}/${file.path}` })),
  ] };
  return { change, digest };
};

const entries = (directory: string) => readdir(directory, { withFileTypes: true }).catch((error) => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
  throw error;
});

/** Discover whole packages before skill discovery, including disabled packages awaiting review. */
export const scanNativeInstalls = async (context: RootContext, model: CanonicalModel, applied: ReadonlyArray<AppliedResourceRecord>) => {
  const installs: NativeInstall[] = [];
  const roots: string[] = [];
  const managed = (path: string) => applied.some((record) => path === record.target || record.ownership === "DirectoryEntries" && record.ownedFiles.some((file) => join(record.target, file.path).startsWith(path + sep)));
  for (const harness of NATIVE_PLUGIN_HARNESSES.filter((id) => model.harnesses.includes(id))) {
    const layout = adapterFor(harness).layout(context, model);
    const collect = (install: NativeInstall) => {
      roots.push(install.path);
      if (!managed(install.path)) installs.push(install);
    };
    if (harness === "claude-code" || harness === "codex") {
      const cache = join(layout.root, "plugins", "cache");
      for (const market of await entries(cache)) {
        if (!market.isDirectory()) continue;
        for (const plugin of await entries(join(cache, market.name))) {
          if (!plugin.isDirectory()) continue;
          for (const version of await entries(join(cache, market.name, plugin.name))) {
            if (!version.isDirectory()) continue;
            collect({ path: join(cache, market.name, plugin.name, version.name), harness,
              disable: harness === "claude-code"
                ? { path: join(layout.root, "settings.json"), format: "json", key: formatConfigPath(["enabledPlugins", `${plugin.name}@${market.name}`]) }
                : { path: join(layout.root, "config.toml"), format: "toml", key: formatConfigPath(["plugins", `${plugin.name}@${market.name}`, "enabled"]) } });
          }
        }
      }
      if (harness === "claude-code") {
        const skills = join(layout.root, "skills");
        for (const plugin of await entries(skills)) {
          if (!plugin.isDirectory()) continue;
          if ((await entries(join(skills, plugin.name, ".claude-plugin"))).some((file) => file.name === "plugin.json")) collect({ path: join(skills, plugin.name), harness });
        }
      }
    } else if (harness === "qwen") {
      const directory = join(layout.root, "extensions");
      for (const plugin of await entries(directory)) if (plugin.isDirectory()) collect({ path: join(directory, plugin.name), harness });
    } else {
      const loader = layout.surfaces.find((surface) => surface.id === "plugin" || surface.id === "extension");
      if (loader === undefined) continue;
      const directory = dirname(loader.target);
      for (const plugin of await entries(directory)) {
        if (plugin.isDirectory() || plugin.isFile() && /\.(ts|js|mjs)$/u.test(plugin.name)) collect({ path: join(directory, plugin.name), harness });
      }
    }
  }
  return { installs, roots };
};
