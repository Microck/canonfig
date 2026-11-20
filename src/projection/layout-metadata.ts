import { posix, win32 } from "node:path";
import { BUILTIN_ADAPTERS } from "./adapters/index.ts";
import type { HarnessAdapter, HarnessLayout, OwnedSurface, RootContext } from "./harness.ts";
import { SURFACE_CATEGORIES, type CanonicalModel, type SurfaceCategory } from "./model.ts";

/** The config file that receives a harness's declared settings, if it has one. */
export const settingsSurfaceOf = (layout: HarnessLayout) =>
  layout.surfaces.find((candidate): candidate is Extract<OwnedSurface, { readonly kind: "config" }> =>
    candidate.kind === "config" && candidate.settings !== undefined
  );

export const supportedCategories = (adapter: HarnessAdapter, layout: HarnessLayout): ReadonlyArray<SurfaceCategory> =>
  SURFACE_CATEGORIES.filter((category) => category === "settings"
    ? settingsSurfaceOf(layout) !== undefined
    : adapter.descriptor.capabilities[category] !== "unsupported"
  );

const adapterLayouts = (context: RootContext, model: CanonicalModel) =>
  BUILTIN_ADAPTERS.map((adapter) => ({ adapter, layout: adapter.layout(context, model) }));

/** Authored resources cannot overlap any layout, including an unselected harness. */
export function reservedResourcePaths(context: RootContext, model: CanonicalModel, layouts = adapterLayouts(context, model)) {
  return [
    { owner: "the Canonical Folder", path: model.folder },
    { owner: "the shared agent directory", path: context.join(context.home, ".agents") },
    ...layouts.flatMap(({ adapter, layout }) => [
      layout.root,
      ...layout.surfaces.flatMap((surface) => surface.kind === "config"
        ? [surface.target, ...surface.alternatives ?? []]
        : [surface.target]),
      ...layout.neverTouch,
    ].map((path) => ({ owner: adapter.descriptor.name, path }))),
  ];
}

export const pathsFor = (platform: RootContext["platform"]) => platform === "windows" ? win32 : posix;

function relativeInside(paths: typeof posix, root: string, path: string): string | undefined {
  const relative = paths.relative(root, path);
  if (relative === ".." || relative.startsWith(".." + paths.sep) || paths.isAbsolute(relative)) return undefined;
  return relative;
}

export const within = (paths: typeof posix, root: string, path: string): boolean =>
  relativeInside(paths, root, path) !== undefined;

export function projectionSettingsFiles(context: RootContext, model: CanonicalModel, layouts = adapterLayouts(context, model)) {
  return Object.fromEntries(layouts.flatMap(({ adapter, layout }) => {
    const settings = settingsSurfaceOf(layout);
    return settings?.settings ? [[adapter.descriptor.id, { owned: settings.keys, reserved: settings.settings.reserved }] as const] : [];
  }));
}

/** The adapter-owned inputs needed by Profile authoring. */
export function projectionProfileMetadata(context: RootContext, model: CanonicalModel, layouts = adapterLayouts(context, model)) {
  const paths = pathsFor(context.platform);
  const caseSensitive = context.platform === "linux";
  const fold = (path: string) => caseSensitive ? path : path.toLowerCase();
  const home = fold(context.home);
  const reservedPaths: Array<{ owner: string; path: string }> = [];
  for (const entry of reservedResourcePaths(context, model, layouts)) {
    const path = fold(entry.path);
    const child = relativeInside(paths, home, path);
    const relative = within(paths, path, home) ? "~" : child === undefined ? undefined : "~/" + child.split(paths.sep).join("/");
    if (relative === undefined) continue;
    // An earlier ancestor already wins every overlap with this path.
    if (reservedPaths.some(({ path }) => path === relative || relative.startsWith(path + "/"))) continue;
    reservedPaths.push({ owner: entry.owner, path: relative });
  }
  return {
    caseSensitive,
    reservedPaths,
    supportedSurfaces: Object.fromEntries(layouts.map(({ adapter, layout }) => [adapter.descriptor.id, supportedCategories(adapter, layout)])),
  };
}

export function projectionLayoutMetadata(context: RootContext, model: CanonicalModel) {
  const layouts = adapterLayouts(context, model);
  return { ...projectionProfileMetadata(context, model, layouts), settingsFiles: projectionSettingsFiles(context, model, layouts) };
}
