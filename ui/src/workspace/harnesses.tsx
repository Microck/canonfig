// The harness list and takeover backups page share the active workspace's reports and restore action.
import { useRef, useState, type ReactNode } from "react";
import { CaretDown } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HARNESS_NAMES, DEMO, SURFACE_CATEGORIES, SURFACE_NAMES, SURFACE_SUPPORT, type Harness, type HarnessId, type Snapshot, type SurfaceCategory } from "@/shared/metadata";
import { Mono, StatusMark, type StatusKind } from "@/shared/shared";
import { useWorkspace } from "./store";
import { AnimatedRow, Body, EmptyState, ListHead, ListRow, PageHeader, RowPresence } from "./kit";
import { ConfirmDialog } from "./settings";
import { FollowerOperationEvidence } from "./follower-evidence";


/** What Canonfig does with a harness on this machine, from the three facts `canonfig harnesses` reports. */
function harnessStatus(h: Harness): { kind: StatusKind; label: string; hint: string } {
  if (h.excluded) return { kind: "off", label: "Excluded here", hint: h.listed ? "Listed, but this machine's local/local.jsonc excludes it, so Canonfig leaves it alone." : "Not listed in the profile." };
  if (!h.listed && h.installed) return { kind: "off", label: "Installed, not listed", hint: "Canonfig ignores it until canonfig.jsonc lists it." };
  if (!h.listed) return { kind: "off", label: "Not installed", hint: "Not on this machine and not in the list." };
  if (!h.installed) return { kind: "warn", label: "Listed, not installed", hint: "Reported as not installed.\nCanonfig backs it up and starts syncing into it once it's installed." };
  return { kind: "ok", label: "Managed here", hint: "Listed, installed and not excluded, so Canonfig writes the folder into it." };
}

/** "Everything", "Nothing", or the chosen categories by name. */
function surfacesLabel(selected: SurfaceCategory[] | undefined): string {
  if (selected === undefined) return "Everything";
  if (selected.length === 0) return "Nothing";
  return SURFACE_CATEGORIES.filter((c) => selected.includes(c)).map((c) => SURFACE_NAMES[c]).join(", ");
}

/** Whether two Gets choices pick the same categories, in any order; `undefined` is "Everything". */
function sameSurfaces(a: SurfaceCategory[] | undefined, b: SurfaceCategory[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((category) => b.includes(category));
}

/**
 * Which categories a listed harness gets, out of the ones it supports (canonfig.jsonc refuses the rest).
 * Ticking every supported category drops the harness's entry, so the file keeps the default
 * ("everything") rather than a list that would miss a category the harness gains later.
 * Ticks are a draft while the menu is open and are saved once when it closes: each canonfig.jsonc
 * write validates the whole folder, about a second on a large profile, and blocks the page meanwhile.
 */
function SurfacesMenu({ harness }: { harness: Harness }) {
  const ws = useWorkspace();
  const supported = ws.profileLive?.snapshot ? SURFACE_CATEGORIES.filter((category) => ws.profileLive!.snapshot!.supportedSurfaces[harness.id]?.includes(category)) : SURFACE_SUPPORT[harness.id];
  const selected = ws.surfaces[harness.id];
  const label = surfacesLabel(selected);
  // Radix puts focus back on the trigger when the menu closes, which draws its focus ring even after a
  // mouse click outside. Return focus only when the menu was driven from the keyboard.
  const closedByPointer = useRef(false);
  // `null` means no change since the menu opened; `{ value: undefined }` is a pending "Everything".
  // The ref lets the close handler read a draft set in the same event, such as choosing Everything.
  const [draft, setDraftState] = useState<{ value: SurfaceCategory[] | undefined } | null>(null);
  const draftRef = useRef(draft);
  const setDraft = (next: { value: SurfaceCategory[] | undefined } | null) => { draftRef.current = next; setDraftState(next); };
  const shown = draft === null ? selected : draft.value;
  const change = (next: SurfaceCategory[] | undefined) => {
    ws.setSurfaces((prev) => {
      const { [harness.id]: _dropped, ...rest } = prev;
      return next === undefined ? rest : { ...rest, [harness.id]: next };
    });
    if (!ws.profileLive) ws.markProfileEdit({ area: "harnesses", id: "harnesses", change: "modified" });
  };
  const toggle = (category: SurfaceCategory, on: boolean) => {
    const current = shown ?? supported;
    const next = on ? [...current, category] : current.filter((c) => c !== category);
    setDraft({ value: next.length === supported.length ? undefined : next });
  };
  const commit = (open: boolean) => {
    if (open) return;
    const pending = draftRef.current;
    setDraft(null);
    if (pending === null) return;
    if (!sameSurfaces(pending.value, selected)) change(pending.value);
  };
  return (
    <DropdownMenu onOpenChange={commit}>
      <DropdownMenuTrigger asChild>
        {/* -ml-[7px] cancels px-1.5 plus the button's 1px border so the label lines up with "Not listed" and the column heading; the hover fill bleeds into the gutter. */}
        <Button variant="ghost" size="sm" disabled={ws.profileLive?.busy} className="-ml-[7px] min-w-0 justify-between gap-1 px-1.5 font-normal" title={label} aria-label={`What ${harness.name} gets: ${label}`}>
          <span className="truncate">{label}</span>
          <CaretDown className="shrink-0 text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-56"
        onPointerDown={() => (closedByPointer.current = true)}
        onPointerDownOutside={() => (closedByPointer.current = true)}
        onKeyDown={() => (closedByPointer.current = false)}
        onCloseAutoFocus={(event) => {
          if (closedByPointer.current) event.preventDefault();
          closedByPointer.current = false;
        }}
      >
        {/* Every category in the same order for every harness; ones this harness has no global place for stay visible but disabled and unticked. */}
        {SURFACE_CATEGORIES.map((category) => {
          const available = supported.includes(category);
          return (
            <DropdownMenuCheckboxItem
              key={category}
              disabled={!available || ws.profileLive?.busy}
              checked={available && (shown === undefined || shown.includes(category))}
              // Keep the menu open so several categories can be changed in one go.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => toggle(category, on)}
            >
              {SURFACE_NAMES[category]}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={shown === undefined || ws.profileLive?.busy} onSelect={() => setDraft({ value: undefined })}>
          Everything
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Every harness Canonfig supports, as this machine sees it. `edit` puts a checkbox in front of each row:
 * "listed" edits canonfig.jsonc `harnesses` (the Source's Profile), "managed" edits only this machine's
 * exclusions in local/local.jsonc (Local settings), independently of whether a harness is listed.
 */
export function HarnessTable({ edit, onToggle, keys }: {
  edit?: "listed" | "managed";
  onToggle?: (id: HarnessId, on: boolean) => void;
  /** An extra last column (Local settings' key claims), rendered per harness. */
  keys?: { title: ReactNode; render: (harness: Harness) => ReactNode };
}) {
  const ws = useWorkspace();
  const showRoot = ws.harnesses.some((h) => h.root);
  const showBackup = ws.harnesses.some((h) => h.snapshot);
  // The Source's 120px Gets minimum keeps its menu inside a 390px viewport.
  const cols = `${edit ? "24px " : ""}minmax(180px,240px) ${edit === "listed" ? "minmax(120px,200px) " : ""}minmax(170px,1fr)`
    + (showRoot ? " minmax(140px,220px)" : "")
    + (showBackup ? " minmax(150px,220px)" : "")
    + (keys ? " minmax(200px,2fr)" : "");
  const minWidth = 180 + 170 + 12 + 20
    + (edit ? 24 + 12 : 0) + (edit === "listed" ? 120 + 12 : 0)
    + (showRoot ? 140 + 12 : 0) + (showBackup ? 150 + 12 : 0) + (keys ? 200 + 12 : 0);
  return (
    <>
      <ListHead cols={cols} minWidth={minWidth} data-tour="harness-list">
        {/* A grid cell of its own: an sr-only span is absolutely positioned and would shift the headings left. */}
        {edit && (
          <span>
            <span className="sr-only">{edit === "listed" ? "In the list" : "Included locally"}</span>
          </span>
        )}
        <span>Harness</span>
        {edit === "listed" && <span>Gets</span>}
        <span>On this machine</span>
        {showRoot && <span>Root</span>}
        {showBackup && <span>Backup</span>}
        {keys && <span>{keys.title}</span>}
      </ListHead>
      {ws.harnesses.map((h) => {
        const status = harnessStatus(h);
        const checked = edit === "listed" ? h.listed : !h.excluded;
        const id = `harness-${edit}-${h.id}`;
        return (
          // Chips in the keys column can wrap, so those rows grow instead of keeping the fixed list height.
          <ListRow key={h.id} cols={cols} minWidth={minWidth} data-tour="harness-list" className={keys && "h-auto min-h-[44px] py-1.5"}>
            {edit && <Checkbox
              id={id}
              checked={checked}
              disabled={edit === "listed" ? !ws.capabilities.profileWrite || ws.profileLive?.busy : !ws.capabilities.followerWrite || ws.followerLive?.action.loading}
              aria-label={edit === "listed" ? `List ${h.name}` : `Include ${h.name} on this machine`}
              onCheckedChange={(c) => onToggle?.(h.id, !!c)}
            />}
            <span className="grid min-w-0">
              <span className="truncate font-medium">{h.name}</span>
              <Mono className="truncate text-faint">{h.id}</Mono>
            </span>
            {/* Only a listed harness gets anything, so an unlisted row has no choice to make. */}
            {edit === "listed" && (h.listed ? ws.capabilities.profileWrite ? <SurfacesMenu harness={h} /> : <span className="text-sm text-faint">Read only</span> : <span className="text-sm text-faint">Not listed</span>)}
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" title={status.hint}>
              <StatusMark kind={status.kind} />
              <span className="truncate">{status.label}</span>
            </span>
            {/* Later syncs refuse any folder other than the recorded root. */}
            {showRoot && <Mono className="truncate">{h.root}</Mono>}
            {showBackup && <Mono className="truncate">{h.snapshot}</Mono>}
            {keys && <span className="flex min-w-0 flex-wrap items-center gap-1.5">{keys.render(h)}</span>}
          </ListRow>
        );
      })}
    </>
  );
}

/** "Codex, Claude Code" for a snapshot's harnesses. */
const namesOf = (ids: HarnessId[]) => ids.map((h) => HARNESS_NAMES[h]).join(", ");

/**
 * Retention as Canonfig applies it after writing a snapshot (src/projection/takeover.ts): the first stays, and
 * the oldest of the recent ones goes once there are more than 4 of them.
 */
const RECENT_KEPT = 4;

export function BackupsView() {
  const ws = useWorkspace();
  const [restoring, setRestoring] = useState<Snapshot | null>(null);
  const cols = "minmax(220px,280px) minmax(160px,1fr) 64px 120px";
  const colsMin = 220 + 160 + 64 + 120 + 3 * 12 + 20;
  const recent = ws.snapshots.filter((s) => s.first === false).length;
  // Newest first, the way people look for the one to restore.
  const shown = [...ws.snapshots].reverse();
  return (
    <>
      <PageHeader crumbs={["Backups"]} actions={ws.followerLive && <Button size="sm" variant="outline" onClick={ws.reload}>Reload</Button>} />
      <Body>
        <p data-tour="backups-about" className="border-b border-border px-[18px] py-3 text-sm text-pretty text-muted-foreground">
          Canonfig keeps the first harness snapshot, the first folder snapshot and the {RECENT_KEPT} most recent snapshots.
        </p>
        {(!ws.session || ws.session.role === "follower") && ws.backups === false && (
          <p className="flex items-center gap-2 border-b border-border px-[18px] py-3 text-sm text-pretty text-warn">
            <StatusMark kind="warn" />
            Backups are off on this machine: local/local.jsonc sets "backups": false, so Canonfig takes over a new harness without a snapshot.
          </p>
        )}
        {shown.length === 0 ? (
          <EmptyState title="No backups yet" body="Apply a sync plan with backups enabled to create one." />
        ) : (
          <>
            <ListHead cols={cols} minWidth={colsMin} data-tour="backups-list">
              <span>Snapshot</span>
              <span>Harnesses</span>
              <span>Files</span>
              <span className="sr-only">Restore</span>
            </ListHead>
            <RowPresence>
              {shown.map((s) => {
                const done = ws.capabilities.simulatedTelemetry && s.harnesses.length > 0 && s.harnesses.every((h) => ws.excluded.includes(h));
                return (
                  <AnimatedRow key={s.id}>
                    <ListRow cols={cols} minWidth={colsMin} data-tour="backups-list">
                      <span className="flex min-w-0 items-center gap-2">
                        <Mono className="truncate text-foreground">{s.id}</Mono>
                        {s.first && (
                          <span title={"The state before Canonfig ever wrote.\nCanonfig always keeps it."} className="inline-flex h-4 shrink-0 items-center rounded-[3px] bg-raised px-1 text-xs font-medium text-muted-foreground">
                            First, kept
                          </span>
                        )}
                      </span>
                      <span className="truncate text-sm text-muted-foreground" title={s.harnesses.join(", ")}>
                        {s.harnesses.length > 0 ? namesOf(s.harnesses) : "Not reported"}
                      </span>
                      <span className="text-sm text-muted-foreground tabular-nums">{s.files ?? "Not reported"}</span>
                      <span className="flex justify-end">
                        <Button variant="outline" size="xs" disabled={done || ws.followerLive?.action.loading} title={done ? "Its harnesses are already excluded on this machine." : undefined} onClick={() => setRestoring(s)}>
                          {done ? "Restored" : "Restore…"}
                        </Button>
                      </span>
                    </ListRow>
                  </AnimatedRow>
                );
              })}
            </RowPresence>
            <p className="px-[18px] py-3 text-sm text-pretty text-faint">
              {ws.snapshots.every((snapshot) => snapshot.first !== undefined) && <>{recent} of {RECENT_KEPT} recent {recent === 1 ? "snapshot" : "snapshots"} kept. </>}For files a harness shares with its own state, like{" "}
              <Mono>~/.claude.json</Mono>, a snapshot holds only the keys Canonfig owns, so sign-in data never enters a backup.
            </p>
          </>
        )}
        {ws.followerLive?.operationName === "Restore backup" && <FollowerOperationEvidence />}
      </Body>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={restoring ? `Restore ${restoring.harnesses.length > 0 ? namesOf(restoring.harnesses) : restoring.id}?` : ""}
        body={
          restoring && (
            <>
              Restoring a harness snapshot excludes its harnesses and resources from sync; restoring an import-replacement snapshot backs up and replaces the affected Canonical Folder entries.
              {DEMO && " Simulated in this demo."}
            </>
          )
        }
        confirm="Restore"
        onConfirm={() => restoring && ws.restore(restoring.id)}
      />
    </>
  );
}
