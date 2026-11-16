// The harness list shares the active workspace's harness reports.
import { useRef, useState } from "react";
import { CaretDown } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SURFACE_CATEGORIES, SURFACE_NAMES, SURFACE_SUPPORT, type Harness, type HarnessId, type SurfaceCategory } from "@/shared/metadata";
import { Mono, StatusMark, type StatusKind } from "@/shared/shared";
import { useWorkspace } from "./store";
import { ListHead, ListRow } from "./kit";

/** What Canonfig does with a harness on this machine, from the three facts `canonfig harnesses` reports. */
function harnessStatus(h: Harness): { kind: StatusKind; label: string; hint: string } {
  if (!h.listed && h.installed) return { kind: "off", label: "Installed, not listed", hint: "Canonfig ignores it until canonfig.jsonc lists it." };
  if (!h.listed) return { kind: "off", label: "Not installed", hint: "Not on this machine and not in the list." };
  if (h.excluded) return { kind: "off", label: "Excluded here", hint: "Listed, but this machine's local/local.jsonc excludes it, so Canonfig leaves it alone." };
  if (!h.installed) return { kind: "warn", label: "Listed, not installed", hint: "Reported as not installed.\nCanonfig backs it up and starts syncing into it once it's installed." };
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
                  disabled={edit === "listed" ? !ws.capabilities.profileWrite || ws.profileLive?.busy : !ws.capabilities.followerWrite}
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
            {/* Later syncs refuse any folder other than the recorded root. */}
            {h.root ? <Mono className="truncate">{h.root}</Mono>
              : <span className="truncate text-sm text-faint" title="Canonfig records this harness's folder the first time a sync writes into it.">Not synced here yet</span>}
            <Mono className="truncate">{h.snapshot ?? "None"}</Mono>
          </ListRow>
        );
      })}
    </>
  );
}
