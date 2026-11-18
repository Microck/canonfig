import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ErrorNotice } from "@/live/session";
import { shortHistoryId, type HistoryDiff, type HistoryStatus } from "../../../src/gui/contract/history";
import { Body, PageHeader, SettingRow, settingsGroup, useDialogReturnFocus } from "./kit";
import type { useLiveHistory } from "./live/history";
import { focusPageHeading } from "./routes";
import { Column } from "./settings";
import { useWorkspace } from "./store";

type Status = typeof HistoryStatus.Type;
type Entry = Status["entries"][number];

function HistorySettings({ status, history, report }: {
  readonly status: Status;
  readonly history: ReturnType<typeof useLiveHistory>;
  readonly report: (message: string) => void;
}) {
  const [enabled, setEnabled] = useState(status.enabled);
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState(status.branch);
  const busy = history.action.loading;
  async function save(action: "enable" | "check" | "disable") {
    const destination = remote.trim();
    const result = await history.run(action === "disable" ? { action } : {
      action, branch: branch.trim(), ...(destination === "" ? {} : { remote: destination }),
    });
    if (result === null || "diff" in result) return;
    const warning = result.warnings?.join(" ");
    report(warning || (action === "check" ? "Git destination check passed." : "History settings saved."));
  }

  return <form onSubmit={(event) => { event.preventDefault(); void save(enabled ? "enable" : "disable"); }} className={settingsGroup}>
    <SettingRow title="Record history" description="Save a local Git commit when you publish a Profile Revision.">
      <Switch aria-label="Record history" checked={enabled} disabled={busy} onCheckedChange={setEnabled} />
    </SettingRow>
    {enabled && <>
      <SettingRow title={<Label htmlFor="history-remote">Git remote</Label>} description="History is plaintext. Leave this field empty to save locally.">
        <Input id="history-remote" value={remote} onChange={event => setRemote(event.target.value)} placeholder="Optional" />
      </SettingRow>
      <SettingRow title={<Label htmlFor="history-branch">Branch</Label>}>
        <Input id="history-branch" value={branch} onChange={event => setBranch(event.target.value)} required />
      </SettingRow>
    </>}
    <div className="flex justify-end gap-2 p-3">
      {enabled && <Button type="button" variant="outline" disabled={busy || branch.trim() === ""} onClick={() => void save("check")}>Check</Button>}
      <Button type="submit" variant="primary" disabled={busy}>Save</Button>
    </div>
  </form>;
}

function RestoreDialog({ entry, busy, restore, close }: {
  readonly entry: Entry;
  readonly busy: boolean;
  readonly restore: (reviewer: string) => Promise<void>;
  readonly close: () => void;
}) {
  const [reviewer, setReviewer] = useState("");
  const returnFocus = useDialogReturnFocus(focusPageHeading);
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent {...returnFocus}>
      <DialogHeader>
        <DialogTitle>Restore {entry.sequence === undefined ? shortHistoryId(entry.id) : `Revision ${entry.sequence}`}?</DialogTitle>
        <DialogDescription>
          Canonfig replaces the authored files, removes entries missing from this commit, and publishes the restored content. It saves a Takeover Snapshot first.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void restore(reviewer.trim()); }}>
        <div className="space-y-2">
          <Label htmlFor="history-reviewer">Reviewer</Label>
          <Input id="history-reviewer" autoComplete="name" required value={reviewer} onChange={event => setReviewer(event.target.value)} />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
          <Button type="submit" variant="destructive" disabled={busy || reviewer.trim() === ""}>Restore and publish</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function HistoryView() {
  const { history } = useWorkspace();
  const [notice, setNotice] = useState("");
  const [selected, select] = useState<Entry>();
  const [patch, setPatch] = useState<typeof HistoryDiff.Type>();
  const status = history?.status;
  const busy = history?.action.loading ?? false;

  async function diff(entry: Entry) {
    if (patch?.from === entry.id) { setPatch(undefined); return; }
    const result = await history?.run({ action: "diff", from: entry.id });
    if (result && "diff" in result) setPatch(result.diff);
  }

  async function restore(reviewer: string) {
    if (selected === undefined) return;
    const result = await history?.run({ action: "restore", revision: selected.id, reviewer });
    if (!result || "diff" in result) { select(undefined); return; }
    select(undefined);
    setPatch(undefined);
    setNotice(result.backup === undefined ? "Restored and published." : `Restored and published. Takeover Snapshot ${result.backup}`);
  }

  return <>
    <PageHeader crumbs={["Settings", "History"]} />
    <Body reloading={history?.state.loading ?? false}>
      <Column>
        {history?.action.error && <ErrorNotice error={history.action.error} />}
        {notice !== "" && <p role="status" className="mb-3 break-words">{notice}</p>}
        {history && status && <>
          <HistorySettings key={JSON.stringify([status.enabled, status.remote, status.branch])} status={status} history={history} report={setNotice} />
          <div className={`mt-6 ${settingsGroup}`}>
            <SettingRow title="Status" description={status.lastPushError}>
              <span>{status.enabled ? "Enabled" : "Disabled"}</span>
            </SettingRow>
            <SettingRow title="Remote" description={status.remote ?? "Local only"}>
              {status.remote && <>
                <span>{status.backlog === 0 ? "Up to date" : `${status.backlog} to push`}</span>
                <Button size="sm" variant="outline" disabled={busy || !status.enabled || status.backlog === 0}
                  onClick={() => { void history.run({ action: "push" }); }}>Push</Button>
              </>}
            </SettingRow>
          </div>
          <h2 className="mt-8 mb-2 font-medium">Commits{status.entries.length > 0 ? ` (${status.entries.length})` : ""}</h2>
          {status.entries.length === 0 ? <p className="text-muted-foreground">No commits yet.</p> :
            <ul className="divide-y">
              {status.entries.map(entry => <li key={entry.id} className="py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <div className="break-words">{entry.subject}</div>
                    <div className="text-sm text-muted-foreground">
                      <code>{shortHistoryId(entry.id)}</code> · {entry.author} · <time dateTime={entry.date}>{new Date(entry.date).toLocaleString()}</time> · {entry.pushed ? "Pushed" : "Local"}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void diff(entry)}>{patch?.from === entry.id ? "Hide diff" : "Diff to latest"}</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => select(entry)}>Restore</Button>
                </div>
                {patch?.from === entry.id && <pre tabIndex={0} aria-label="Git diff" className="mt-2 max-h-96 overflow-auto border p-3 text-xs">
                  {patch.patch === "" ? "No changes." : `${patch.names.join("\n")}\n\n${patch.patch}`}
                </pre>}
              </li>)}
            </ul>}
        </>}
        {history === undefined && <p>Open the installed Source workspace to manage History.</p>}
        {selected && <RestoreDialog entry={selected} busy={busy} restore={restore} close={() => select(undefined)} />}
      </Column>
    </Body>
  </>;
}
