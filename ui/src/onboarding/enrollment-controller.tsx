import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Schema } from "effect";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { Check, Circle, HourglassMedium, Question, Warning, X } from "@/components/icons";
import { SectionLabel, settingsGroup } from "@/workspace/kit";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isCoarsePointer, SNAP } from "@/lib/utils";
import { HARNESS_NAMES, type HarnessId } from "@/shared/metadata";
import { CliText, Mono } from "@/shared/shared";
import { ErrorNotice } from "@/live/session";
import type { GuiRequestError, GuiSession, WorkspaceBackend } from "@/gui-client";
import { LiveResourcesContext, requestError, useLiveActions, useLiveResource } from "@/workspace/live/resource";
import { GuiInvitationInspection, GuiSetupJournal, GuiSetupStatus } from "../../../src/gui/contract/enrollment";
import { GuiHarnessReport } from "../../../src/gui/contract/synchronization";
import { TARGET_IDS } from "../../../src/projection/model";
import { Onboarding, type OnboardingData } from "./onboarding";
import { Facts } from "./kit";
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
  /** `next` runs once approval is recorded and observed, like `planSetup`'s. */
  approveSetup: (next?: () => void) => Promise<void>;
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
      assertIdle(); setApprover(""); sendSource({ kind: "plan" });
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
    approveSetup(next) {
      assertIdle(); sendSource({ kind: "approve" });
      let committed = false;
      return run(async (signal) => {
        const digest = plan?.planDigest ?? status?.planDigest;
        if (!digest) throw new Error("Create a setup plan before approving it.");
        const journal = await backend.request("/api/setup/approve", GuiSetupJournal, signal, { method: "POST", body: { approver: approver.trim(), planDigest: digest } });
        committed = true; sendSource({ kind: "approval-committed", journal });
        await observe(signal);
        next?.();
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
/** Explanations stay available to touch and keyboard users, not only on hover. */
function SetupHelp({ label, children }: { label: string; children: ReactNode }) {
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" aria-label={`Explain ${label}`} className="inline-flex size-10 shrink-0 items-center justify-center rounded-sm text-faint hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:size-11">
        <Question className="size-3.5" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" aria-label={`About ${label}`} className="max-w-[calc(100vw-2rem)]">
      {children}
    </PopoverContent>
  </Popover>;
}
/** Widest the name pill grows; narrower rows cap it at their own width. */
const APPROVAL_PILL_PX = 360;
/**
 * Approve setup morphs in place: the gold button widens into a name field on the same
 * 32px line, so the card never changes height. Only the pill's width and colours move; the
 * label and the field crossfade (the leaving one pops out of layout), so the pill is never
 * empty mid-morph and nothing scales. Opening or typing never approves.
 *
 * In the wizard the field sits inside the wizard form, so Continue (or Enter, which
 * submits that form) is the approval; the wizard keeps Continue disabled until a name
 * is entered. Settings has no Continue, so `confirm` adds its own Confirm button.
 * The one help button beside the pill explains the planned changes and why the name is kept.
 */
export function SetupApproval({ controller: c, confirm: inlineConfirm }: { controller: EnrollmentController; confirm: boolean }) {
  const [editing, setEditing] = useState(false);
  const [tried, setTried] = useState(false);
  // Measured at the click, so the morph runs between two real pixel widths.
  const [widths, setWidths] = useState<{ closed: number; open: number } | null>(null);
  const reduced = useReducedMotion();
  const row = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const invalid = tried && !c.approver.trim();
  const transition = { duration: reduced ? 0 : 0.24, ease: SNAP };
  // Crossfade for the pill's contents. Reduced motion swaps them at once (no AnimatePresence below).
  const swap = { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: 0.16, delay: 0.04, ease: SNAP } }, exit: { opacity: 0, transition: { duration: 0.1, ease: SNAP } } };
  const focusApproved = useCallback((node: HTMLParagraphElement | null) => {
    if (node && editing) node.focus();
  }, [editing]);
  const open = () => {
    const closed = pill.current?.offsetWidth ?? 0;
    // The help button (40px plus the gap) sits beside the pill on the same line.
    const available = (row.current?.clientWidth ?? APPROVAL_PILL_PX) - 44;
    flushSync(() => { setWidths({ closed, open: Math.min(APPROVAL_PILL_PX, available) }); setEditing(true); });
    if (!isCoarsePointer()) name.current?.focus();
  };
  // Cancelling discards the name: in the wizard a typed name is what enables Continue,
  // so keeping it would leave approval one click away behind a closed field.
  const close = () => {
    if (c.state.loading) return;
    flushSync(() => { setEditing(false); setTried(false); c.setApprover(""); });
    trigger.current?.focus();
  };
  const confirm = () => {
    if (c.state.loading || c.approved) return;
    if (!c.approver.trim()) {
      flushSync(() => setTried(true));
      name.current?.focus();
      return;
    }
    void c.approveSetup();
  };
  const content = editing ? <motion.div key="name" {...(reduced ? {} : swap)} className="flex h-full min-w-0 flex-1 items-center gap-1 pr-0.5">
    <input ref={name} id="setup-approver" name="approver" autoComplete="name" value={c.approver} disabled={c.state.loading}
      aria-label="Your name" placeholder={invalid ? "Enter your name" : "Your name"}
      aria-invalid={invalid || undefined} aria-describedby={invalid ? "setup-approver-error" : undefined}
      onChange={(event) => c.setApprover(event.target.value)} onKeyDown={inlineConfirm ? (event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          confirm();
        }
      } : undefined}
      className={cn("h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none max-sm:text-[16px]", invalid ? "placeholder:text-bad" : "placeholder:text-faint")} />
    {inlineConfirm && <Button type="button" size="sm" variant="primary" disabled={c.state.loading} onClick={confirm}>{c.state.loading ? "Approving…" : "Confirm"}</Button>}
    <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel" disabled={c.state.loading} onClick={close}><X className="size-3.5" aria-hidden="true" /></Button>
  </motion.div> : <motion.button key="trigger" {...(reduced ? {} : swap)} ref={trigger} type="button" disabled={c.state.loading} onClick={open}
    className="h-full whitespace-nowrap px-2.5 text-sm font-medium text-gold-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60">
    Approve setup
  </motion.button>;
  // Every state is one h-8 line; the help button's negative margin keeps its larger hit area from growing it.
  return <div ref={row} className="flex h-8 items-center gap-1">
    {c.approved ? <p ref={focusApproved} role="status" tabIndex={-1} className="flex items-center gap-2 text-sm text-ok outline-none">
      <Check className="size-4" aria-hidden="true" />Approved
    </p> : <>
      <motion.div ref={pill} initial={false} transition={transition}
        // Always defined: Motion skips the first change of an `animate` that started undefined, which froze the
        // first open. Opening also states its start width, because by the time Motion reads the DOM the wider
        // field has already mounted.
        animate={{ width: widths ? editing ? [widths.closed, widths.open] : widths.closed : "auto" }}
        onAnimationComplete={() => { if (!editing) setWidths(null); }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && editing && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        className={cn("relative flex h-8 max-w-full shrink-0 items-center overflow-hidden rounded-lg border transition-colors duration-200 ease-snap motion-reduce:transition-none",
          editing ? cn("bg-panel focus-within:border-ring", invalid ? "border-bad" : "border-input") : "border-transparent bg-gold not-has-disabled:hover:bg-gold-hover")}>
        {reduced ? content : <AnimatePresence mode="popLayout" initial={false}>{content}</AnimatePresence>}
      </motion.div>
      {invalid && <span id="setup-approver-error" role="alert" className="sr-only">Enter a name to record this approval.</span>}
      <span className="-my-2 shrink-0">
        <SetupHelp label="this approval">
          <SetupChangeNotes plan={c.plan} />
          <p>Canonfig saves your name with the plan to record who approved it. Approval does not apply anything; the Create step does.</p>
        </SetupHelp>
      </span>
    </>}
  </div>;
}

/** Selected import entries of a plan; offers include unselected items, so only executable import items count. */
function selectedImports(plan: GuiSetupJournal): unknown[] {
  return plan.items.filter((item) => item.kind === "harness-import").flatMap((item) => Array.isArray(item.detail.items) ? item.detail.items : []);
}

/** What the planned changes mean, shown in the approval help beside the name field. */
function SetupChangeNotes({ plan }: { plan: GuiSetupJournal | null }) {
  if (!plan) return null;
  const folder = plan.items.find((item) => item.kind === "folder-scaffold");
  const createsFolder = !!folder || plan.items.some((item) => item.kind === "ensure-directory");
  return <>
    {createsFolder && <p>Create the shared setup folder{typeof folder?.detail.folder === "string" && <> at <Mono className="break-all">{folder.detail.folder}</Mono></>}{folder?.detail.profile !== undefined ? " and its machine profile." : "."}</p>}
    {plan.items.some((item) => item.kind === "source-init") && <p>Canonfig generates this Source's identity keys. These are separate from your AI tools' API keys.</p>}
    {selectedImports(plan).length > 0 && <p>The original AI coding tools' files stay unchanged.</p>}
  </>;
}

function SetupChangeSummary({ plan }: { plan: GuiSetupJournal | null }) {
  if (!plan) return <p className="text-muted-foreground">The saved status does not include the planned changes. Open Settings, Setup to review the recorded steps.</p>;
  const createsIdentity = plan.items.some((item) => item.kind === "source-init");
  const createsFolder = plan.items.some((item) => item.kind === "folder-scaffold" || item.kind === "ensure-directory");
  const installations = plan.items.filter((item) => item.kind === "recipe-install");
  const imports = selectedImports(plan);
  const requiredVariables = new Set<string>();
  for (const item of imports) {
    if (item === null || typeof item !== "object") continue;
    if ("secrets" in item && Array.isArray(item.secrets)) {
      const secrets: readonly unknown[] = item.secrets;
      for (const secret of secrets) {
        if (secret !== null && typeof secret === "object" && "fromEnv" in secret && typeof secret.fromEnv === "string") requiredVariables.add(secret.fromEnv);
      }
    }
  }
  // The explanation of these lines lives in the single help button beside the approval field.
  return <div className="space-y-3">
    <ul aria-label="Setup changes" className="list-disc space-y-1 ps-4">
      {createsFolder && <li>Create the Canonfig folder</li>}
      {createsIdentity && !createsFolder && <li>Create this Source's identity keys</li>}
      <li>{imports.length === 0 ? "No items selected for import" : `Import ${imports.length.toLocaleString()} ${imports.length === 1 ? "item" : "items"}`}</li>
      {installations.map((item) => <li key={item.id}>
        Install <Mono>{typeof item.detail.resource === "string" ? item.detail.resource : item.scope.replace(/^resource:tool:/, "")}</Mono>
        {typeof item.detail.version === "string" && <> ({item.detail.version})</>}
        {typeof item.detail.installerMethod === "string" && <> using {item.detail.installerMethod}</>}.
      </li>)}
    </ul>
    {plan.inventory.credentialStorage.kind === "local-file" && createsIdentity && <p className="text-sm">Source keys will be stored in a local file on this machine.</p>}
    {plan.inventory.credentialStorage.recovery && <p className="text-sm">{plan.inventory.credentialStorage.recovery}</p>}
    {requiredVariables.size > 0 && <p className="text-sm">Selected imports need environment variables: <Mono className="break-all">{[...requiredVariables].join(", ")}</Mono>. Set them on each machine that uses these imports.</p>}
  </div>;
}

export function SetupEvidence({ controller: c, view }: { controller: EnrollmentController; view: "approve" | "create" }) {
  const records: GuiSetupStatus["items"] = c.status?.items ?? c.plan?.records ?? [];
  // Create names who approved this exact plan instead of repeating the Approve step's list.
  const digest = c.plan?.planDigest ?? c.status?.planDigest;
  const approvedBy = view === "create" ? [...(c.status?.approvals ?? []), ...(c.plan?.approvals ?? [])].find((approval) => approval.digest === digest)?.approver : undefined;
  return <div className="space-y-4">
    {view === "create" ? <p className="text-muted-foreground">
      {approvedBy && <>Approved by <span className="text-foreground">{approvedBy}</span>. </>}Making {c.session.machineName} the Source applies the approved changes on this machine now. Go back to review them.
    </p> : <SetupChangeSummary plan={c.plan} />}
    {records.filter((record) => record.status === "failed" || record.status === "interrupted" || record.status === "skipped").map((record) => {
      const evidence = setupRecordEvidence(record);
      return <div key={record.id} className="space-y-1 text-sm">
        <p>{RECORD_LABELS[record.id.split(":")[0]] ?? record.id}: {record.status}.</p>
        {evidence && <p><CliText>{evidence}</CliText></p>}
      </div>;
    })}
    {view === "approve" && <SetupApproval key={c.plan?.planDigest ?? c.status?.planDigest} controller={c} confirm={false} />}
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

const STEP_MARK: Record<GuiSetupStatus["items"][number]["status"], ReactNode> = {
  completed: <Check className="size-3.5 text-ok" aria-label="Done" />,
  skipped: <Check className="size-3.5 text-faint" aria-label="Skipped" />,
  running: <HourglassMedium className="size-3.5 text-muted-foreground" aria-label="Running" />,
  interrupted: <Warning className="size-3.5 text-act" aria-label="Interrupted" />,
  failed: <Warning className="size-3.5 text-bad" aria-label="Failed" />,
  pending: <Circle className="size-3 text-faint" aria-label="Pending" />,
};

/**
 * Settings, Setup on a real machine: the recorded steps as one list, like the rest of Settings. The plan's
 * identifiers, decisions and field-level detail stay in a closed "Technical details" section.
 * `frame` places the page actions in the page header and the content in the page body.
 */
export function SetupJournal({ backend, session, frame }: { backend: WorkspaceBackend; session: GuiSession; frame: (actions: ReactNode, content: ReactNode) => ReactNode }) {
  const resources = useContext(LiveResourcesContext);
  if (!resources) throw new Error("Setup settings require a live workspace.");
  const status = useLiveResource(backend, "/api/setup", GuiSetupStatus, true);
  const c = useEnrollmentController(backend, session, [
    status.data, (value) => resources.cache.set("/api/setup", value),
  ]);
  const error = status.error ?? c.state.error;
  const busy = status.loading || c.state.loading;
  const current = c.status;
  const complete = current?.stage === "complete";
  const records = current?.items ?? [];
  const actions = <>
    <Button size="sm" variant="outline" disabled={busy} onClick={c.reloadStatus}>Reload</Button>
    {current?.approved && !complete && <Button size="sm" variant="primary" disabled={c.state.loading} onClick={() => void c.applySetup()}>Apply approved setup</Button>}
  </>;
  return frame(actions,
    <div className="space-y-4" aria-busy={busy}>
      {error && <ErrorNotice error={error} />}
      {current?.planDigest ? <>
        <SectionLabel action={<span className="text-xs text-faint">{complete ? "Done" : current.approved ? "Approved, not applied" : "Waiting for approval"}</span>}>Steps</SectionLabel>
        <ol aria-label="Setup steps" className={cn("mt-1", settingsGroup)}>
          {records.map((record) => {
            // Ids are "<kind>:<target>"; the target names the tool, so "tool-verify:pnpm" reads "Check pnpm".
            const [kind, target] = record.id.split(/:(.*)/s);
            const label = (kind === "tool-verify" || kind === "recipe-install") && target ? `${kind === "tool-verify" ? "Check" : "Install"} ${target}` : RECORD_LABELS[kind] ?? record.id;
            // Evidence repeats the id ("tool-verify:pnpm failed: …"); the row already names it.
            const evidence = setupRecordEvidence(record)?.replace(`${record.id} ${record.status}: `, "");
            const problem = record.status === "failed" || record.status === "interrupted";
            return <li key={record.id} className="grid min-h-10 grid-cols-[16px_minmax(0,1fr)] items-center gap-x-3 px-4 py-2 text-base">
              <span className="flex justify-center">{STEP_MARK[record.status]}</span>
              <span>{label}</span>
              {problem && evidence && <p className="col-start-2 text-sm text-pretty text-muted-foreground"><CliText>{evidence}</CliText></p>}
            </li>;
          })}
        </ol>
        {!current.approved && <SetupApproval key={current.planDigest} controller={c} confirm />}
        {c.state.loading && <p role="status" className="text-sm text-muted-foreground">Running setup…</p>}
        <details className="text-sm">
          <summary className="min-h-6 cursor-pointer text-muted-foreground">Technical details</summary>
          <div className="mt-3 space-y-3">
            <Facts items={[["Plan identifier", <Mono className="break-all">{current.planDigest}</Mono>], ["Stage", current.stage]]} />
            {c.plan && <SetupFields value={{ decisions: c.plan.decisions, exclusions: c.plan.exclusions, evidence: c.plan.evidence, imports: c.plan.imports }} />}
          </div>
        </details>
      </> : !busy && <p className="text-muted-foreground">No setup has been recorded on this machine.</p>}
    </div>,
  );
}
