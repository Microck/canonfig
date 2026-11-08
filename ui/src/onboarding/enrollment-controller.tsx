import { useContext, useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HARNESS_NAMES, type HarnessId } from "@/shared/metadata";
import { Mono } from "@/shared/shared";
import { ErrorNotice } from "@/live/session";
import type { GuiRequestError, GuiSession, WorkspaceBackend } from "@/gui-client";
import { LiveResourcesContext, requestError, useLiveActions, useLiveResource } from "@/workspace/live/resource";
import { GuiInvitationInspection, GuiSetupJournal, GuiSetupStatus } from "../../../src/gui/contract/enrollment";
import { GuiHarnessReport } from "../../../src/gui/contract/synchronization";
import { TARGET_IDS } from "../../../src/projection/model";
import { Onboarding, type OnboardingData } from "./onboarding";
import { Facts, Field } from "./kit";
import type { ResourceState } from "@/workspace/workspace-types";
import { TransitionError, useStateMachine } from "@/lib/state-machine";
import { hasJoined, setupEvidence, transitionFollower, transitionSource, type FollowerEnrollmentState, type FollowerEvent, type PreferenceDraft, type SourceEvent, type SourceSetupState } from "./enrollment-state";

export interface EnrollmentController {
  state: ResourceState;
  sourceState: SourceSetupState;
  followerState: FollowerEnrollmentState;
  invitationLabel: string | null;
  preferenceDraft: PreferenceDraft | null;
  editPreferences: (draft: PreferenceDraft) => void;
  session: GuiSession;
  plan: GuiSetupJournal | null;
  status: GuiSetupStatus | null;
  data: OnboardingData;
  approver: string;
  setApprover: (name: string) => void;
  approved: boolean;
  applied: boolean;
  inspection: GuiInvitationInspection | null;
  envelope: string;
  joined: boolean;
  harnessReport: GuiHarnessReport | null;
  preferencesSaved: boolean;
  planSetup: (harnesses: HarnessId[] | undefined, imports: string[] | undefined, next: () => void) => Promise<void>;
  approveSetup: () => Promise<void>;
  applySetup: () => Promise<void>;
  reloadStatus: () => void;
  inspectInvitation: (contents: string, next: (inspection: GuiInvitationInspection) => void, label?: string) => Promise<void>;
  clearInvitation: () => void;
  join: (input: { name: string; replace: boolean; tunnel: boolean; sshHost: string; sshUser: string; sshPort: number; hostKey: string; localPort: number }) => Promise<void>;
  loadHarnesses: () => Promise<void>;
  savePreferences: (excluded: HarnessId[], schedule: boolean) => Promise<void>;
}

const ITEM_LABELS: Record<GuiSetupJournal["items"][number]["kind"], string> = {
  "source-init": "Create the Source identity", "ensure-directory": "Create folder", "tool-verify": "Check tool",
  "recipe-install": "Install tool", "toolchain-verify": "Check required tools", "folder-scaffold": "Create the shared setup folder", "harness-import": "Import selected AI tool settings",
};

const RECORD_LABELS: Record<string, string> = { ...ITEM_LABELS, "canonfig-folder": ITEM_LABELS["folder-scaffold"], "ensure-directories": ITEM_LABELS["ensure-directory"] };
const FIELD_LABELS: Record<string, string> = {
  id: "Identifier", dir: "Folder", fromEnv: "Environment variable", detected: "Installed AI coding tools", target: "Destination", secrets: "Required environment variables",
};

export function useEnrollmentController(backend: WorkspaceBackend, session: GuiSession, statusState?: readonly [
  GuiSetupStatus | null, (status: GuiSetupStatus | null) => void,
]): EnrollmentController {
  const actions = useLiveActions(backend, () => {});
  const resources = useContext(LiveResourcesContext);
  const source = useStateMachine<SourceSetupState, SourceEvent>({ kind: "empty" }, transitionSource);
  const { send: sendSource, current: sourceCurrent } = source;
  const follower = useStateMachine<FollowerEnrollmentState, FollowerEvent>({ kind: "empty" }, transitionFollower);
  useEffect(() => {
    const status = statusState?.[0];
    if (status && sourceCurrent.current.kind === "empty") {
      sendSource({ kind: "observe" });
      sendSource({ kind: "observed", status });
    }
  }, [statusState, sendSource, sourceCurrent]);
  const [importReview, setImportReview] = useState<GuiSetupJournal | null>(null);
  const [selectedHarnesses, setSelectedHarnesses] = useState<HarnessId[]>([]);
  const [approver, setApprover] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const assertIdle = () => {
    if (active.current) throw new TransitionError("Enrollment", "busy", "start another command");
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>, failed: (error: GuiRequestError) => void) => {
    const controller = new AbortController();
    active.current = controller;
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) failed(requestError(cause)); }
    finally { active.current = null; }
  };
  const observe = async (signal: AbortSignal) => {
    const status = await backend.request("/api/setup", GuiSetupStatus, signal);
    sendSource({ kind: "observed", status });
    statusState?.[1](status);
  };
  const evidence = setupEvidence(source.state);
  const plan = evidence.journal;
  const status = evidence.status ?? statusState?.[0] ?? null;
  const fs = follower.state;
  const inspection = "inspection" in fs ? fs.inspection : null;
  const envelope = "envelope" in fs && fs.kind !== "inspecting" ? fs.envelope : "";
  const harnessReport = "report" in fs ? fs.report : null;
  const sourceBusy = ["planning", "approving", "approval-observing", "applying", "observing"].includes(source.state.kind);
  const followerBusy = ["inspecting", "joining", "joined-loading", "saving-preferences"].includes(fs.kind);
  const error = "error" in fs ? fs.error : "error" in source.state ? source.state.error : null;
  const detected = importReview?.items.find((item) => item.kind === "folder-scaffold")?.detail.detected;
  return {
    state: { loading: sourceBusy || followerBusy, error }, sourceState: source.state, followerState: fs,
    session, plan, status, approver, setApprover,
    approved: ["approved", "applying", "needs-human-action", "complete"].includes(source.state.kind) || (source.state.kind === "observation-lost" && source.state.committed === "approval"),
    applied: source.state.kind === "complete", inspection, envelope, joined: hasJoined(fs), harnessReport,
    invitationLabel: "label" in fs && fs.kind !== "inspecting" ? fs.label : null,
    preferenceDraft: "draft" in fs ? fs.draft : null,
    editPreferences: (draft) => { follower.send({ kind: "edit-preferences", draft }); },
    preferencesSaved: fs.kind === "joined" && fs.saved,
    data: {
      hostname: session.machineName, endpoint: inspection?.endpoint ?? "", profileName: session.machineName,
      harnesses: TARGET_IDS.map((id) => ({ id, name: HARNESS_NAMES[id], installed: Array.isArray(detected) && detected.includes(id), listed: selectedHarnesses.includes(id), excluded: false })),
      offers: importReview?.imports?.offered ?? [],
      skipped: importReview?.imports?.skipped ?? [],
      collisions: importReview?.imports?.collisions ?? [],
      present: importReview?.imports?.present ?? [],
      followerInstalled: [],
    },
    planSetup(harnesses, imports, next) {
      assertIdle(); sendSource({ kind: "plan" });
      return run(async (signal) => {
        const journal = await backend.request("/api/setup/plan", GuiSetupJournal, signal, { method: "POST", body: {
          role: "source", scope: "full", mode: "simple", files: [], ...(harnesses === undefined ? {} : { harnesses }),
          imports: imports === undefined ? { kind: "offer" } : imports.length ? { kind: "some", requested: imports } : { kind: "none" },
        } });
        if (harnesses === undefined) {
          const choices = journal.items.find((item) => item.kind === "folder-scaffold")?.detail.harnesses;
          setSelectedHarnesses(TARGET_IDS.filter((id) => Array.isArray(choices) && choices.includes(id)));
        }
        if (imports === undefined) setImportReview(journal);
        sendSource({ kind: "planned", journal }); next();
      }, (error) => sendSource({ kind: "failed", error }));
    },
    approveSetup() {
      assertIdle(); sendSource({ kind: "approve" });
      let committed = false;
      return run(async (signal) => {
        const digest = plan?.planDigest ?? status?.planDigest;
        if (!digest) throw new Error("Create a setup plan before approving it.");
        const journal = await backend.request("/api/setup/approve", GuiSetupJournal, signal, { method: "POST", body: { approver: approver.trim(), planDigest: digest } });
        committed = true; sendSource({ kind: "approval-committed", journal });
        await observe(signal);
      }, (error) => sendSource({ kind: "failed", error, ...(committed ? { committed: "approval" } : {}) }));
    },
    applySetup() {
      assertIdle(); sendSource({ kind: "apply" });
      let committed = false;
      return run(async (signal) => {
        const digest = plan?.planDigest ?? status?.planDigest;
        if (!digest) throw new Error("Create and approve a setup plan before applying it.");
        try {
          await actions.operation("/api/setup/apply", { planDigest: digest }, signal);
          committed = true; await observe(signal);
        } finally {
          resources?.cache.invalidate(["/api/status", "/api/profile/items", "/api/harnesses", "/api/skills", "/api/local/items", "/api/local/overlays"]);
        }
      }, (error) => sendSource({ kind: "failed", error, ...(committed ? { committed: "apply" } : {}) }));
    },
    reloadStatus() {
      assertIdle(); sendSource({ kind: "observe" });
      void run(observe, (error) => sendSource({ kind: "failed", error }));
    },
    inspectInvitation(contents, next, label = "(pasted)") {
      assertIdle(); follower.send({ kind: "inspect", envelope: contents, label });
      return run(async (signal) => {
        const checked = await backend.request("/api/enrollment/inspect", GuiInvitationInspection, signal, { method: "POST", body: { envelope: contents } });
        follower.send({ kind: "inspected", inspection: checked }); next(checked);
      }, (error) => follower.send({ kind: "failed", error }));
    },
    clearInvitation() { assertIdle(); follower.send({ kind: "clear" }); },
    join(input) {
      assertIdle();
      const joining = follower.send({ kind: "join" });
      if (joining.kind !== "joining") throw new TransitionError("Enrollment", joining.kind, "join");
      return run(async (signal) => {
        if (input.tunnel) await actions.operation("/api/enrollment/tunnel", { envelope: joining.envelope, sshHost: input.sshHost, sshUser: input.sshUser, sshPort: input.sshPort, sshHostKeyPath: input.hostKey, localPort: input.localPort, trustConfirmed: true }, signal);
        await actions.operation("/api/enrollment", { envelope: joining.envelope, followerName: input.name, replace: input.replace }, signal);
        follower.send({ kind: "joined" });
        follower.send({ kind: "report", report: await backend.request("/api/harnesses", GuiHarnessReport, signal) });
      }, (error) => follower.send({ kind: "failed", error }));
    },
    loadHarnesses() {
      assertIdle(); follower.send({ kind: "load-preferences" });
      return run(async (signal) => {
        follower.send({ kind: "report", report: await backend.request("/api/harnesses", GuiHarnessReport, signal) });
      }, (error) => follower.send({ kind: "failed", error }));
    },
    savePreferences(excluded, schedule) {
      assertIdle();
      follower.send({ kind: "edit-preferences", draft: { excluded, schedule } });
      const saving = follower.send({ kind: "save-preferences" });
      if (saving.kind !== "saving-preferences") throw new TransitionError("Enrollment preferences", saving.kind, "save");
      return run(async (signal) => {
        // Re-read after partial failure before attempting another multi-commit save.
        const actual = await backend.request("/api/harnesses", GuiHarnessReport, signal);
        for (const harness of TARGET_IDS) {
          if (excluded.includes(harness) === actual.excluded.includes(harness)) continue;
          const report = await backend.request("/api/harnesses", GuiHarnessReport, signal, { method: "PUT", body: { harness, action: excluded.includes(harness) ? "exclude" : "include" } });
          follower.send({ kind: "preference-applied", harness, report });
        }
        if (schedule) await backend.request("/api/schedule", Schema.Json, signal, { method: "PUT", body: { profileDefault: true } });
        follower.send({ kind: "preferences-saved" });
      }, (error) => follower.send({ kind: "failed", error }));
    },
  };
}

/** The same wizard renders both providers. Only this controller knows the browser API. */
export function EnrollmentOnboarding({ backend, session, onCancel }: { backend: WorkspaceBackend; session: GuiSession; onCancel?: () => void }) {
  const controller = useEnrollmentController(backend, session);
  return <Onboarding data={controller.data} live={controller} onCancel={onCancel} onDone={(setup) => { window.location.href = `/${setup.role}/overview`; }} />;
}

function setupRecordEvidence(record: GuiSetupStatus["items"][number]): string | undefined {
  switch (record.status) {
    case "pending":
    case "running": return undefined;
    case "interrupted":
    case "completed":
    case "failed":
    case "skipped": return record.evidence;
    default: {
      const unhandled: never = record;
      return unhandled;
    }
  }
}

export function SetupEvidence({ controller: c, approval = false }: { controller: EnrollmentController; approval?: boolean }) {
  const records: GuiSetupStatus["items"] = c.status?.items ?? c.plan?.records ?? [];
  return <div className="space-y-4">
    <p className="text-muted-foreground">Review the changes setup will make on this machine. Approving them changes nothing yet. Setup makes the changes when you apply the plan.</p>
    <Facts items={[
      ["Plan identifier", <Mono className="break-all">{c.plan?.planDigest ?? c.status?.planDigest ?? "No plan created"}</Mono>],
      ["Status", c.status?.stage ?? (c.approved ? "Approved" : "Awaiting approval")],
    ]} />
    <ul className="divide-y divide-border rounded-lg border border-border">
      {(c.plan?.items ?? records).map((item) => {
        const record = records.find((entry) => entry.id === item.id);
        const evidence = record ? setupRecordEvidence(record) : undefined;
        return <li key={item.id} className="px-3.5 py-3">
          <div className="flex flex-wrap justify-between gap-2"><span>{"kind" in item ? ITEM_LABELS[item.kind] : RECORD_LABELS[item.id.split(":")[0]] ?? item.id}</span><span className="text-muted-foreground capitalize">{record?.status ?? "Pending"}</span></div>
          <Mono className="block break-all text-xs">{item.id}</Mono>
          {"scope" in item && <p className="text-sm text-muted-foreground">{item.scope === "machine" ? "This machine" : item.scope.replace(/^resource:tool:/, "Tool: ")}</p>}
          {"detail" in item && Object.keys(item.detail).length > 0 && <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Review planned changes</summary>
            <div className="mt-2"><SetupFields value={item.detail} /></div>
          </details>}
          {evidence && <p className="mt-1 text-sm text-muted-foreground">{evidence}</p>}
        </li>;
      })}
    </ul>
    {c.plan && [...c.plan.decisions, ...c.plan.exclusions, ...c.plan.evidence].map((entry, index) => <p key={index} className="text-sm text-muted-foreground">{entry}</p>)}
    {approval && <>
      <Field label="Your name" htmlFor="setup-approver" hint="Canonfig records who approved these changes. Enter a name, then approve the plan to continue."><Input id="setup-approver" value={c.approver} onChange={(event) => c.setApprover(event.target.value)} /></Field>
      <Button type="button" disabled={c.state.loading || !c.approver.trim() || c.approved} onClick={() => void c.approveSetup()}>{c.approved ? "Plan approved" : "Approve setup plan"}</Button>
    </>}
    <p className="text-sm text-muted-foreground">After setup, open Settings, Source service to let other machines connect. To find tools this setup needs, open Profile and select Discover tools. Approval covers only the changes listed in this plan.</p>
    {c.state.loading && <p role="status">Running setup…</p>}
  </div>;
}

/** Plan values stay structured and labelled; no serialized API dump is shown. */
function SetupFields({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Not set</span>;
  if (Array.isArray(value)) return <ul className="space-y-1">{value.map((item, index) => <li key={index}><SetupFields value={item} /></li>)}</ul>;
  if (typeof value === "object") return <dl className="space-y-2">{Object.entries(value).filter(([, item]) => !Array.isArray(item) || item.length > 0).map(([key, item]) => <div key={key} className="grid gap-1 text-sm">
    <dt className="text-muted-foreground">{FIELD_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase())}</dt>
    <dd className="break-all"><SetupFields value={item} /></dd>
  </div>)}</dl>;
  return <span>{typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</span>;
}

export function SetupJournal({ backend, session }: { backend: WorkspaceBackend; session: GuiSession }) {
  const resources = useContext(LiveResourcesContext);
  if (!resources) throw new Error("Setup settings require a live workspace.");
  const status = useLiveResource(backend, "/api/setup", GuiSetupStatus, true);
  const controller = useEnrollmentController(backend, session, [
    status.data, (value) => resources.cache.set("/api/setup", value),
  ]);
  const error = status.error ?? controller.state.error;
  return <div className="space-y-4" aria-busy={status.loading || controller.state.loading}>
    {error && <ErrorNotice error={error} />}
    <Button variant="outline" disabled={status.loading || controller.state.loading} onClick={controller.reloadStatus}>Reload setup status</Button>
    {controller.status?.planDigest ? <>
      <SetupEvidence controller={controller} approval={!controller.status.approved} />
      {controller.status.approved && <Button disabled={controller.state.loading} onClick={() => void controller.applySetup()}>Apply approved setup</Button>}
    </> : <p>No setup plan has been recorded on this machine.</p>}
  </div>;
}
