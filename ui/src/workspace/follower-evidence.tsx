import type { Schema } from "effect";
import { Mono, StateBand, StatusMark, type StatusKind } from "../shared/shared";
import { Button } from "../components/ui/button";
import { useWorkspace } from "./store";
import { ListHead, ListRow, SectionLabel, SettingRow, settingsGroup } from "./kit";
import { record, strings, text } from "./live/follower";
import { HARNESS_NAMES } from "../shared/metadata";

const actionLabels: Record<string, string> = {
  "no-op": "Already matches", "transfer-blob": "Download", "write-file": "Write file", "write-config": "Set keys",
  "mirror-directory": "Update folder", "remove-resource": "Remove", "install-tool": "Install", "verify-only": "Verify",
  "human-action": "Needs you", "agent-task": "Agent task", "drift-conflict": "Held",
};
const stateLabels: Record<string, string> = {
  Converged: "Configuration verified", HumanActionRequired: "Needs your action", FollowerDrift: "Changes held because of drift",
  Failed: "Update failed", Interrupted: "Update interrupted", running: "Running", succeeded: "Completed", failed: "Failed",
  "not-configured": "Not configured", stopped: "Stopped", degraded: "Connection needs attention", "identity-mismatch": "Identity mismatch",
};

const resourceLabels: Record<string, string> = { instructions: "Instructions", rules: "Rule", skills: "Skill", agents: "Agent", commands: "Command", mcp: "MCP server", settings: "Settings", mirror: "Profile file" };
function resourceLabel(resource: string | undefined): string {
  if (!resource) return "Not reported";
  const [scope, name, kind] = resource.split(":");
  if (scope === "harness") return `${Object.entries(HARNESS_NAMES).find(([id]) => id === name)?.[1] ?? name}: ${resourceLabels[kind] ?? kind}`;
  return `${resourceLabels[scope] ?? scope}${name ? `: ${name}` : ""}`;
}

/** Only named CLI evidence is rendered. Unknown fields never become a JSON dump. */
export function TunnelEvidence({ report: value }: { report: Schema.Json }) {
  const report = record(value);
  const lifecycle = text(report.lifecycle);
  const identity = record(report.identity);
  return <div className={settingsGroup}>
    <SettingRow title="State" description={text(report.detail)}><span className="inline-flex items-center gap-2"><StatusMark kind={lifecycle === "running" ? "ok" : "offline"} />{lifecycle ? stateLabels[lifecycle] ?? "Connection needs attention" : "Not reported"}</span></SettingRow>
    {text(report.endpoint) && <SettingRow title="Forwarding endpoint"><Mono className="break-all">{text(report.endpoint)}</Mono></SettingRow>}
    {text(report.startedAt) && <SettingRow title="Started">{text(report.startedAt)}</SettingRow>}
    {text(identity.sshHostKeyFingerprint) && <SettingRow title="Pinned SSH host key"><Mono className="break-all">{text(identity.sshHostKeyFingerprint)}</Mono></SettingRow>}
    {text(identity.tlsPinnedFingerprint) && <SettingRow title="Pinned TLS fingerprint"><Mono className="break-all">{text(identity.tlsPinnedFingerprint)}</Mono></SettingRow>}
    {text(identity.sourcePinnedFingerprint) && <SettingRow title="Pinned Source signing key"><Mono className="break-all">{text(identity.sourcePinnedFingerprint)}</Mono></SettingRow>}
    {text(report.recovery) && <SettingRow title="Recovery command"><Mono>{text(report.recovery)}</Mono></SettingRow>}
  </div>;
}

export function FollowerOperationEvidence() {
  const ws = useWorkspace();
  const live = ws.followerLive;
  if (!live) return null;
  const observationLost = live.command.kind === "ObservationLost" && <div className="mt-2 grid gap-2"><p className="text-sm">Observation lost. The command may still be running on this machine.</p><Button variant="outline" size="sm" onClick={live.resumeObservation}>Resume observation</Button></div>;
  const operation = live.operation;
  if (!operation) return observationLost ? <section aria-live="polite" className="px-[18px] py-4">{observationLost}</section> : null;
  const journal = record(operation.journal);
  const report = operation.state === "succeeded" ? record(operation.result) : record(journal.details ?? operation.journal);
  const outcome = record(report.outcome);
  const plan = record(report.plan);
  const actions = Array.isArray(plan.actions) ? plan.actions.map(record) : [];
  const human = Array.isArray(outcome.actions) ? outcome.actions.map(record) : [];
  const conflicts = Array.isArray(outcome.conflicts) ? outcome.conflicts.map(record) : [];
  const reviews = Array.isArray(report.adoptionReviews) ? report.adoptionReviews.map(record) : [];
  const cols = "100px minmax(160px,240px) minmax(200px,1fr)";
  const outcomeName = text(outcome.outcome);
  const status: StatusKind = operation.state === "failed" ? "bad" : operation.state === "running" ? "off" : outcomeName && outcomeName !== "Converged" ? "warn" : "ok";
  return <section aria-live="polite">
    <div className="relative isolate overflow-hidden border-b border-border px-[18px] py-4">
      <StateBand tone={status === "ok" ? "ok" : "warn"} mode={operation.state === "running" ? "running" : "idle"} className="-z-10 opacity-70" />
      <h2 className="flex items-center gap-2 font-medium"><StatusMark kind={status} />{live.operationName}: {outcomeName ? stateLabels[outcomeName] ?? "Result received" : stateLabels[operation.state]}</h2>
      {observationLost}
      {text(outcome.reason) && <p className="mt-2 text-sm text-muted-foreground">{text(outcome.reason)}</p>}
      {operation.state === "failed" && <p className="mt-2 text-sm text-bad">{operation.failure.message}</p>}
    </div>
    <div className="px-[18px] py-4">
      <div className={settingsGroup}>
        {text(report.revision) && <SettingRow title="Profile revision"><Mono className="break-all">{text(report.revision)}</Mono></SettingRow>}
        {text(outcome.run ?? report.run ?? journal.run) && <SettingRow title="Synchronization run"><Mono className="break-all">{text(outcome.run ?? report.run ?? journal.run)}</Mono></SettingRow>}
        {typeof report.downloadedBlobs === "number" && <SettingRow title="Files downloaded">{report.downloadedBlobs}</SettingRow>}
        {typeof report.reusedBlobs === "number" && <SettingRow title="Files reused">{report.reusedBlobs}</SettingRow>}
        {text(report.restored) && <SettingRow title="Restored snapshot"><Mono>{text(report.restored)}</Mono></SettingRow>}
        {strings(report.excludedHarnesses).length > 0 && <SettingRow title="Harnesses excluded after restore">{strings(report.excludedHarnesses).join(", ")}</SettingRow>}
        {text(record(report.schedule).detail) && <SettingRow title="Schedule">{text(record(report.schedule).detail)}</SettingRow>}
        {report.abandoned === true && <SettingRow title="Recovery">Run abandoned. Applied changes remain; nothing was rolled back.</SettingRow>}
      </div>
      {human.map((action, index) => <div key={index} className="border-b border-border py-3"><h3 className="font-medium">{text(action.reason)}</h3><p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{text(action.instructions)}</p></div>)}
      {conflicts.map((conflict, index) => <div key={index} className="border-b border-border py-3"><h3 className="font-medium">Held: {resourceLabel(text(conflict.resource))}</h3><Mono>{text(conflict.target)}</Mono><p className="mt-1 text-sm text-muted-foreground">Move your edit into the Local folder, ask the Source to publish it, or restore the published content. Canonfig does not force an overwrite.</p></div>)}
      {[...(Array.isArray(report.diagnostics) ? report.diagnostics : []), ...(Array.isArray(report.warnings) ? report.warnings : []), ...(Array.isArray(report.clientSteps) ? report.clientSteps : [])].map((entry, index) => {
        const detail = record(entry);
        const message = text(entry) ?? text(detail.message) ?? text(detail.detail) ?? text(detail.instructions);
        return message ? <p key={index} className="border-b border-border py-3 text-sm text-muted-foreground">{message}</p> : null;
      })}
      {report.adoptionReviews !== undefined && <><SectionLabel className="mt-5">Private adoption review</SectionLabel>{reviews.length === 0 ? <p className="text-sm text-muted-foreground">No first-adoption files need a private review.</p> : reviews.map((review, index) => <SettingRow key={index} title={text(review.target) ?? "Review file"}><Mono className="break-all">{text(review.path) ?? text(review.file)}</Mono></SettingRow>)}<p className="mt-2 text-sm text-muted-foreground">Private review text stays on disk. The browser cannot read or delete it.</p></>}
    </div>
    {actions.length > 0 && <><ListHead cols={cols} minWidth={600}><span>Change</span><span>Item</span><span>Where and why</span></ListHead>{actions.map((action, index) => {
      const detail = record(action.detail);
      const kind = text(action.kind) ?? "";
      const reason = text(detail.reason) ?? text(detail.adoptionNotice) ?? text(detail.retentionNotice) ?? text(detail.summary);
      return <ListRow key={text(action.id) ?? index} cols={cols} minWidth={600}>
        <span className="flex items-center gap-2 text-sm"><StatusMark kind={kind === "drift-conflict" ? "warn" : kind === "human-action" ? "act" : "off"} />{actionLabels[kind] ?? "Planned action"}</span>
        <span className="break-words text-sm">{resourceLabel(text(action.resource))}</span>
        <div className="min-w-0 text-sm"><Mono className="break-all">{text(detail.target) ?? text(detail.package) ?? text(detail.method)}</Mono>{reason && <p className="mt-1 text-muted-foreground">{reason}</p>}{text(detail.instructions) && <p className="mt-1 whitespace-pre-wrap">{text(detail.instructions)}</p>}{kind === "drift-conflict" && <p className="mt-1 text-muted-foreground">Your edit stays in place. Resolve it outside Sync before checking again.</p>}</div>
      </ListRow>;
    })}</>}
    {strings(outcome.verified).length > 0 && <><ListHead cols="28px minmax(160px,1fr)"><span /><span>Verified item</span></ListHead>{strings(outcome.verified).map((resource) => <ListRow key={resource} cols="28px minmax(160px,1fr)"><StatusMark kind="ok" /><span className="text-sm">{resourceLabel(resource)}</span></ListRow>)}</>}
    {(human.length > 0 || conflicts.length > 0) && <div className="px-[18px] py-3"><Button variant="outline" size="sm" disabled={live.action.loading} onClick={live.check}>Check again</Button></div>}
  </section>;
}
