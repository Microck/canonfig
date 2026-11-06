import { useEffect, useMemo, useRef, useState } from "react";
import { Schema } from "effect";
import { HARNESS_NAMES, LOCAL_CATEGORIES, APPEND_LOCAL_CATEGORIES, SURFACE_CATEGORIES, type HarnessId, type SurfaceCategory } from "@/shared/metadata";
import { GuiProfileSnapshot, GuiProfileSaved, GuiProfileValidation, GuiRevisions, GuiSkills, GuiTrackedSkill, GuiSkillChecks, profileEndpoints, type GuiProfileConfigWrite, type GuiSkillCheck } from "../../../../src/gui/contract/profile";
import { GuiArchiveDownload, GuiSecrets, GuiSecretSummary, GuiSecretRemoval } from "../../../../src/gui/contract/synchronization";
import type { GuiRequestError, GuiSession, WorkspaceBackend } from "../../gui-client";
import type { ProfileSlice, ProfileEdit, ScannedTool } from "../workspace-types";
import { authoredItems, itemWrite, object, strings } from "../profile-authoring";
import { WEEK, type Schedule } from "../schedule";
import { requestError, resourceState, useLiveActions, useLiveResource } from "./resource";

function scheduleOf(value: Schema.Json | undefined): Schedule | null {
  if (typeof value !== "string") return null;
  const [cadence, time] = value.split("@");
  if (!time) return null;
  return cadence === "daily" ? { cadence: "daily", days: [], time } : { cadence: "days", days: WEEK.filter((day) => cadence?.slice(7).split(",").includes(day)), time };
}

export function useLiveProfile(backend: WorkspaceBackend, session: GuiSession, reload: () => void, refresh: () => void): Omit<ProfileSlice, "profileTab"> {
  const source = session.role === "source";
  const items = useLiveResource(backend, profileEndpoints.items, GuiProfileSnapshot, source);
  const revisions = useLiveResource(backend, profileEndpoints.revisions, GuiRevisions, source);
  const skills = useLiveResource(backend, profileEndpoints.skills, GuiSkills, source);
  const secrets = useLiveResource(backend, "/api/secrets", GuiSecrets, source);
  const operations = useLiveActions(backend, reload);
  const active = useRef<AbortController | null>(null);
  const [actionState, setActionState] = useState({ loading: false, error: null as GuiRequestError | null });
  useEffect(() => () => active.current?.abort(), []);
  async function run(action: (signal: AbortSignal) => Promise<unknown>, refresh = true) {
    if (active.current) return false;
    const controller = new AbortController(); active.current = controller;
    setActionState({ loading: true, error: null });
    try {
      await action(controller.signal);
      if (controller.signal.aborted) return false;
      setActionState({ loading: false, error: null });
      if (refresh) reload();
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setActionState({ loading: false, error: requestError(cause) });
      return false;
    } finally { active.current = null; }
  }
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [validation, setValidation] = useState<GuiProfileValidation | null>(null);
  const [archive, setArchive] = useState<GuiArchiveDownload | null>(null);
  const [skillChecks, setSkillChecks] = useState<Record<string, GuiSkillCheck>>({});
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [scannedTools, setScannedTools] = useState<ScannedTool[]>([]);
  const [scanDone, setScanDone] = useState(false);
  const [revisionDetail, setRevisionDetail] = useState<Schema.Json | null>(null);
  const [pending, setPending] = useState<ProfileEdit[]>([]);
  const config = items.data?.config ?? {};
  const profileConfig = object(config.profile), localConfig = object(config.local);
  const resources = useMemo(() => items.data ? authoredItems(items.data).map((entry) => entry.resource) : [], [items.data]);
  const profile = { id: typeof profileConfig.id === "string" ? profileConfig.id : "", name: typeof profileConfig.name === "string" ? profileConfig.name : "", groups: Object.keys(object(config.groups)).map((name) => ({ name, description: "" })), localAllow: LOCAL_CATEGORIES.filter((category) => strings(localConfig.allow).includes(category)), appendLocal: APPEND_LOCAL_CATEGORIES.filter((category) => strings(localConfig.appendLocal).includes(category)) };
  const listed = (Object.keys(HARNESS_NAMES) as HarnessId[]).filter((id) => strings(config.harnesses).includes(id));
  const surfaces: Partial<Record<HarnessId, SurfaceCategory[]>> = {};
  for (const id of listed) {
    const configured = object(config.surfaces)[id];
    if (configured !== undefined) surfaces[id] = SURFACE_CATEGORIES.filter((category) => strings(configured).includes(category));
  }
  const saveConfig = (snapshot: GuiProfileSnapshot, edits: typeof GuiProfileConfigWrite.Type.edits) => run((signal) => backend.request(profileEndpoints.config, GuiProfileSaved, signal, { method: "PUT", body: { expectedDigest: snapshot.items.find((item) => item.path === "canonfig.jsonc")?.digest ?? null, edits, changes: [] } }));
  const saveItem: NonNullable<ProfileSlice["profileLive"]>["saveItem"] = (snapshot, before, next, exact, remove) => run(async (signal) => {
    await backend.request(profileEndpoints.config, GuiProfileSaved, signal, { method: "PUT", body: itemWrite(snapshot, before, next, exact, remove) });
    if (next.category === "skills") setSkillChecks((checks) => Object.fromEntries(Object.entries(checks).filter(([id]) => id !== before?.id && id !== next.id)));
  });
  function skillAction(kind: "check" | "update", name: string) {
    void run(async (signal) => {
      setSkillBusy(`${kind}:skills/${name}`);
      setSkillChecks(({ [`skills/${name}`]: _previous, ...checks }) => checks);
      try {
        const completed = await operations.operation(profileEndpoints[kind], { name }, signal);
        const checks = Schema.decodeUnknownSync(GuiSkillChecks)(completed.result);
        setSkillChecks((previous) => ({ ...previous, ...Object.fromEntries(checks.map((check) => [`skills/${check.name}`, kind === "update" ? { ...check, status: "unchanged" as const } : check])) }));
      } finally { setSkillBusy(null); }
    });
  }
  const profileLive: NonNullable<ProfileSlice["profileLive"]> = {
    snapshot: items.data, busy: actionState.loading, error: actionState.error, validation, archive, skillChecks, skillBusy, scanDone, revisionDetail,
    reload: () => { setActionState({ loading: false, error: null }); setValidation(null); refresh(); }, saveItem, saveConfig,
    setSecret: (name, value) => run((signal) => backend.request("/api/secrets", GuiSecretSummary, signal, { method: "PUT", body: { name, value } })),
    removeSecret: (name) => run((signal) => backend.request("/api/secrets", GuiSecretRemoval, signal, { method: "DELETE", body: { name } })),
    validate: () => run(async (signal) => { setValidation(null); setValidation(await backend.request(profileEndpoints.validate, GuiProfileValidation, signal, { method: "POST", body: {} })); }, false),
    scan: () => run(async (signal) => {
      setScanDone(false);
      const scan = object(await backend.request(profileEndpoints.scan, Schema.Json, signal, { method: "POST", body: {} }));
      setScannedTools((Array.isArray(scan.tools) ? scan.tools : []).map((value) => {
        const tool = object(value), evidence = object(Array.isArray(tool.evidence) ? tool.evidence[0] : undefined);
        return { id: String(tool.id), executable: String(tool.executable), command: strings(evidence.invocation).join(" "), file: String(evidence.sourcePath ?? ""), where: String(tool.reviewStatus ?? "") };
      })); setScanDone(true);
    }, false),
    inspectRevision: (sequence) => { const entry = revisions.data?.revisions.find((entry) => entry.sequence === sequence); if (entry) void run(async (signal) => { setRevisionDetail(null); setRevisionDetail(await backend.request(profileEndpoints.revision, Schema.Json, signal, { method: "POST", body: { revision: entry.id } })); }, false); },
    trackSkill: (name, source, ref, subdir) => run(async (signal) => {
      setSkillBusy(`track:skills/${name}`);
      try {
        const completed = await operations.operation(profileEndpoints.track, { name, source, ref, subdir }, signal);
        Schema.decodeUnknownSync(GuiTrackedSkill)(completed.result);
      }
      finally { setSkillBusy(null); }
    }),
    checkSkill: (name) => skillAction("check", name), updateSkill: (name) => skillAction("update", name),
  };
  return {
    profileLive, profileState: resourceState([items, revisions, skills, secrets]), profileStates: { items, revisions, skills, secrets },
    profile, profileName: profile.name, profileSchedule: scheduleOf(config.scheduleDefault), proposed: [], publishOpen, setPublishOpen, resources,
    setResources: (update) => { if (!items.data) return; const next = typeof update === "function" ? update(resources) : update; const changed = next.find((entry) => resources.find((before) => before.id === entry.id) !== entry); const removed = resources.find((entry) => !next.some((after) => after.id === entry.id)); if (changed) void saveItem(items.data, resources.find((entry) => entry.id === changed.id), changed, undefined, changed.change === "removed"); else if (removed) void saveItem(items.data, removed, removed, undefined, true); },
    readResources: () => resources, readQueue: () => ({ pending: [], nextSequence: undefined }),
    revisions: (revisions.data?.revisions ?? []).map((entry) => ({ sequence: entry.sequence, digest: entry.digest, publishedAt: entry.publishedAt, reviewer: "", changes: "" })),
    latest: revisions.data?.revisions[0]?.sequence, publicationReviewer: "", secrets: (secrets.data?.secrets ?? []).map(({ name }) => ({ name })),
    setSecrets: (update) => { const current = (secrets.data?.secrets ?? []).map(({ name }) => ({ name })); const next = typeof update === "function" ? update(current) : update; const removed = current.find((entry) => !next.some((after) => after.name === entry.name)); if (removed) void profileLive.removeSecret(removed.name); },
    pending, markProfileEdit: (edit) => setPending((previous) => [...previous.filter((entry) => entry.id !== edit.id), edit]), removeProfileEdit: (edit) => setPending((previous) => previous.filter((entry) => entry.id !== edit.id)), nextSequence: undefined, publishing,
    publish: (reviewer, onDone) => { void run(async (signal) => { setPublishing(true); try { await operations.operation(profileEndpoints.publications, { reviewer }, signal); setValidation(null); setPending([]); onDone(); } finally { setPublishing(false); } }); },
    listed, setListed: (update) => { if (!items.data) return; const next = typeof update === "function" ? update(listed) : update; void saveConfig(items.data, [{ path: ["harnesses"], value: next }, { path: ["surfaces"], value: Object.fromEntries(Object.entries(surfaces).filter(([id]) => next.includes(id as HarnessId))) }]); },
    surfaces, setSurfaces: (update) => { if (items.data) void saveConfig(items.data, [{ path: ["surfaces"], value: typeof update === "function" ? update(surfaces) : update }]); },
    skillSources: (skills.data?.skills ?? []).map((skill) => ({ id: `skills/${skill.name}`, source: skill.source, ref: skill.ref, subdir: skill.subdir, commit: skill.commit, baseline: {} })), upstreamSkills: [], demoSkillsRepo: "", scannedTools,
    toolFromScan: (tool) => ({ id: `tools/${tool.id}`, category: "tools", path: "canonfig.jsonc", groups: [], summary: tool.command, detail: { Executable: tool.executable } }),
    exportArchive: () => { void run(async (signal) => {
      const downloaded = await backend.request("/api/exports", GuiArchiveDownload, signal, { method: "POST", body: { includeHarnesses: false } });
      const bytes = Uint8Array.from(atob(downloaded.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: downloaded.mediaType }));
      const link = document.createElement("a"); link.href = url; link.download = downloaded.filename; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); setArchive(downloaded);
    }, false); },
  };
}
