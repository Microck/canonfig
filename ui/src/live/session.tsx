import type { ReactNode } from "react";
import { WarningCircle } from "@/components/icons";
import { CliText } from "@/shared/shared";
import type { GuiRequestError, GuiSession } from "../gui-client";

export function overviewPath(role: GuiSession["role"]) {
  return role === "unconfigured" ? "/setup" : `/${role}/overview`;
}


function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}


export function ErrorNotice({ error, title = "Operation failed", recovery }: { error: GuiRequestError; title?: string; recovery?: string }) {
  return (
    <section role="alert" className="rounded-lg border border-bad/40 p-4">
      <h2 className="flex items-center gap-2 font-medium"><WarningCircle className="size-4 text-bad" />{title}</h2>
      <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]"><CliText>{error.message}</CliText></p>
      {recovery && <p className="mt-2 text-sm text-muted-foreground">{recovery}</p>}
      {/* Category and exit code help when reporting a bug, not when deciding what to do next. */}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
        <dl className="mt-1">
          <Fact label="Category"><span className="font-mono">{error.failure.category}</span></Fact>
          <Fact label="CLI exit code"><span className="font-mono">{error.failure.exitCode}</span></Fact>
          {error.httpStatus !== undefined && <Fact label="HTTP status"><span className="font-mono">{error.httpStatus}</span></Fact>}
        </dl>
      </details>
    </section>
  );
}

