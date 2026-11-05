import { useState } from "react";
import { Schema } from "effect";
import { GuiBackups, GuiHarnessReport, GuiLocalItems, GuiSynchronizationResult } from "../../../../src/gui/contract/synchronization";
import type { GuiSession, GuiStatus, WorkspaceBackend } from "../../gui-client";
import type { FollowerSlice } from "../workspace-types";
import { notImplemented, resourceState, useLiveActions, useLiveResource } from "./resource";

/** Phase 2d checklist: these members need shared forms that preserve CLI evidence and digest checks.
 * notImplemented: plan, runs, setHumanAction, setExcluded, setBackups, setLocal,
 * setOverlays, followerSchedule, tunnel controls, secret refresh, private review creation.
 * Telemetry-only progress/revision/retained content stay absent, not simulated.
 * Delete ui/src/live/synchronization.tsx and workspace/synchronization/screens.tsx when complete.
 */
export const FOLLOWER_NOT_IMPLEMENTED = ["plan", "runs", "setHumanAction", "setExcluded", "setBackups", "setLocal", "setOverlays", "followerSchedule", "tunnel controls", "secret refresh", "private review creation"] as const;

export function useLiveFollower(backend: WorkspaceBackend, session: GuiSession, status: GuiStatus | undefined, revision: number, reload: () => void): FollowerSlice {
  const follower = session.role === "follower";
  const harnesses = useLiveResource(backend, "/api/harnesses", GuiHarnessReport, follower, revision);
  const local = useLiveResource(backend, "/api/local/items", GuiLocalItems, follower, revision);
  const schedule = useLiveResource(backend, "/api/schedule", GuiSynchronizationResult, follower, revision);
  const backups = useLiveResource(backend, "/api/backups", GuiBackups, follower, revision);
  const overlays = useLiveResource(backend, "/api/local/overlays", GuiSynchronizationResult, follower, revision);
  const tunnel = useLiveResource(backend, "/api/tunnel", GuiSynchronizationResult, follower, revision);
  const actions = useLiveActions(backend, reload);
  const [unenrollOpen, setUnenrollOpen] = useState(false);
  const [unenrolled, setUnenrolled] = useState(false);
  const interrupted = status?.recovery !== undefined && status.recovery !== null;
  const phase = actions.state.loading ? "running" : "plan";
  return {
    followerState: resourceState([harnesses, local, schedule, backups, overlays, tunnel, actions.state]),
    followerStates: { harnesses, local, schedule, backups, overlays, tunnel },
    followerSchedule: null, tunnelUp: tunnel.data?.state === "running", secretsRefresh: { busy: false, updated: "" },
    serviceInstalled: false, tunnelConfigured: tunnel.data?.configured === true,
    plan: [], targetRevision: undefined, phase, progress: undefined,
    applyPlan: () => { void actions.run((signal) => actions.operation("/api/sync/apply", {}, signal)); },
    driftOpen: false, interrupted,
    recover: () => { void actions.run((signal) => actions.operation("/api/recovery", {}, signal)); },
    abandon: () => { void actions.run((signal) => actions.operation("/api/recovery/abandon", {}, signal)); },
    runs: [], humanAction: false, setHumanAction: () => notImplemented("setHumanAction"), appliedRevision: undefined,
    excluded: [...(harnesses.data?.excluded ?? [])], setExcluded: () => notImplemented("setExcluded"),
    harnesses: (harnesses.data?.harnesses ?? []).map((entry) => ({
      id: entry.harness, name: entry.name, installed: entry.installed, listed: entry.listed,
      excluded: entry.excluded, root: entry.pinnedRoot ?? null, snapshot: entry.snapshot ?? null,
    })),
    backups: false, setBackups: () => notImplemented("setBackups"),
    snapshots: (backups.data?.snapshots ?? []).map((id) => ({ id, harnesses: [] })),
    restore: (snapshot) => { void actions.run((signal) => actions.operation("/api/backups/restore", { snapshot }, signal)); },
    local: [], setLocal: () => notImplemented("setLocal"), overlays: [], setOverlays: () => notImplemented("setOverlays"), kept: [],
    unenrollOpen, setUnenrollOpen, unenrolled,
    unenroll: () => { void actions.run(async (signal) => {
      await backend.request("/api/enrollment", Schema.Json, signal, { method: "DELETE", body: {} });
      setUnenrolled(true);
      window.location.assign("/setup");
    }); },
    isStopped: () => unenrolled,
  };
}
