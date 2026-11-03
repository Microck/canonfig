// The harness list and the takeover backups page, shared by the Source and the Follower. Both read the
// simulated `canonfig harnesses` report and ~/.canonfig/.backups from the workspace; restore is simulated.
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { HARNESS_NAMES, DEMO, type Harness, type HarnessId, type Snapshot } from "@/shared/data";
import { Mono, StatusMark, Term, type StatusKind } from "@/shared/shared";
import { useWorkspace } from "./store";
import { AnimatedRow, Body, EmptyState, ListHead, ListRow, PageHeader, RowPresence } from "./kit";
import { ConfirmDialog } from "./settings";

/** What Canonfig does with a harness on this machine, from the three facts `canonfig harnesses` reports. */
function harnessStatus(h: Harness): { kind: StatusKind; label: string; hint: string } {
  if (!h.listed && h.installed) return { kind: "off", label: "Installed, not listed", hint: "Canonfig ignores it until canonfig.jsonc lists it." };
  if (!h.listed) return { kind: "off", label: "Not installed", hint: "Not on this machine and not in the list." };
  if (h.excluded) return { kind: "off", label: "Excluded here", hint: "Listed, but this machine's local/local.jsonc excludes it, so Canonfig leaves it alone." };
  if (!h.installed) return { kind: "warn", label: "Listed, not installed", hint: "Reported as not installed. Canonfig takes it over, with a backup, once it's installed." };
  return { kind: "ok", label: "Managed here", hint: "Listed, installed and not excluded, so Canonfig writes the folder into it." };
}

const COLS = "minmax(180px,240px) minmax(170px,1fr) minmax(140px,220px) minmax(150px,220px)";
const COLS_MIN = 180 + 170 + 140 + 150 + 3 * 12 + 20;
const EDIT_COLS = `24px ${COLS}`;
const EDIT_COLS_MIN = COLS_MIN + 24 + 12;

/**
 * Every harness Canonfig supports, as this machine sees it. `edit` puts a checkbox in front of each row:
 * "listed" edits canonfig.jsonc `harnesses` (the Source's Profile), "managed" edits this machine's
 * exclusions in local/local.jsonc (Local settings), where unlisted harnesses have nothing to exclude.
 */
export function HarnessTable({ edit, onToggle }: { edit?: "listed" | "managed"; onToggle?: (id: HarnessId, on: boolean) => void }) {
  const ws = useWorkspace();
  const cols = edit ? EDIT_COLS : COLS;
  const minWidth = edit ? EDIT_COLS_MIN : COLS_MIN;
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
                  aria-label={edit === "listed" ? `List ${h.name}` : `Manage ${h.name} on this machine`}
                  onCheckedChange={(c) => onToggle?.(h.id, !!c)}
                />
              ))}
            <span className="grid min-w-0">
              <span className="truncate font-medium">{h.name}</span>
              <Mono className="truncate text-faint">{h.id}</Mono>
            </span>
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
  const recent = ws.snapshots.filter((s) => !s.first).length;
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
        {!ws.backups && (
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
                const done = s.harnesses.every((h) => ws.excluded.includes(h));
                return (
                  <AnimatedRow key={s.id}>
                    <ListRow cols={cols} minWidth={colsMin} data-tour="backups-list">
                      <span className="flex min-w-0 items-center gap-2">
                        <Mono className="truncate text-foreground">{s.id}</Mono>
                        {s.first && (
                          <span title="The state before Canonfig ever wrote. Canonfig always keeps it." className="inline-flex h-4 shrink-0 items-center rounded-[3px] bg-raised px-1 text-xs font-medium text-muted-foreground">
                            First, kept
                          </span>
                        )}
                      </span>
                      <span className="truncate text-sm text-muted-foreground" title={s.harnesses.join(", ")}>
                        {namesOf(s.harnesses)}
                      </span>
                      <span className="text-sm text-muted-foreground tabular-nums">{s.files}</span>
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
              {recent} of {RECENT_KEPT} recent {recent === 1 ? "snapshot" : "snapshots"} kept. For files a harness shares with its own state, like{" "}
              <Mono>~/.claude.json</Mono>, a snapshot holds only the keys Canonfig owns, so sign-in data never enters a backup.
            </p>
          </>
        )}
      </Body>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={restoring ? `Restore ${namesOf(restoring.harnesses)}?` : ""}
        body={
          restoring && (
            <>
              Canonfig writes snapshot <Mono className="text-foreground">{restoring.id}</Mono> back as a recorded update, removing files it added where the harness had none, and excludes{" "}
              {namesOf(restoring.harnesses)} on this machine in <Mono className="text-foreground">~/.canonfig/local/local.jsonc</Mono>, so the next sync leaves{" "}
              {restoring.harnesses.length === 1 ? "it" : "them"} alone. It refuses a file that changed since Canonfig last wrote it and changes nothing.
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
