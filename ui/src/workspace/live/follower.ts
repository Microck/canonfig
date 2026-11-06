import { useState } from "react";
import { Schema } from "effect";
import { GuiArchiveDownload, GuiBackups, GuiHarnessReport, GuiLocalItems, GuiSecrets, GuiSecretSync, GuiSynchronizationResult } from "../../../../src/gui/contract/synchronization";
import { GuiEnrollment } from "../../../../src/gui/contract/enrollment";
import { GuiOperationTicket, type GuiOperation } from "../../../../src/gui/contract/operations";
import { GuiRequestError, type GuiSession, type GuiStatus, type WorkspaceBackend } from "../../gui-client";
import { LOCAL_CATEGORIES, type LocalItem } from "../../shared/metadata";
import type { FollowerSlice } from "../workspace-types";
import type { FollowerLive } from "../follower-types";
import { resourceState, useLiveActions, useLiveResource } from "./resource";
import { WEEK } from "../schedule";

export function record(value: Schema.Json | undefined): Record<string, Schema.Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
export function text(value: Schema.Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function strings(value: Schema.Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** File summaries never replace their exact trees or digest preconditions when saved. */
export function localItems(snapshot: GuiLocalItems | null): LocalItem[] {
  if (!snapshot) return [];
  const files: LocalItem[] = snapshot.items.flatMap((item) => {
    if (item.path === "local.jsonc") return [];
    const category = item.path === "AGENTS.md" ? "instructions" : LOCAL_CATEGORIES.find((category) => item.path.startsWith(`${category}/`));
    if (!category) return [];
    return [{ id: category === "instructions" ? "instructions" : item.path.replace(/\.md$/, ""), category, path: item.path, summary: `${item.files.length} files` }];
  });
  for (const category of ["mcp", "settings"] as const) {
    for (const name of Object.keys(record(snapshot.config[category]))) {
      files.push({ id: `${category}/${name}`, category, path: `local.jsonc ${category}.${name}`, summary: category === "mcp" ? "MCP server" : "Settings keys" });
    }
  }
  return files;
}

export function useLiveFollower(backend: WorkspaceBackend, session: GuiSession, status: GuiStatus | undefined, reload: () => void): FollowerSlice {
  const follower = session.role === "follower";
  const harnesses = useLiveResource(backend, "/api/harnesses", GuiHarnessReport, session.role !== "unconfigured");
  const local = useLiveResource(backend, "/api/local/items", GuiLocalItems, follower);
  const schedule = useLiveResource(backend, "/api/schedule", GuiSynchronizationResult, follower);
  const backups = useLiveResource(backend, "/api/backups", GuiBackups, follower);
  const overlays = useLiveResource(backend, "/api/local/overlays", GuiSynchronizationResult, follower);
  const tunnel = useLiveResource(backend, "/api/tunnel", GuiSynchronizationResult, follower);
  const enrollment = useLiveResource(backend, "/api/enrollment", GuiEnrollment, follower);
  const secrets = useLiveResource(backend, "/api/secrets", GuiSecrets, follower);
  const actions = useLiveActions(backend, reload);
  const [operation, setOperation] = useState<GuiOperation | null>(null);
  const [operationName, setOperationName] = useState("");
  const [secretMessage, setSecretMessage] = useState("");
  const [archive, setArchive] = useState<FollowerLive["archive"]>(null);
  const [unenrollOpen, setUnenrollOpen] = useState(false);
  const [unenrolled, setUnenrolled] = useState(false);
  const config = local.data?.config ?? {};
  const configItem = local.data?.items.find((item) => item.path === "local.jsonc");
  const excluded = [...(harnesses.data?.excluded ?? [])];
  const overlayItems = strings(config.overlays);
  const items = localItems(local.data);
  const interrupted = status?.activeRecovery !== undefined && status.activeRecovery !== null;
  const run = async (action: (signal: AbortSignal) => Promise<unknown>) => {
    let succeeded = false;
    await actions.run(async (signal) => { await action(signal); succeeded = true; });
    return succeeded;
  };
  const mutation = (path: string, method: "POST" | "PUT" | "DELETE", body: unknown) =>
    run((signal) => backend.request(path, GuiSynchronizationResult, signal, { method, body }));
  const start = (path: string, name: string, body: unknown = {}) => { void actions.run(async (signal) => {
    setOperationName(name);
    setOperation(null);
    const ticket = await backend.request(path, GuiOperationTicket, signal, { method: "POST", body });
    let current = await backend.operation(ticket.id, signal);
    setOperation(current);
    while (current.state === "running") {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      signal.throwIfAborted();
      current = await backend.operation(ticket.id, signal);
      if (!signal.aborted) setOperation(current);
    }
    // Keep failed operation evidence visible, including the exact run journal.
    if (current.state === "failed") {
      reload();
      throw current.failure ? new GuiRequestError(current.failure) : new Error("The operation failed without a diagnostic.");
    }
  }); };
  const savePreferences: FollowerLive["savePreferences"] = (input) => run((signal) => backend.request("/api/local/preferences", GuiLocalItems, signal, {
    method: "PUT", body: input,
  }));
  const check = () => start("/api/sync/plan", "Check for updates");
  const live: FollowerLive = {
    action: actions.state, operation, operationName, local: local.data,
    allowed: LOCAL_CATEGORIES.filter((category) => strings(record(local.data?.canonicalConfig.local).allow).includes(category)),
    schedule: schedule.data, tunnel: tunnel.data, enrollment: enrollment.data, secrets: secrets.data?.secrets ?? [],
    check, createReview: () => start("/api/sync/reviews", "Private adoption review"),
    saveSchedule: (draft) => mutation("/api/schedule", "PUT", draft.cadence === "default" ? { profileDefault: true } : {
      schedule: draft.cadence === "custom" ? { kind: "custom", expression: draft.expression, timezone: draft.timezone } : draft.cadence === "daily" ?
        { kind: "daily", localTime: draft.time, timezone: draft.timezone } :
        { kind: "weekly", localTime: draft.time, weekdays: draft.cadence === "weekdays" ? ["Mon", "Tue", "Wed", "Thu", "Fri"] : draft.days, timezone: draft.timezone },
    }),
    saveItems: (input) => run((signal) => backend.request("/api/local/items", GuiLocalItems, signal, { method: "PUT", body: input })),
    savePreferences,
    refreshSecrets: () => { void actions.run(async (signal) => {
      const report = await backend.request("/api/secrets/sync", GuiSecretSync, signal, { method: "POST", body: {} });
      setSecretMessage(report.status === "synchronized" ? `Updated ${report.secrets.length} secrets.` : report.status === "not-shared" ? "This enrollment does not receive shared secrets." : "This machine is not enrolled.");
    }); },
    toggleTunnel: () => { void mutation(`/api/tunnel/${tunnel.data?.lifecycle === "running" ? "stop" : "start"}`, "POST", {}); },
    archive,
    exportArchive: () => { void actions.run(async (signal) => {
      const download = await backend.request("/api/exports", GuiArchiveDownload, signal, { method: "POST", body: { includeHarnesses: false } });
      const bytes = Uint8Array.from(atob(download.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: download.mediaType }));
      const link = document.createElement("a");
      link.href = url; link.download = download.filename; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setArchive({ sha256: download.sha256, manifestSha256: download.manifestSha256, signer: download.signer });
    }); },
  };
  const savedSchedule = record(schedule.data?.schedule);
  const kind = savedSchedule.kind;
  // Mutation progress must not remount the detail panel and discard a failed save's draft.
  const actionError = { loading: false, error: actions.state.error };
  return {
    followerLive: live,
    followerState: resourceState([tunnel, enrollment, secrets, actionError]),
    followerStates: {
      harnesses: resourceState([harnesses, actionError]), local: resourceState([harnesses, local, overlays, actionError]),
      schedule: resourceState([schedule, actionError]), backups: resourceState([backups, actionError]),
      overlays: resourceState([overlays, actionError]), tunnel: resourceState([tunnel, actionError]),
    },
    followerSchedule: kind === "daily" || kind === "weekly" || kind === "custom" ? {
      cadence: kind === "weekly" ? "days" : kind, time: text(savedSchedule.localTime) ?? "", days: WEEK.filter((day) => strings(savedSchedule.weekdays).includes(day)),
      expression: text(savedSchedule.expression), timezone: text(savedSchedule.timezone),
    } : null,
    tunnelUp: tunnel.data?.lifecycle === "running", secretsRefresh: { busy: actions.state.loading, updated: secretMessage },
    serviceInstalled: false, tunnelConfigured: tunnel.data !== null && tunnel.data.lifecycle !== "not-configured",
    plan: [], targetRevision: undefined, phase: actions.state.loading ? "running" : "plan", progress: undefined,
    applyPlan: () => start("/api/sync/apply", "Apply changes"), driftOpen: false, interrupted,
    recover: () => start("/api/recovery", "Recover update"), abandon: () => start("/api/recovery/abandon", "Abandon update"),
    runs: [], humanAction: actions.state.error?.failure.category === "human-action-required", setHumanAction: check, appliedRevision: undefined,
    excluded, setExcluded: (update) => { const next = typeof update === "function" ? update(excluded) : update; void actions.run(async (signal) => {
      for (const harness of new Set([...excluded, ...next])) {
        if (excluded.includes(harness) !== next.includes(harness)) await backend.request("/api/harnesses", GuiHarnessReport, signal, { method: "PUT", body: { harness, action: next.includes(harness) ? "exclude" : "include" } });
      }
    }); },
    harnesses: (harnesses.data?.harnesses ?? []).map((entry) => ({ id: entry.harness, name: entry.name, installed: entry.installed, listed: entry.listed, excluded: entry.excluded, root: entry.pinnedRoot ?? null, snapshot: entry.snapshot ?? null })),
    backups: config.backups !== false,
    setBackups: (update) => { const next = typeof update === "function" ? update(config.backups !== false) : update; void savePreferences({ expectedDigest: configItem?.digest ?? null, edits: [{ path: ["backups"], value: next }] }); },
    snapshots: (backups.data?.snapshots ?? []).map((id) => ({ id, harnesses: [] })),
    restore: (snapshot) => start("/api/backups/restore", "Restore backup", { snapshot }),
    local: items,
    setLocal: (update) => { const next = typeof update === "function" ? update(items) : update; void actions.run(async (signal) => {
      const removed = items.filter((item) => !next.some((entry) => entry.id === item.id));
      const changes = removed.flatMap((item) => { const file = local.data?.items.find((entry) => entry.path === item.path); return file ? [{ path: file.path, expectedDigest: file.digest, files: [] }] : []; });
      if (changes.length) await backend.request("/api/local/items", GuiLocalItems, signal, { method: "PUT", body: { changes } });
    }); },
    overlays: overlayItems, setOverlays: (update) => { const next = typeof update === "function" ? update(overlayItems) : update; void actions.run(async (signal) => {
      for (const item of new Set([...overlayItems, ...next])) {
        if (overlayItems.includes(item) !== next.includes(item)) await backend.request("/api/local/overlays", GuiSynchronizationResult, signal, { method: next.includes(item) ? "PUT" : "DELETE", body: { item } });
      }
    }); }, kept: [],
    unenrollOpen, setUnenrollOpen, unenrolled,
    unenroll: () => { void actions.run(async (signal) => {
      await backend.request("/api/enrollment", Schema.Json, signal, { method: "DELETE", body: {} });
      setUnenrolled(true); window.location.assign("/setup");
    }); }, isStopped: () => unenrolled,
  };
}
