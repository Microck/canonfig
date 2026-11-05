// Upstream skill updates on the Source, in a skill's detail panel: `canonfig skills track`, `check` and `update`
// (src/skills/manager.ts, docs/skill-updates.md). The record of where each skill came from is
// ~/.canonfig/skills-sources.json, which stays on the Source and is never published. An update only changes the
// skill in the Canonfig folder, so machines get it with the next revision, like any other edit.
// Demo state: the fetch reads `upstreamSkills` in shared/data.ts, never the network.
import { useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DEMO, DEMO_SKILLS_REPO, skillManifest, skillSources, upstreamSkills, type Resource, type SkillSource } from "@/shared/data";
import { Mono, StatusMark, type StatusKind } from "@/shared/shared";
import { useSharedReader, useSharedState, useWorkspace } from "./store";
import { Field, Prop, SectionLabel, useDialogReturnFocus } from "./kit";
import { useSelfUpdating } from "./settings";

type Files = Record<string, string>;

/** One skill's `canonfig skills check` result (SkillCheck in src/skills/manager.ts). */
interface SkillCheck {
  status: "unchanged" | "update-available" | "local-edits";
  nextCommit: string;
  added: string[];
  changed: string[];
  removed: string[];
}

/** The Source's skills-sources.json. A Source fresh out of onboarding starts with none (store.tsx sharedSeed). */
function useSkillSources() {
  return useSharedState<SkillSource[]>("skill-sources", skillSources);
}

/** The last check of each tracked skill this session, by item id. Checks aren't stored anywhere else: `list` reads no network. */
function useSkillChecks() {
  return useSharedState<Record<string, SkillCheck>>("skill-checks", {});
}

/** The running check, update or tracking, as `<kind>:<item id>`: one at a time, like the CLI's skill lock. */
function useSkillBusy() {
  return useSharedState<string | null>("skill-busy", null);
}

/**
 * Whether a check or update of this skill is running. The item editor locks while one does, so no edit lands under an
 * update and no rename moves the skill away from a check that writes its result under this id.
 */
export function useSkillLocked(id: string) {
  const busy = useSkillBusy()[0];
  return busy === `update:${id}` || busy === `check:${id}`;
}

/**
 * Keeps skills-sources.json in step with the folder when the item editor renames or removes a skill: a renamed skill
 * keeps its record (its `name` and `path`) and last check under the new id, and a removed one loses them, so a later
 * skill with the old name starts untracked instead of inheriting them. `to` is null for a removal.
 */
export function useMoveSkillTracking() {
  const [, setSources] = useSkillSources();
  const [, setChecks] = useSkillChecks();
  return (from: string, to: string | null) => {
    setSources((prev) => prev.flatMap((s) => (s.id !== from ? [s] : to ? [{ ...s, id: to }] : [])));
    setChecks((prev) => {
      const { [from]: moved, ...rest } = prev;
      return to && moved ? { ...rest, [to]: moved } : rest;
    });
  };
}

const short = (commit: string) => commit.slice(0, 7);

type Fetched = { ok: true; commit: string; files: Files } | { ok: false; error: string };

/** Fetches one skill directory at one ref, as fetchSkill in src/skills/upstream.ts does with Git. */
function fetchSkill(source: string, ref: string, subdir: string): Fetched {
  const known = upstreamSkills.filter((u) => u.source === source && (u.refs.includes(ref) || u.commit === ref));
  if (known.length === 0)
    return { ok: false, error: `Couldn't fetch ${ref} from that repository. Check the address and the branch, tag or commit, that Git is installed here, and that the repository is public.` };
  const hit = known.find((u) => u.subdir === subdir);
  if (!hit) return { ok: false, error: `${subdir === "." ? "The repository root" : subdir} has no SKILL.md at ${ref}. Enter the folder that holds the skill.` };
  return { ok: true, commit: hit.commit, files: hit.files };
}

/**
 * The skill's files in the Canonfig folder. Description and Body make SKILL.md; the GUI doesn't edit the skill's other
 * files, so their content is what `known` holds (the recorded baseline, or the upstream copy being tracked).
 */
function folderFiles(r: Resource, known: Files): Files {
  const names = new Set(["SKILL.md", ...(r.detail.Files ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
  return Object.fromEntries([...names].map((p) => [p, p === "SKILL.md" ? skillManifest(r.detail.Description ?? "", r.detail.Body ?? "") : (known[p] ?? `${p} as written here`)]));
}

const sameFiles = (a: Files, b: Files) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((p) => a[p] === b[p]);

/** Compares the folder's copy with the fetched one, file by file, and classifies it the way `skills check` does. */
function compare(r: Resource, record: SkillSource, fetched: { commit: string; files: Files }): SkillCheck {
  const local = folderFiles(r, record.baseline);
  const after = fetched.files;
  return {
    status: !sameFiles(local, record.baseline) ? "local-edits" : sameFiles(after, record.baseline) ? "unchanged" : "update-available",
    nextCommit: fetched.commit,
    added: Object.keys(after).filter((p) => !(p in local)).sort(),
    changed: Object.keys(after).filter((p) => p in local && local[p] !== after[p]).sort(),
    removed: Object.keys(local).filter((p) => !(p in after)).sort(),
  };
}

/** The folder item after an update: SKILL.md's fields and the file list come from the fetched copy. */
function updatedItem(r: Resource, files: Files): Resource {
  const [description, body] = files["SKILL.md"].split("\n---\n");
  const names = Object.keys(files);
  const { Files: _files, ...rest } = r.detail;
  return {
    ...r,
    change: r.change ?? "modified",
    summary: names.length > 1 ? `${names.length} files` : "SKILL.md",
    detail: { ...rest, Description: description, Body: body, ...(names.length > 1 ? { Files: names.join(", ") } : {}) },
  };
}

/** The file counts of a check, as `skills check` prints them (+added ~changed -removed), in words. */
const countText = (c: SkillCheck) => `${c.added.length} new, ${c.changed.length} changed, ${c.removed.length} removed`;

const STATE: Record<SkillCheck["status"], { kind: StatusKind; label: (c: SkillCheck, ref: string) => string }> = {
  unchanged: { kind: "ok", label: (_c, ref) => `Up to date with ${ref}` },
  "update-available": { kind: "warn", label: (c) => `Update available: ${short(c.nextCommit)}` },
  "local-edits": { kind: "act", label: () => "Edited here, so it can't update" },
};

/**
 * A skill row's Summary cell in Profile: the last check's state when it found something to do, otherwise the
 * summary and the ref a tracked skill follows.
 */
export function SkillSummary({ resource }: { resource: Resource }) {
  const [sources] = useSkillSources();
  const [checks] = useSkillChecks();
  const record = sources.find((s) => s.id === resource.id);
  const result = checks[resource.id];
  if (record && result && result.status !== "unchanged")
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        <StatusMark kind={STATE[result.status].kind} />
        <span className="truncate">{result.status === "update-available" ? "Update available" : "Local edits"}</span>
      </span>
    );
  const text = record ? `${resource.summary}, follows ${record.ref}` : resource.summary;
  return (
    <span className="truncate text-sm text-faint" title={text}>
      {text}
    </span>
  );
}

/** The files a check found different, grouped and labelled in words, so the list doesn't rely on colour or symbols. */
function FileChanges({ check }: { check: SkillCheck }) {
  const rows = [
    ...check.added.map((p) => ["New", p] as const),
    ...check.changed.map((p) => ["Changed", p] as const),
    ...check.removed.map((p) => ["Removed", p] as const),
  ];
  return (
    <ul className="grid gap-0.5 rounded-md border border-border bg-canvas/60 px-2.5 py-1.5" aria-label="Files that differ">
      {rows.map(([what, path]) => (
        <li key={`${what}:${path}`} className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2 text-sm">
          <span className="text-muted-foreground">{what}</span>
          <Mono className="break-all text-foreground">{path}</Mono>
        </li>
      ))}
    </ul>
  );
}

/**
 * The Upstream part of a skill's detail panel. A tracked skill shows its repository, the ref it follows and the commit
 * its copy came from; Check fetches that ref and previews the files an update changes, and Update replaces the skill in
 * the folder with that commit. Both refuse a copy edited since Canonfig installed it, as the CLI does: there is no force.
 * An untracked skill offers to start tracking. `editing` (the panel has unsaved edits) holds Update back, and the editor
 * locks while a check or update runs (useSkillLocked), so the update never lands under a draft. The panel shows the updated
 * item by following its saved resource (ItemEditor in profile.tsx).
 */
export function SkillUpstream({ resource, editing }: { resource: Resource; editing: boolean }) {
  const ws = useWorkspace();
  const [sources, setSources] = useSkillSources();
  const readSources = useSharedReader<SkillSource[]>("skill-sources", skillSources);
  const [checks, setChecks] = useSkillChecks();
  // Shared, like the service page's busy state: the guard survives leaving the panel, and switching roles cancels the result.
  const [busy, setBusy] = useSkillBusy();
  // A Canonfig update holds every other command back, skills included (VersionView waits for skill-busy the same way).
  const selfUpdating = useSelfUpdating();
  const [tracking, setTracking] = useState(false);
  // Where focus goes once tracking succeeds and its Track upstream button is gone.
  const checkButton = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const record = sources.find((s) => s.id === resource.id);
  const result = record ? checks[resource.id] : undefined;
  const id = resource.id;

  const check = (tracked: SkillSource) => {
    setBusy(`check:${id}`);
    ws.later(() => {
      setBusy(null);
      const fetched = fetchSkill(tracked.source, tracked.ref, tracked.subdir);
      if (!fetched.ok) {
        toast.error(`Couldn't check ${id}`, { description: fetched.error });
        return;
      }
      const next = compare(ws.readResources().find((r) => r.id === id) ?? resource, tracked, fetched);
      setChecks((prev) => ({ ...prev, [id]: next }));
      if (next.status === "unchanged") toast(`${id} is up to date`, { description: `It matches ${tracked.ref} at ${short(next.nextCommit)}.` });
      else if (next.status === "update-available")
        toast(`Update available for ${id}`, { description: `Files at ${short(next.nextCommit)} on ${tracked.ref}: ${countText(next)}.\nReview them, then update.` });
      else toast(`${id} has local edits`, { description: "Canonfig won't update it until you move or back up your changes." });
    }, 900);
  };

  const refuseLocalEdits = () => toast.error(`Didn't update ${id}`, { description: "It has local edits, so no skill was updated.\nMove or back up your changes first." });

  const update = (tracked: SkillSource) => {
    // `skills update --apply` checks again before it replaces anything, so an edit saved after the last check still blocks it.
    const fetched = fetchSkill(tracked.source, tracked.ref, tracked.subdir);
    if (!fetched.ok) {
      toast.error(`Couldn't update ${id}`, { description: fetched.error });
      return;
    }
    const latest = compare(resource, tracked, fetched);
    setChecks((prev) => ({ ...prev, [id]: latest }));
    if (latest.status === "local-edits") return refuseLocalEdits();
    if (latest.status === "unchanged") {
      toast(`${id} is up to date`, { description: `It matches ${tracked.ref} at ${short(latest.nextCommit)}.` });
      return;
    }
    setBusy(`update:${id}`);
    ws.later(() => {
      setBusy(null);
      // And once more right before replacing, as updateSkills does inside its lock: compare what the folder and
      // skills-sources.json hold now, not what they held when the update started.
      const current = ws.readResources().find((r) => r.id === id && r.change !== "removed");
      const now = readSources().find((s) => s.id === id);
      if (!current || now?.commit !== tracked.commit) {
        toast.error(`Didn't update ${id}`, { description: "It changed in the folder while the update ran, so no skill was updated.\nCheck again." });
        return;
      }
      const again = compare(current, now, fetched);
      if (again.status === "local-edits") {
        setChecks((prev) => ({ ...prev, [id]: again }));
        return refuseLocalEdits();
      }
      ws.setResources((prev) => prev.map((r) => (r.id === id ? updatedItem(current, fetched.files) : r)));
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, commit: fetched.commit, baseline: fetched.files } : s)));
      setChecks((prev) => ({ ...prev, [id]: { status: "unchanged", nextCommit: fetched.commit, added: [], changed: [], removed: [] } }));
      // Read live: the render this callback closed over predates the update, and edits may have landed since.
      const live = ws.readQueue();
      const unpublished = live.pending.length + (current.change ? 0 : 1);
      toast.success(`Updated ${id}`, {
        description: `Now at ${short(fetched.commit)} from ${tracked.ref}. Files: ${countText(again)}.\nGoes out with revision ${live.nextSequence}: ${unpublished} unpublished ${unpublished === 1 ? "change" : "changes"}.${DEMO ? "\nSaved in this demo workspace." : ""}`,
      });
    }, 900);
  };

  const state = result ? STATE[result.status] : null;
  return (
    <section aria-label="Upstream" className="grid gap-1">
      {!record ? (
        <>
          <SectionLabel
            action={
              <Button type="button" variant="outline" size="xs" onClick={() => setTracking(true)}>
                Track upstream…
              </Button>
            }
          >
            Upstream
          </SectionLabel>
          <p className="text-sm text-pretty text-faint">Not tracked. If this skill came from a Git repository, track it so Canonfig can check that repository for updates.</p>
        </>
      ) : (
        <>
          <SectionLabel>Upstream</SectionLabel>
          <Prop label="Repository">
            <Mono className="break-all text-foreground">{record.source}</Mono>
          </Prop>
          <Prop label="Follows">
            <Mono className="text-foreground">{record.ref}</Mono>
            {record.subdir !== "." && (
              <>
                {" in "}
                <Mono className="break-all text-foreground">{record.subdir}</Mono>
              </>
            )}
          </Prop>
          <Prop label="Installed from">
            <span title={record.commit}>
              <Mono className="text-foreground">{short(record.commit)}</Mono>
            </span>
          </Prop>
          <Prop label="State">
            <span className="inline-flex items-center gap-1.5" aria-live="polite">
              <StatusMark kind={state?.kind ?? "off"} />
              {state && result ? state.label(result, record.ref) : "Not checked yet"}
            </span>
          </Prop>
          {result && result.status !== "unchanged" && (
            <div className="mt-1 grid gap-1.5">
              <p className="text-sm text-muted-foreground">
                Compared with {record.ref} at <Mono>{short(result.nextCommit)}</Mono>:
              </p>
              <FileChanges check={result} />
            </div>
          )}
          {result?.status === "local-edits" && (
            <p className="mt-1 text-sm text-pretty text-muted-foreground">
              This copy changed since Canonfig installed <Mono>{short(record.commit)}</Mono>, so Canonfig won't update it: it never overwrites local edits and has no way to force
              it. Move or back up your changes, then track the revision they match.
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button ref={checkButton} type="button" variant="secondary" size="sm" disabled={busy !== null || selfUpdating} onClick={() => check(record)}>
              {busy === `check:${id}` ? "Checking…" : "Check for updates"}
            </Button>
            {result?.status === "update-available" && (
              <Button type="button" variant="secondary" size="sm" disabled={busy !== null || editing || selfUpdating} aria-describedby={noteId} onClick={() => update(record)}>
                {busy === `update:${id}` ? "Updating…" : `Update to ${short(result.nextCommit)}`}
              </Button>
            )}
          </div>
          {result?.status === "update-available" && (
            <p id={noteId} className="text-sm text-pretty text-faint">
              {busy === `update:${id}`
                ? "The editor is locked until the update finishes."
                : editing
                  ? "Save or discard your edits before updating."
                  : "Updating replaces this skill's folder in ~/.canonfig with that commit. Nothing reaches other machines until you publish, and Canonfig never runs the skill's files."}
            </p>
          )}
        </>
      )}
      {/* Mounted for tracked skills too, so it closes normally once tracking succeeds and hands focus to Check. */}
      <TrackSkillDialog resource={resource} open={tracking} onOpenChange={setTracking} onTracked={() => checkButton.current?.focus()} />
    </section>
  );
}

/** The ref rule of validateSource in src/skills/upstream.ts: a branch, tag or commit name, never a Git expression. */
const REF = /^[A-Za-z0-9_./-]+$/;

function refError(ref: string) {
  return !ref || ref.startsWith("-") || !REF.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.includes("//") ? "Enter a branch, tag or commit, like main or v1.2.0." : null;
}

/** normalizeSource in src/skills/upstream.ts: public HTTPS without credentials, or a local repository by path. */
function sourceError(source: string) {
  if (source.startsWith("https://")) {
    try {
      const url = new URL(source);
      return url.username || url.password || url.search || url.hash ? "Remove the sign-in details and any ? or # part. Canonfig only fetches public repositories." : null;
    } catch {
      return "Enter a complete HTTPS address, like https://github.com/you/skills.git.";
    }
  }
  return source.startsWith("/") || source.startsWith("~/") ? null : "Enter an HTTPS Git address, or a local repository path that starts with / or ~/.";
}

/** safePath in src/skills/upstream.ts, plus `.` for the repository root. */
function subdirError(subdir: string) {
  if (subdir === ".") return null;
  const bad = !subdir || subdir.startsWith("/") || subdir.includes("\\") || subdir.split("/").some((part) => !part || part === "." || part === ".." || part === ".git");
  return bad ? "Enter a folder inside the repository, like skills/debugging, or . for its root." : null;
}

/**
 * Starts tracking a skill that is already in the folder (`canonfig skills track`). Canonfig fetches the ref and records
 * it only when every file matches the folder's copy: it never adopts edits it can't explain. Tracking changes no files.
 * Cancel returns focus to Track upstream; after tracking that button is gone, so `onTracked` places focus instead.
 */
function TrackSkillDialog({ resource, open, onOpenChange, onTracked }: { resource: Resource; open: boolean; onOpenChange: (open: boolean) => void; onTracked: () => void }) {
  const ws = useWorkspace();
  const [, setSources] = useSkillSources();
  const [busy, setBusy] = useSkillBusy();
  const returnFocus = useDialogReturnFocus(onTracked);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [subdir, setSubdir] = useState(".");
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const checking = busy === `track:${resource.id}`;
  const trimmed = { source: source.trim(), ref: ref.trim(), subdir: subdir.trim() };
  const errors = { source: sourceError(trimmed.source), ref: refError(trimmed.ref), subdir: subdirError(trimmed.subdir) };
  const shown = (key: keyof typeof errors) => (tried ? errors[key] : null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The dialog renders through a portal but stays inside the item editor's form in React's tree; keep its submit there.
    event.stopPropagation();
    setTried(true);
    setRefusal(null);
    const first = (Object.keys(errors) as (keyof typeof errors)[]).find((k) => errors[k]);
    if (first) {
      event.currentTarget.querySelector<HTMLElement>(`#track-${first}`)?.focus();
      return;
    }
    // One skill command at a time: another skill's check finishing can't re-enable Track mid-flight and double-submit.
    if (busy !== null) return;
    const normalized = trimmed.source.startsWith("https://") ? new URL(trimmed.source).href : trimmed.source;
    setBusy(`track:${resource.id}`);
    ws.later(() => {
      setBusy(null);
      // The skill may have been removed or renamed while fetching; then there is nothing left to track under this id.
      const live = ws.readResources().find((r) => r.id === resource.id && r.change !== "removed");
      if (!live) return setRefusal(`${resource.id} is no longer in the folder, so Canonfig didn't track it.`);
      const fetched = fetchSkill(normalized, trimmed.ref, trimmed.subdir);
      if (!fetched.ok) return setRefusal(fetched.error);
      if (!sameFiles(folderFiles(live, fetched.files), fetched.files))
        return setRefusal(
          `This skill doesn't match ${trimmed.ref} (${short(fetched.commit)}) in that repository, so Canonfig won't track it: it never adopts edits it can't explain. Choose the branch, tag or commit the skill came from, or make its files match first.`,
        );
      setSources((prev) => [...prev, { id: resource.id, source: normalized, ref: trimmed.ref, subdir: trimmed.subdir, commit: fetched.commit, baseline: fetched.files }]);
      onOpenChange(false);
      toast.success(`Tracking ${resource.id}`, {
        description: `Follows ${trimmed.ref}, at ${short(fetched.commit)}.\nRecorded in ~/.canonfig/skills-sources.json, which stays on ${ws.machineName} and is never published.`,
      });
    }, 900);
  };

  return (
    // Closing waits for a running check, so its answer always has somewhere to show.
    <Dialog open={open} onOpenChange={(next) => !checking && onOpenChange(next)}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md" {...returnFocus}>
        <form className="contents" noValidate onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Track {resource.id}</DialogTitle>
            <DialogDescription className="text-base text-pretty">
              Name the Git repository this skill came from. Canonfig fetches it and records it only if every file matches your copy. Nothing in the folder changes.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field
              label="Repository"
              htmlFor="track-source"
              error={shown("source")}
              description={DEMO ? `This demo can only fetch ${DEMO_SKILLS_REPO}.` : "A public HTTPS address, or a local repository path."}
            >
              <Input
                id="track-source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="https://github.com/you/skills.git"
                aria-invalid={!!shown("source")}
                aria-describedby="track-source-note"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </Field>
            <Field label="Branch, tag or commit" htmlFor="track-ref" error={shown("ref")} description="Pick the one your copy came from. A commit stays pinned.">
              <Input
                id="track-ref"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="main"
                aria-invalid={!!shown("ref")}
                aria-describedby="track-ref-note"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </Field>
            <Field label="Folder in the repository" htmlFor="track-subdir" error={shown("subdir")} description={`The folder that holds SKILL.md, like skills/${resource.id.slice("skills/".length)}, or . for the root.`}>
              <Input
                id="track-subdir"
                value={subdir}
                onChange={(e) => setSubdir(e.target.value)}
                aria-invalid={!!shown("subdir")}
                aria-describedby="track-subdir-note"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </Field>
            {refusal && (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-pretty text-bad">
                <StatusMark kind="bad" className="mt-0.5" />
                {refusal}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={checking} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy !== null}>
              {checking ? "Checking…" : "Track skill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
