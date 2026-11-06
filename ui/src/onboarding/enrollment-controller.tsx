import { useContext, useState } from "react";
import { Schema } from "effect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HARNESS_NAMES, type HarnessId } from "@/shared/metadata";
import { Mono } from "@/shared/shared";
import { ErrorNotice } from "@/live/session";
import type { GuiSession, WorkspaceBackend } from "@/gui-client";
import { LiveResourcesContext, useLiveActions, useLiveResource } from "@/workspace/live/resource";
import { GuiInvitationInspection, GuiSetupJournal, GuiSetupStatus } from "../../../src/gui/contract/enrollment";
import { GuiHarnessReport } from "../../../src/gui/contract/synchronization";
import { TARGET_IDS } from "../../../src/projection/model";
import { Onboarding, type ImportOffer, type OnboardingData } from "./onboarding";
import { Facts, Field } from "./kit";
import type { ResourceState } from "@/workspace/workspace-types";

export interface EnrollmentController {
  state: ResourceState;
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
  inspectInvitation: (contents: string, next: (inspection: GuiInvitationInspection) => void) => Promise<void>;
  clearInvitation: () => void;
  join: (input: { name: string; replace: boolean; tunnel: boolean; sshHost: string; sshUser: string; sshPort: number; hostKey: string; localPort: number }) => Promise<void>;
  loadHarnesses: () => Promise<void>;
  savePreferences: (excluded: HarnessId[], schedule: boolean) => Promise<void>;
}

const ITEM_LABELS: Record<GuiSetupJournal["items"][number]["kind"], string> = {
  "source-init": "Initialize the Source", "ensure-directory": "Create directory", "tool-verify": "Verify tool",
  "recipe-install": "Install tool", "toolchain-verify": "Verify toolchain", "folder-scaffold": "Create Canonical Folder", "harness-import": "Import harness items",
};

const RECORD_LABELS: Record<string, string> = { ...ITEM_LABELS, "canonfig-folder": ITEM_LABELS["folder-scaffold"], "ensure-directories": ITEM_LABELS["ensure-directory"] };
const FIELD_LABELS: Record<string, string> = {
  id: "Identifier", dir: "Directory", fromEnv: "Environment reference", detected: "Detected harnesses", target: "Destination", secrets: "Credential references",
};

export function useEnrollmentController(backend: WorkspaceBackend, session: GuiSession, statusState?: readonly [
  GuiSetupStatus | null, (status: GuiSetupStatus | null) => void,
]): EnrollmentController {
  const actions = useLiveActions(backend, () => {});
  const [plan, setPlan] = useState<GuiSetupJournal | null>(null);
  const [importReview, setImportReview] = useState<GuiSetupJournal | null>(null);
  const localStatus = useState<GuiSetupStatus | null>(null);
  const [status, setStatus] = statusState ?? localStatus;
  const [selectedHarnesses, setSelectedHarnesses] = useState<HarnessId[]>([]);
  const [approver, setApprover] = useState("");
  const [applied, setApplied] = useState(false);
  const [inspection, setInspection] = useState<GuiInvitationInspection | null>(null);
  const [envelope, setEnvelope] = useState("");
  const [joined, setJoined] = useState(false);
  const [harnessReport, setHarnessReport] = useState<GuiHarnessReport | null>(null);
  const [preferencesSaved, setPreferencesSaved] = useState(false);
  const approved = !!plan?.approvals.some((approval) => approval.digest === plan.planDigest);
  const detected = importReview?.items.find((item) => item.kind === "folder-scaffold")?.detail.detected;
  const reloadStatus = () => actions.run(async (signal) => setStatus(await backend.request("/api/setup", GuiSetupStatus, signal)));
  return {
    state: actions.state, session, plan, status, approver, setApprover, approved, applied, inspection, envelope, joined, harnessReport, preferencesSaved,
    data: {
      hostname: session.machineName, endpoint: inspection?.endpoint ?? "", profileName: session.machineName,
      harnesses: TARGET_IDS.map((id) => ({ id, name: HARNESS_NAMES[id], installed: Array.isArray(detected) && detected.includes(id), listed: selectedHarnesses.includes(id), excluded: false })),
      offers: (importReview?.imports?.offered ?? []).map((offer): ImportOffer => {
        const [source, category, ...name] = offer.id.split("/");
        return { id: offer.id, source: source as ImportOffer["source"], category: category as ImportOffer["category"], name: name.join("/"),
          harnesses: source === "agents" ? [...TARGET_IDS] : [source as HarnessId], path: "", target: offer.target,
          secrets: [], credentialNotes: [...offer.secrets], notes: [...offer.notes] };
      }), skipped: [], importNotes: importReview?.exclusions ?? [], followerInstalled: [],
    } satisfies OnboardingData,
    planSetup(harnesses: HarnessId[] | undefined, imports: string[] | undefined, next: () => void) {
      return actions.run(async (signal) => {
        const journal = await backend.request("/api/setup/plan", GuiSetupJournal, signal, { method: "POST", body: {
          role: "source", scope: "full", mode: "simple", files: [], ...(harnesses === undefined ? {} : { harnesses }),
          imports: imports === undefined ? { kind: "offer" } : imports.length ? { kind: "some", requested: imports } : { kind: "none" },
        } });
        if (harnesses === undefined) {
          const choices = journal.items.find((item) => item.kind === "folder-scaffold")?.detail.harnesses;
          setSelectedHarnesses(TARGET_IDS.filter((id) => Array.isArray(choices) && choices.includes(id)));
        }
        if (imports === undefined) setImportReview(journal);
        setPlan(journal); setStatus(null); setApplied(false); next();
      });
    },
    approveSetup() {
      return actions.run(async (signal) => {
        const digest = plan?.planDigest ?? status?.planDigest;
        if (!digest) throw new Error("Create a setup plan before approving it.");
        const journal = await backend.request("/api/setup/approve", GuiSetupJournal, signal, { method: "POST", body: { approver: approver.trim(), planDigest: digest } });
        setPlan(journal);
        setStatus(await backend.request("/api/setup", GuiSetupStatus, signal));
      });
    },
    applySetup() {
      return actions.run(async (signal) => {
        const digest = plan?.planDigest ?? status?.planDigest;
        if (!digest) throw new Error("Create and approve a setup plan before applying it.");
        await actions.operation("/api/setup/apply", { planDigest: digest }, signal);
        const actual = await backend.request("/api/setup", GuiSetupStatus, signal);
        setStatus(actual);
        // A successful command can stop for human action. Only the journal certifies completion.
        setApplied(actual.stage === "complete");
      });
    },
    reloadStatus,
    inspectInvitation(contents: string, next: (inspection: GuiInvitationInspection) => void) {
      setInspection(null);
      setEnvelope("");
      return actions.run(async (signal) => {
        const checked = await backend.request("/api/enrollment/inspect", GuiInvitationInspection, signal, { method: "POST", body: { envelope: contents } });
        setInspection(checked); setEnvelope(contents); next(checked);
      });
    },
    clearInvitation() { setInspection(null); setEnvelope(""); },
    join(input: { name: string; replace: boolean; tunnel: boolean; sshHost: string; sshUser: string; sshPort: number; hostKey: string; localPort: number }) {
      return actions.run(async (signal) => {
        if (input.tunnel) await actions.operation("/api/enrollment/tunnel", { envelope, sshHost: input.sshHost, sshUser: input.sshUser, sshPort: input.sshPort, sshHostKeyPath: input.hostKey, localPort: input.localPort, trustConfirmed: true }, signal);
        await actions.operation("/api/enrollment", { envelope, followerName: input.name, replace: input.replace }, signal);
        setJoined(true); setEnvelope("");
        setHarnessReport(await backend.request("/api/harnesses", GuiHarnessReport, signal));
      });
    },
    loadHarnesses() { return actions.run(async (signal) => setHarnessReport(await backend.request("/api/harnesses", GuiHarnessReport, signal))); },
    savePreferences(excluded: HarnessId[], schedule: boolean) {
      return actions.run(async (signal) => {
        setPreferencesSaved(false);
        for (const harness of TARGET_IDS) {
          if (excluded.includes(harness) === harnessReport?.excluded.includes(harness)) continue;
          const report = await backend.request("/api/harnesses", GuiHarnessReport, signal, { method: "PUT", body: { harness, action: excluded.includes(harness) ? "exclude" : "include" } });
          setHarnessReport(report);
        }
        if (schedule) await backend.request("/api/schedule", Schema.Json, signal, { method: "PUT", body: { profileDefault: true } });
        setPreferencesSaved(true);
      });
    },
  };
}

/** The same wizard renders both providers. Only this controller knows the browser API. */
export function EnrollmentOnboarding({ backend, session, onCancel }: { backend: WorkspaceBackend; session: GuiSession; onCancel?: () => void }) {
  const controller = useEnrollmentController(backend, session);
  return <Onboarding data={controller.data} live={controller} onCancel={onCancel} onDone={(setup) => { window.location.href = `/${setup.role}/overview`; }} />;
}

export function SetupEvidence({ controller: c, approval = false }: { controller: EnrollmentController; approval?: boolean }) {
  const records = c.status?.items ?? c.plan?.records ?? [];
  return <div className="space-y-4">
    <Facts items={[
      ["Plan digest", <Mono className="break-all">{c.plan?.planDigest ?? c.status?.planDigest ?? "No plan"}</Mono>],
      ["Status", c.status?.stage ?? (c.approved ? "Approved" : "Awaiting approval")],
    ]} />
    <ul className="divide-y divide-border rounded-lg border border-border">
      {(c.plan?.items ?? records).map((item) => {
        const record = records.find((entry) => entry.id === item.id);
        return <li key={item.id} className="px-3.5 py-3">
          <div className="flex flex-wrap justify-between gap-2"><span>{"kind" in item ? ITEM_LABELS[item.kind] : RECORD_LABELS[item.id.split(":")[0]] ?? item.id}</span><span className="text-muted-foreground capitalize">{record?.status ?? "Pending"}</span></div>
          <Mono className="block break-all text-xs">{item.id}</Mono>
          {"scope" in item && <p className="text-sm text-muted-foreground">{item.scope === "machine" ? "This machine" : item.scope.replace(/^resource:tool:/, "Tool: ")}</p>}
          {"detail" in item && Object.keys(item.detail).length > 0 && <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Review planned changes</summary>
            <div className="mt-2"><SetupFields value={item.detail} /></div>
          </details>}
          {record?.evidence && <p className="mt-1 text-sm text-muted-foreground">{record.evidence}</p>}
        </li>;
      })}
    </ul>
    {c.plan && [...c.plan.decisions, ...c.plan.exclusions, ...c.plan.evidence].map((entry, index) => <p key={index} className="text-sm text-muted-foreground">{entry}</p>)}
    {approval && <>
      <Field label="Approver name" htmlFor="setup-approver"><Input id="setup-approver" value={c.approver} onChange={(event) => c.setApprover(event.target.value)} /></Field>
      <Button type="button" disabled={c.state.loading || !c.approver.trim() || c.approved} onClick={() => void c.approveSetup()}>{c.approved ? "Plan approved" : "I reviewed and approve this plan"}</Button>
    </>}
    <p className="text-sm text-muted-foreground">Service installation and tool scanning are separate operations after setup. Approval applies only to this exact plan.</p>
    {c.state.loading && <p role="status">Setup operation running…</p>}
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
