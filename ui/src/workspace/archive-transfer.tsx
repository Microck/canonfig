import { useEffect, useRef, useState, type ReactNode } from "react";
import { Schema } from "effect";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mono } from "@/shared/shared";
import { ErrorNotice } from "@/live/session";
import { GuiRequestError, type WorkspaceBackend } from "@/gui-client";
import { requestError } from "./live/resource";
import { Prop } from "./kit";
import { GuiOperationTicket } from "../../../src/gui/contract/operations";
import { GuiArchiveImportResult, type GuiArchiveImportInput } from "../../../src/gui/contract/synchronization";

export function ArchiveExportButton({ onExport, disabled }: { onExport: (includeHarnesses: boolean) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [includeHarnesses, setIncludeHarnesses] = useState(false);
  return <>
    <Button variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>Export</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Export archive</DialogTitle><DialogDescription>Exports the Canonical Folder and local items.</DialogDescription></DialogHeader>
        <label className="flex items-start gap-3 text-sm"><Checkbox checked={includeHarnesses} onCheckedChange={(value) => setIncludeHarnesses(value === true)} /><span>Include managed harness files<span className="mt-1 block text-muted-foreground">Unchanged files and owned keys; import verifies them without restoring them.</span></span></label>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => { onExport(includeHarnesses); setOpen(false); }}>Download archive</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

type PreviewSubmission = { kind: "preview"; input: typeof GuiArchiveImportInput.Type };
type ApplySubmission = { kind: "apply"; input: typeof GuiArchiveImportInput.Type; sha256: string };
type Submission = PreviewSubmission | ApplySubmission;
type ImportState =
  | { kind: "editing"; error?: GuiRequestError }
  | { kind: "reading" }
  | { kind: "running"; submission: Submission; ticket?: string }
  | { kind: "lost"; submission: Submission; ticket: string; error: GuiRequestError }
  | { kind: "lost"; submission: ApplySubmission; ticket?: undefined; error: GuiRequestError }
  | { kind: "review"; submission: Submission; result: GuiArchiveImportResult }
  | { kind: "complete"; submission: Submission; result: GuiArchiveImportResult };

/**
 * One immutable upload/options pair owns preview and apply. Lost observation never repeats a write.
 * `trigger` replaces the default outlined button, e.g. with the setup header's action style.
 */
export function ArchiveImportButton({ backend, onImported, trigger }: { backend: WorkspaceBackend; onImported?: () => void; trigger?: (open: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    {trigger ? trigger(() => setOpen(true)) : <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Import archive</Button>}
    {open && <ArchiveImportDialog backend={backend} onClose={() => setOpen(false)} onImported={onImported} />}
  </>;
}

function ArchiveImportDialog({ backend, onClose, onImported }: { backend: WorkspaceBackend; onClose: () => void; onImported?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [expectKey, setExpectKey] = useState("");
  const [replace, setReplace] = useState(false);
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<ImportState>({ kind: "editing" });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const busy = state.kind === "reading" || state.kind === "running";
  const locked = busy || state.kind === "lost";
  const result = state.kind === "review" || state.kind === "complete" ? state.result : null;
  const error = state.kind === "editing" || state.kind === "lost" ? state.error : undefined;
  const key = expectKey.trim().toLowerCase();
  const validKey = !key || /^[a-f0-9]{64}$/u.test(key);

  const execute = async (submission: Submission, ticket?: string) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    let operationId = ticket;
    setState({ kind: "running", submission, ...(ticket ? { ticket } : {}) });
    try {
      if (!operationId) {
        const started = await backend.request(submission.kind === "preview" ? "/api/imports/preview" : "/api/imports", GuiOperationTicket, controller.signal, {
          method: "POST", body: { ...submission.input, ...(submission.kind === "apply" ? { sha256: submission.sha256 } : {}) },
        });
        operationId = started.id;
        setState({ kind: "running", submission, ticket: operationId });
      }
      let operation = await backend.operation(operationId, controller.signal);
      while (operation.state === "running") {
        const { promise, resolve } = Promise.withResolvers<void>();
        window.setTimeout(resolve, 500);
        await promise;
        controller.signal.throwIfAborted();
        operation = await backend.operation(operationId, controller.signal);
      }
      if (operation.state === "failed") {
        setState({ kind: "editing", error: new GuiRequestError(operation.failure) });
        return;
      }
      const completed = Schema.decodeUnknownSync(GuiArchiveImportResult)(operation.result);
      setState(submission.kind === "preview" ? { kind: "review", submission, result: completed } : { kind: "complete", submission, result: completed });
    } catch (cause) {
      if (controller.signal.aborted) return;
      const failure = requestError(cause);
      if (operationId) {
        setState({ kind: "lost", submission, ticket: operationId, error: failure });
        return;
      }
      // Preview is read-only and cannot write the archive, so a lost start response returns to editing.
      // For apply, only a non-2xx response confirms rejection; transport or success-decoding failures may hide a started run.
      const rejected = cause instanceof GuiRequestError && cause.httpStatus !== undefined && (cause.httpStatus < 200 || cause.httpStatus >= 300);
      if (submission.kind === "preview" || rejected) setState({ kind: "editing", error: failure });
      else setState({ kind: "lost", submission, error: failure });
    } finally { active.current = null; }
  };
  const preview = async () => {
    if (!file || locked || active.current) return;
    setState({ kind: "reading" });
    const controller = new AbortController();
    active.current = controller;
    try {
      // FileReader produces base64 without spreading a potentially large byte array onto the stack.
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("Could not read the archive."));
      reader.onerror = () => reject(new Error("Could not read the archive."));
      reader.readAsDataURL(file);
      const base64 = await promise;
      controller.signal.throwIfAborted();
      active.current = null;
      await execute({ kind: "preview", input: { base64, replace, ...(key ? { expectKey: key } : {}) } });
    } catch (cause) { if (!controller.signal.aborted) setState({ kind: "editing", error: requestError(cause) }); }
    finally { if (active.current === controller) active.current = null; }
  };
  const edit = () => { setConsent(false); setState({ kind: "editing" }); };
  const close = () => { if (state.kind === "complete") onImported?.(); onClose(); };
  return <Dialog open onOpenChange={(next) => { if (!next && !locked) close(); }}>
    <DialogContent aria-describedby={undefined} className="max-h-[85svh] overflow-y-auto sm:max-w-2xl" showCloseButton={!locked}>
      <DialogHeader><DialogTitle>Import archive</DialogTitle></DialogHeader>
      {state.kind !== "complete" && <fieldset hidden={state.kind === "review"} disabled={locked || state.kind === "review"} className="space-y-4">
        <div className="space-y-2"><Label htmlFor="archive-file">Archive file</Label><Input id="archive-file" type="file" accept=".tar.gz,application/gzip" onChange={(event) => { setFile(event.target.files?.[0] ?? null); edit(); }} /></div>
        <div className="space-y-2"><Label htmlFor="archive-signer">Expected signing key fingerprint (optional)</Label><Input id="archive-signer" value={expectKey} onChange={(event) => { setExpectKey(event.target.value); edit(); }} placeholder="64 hex digits" /><p className="text-sm text-muted-foreground">From canonfig status on a trusted Source; leave blank to accept any signer or an unsigned archive.</p>{!validKey && <p role="alert" className="text-sm text-destructive">Enter all 64 hexadecimal digits.</p>}</div>
        <label className="flex items-start gap-3 text-sm"><Checkbox checked={replace} onCheckedChange={(value) => { setReplace(value === true); edit(); }} /><span>Allow replacement of existing folder entries<span className="mt-1 block text-muted-foreground">Matching whole files or directories are snapshotted to ~/.canonfig/.backups/ before replacement; canonfig restore puts them back.</span></span></label>
      </fieldset>}
      {busy && <p role="status">{state.kind === "reading" ? "Reading archive…" : state.submission.kind === "preview" ? "Verifying archive…" : "Importing archive…"}</p>}
      {error && <ErrorNotice error={error} title={state.kind === "lost" ? "Operation observation lost" : "Archive import failed"} />}
      {state.kind === "lost" && <div className="space-y-2 text-sm">{state.ticket ? <><Prop label="Operation"><Mono>{state.ticket}</Mono></Prop><Button onClick={() => void execute(state.submission, state.ticket)}>Resume observation</Button></> : <p>Check canonfig status, recover any interrupted run with canonfig recover, then reopen the GUI.</p>}</div>}
      {result && <div className="space-y-2 text-sm">
        <Prop label="Archive file">{file?.name}</Prop>
        <p role="status">{state.kind === "complete" ? "Import complete." : "Ready to import."}</p>
        <Prop label="Archive fingerprint"><Mono className="break-all">{result.sha256}</Mono></Prop>
        <Prop label="Manifest fingerprint"><Mono className="break-all">{result.manifestSha256}</Mono></Prop>
        <Prop label="Signer"><Mono className="break-all">{result.signer}</Mono></Prop>
        <Prop label="Expected signer">{(state.kind === "review" || state.kind === "complete") && state.submission.input.expectKey ? "Matched" : "Not checked"}</Prop>
        <Prop label="Folder files">{result.folderFiles}</Prop><Prop label="Entries replaced">{result.replaced.join(", ") || "None"}</Prop><Prop label="Existing entries kept">{result.kept?.join(", ") || "None"}</Prop>
        <Prop label="Managed harness files">{result.harnessFiles?.verified ?? 0} verified, not restored</Prop>
        {result.backup && <Prop label="Recovery snapshot"><Mono>{result.backup}</Mono></Prop>}
        <details><summary className="cursor-pointer">{state.kind === "complete" ? "Run details" : "Import plan"}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(state.kind === "complete" ? result.outcome : result.plan, null, 2)}</pre></details>
      </div>}
      {state.kind === "review" && <label className="flex items-start gap-3 text-sm"><Checkbox checked={consent} onCheckedChange={(value) => setConsent(value === true)} /><span>{state.submission.input.replace ? "Replace matching entries after a recovery snapshot; canonfig restore puts them back." : "I have reviewed the plan."}</span></label>}
      <DialogFooter>
        <Button variant="outline" disabled={locked} onClick={close}>{state.kind === "complete" ? "Done" : "Cancel"}</Button>
        {state.kind === "review" ? <><Button variant="outline" onClick={edit}>Change inputs</Button><Button disabled={!consent} onClick={() => void execute({ ...state.submission, kind: "apply", sha256: state.result.sha256 })}>Import verified archive</Button></> : state.kind !== "complete" && state.kind !== "lost" && <Button disabled={busy || !file || !validKey} onClick={() => void preview()}>Verify and preview</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
