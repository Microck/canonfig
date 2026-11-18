import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { request } from "@/gui-client";
import { ErrorNotice } from "@/live/session";
import { requestError } from "@/workspace/live/resource";
import { IssueReportingPreference, issueTrackerUrl } from "../../../src/domain/issue-reporting";
import { guiEndpoints } from "../../../src/gui/contract/session";

type PreferenceState =
  | { readonly kind: "loading" | "disabling" }
  | { readonly kind: "ready"; readonly value: IssueReportingPreference }
  | { readonly kind: "error"; readonly error: ReturnType<typeof requestError> };

export function IssueReporting({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PreferenceState>({ kind: "loading" });
  const read = useRef<AbortController | null>(null);
  useEffect(() => () => read.current?.abort(), []);

  function changeOpen(next: boolean) {
    setOpen(next);
    read.current?.abort();
    // A pending opt-out survives closing and reopening the dialog.
    if (!next || state.kind === "disabling") return;
    const controller = new AbortController();
    read.current = controller;
    setState({ kind: "loading" });
    void request(guiEndpoints.issueReporting, IssueReportingPreference,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(
      (value) => {
        if (!controller.signal.aborted) setState({ kind: "ready", value });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setState({ kind: "error", error: requestError(cause) });
      },
    );
  }

  async function disable() {
    // A stale status read cannot replace the result of the opt-out.
    read.current?.abort();
    setState({ kind: "disabling" });
    try {
      const value = await request(guiEndpoints.issueReporting, IssueReportingPreference, AbortSignal.timeout(10_000), {
        method: "DELETE", body: {},
      });
      setState({ kind: "ready", value });
    } catch (cause) {
      setState({ kind: "error", error: requestError(cause) });
    }
  }

  const preference = state.kind === "ready" ? state.value : undefined;
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild>
      <button type="button" className={className}>
        <ArrowSquareOut className="size-3.5" aria-hidden />
        Issue reporting
      </button>
    </DialogTrigger>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Issue reporting</DialogTitle>
        <DialogDescription>
          Your agent can ask to post future Canonfig bugs publicly on GitHub under your account.
        </DialogDescription>
      </DialogHeader>
      {state.kind === "error"
        ? <ErrorNotice title="Could not manage issue reporting" error={state.error} />
        : <p role="status">
          {state.kind === "loading" ? "Checking automatic reporting…"
            : state.kind === "disabling" ? "Turning off automatic reporting…"
            : preference?.status === "enabled" ? `Automatic reporting is on for @${preference.account.login}.`
            : preference?.status === "ask" ? "Your agent can ask you to turn on automatic reporting."
            : "Automatic reporting is off."}
        </p>}
      <DialogFooter>
        {preference?.status !== "disabled" && <Button variant="outline" disabled={state.kind === "disabling"} onClick={() => { void disable(); }}>
          Turn off automatic reporting
        </Button>}
        <Button asChild variant="secondary">
          <a href={`${issueTrackerUrl}/new/choose`} target="_blank" rel="noreferrer">
            Report an issue on GitHub <ArrowSquareOut aria-hidden />
          </a>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
