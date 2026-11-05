// The harness list and the takeover backups page, shared by the Source and the Follower. Both read the
// simulated `canonfig harnesses` report and ~/.canonfig/.backups from the workspace; restore is simulated.
import { useRef, useState } from "react";
import { CaretDown } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HARNESS_NAMES, DEMO, SURFACE_CATEGORIES, SURFACE_NAMES, SURFACE_SUPPORT, type Harness, type HarnessId, type Snapshot, type SurfaceCategory } from "@/shared/metadata";
import { Mono, StatusMark, Term, type StatusKind } from "@/shared/shared";
import { useWorkspace } from "./store";
import { AnimatedRow, Body, EmptyState, ListHead, ListRow, PageHeader, RowPresence } from "./kit";
import { ConfirmDialog } from "./settings";

/** What Canonfig does with a harness on this machine, from the three facts `canonfig harnesses` reports. */
function harnessStatus(h: Harness): { kind: StatusKind; label: string; hint: string } {
  if (!h.listed && h.installed) return { kind: "off", label: "Installed, not listed", hint: "Canonfig ignores it until canonfig.jsonc lists it." };
  if (!h.listed) return { kind: "off", label: "Not installed", hint: "Not on this machine and not in the list." };
  if (h.excluded) return { kind: "off", label: "Excluded here", hint: "Listed, but this machine's local/local.jsonc excludes it, so Canonfig leaves it alone." };
  if (!h.installed) return { kind: "warn", label: "Listed, not installed", hint: "Reported as not installed.\nCanonfig takes it over, with a backup, once it's installed." };
  return { kind: "ok", label: "Managed here", hint: "Listed, installed and not excluded, so Canonfig writes the folder into it." };
}

const COLS = "minmax(180px,240px) minmax(170px,1fr) minmax(140px,220px) minmax(150px,220px)";
const COLS_MIN = 180 + 170 + 140 + 150 + 3 * 12 + 20;
const EDIT_COLS = `24px ${COLS}`;
const EDIT_COLS_MIN = COLS_MIN + 24 + 12;
// The Source's list also shows what each listed harness gets (canonfig.jsonc `surfaces`). Its 120px minimum keeps
// the menu button inside a 390px viewport; wider, focusing it would scroll the page sideways and clip the intro.
const LISTED_COLS = "24px minmax(180px,240px) minmax(120px,200px) minmax(170px,1fr) minmax(140px,220px) minmax(150px,220px)";
const LISTED_COLS_MIN = EDIT_COLS_MIN + 120 + 12;

/** "Everything", "Nothing", or the chosen categories by name. */
function surfacesLabel(selected: SurfaceCategory[] | undefined): string {
  if (selected === undefined) return "Everything";
  if (selected.length === 0) return "Nothing";
  return SURFACE_CATEGORIES.filter((c) => selected.includes(c)).map((c) => SURFACE_NAMES[c]).join(", ");
}

/**
 * Which categories a listed harness gets, out of the ones it supports (canonfig.jsonc refuses the rest).
 * Ticking every supported category drops the harness's entry, so the file keeps the default
 * ("everything") rather than a list that would miss a category the harness gains later.
 */
function SurfacesMenu({ harness }: { harness: Harness }) {
  const ws = useWorkspace();
  const supported = SURFACE_SUPPORT[harness.id];
  const selected = ws.surfaces[harness.id];
  const label = surfacesLabel(selected);
  // Radix puts focus back on the trigger when the menu closes, which draws its focus ring even after a
  // mouse click outside. Return focus only when the menu was driven from the keyboard.
  const closedByPointer = useRef(false);
  const change = (next: SurfaceCategory[] | undefined) => {
    ws.setSurfaces((prev) => {
      const { [harness.id]: _dropped, ...rest } = prev;
      return next === undefined ? rest : { ...rest, [harness.id]: next };
    });
    ws.markProfileEdit({ area: "harnesses", id: "harnesses", change: "modified" });
  };
  const toggle = (category: SurfaceCategory, on: boolean) => {
    const current = selected ?? supported;
    const next = on ? [...current, category] : current.filter((c) => c !== category);
    change(next.length === supported.length ? undefined : next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* -ml-[7px] cancels px-1.5 plus the button's 1px border so the label lines up with "Not listed" and the column heading; the hover fill bleeds into the gutter. */}
        <Button variant="ghost" size="sm" className="-ml-[7px] min-w-0 justify-between gap-1 px-1.5 font-normal" title={label} aria-label={`What ${harness.name} gets: ${label}`}>
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
              disabled={!available}
              checked={available && (selected === undefined || selected.includes(category))}
              // Keep the menu open so several categories can be changed in one go.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => toggle(category, on)}
            >
              {SURFACE_NAMES[category]}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={selected === undefined} onSelect={() => change(undefined)}>
          Everything
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Every harness Canonfig supports, as this machine sees it. `edit` puts a checkbox in front of each row:
 * "listed" edits canonfig.jsonc `harnesses` (the Source's Profile), "managed" edits this machine's
 * exclusions in local/local.jsonc (Local settings), where unlisted harnesses have nothing to exclude.
 */
export function HarnessTable({ edit, onToggle }: { edit?: "listed" | "managed"; onToggle?: (id: HarnessId, on: boolean) => void }) {
  const ws = useWorkspace();
  const cols = edit === "listed" ? LISTED_COLS : edit ? EDIT_COLS : COLS;
  const minWidth = edit === "listed" ? LISTED_COLS_MIN : edit ? EDIT_COLS_MIN : COLS_MIN;
  return (
    <>
      <ListHead cols={cols} minWidth={minWidth} data-tour="harness-list">
        {/* A grid cell of its own: an sr-only span is absolutely positioned and would shift the headings left. */}
        {edit && (
          <span>
            <span className="sr-only">{edit === "listed" ? "In the list" : "Managed here"}</span>
          </span>
        )}
        <span>Harness</span>
        {edit === "listed" && <span>Gets</span>}
        <span>On this machine</span>
        <span>Root</span>
        <span>Backup</span>
      </ListHead>
      {ws.harnesses.map((h) => {
        const status = harnessStatus(h);
        const checked = edit === "listed" ? h.listed : !h.excluded;
        const id = `harness-${edit}-${h.id}`;
        return (
          <ListRow key={h.id} cols={cols} minWidth={minWidth} data-tour="harness-list">
            {edit &&
              (edit === "managed" && !h.listed ? (
                <span />
              ) : (
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={edit === "listed" ? !ws.capabilities.profileWrite : !ws.capabilities.followerWrite}
                  aria-label={edit === "listed" ? `List ${h.name}` : `Manage ${h.name} on this machine`}
                  onCheckedChange={(c) => onToggle?.(h.id, !!c)}
                />
              ))}
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
            <Mono className="truncate">{h.root ?? "Not taken over yet"}</Mono>
            <Mono className="truncate">{h.snapshot ?? "None"}</Mono>
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
      <PageHeader crumbs={["Backups"]} />
      <Body>
        <p data-tour="backups-about" className="border-b border-border px-[18px] py-3 text-sm text-pretty text-muted-foreground">
          Before Canonfig first writes to a harness, it copies what that harness had into <Mono className="text-foreground">~/.canonfig/.backups</Mono>. It keeps the first
          snapshot, from before it ever wrote, and the {RECENT_KEPT} most recent; a new one replaces the oldest of those {RECENT_KEPT}. Canonfig calls each one a{" "}
          <Term term="Takeover Snapshot">takeover snapshot</Term>. Snapshots never leave this machine.
        </p>
        {ws.backups === false && (
          <p className="flex items-center gap-2 border-b border-border px-[18px] py-3 text-sm text-pretty text-warn">
            <StatusMark kind="warn" />
            Backups are off on this machine: local/local.jsonc sets "backups": false, so Canonfig takes over a new harness without a snapshot.
          </p>
        )}
        {shown.length === 0 ? (
          <EmptyState title="No backups yet" body="Canonfig takes the first one the first time it writes to a harness on this machine." />
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
                        <Button variant="outline" size="xs" disabled={done} title={done ? "Its harnesses are already excluded on this machine." : undefined} onClick={() => setRestoring(s)}>
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
      </Body>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={restoring ? `Restore ${restoring.harnesses.length > 0 ? namesOf(restoring.harnesses) : restoring.id}?` : ""}
        body={
          restoring && (
            <>
              Canonfig restores snapshot <Mono className="text-foreground">{restoring.id}</Mono> and excludes its restored harnesses from future synchronization. It refuses files that changed since Canonfig last wrote them.
              {DEMO && " This demo changes no files."}
            </>
          )
        }
        confirm="Restore"
        onConfirm={() => restoring && ws.restore(restoring.id)}
      />
    </>
  );
}
