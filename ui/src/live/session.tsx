import type { ReactNode } from "react";
import { CheckCircle, Circle, WarningCircle } from "@/components/icons";
import type { GuiRequestError, GuiSession, GuiStatus } from "../gui-client";
import type { LiveScreen } from "./routes";

type JsonValue = GuiStatus["tunnel"];

const ROLE_LABEL: Record<GuiSession["role"], string> = {
  source: "Source Machine",
  follower: "Follower Machine",
  unconfigured: "Unconfigured machine",
};

export function overviewPath(role: GuiSession["role"]) {
  return role === "unconfigured" ? "/overview" : `/${role}/overview`;
}

function fieldLabel(key: string) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("-", " ").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="flex min-h-7 items-center text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Status includes role-specific evidence. Keep it inspectable without inventing a second wire model. */
function ReportValue({ value }: { value: JsonValue }) {
  if (value === null) return <span className="text-muted-foreground">Not reported</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value !== "object") return <span className="font-mono text-sm whitespace-pre-wrap">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    return (
      <ol className="grid gap-3">
        {value.map((item, index) => <li key={index}><ReportValue value={item} /></li>)}
      </ol>
    );
  }
  const fields = Object.entries(value);
  if (fields.length === 0) return <span className="text-muted-foreground">None</span>;
  return <dl>{fields.map(([key, item]) => <Fact key={key} label={fieldLabel(key)}><ReportValue value={item} /></Fact>)}</dl>;
}

function Lifecycle({ status }: { status: GuiStatus }) {
  const steps = Object.entries(status.lifecycle);
  if (steps.length === 0) return <p className="py-3 text-muted-foreground">No lifecycle checks reported.</p>;
  return (
    <ul className="divide-y divide-border">
      {steps.map(([name, { reached, detail, ...evidence }]) => (
        <li key={name} className="grid gap-2 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
          <div className="flex items-start gap-2">
            {reached ? <CheckCircle className="mt-0.5 size-4 shrink-0 text-ok" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            <div>
              <span className="font-medium">{fieldLabel(name)}</span>
              <span className="block text-xs text-muted-foreground">{reached ? "Reached" : "Not reached"}</span>
            </div>
          </div>
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <p>{detail}</p>
            {Object.keys(evidence).length > 0 && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer rounded-sm py-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Check details</summary>
                <ReportValue value={evidence} />
              </details>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Overview({ session, status }: { session: GuiSession; status: GuiStatus }) {
  const { machineRole, lifecycle: _lifecycle, tunnel, ...state } = status;
  return (
    <>
      <Section title="This machine">
        <dl>
          <Fact label="Name"><span className="font-mono">{session.machineName}</span></Fact>
          <Fact label="Role">{ROLE_LABEL[session.role]}</Fact>
          <Fact label="Canonfig version"><span className="font-mono">{session.version}</span></Fact>
          <Fact label="Canonical Folder"><span className="font-mono">{session.folderPath}</span></Fact>
          {machineRole.follower !== undefined && <Fact label="Follower identity"><span className="font-mono text-sm">{machineRole.follower}</span></Fact>}
          {machineRole.sourceFingerprint !== undefined && <Fact label="Source fingerprint"><span className="font-mono text-sm">{machineRole.sourceFingerprint}</span></Fact>}
          {machineRole.tlsFingerprint !== undefined && <Fact label="TLS fingerprint"><span className="font-mono text-sm">{machineRole.tlsFingerprint}</span></Fact>}
        </dl>
      </Section>
      {session.role === "unconfigured" && (
        <p className="mt-6 max-w-prose text-muted-foreground">
          No Source or Follower role is configured. Set up this machine with the Canonfig CLI, then reload. Browser setup is not available yet.
        </p>
      )}
      <Section title="Follower lifecycle">
        {session.role === "follower" ? <Lifecycle status={status} /> : (
          <>
            <p className="py-2 text-muted-foreground">This machine is not a Follower. These checks do not describe Source health.</p>
            <details>
              <summary className="cursor-pointer rounded-sm py-3 focus-visible:outline-2 focus-visible:outline-ring">View reported checks</summary>
              <Lifecycle status={status} />
            </details>
          </>
        )}
      </Section>
      {Object.keys(state).length > 0 && <Section title="Synchronization state"><ReportValue value={state} /></Section>}
      <Section title="SSH tunnel"><ReportValue value={tunnel} /></Section>
    </>
  );
}

export function ErrorNotice({ error, title = "Operation failed" }: { error: GuiRequestError; title?: string }) {
  return (
    <section role="alert" className="rounded-lg border border-bad/40 p-4">
      <h2 className="flex items-center gap-2 font-medium"><WarningCircle className="size-4 text-bad" />{title}</h2>
      <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{error.message}</p>
      <dl className="mt-3 text-sm">
        <Fact label="Category"><span className="font-mono">{error.failure.category}</span></Fact>
        <Fact label="CLI exit code"><span className="font-mono">{error.failure.exitCode}</span></Fact>
        {error.httpStatus !== undefined && <Fact label="HTTP status"><span className="font-mono">{error.httpStatus}</span></Fact>}
      </dl>
      <p className="mt-3 text-sm text-muted-foreground">Use Reload after resolving the error. If the session has expired, restart canonfig ui and open its new URL.</p>
    </section>
  );
}

export const sessionScreens: ReadonlyArray<LiveScreen> = [{
  title: "Overview",
  path: overviewPath,
  render: ({ session, status }) => <Overview session={session} status={status} />,
}];
