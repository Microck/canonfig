import type { ReactNode } from "react";
import { WarningCircle } from "@/components/icons";
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

