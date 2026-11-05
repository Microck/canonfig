import { useMemo, useState } from "react";
import { Schema } from "effect";
import { CATEGORY_LABEL, HARNESS_NAMES, LOCAL_CATEGORIES, APPEND_LOCAL_CATEGORIES, SURFACE_CATEGORIES, type HarnessId, type ItemCategory, type Resource, type SurfaceCategory } from "@/shared/metadata";
import { GuiProfileSnapshot, GuiRevisions, GuiSkills, profileEndpoints } from "../../../../src/gui/contract/profile";
import { GuiArchiveDownload, GuiSecrets } from "../../../../src/gui/contract/synchronization";
import type { GuiSession, WorkspaceBackend } from "../../gui-client";
import type { ProfileSlice, ScannedTool } from "../workspace-types";
import { notImplemented, resourceState, useLiveActions, useLiveResource } from "./resource";

/** Phase 2d checklist: these members need digest-aware form and publication integration.
 * notImplemented: setResources, setSecrets, markProfileEdit, removeProfileEdit, publish,
 * setListed, setSurfaces, scannedTools, skillSources, upstreamSkills, profileSchedule.
 * Once complete, delete ui/src/live/profile.tsx and its form modules.
 */
export const PROFILE_NOT_IMPLEMENTED = ["setResources", "setSecrets", "markProfileEdit", "removeProfileEdit", "publish", "setListed", "setSurfaces", "scannedTools", "skillSources", "upstreamSkills", "profileSchedule"] as const;

function object(value: Schema.Json | undefined): Record<string, Schema.Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
function strings(value: Schema.Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Read-only projection. Exact file trees and digests remain in the authoring API, not editable summaries. */
function itemsOf(snapshot: GuiProfileSnapshot | null): Resource[] {
  if (!snapshot) return [];
  const memberships = new Map<string, string[]>();
  for (const [group, members] of Object.entries(object(snapshot.config.groups))) {
    for (const id of new Set(strings(members))) {
      const groups = memberships.get(id);
      if (groups) groups.push(group);
      else memberships.set(id, [group]);
    }
  }
  const membership = (id: string) => memberships.get(id) ?? [];
  const items: Resource[] = snapshot.items.flatMap((item) => {
    if (item.path === "canonfig.jsonc") return [];
    const category = item.path === "AGENTS.md" ? "instructions" : item.path.startsWith("files/") ? "resources" : item.path.split("/")[0];
    if (!(category in CATEGORY_LABEL)) return [];
    const id = category === "instructions" ? "instructions" : item.path.replace(/\.md$/, "");
    return [{ id, category: category as ItemCategory, path: item.path, groups: membership(id), summary: `${item.files.length} files`, detail: { Digest: item.digest ?? "Not recorded" } }];
  });
  for (const category of ["mcp", "hooks", "settings", "tools", "credentials", "resources"] as const) {
    for (const [name, value] of Object.entries(object(snapshot.config[category]))) {
      const id = `${category}/${name}`;
      items.push({ id, category, path: `canonfig.jsonc ${category}.${name}`, groups: membership(id), summary: "Authored configuration", detail: { JSON: JSON.stringify(value, null, 2) } });
    }
  }
  return items;
}

export function useLiveProfile(backend: WorkspaceBackend, session: GuiSession, revision: number, reload: () => void): Omit<ProfileSlice, "profileTab"> {
  const source = session.role === "source";
  const items = useLiveResource(backend, profileEndpoints.items, GuiProfileSnapshot, source, revision);
  const revisions = useLiveResource(backend, profileEndpoints.revisions, GuiRevisions, source, revision);
  const skills = useLiveResource(backend, profileEndpoints.skills, GuiSkills, source, revision);
  const secrets = useLiveResource(backend, "/api/secrets", GuiSecrets, session.role !== "unconfigured", revision);
  const actions = useLiveActions(backend, reload);
  const [publishOpen, setPublishOpen] = useState(false);
  const config = items.data?.config ?? {};
  const profileConfig = object(config.profile);
  const localConfig = object(config.local);
  const resources = useMemo(() => itemsOf(items.data), [items.data]);
  const profile = {
    id: typeof profileConfig.id === "string" ? profileConfig.id : "",
    name: typeof profileConfig.name === "string" ? profileConfig.name : "",
    groups: Object.keys(object(config.groups)).map((name) => ({ name, description: "" })),
    localAllow: LOCAL_CATEGORIES.filter((category) => strings(localConfig.allow).includes(category)),
    appendLocal: APPEND_LOCAL_CATEGORIES.filter((category) => strings(localConfig.appendLocal).includes(category)),
  };
  const listed = (Object.keys(HARNESS_NAMES) as HarnessId[]).filter((id) => strings(config.harnesses).includes(id));
  const surfaces: Partial<Record<HarnessId, SurfaceCategory[]>> = {};
  for (const id of listed) {
    const configured = object(config.surfaces)[id];
    if (configured !== undefined) surfaces[id] = SURFACE_CATEGORIES.filter((category) => strings(configured).includes(category));
  }
  return {
    profileState: resourceState([items, revisions, skills, secrets, actions.state]),
    profileStates: { items, revisions, skills, secrets },
    profile, profileName: profile.name, profileSchedule: null,
    proposed: [], publishOpen, setPublishOpen, resources,
    setResources: () => notImplemented("setResources"), readResources: () => resources,
    readQueue: () => ({ pending: [], nextSequence: undefined }),
    revisions: (revisions.data?.revisions ?? []).map((entry) => ({ sequence: entry.sequence, digest: entry.digest, publishedAt: entry.publishedAt, reviewer: "", changes: "" })),
    latest: revisions.data?.revisions[0]?.sequence,
    publicationReviewer: "",
    secrets: (secrets.data?.secrets ?? []).map(({ name }) => ({ name })),
    setSecrets: () => notImplemented("setSecrets"), pending: [],
    markProfileEdit: () => notImplemented("markProfileEdit"), removeProfileEdit: () => notImplemented("removeProfileEdit"),
    nextSequence: undefined, publishing: false, publish: () => notImplemented("publish"),
    listed, setListed: () => notImplemented("setListed"), surfaces, setSurfaces: () => notImplemented("setSurfaces"),
    skillSources: [], upstreamSkills: [], demoSkillsRepo: "", scannedTools: [],
    toolFromScan: (_tool: ScannedTool) => notImplemented("selective scan write"),
    exportArchive: () => { void actions.run(async (signal) => {
      const archive = await backend.request("/api/exports", GuiArchiveDownload, signal, { method: "POST", body: { includeHarnesses: false } });
      const bytes = Uint8Array.from(atob(archive.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: archive.mediaType }));
      const link = document.createElement("a");
      link.href = url; link.download = archive.filename; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }); },
  };
}
