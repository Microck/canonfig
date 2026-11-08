import { useMemo, useRef, useState } from "react";
import { CaretDown } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HARNESS_NAMES, type HarnessId } from "@/shared/metadata";
import { Mono } from "@/shared/shared";
import { DisclosureTrigger } from "./kit";
import type { ImportOffer, OnboardingData } from "./onboarding";

const CATEGORIES = ["instructions", "rules", "skills", "agents", "commands", "mcp"] as const;
const LABELS = { instructions: "Instructions", rules: "Rules", skills: "Skills", agents: "Agents", commands: "Commands", mcp: "MCP servers" };
const sourceName = (source: ImportOffer["source"]) => source === "agents" ? "Shared skills" : HARNESS_NAMES[source];
const ROW_GRID = "grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 px-3 md:grid-cols-[16px_minmax(0,1fr)_176px_minmax(0,1fr)_160px]";
const IMPORT_ROW = `${ROW_GRID} min-h-10 items-center gap-y-0.5 py-2 hover:bg-raised/50 pointer-coarse:min-h-11 md:py-0`;
const GROUP_ROW = `${ROW_GRID} sticky top-0 z-10 min-h-10 items-center bg-panel pointer-coarse:min-h-11`;

interface ReviewRow {
  target: string;
  offers: readonly ImportOffer[];
  kind: "item" | "candidates" | "folder";
  category: ImportOffer["category"];
}

/** One display model per scan, not one regrouping pass per row or keystroke. */
export function ImportReview({ data, listed, selected, onSelect, allowCredentials, onAllowCredentials }: {
  data: OnboardingData;
  listed: readonly HarnessId[];
  selected: readonly string[];
  onSelect: (ids: string[]) => void;
  allowCredentials: boolean;
  onAllowCredentials: (allow: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [needsChoice, setNeedsChoice] = useState(false);
  const choiceFilter = useRef<HTMLButtonElement>(null);
  const model = useMemo(() => {
    const present = new Set(data.present);
    const offered = data.offers.filter((offer) => offer.harnesses.some((harness) => listed.includes(harness)) && !present.has(offer.id))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const byId = new Map(offered.map((offer) => [offer.id, offer]));
    const colliding = new Set<string>();
    const rows: ReviewRow[] = [];
    for (const collision of data.collisions) {
      const offers = collision.candidates.flatMap(({ id }) => {
        const offer = byId.get(id);
        return offer ? [offer] : [];
      });
      if (!offers.length) continue;
      for (const offer of offers) colliding.add(offer.id);
      rows.push({ target: collision.target, offers, kind: collision.kind, category: offers[0]!.category });
    }
    const identical = new Map<string, ImportOffer[]>();
    for (const offer of offered) {
      if (colliding.has(offer.id)) continue;
      const group = identical.get(offer.target);
      if (group) group.push(offer);
      else identical.set(offer.target, [offer]);
    }
    // The backend lists every different-content target as a collision. Remaining candidates
    // for one target have identical digests; match selectImports by choosing the first sorted id.
    for (const [target, offers] of identical) rows.push({ target, offers, kind: "item", category: offers[0]!.category });
    rows.sort((a, b) => a.offers[0]!.name.localeCompare(b.offers[0]!.name));
    const skipped = new Map<string, OnboardingData["skipped"][number][]>();
    for (const skip of data.skipped) {
      if (skip.source !== "agents" && !listed.includes(skip.source)) continue;
      const group = skipped.get(skip.reason);
      if (group) group.push(skip);
      else skipped.set(skip.reason, [skip]);
    }
    return { rows, offered, skipped: [...skipped], skippedCount: [...skipped.values()].reduce((count, group) => count + group.length, 0) };
  }, [data.offers, data.collisions, data.present, data.skipped, listed]);
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const unresolved = model.rows.filter((row) => row.kind === "candidates" && !row.offers.some((offer) => selectedIds.has(offer.id))).length;
  const selectedCount = model.rows.filter((row) => row.kind !== "folder" && row.offers.some((offer) => selectedIds.has(offer.id))).length;
  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return CATEGORIES.map((id) => ({ id, rows: model.rows.filter((row) => row.category === id
      && (category === "all" || category === id)
      && (!needsChoice || (row.kind === "candidates" && !row.offers.some((offer) => selectedIds.has(offer.id))))
      && (!query || row.offers.some((offer) => `${offer.name} ${offer.path}`.toLocaleLowerCase().includes(query)))) }));
  }, [model.rows, search, category, needsChoice, selectedIds]);
  const visible = groups.flatMap((group) => group.rows);
  const eligible = (rows: readonly ReviewRow[]) => rows.filter((row) => row.kind === "item" && (allowCredentials || !row.offers[0]!.secrets.length));
  // Bulk selection never decides a collision or overrides existing Canonical Folder content.
  const selectRows = (rows: readonly ReviewRow[], checked: boolean) => {
    const selectable = eligible(rows);
    const ids = new Set(selectable.flatMap((row) => row.offers.map((offer) => offer.id)));
    onSelect([...selected.filter((id) => !ids.has(id)), ...(checked ? selectable.map((row) => row.offers[0]!.id) : [])]);
  };
  const missing = listed.filter((harness) => !model.offered.some((offer) => offer.harnesses.includes(harness)));
  const harnessCount = new Set(model.offered.flatMap((offer) => offer.harnesses.filter((harness) => listed.includes(harness)))).size;
  const hasCredentials = model.rows.some((row) => row.kind === "item" ? row.offers[0]!.secrets.length : row.kind === "candidates" && row.offers.some((offer) => offer.secrets.length));

  return <section aria-label="Review imports" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p role="status" className="tabular-nums">{model.rows.length} items from {harnessCount} harnesses · {selectedCount} selected</p>
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => selectRows(visible, true)}>Select all</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => {
          const ids = new Set(visible.flatMap((row) => row.offers.map((offer) => offer.id)));
          onSelect(selected.filter((id) => !ids.has(id)));
        }}>Select none</Button>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label="Search imports" type="search" placeholder="Search name or path…" value={search} onChange={(event) => setSearch(event.target.value)} className="min-w-40 flex-1" />
      <Select value={category} onValueChange={setCategory}>
        <SelectTrigger aria-label="Filter import category" className="min-h-10 w-44 pointer-coarse:min-h-11"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All categories ({model.rows.length})</SelectItem>
          {CATEGORIES.map((id) => <SelectItem key={id} value={id}>{LABELS[id]} ({model.rows.filter((row) => row.category === id).length})</SelectItem>)}
        </SelectContent>
      </Select>
      <Button ref={choiceFilter} type="button" variant={needsChoice ? "outline" : "ghost"} size="sm" aria-pressed={needsChoice} onClick={() => setNeedsChoice(!needsChoice)}>Needs a choice ({unresolved})</Button>
    </div>
    {hasCredentials && <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm text-muted-foreground pointer-coarse:min-h-11">
      <Checkbox checked={allowCredentials} onCheckedChange={(value) => onAllowCredentials(value === true)} />
      Allow literal secrets to be replaced by environment references
    </label>}
    <div aria-label="Import items" className="max-h-[52dvh] scroll-pt-10 overflow-y-auto overscroll-contain rounded-lg border border-border">
      {groups.filter((group) => group.rows.length).map((group) => {
        const selectable = eligible(group.rows);
        const count = selectable.filter((row) => row.offers.some((offer) => selectedIds.has(offer.id))).length;
        return <Collapsible key={group.id} defaultOpen>
          <div className={GROUP_ROW}>
            <label className="flex min-h-10 shrink-0 items-center pointer-coarse:min-h-11">
              <Checkbox aria-label={`Select ${LABELS[group.id]}`} disabled={!selectable.length} checked={count > 0 && count < selectable.length ? "indeterminate" : count > 0} onCheckedChange={(value) => selectRows(group.rows, value === true)} />
            </label>
            <CollapsibleTrigger className="group col-start-2 flex min-h-10 min-w-0 items-center justify-between gap-2 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 md:col-span-4">
              <span>{LABELS[group.id]} <span className="ml-1 text-muted-foreground tabular-nums">{group.rows.length}</span></span>
              <CaretDown className="size-3.5 text-muted-foreground group-data-[state=closed]:-rotate-90" />
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <ul aria-label={LABELS[group.id]}>
              {group.rows.map((row) => {
                const chosen = row.offers.find((item) => selectedIds.has(item.id));
                const offer = row.kind === "item" ? row.offers[0]! : chosen ?? row.offers[0]!;
                const sources = [...new Set(row.offers.map((item) => sourceName(item.source)))].join(", ");
                const paths = [...new Set(row.offers.map((item) => item.path))];
                if (row.kind === "item") return <li key={row.target}>
                  <label className={`${IMPORT_ROW} cursor-pointer`}>
                    <Checkbox className="col-start-1 row-span-3 row-start-1 self-start md:row-span-1 md:self-center"
                      aria-label={`${offer.name} from ${sources}, ${paths.join(", ")}`} checked={!!chosen} disabled={!allowCredentials && !!offer.secrets.length}
                      onCheckedChange={(value) => selectRows([row], value === true)} />
                    <OfferText offer={offer} sources={sources} paths={paths} />
                  </label>
                </li>;
                return <li key={row.target} className={IMPORT_ROW}>
                  <span className="col-start-1 row-span-3 row-start-1 w-4 md:row-span-1" aria-hidden />
                  <OfferText offer={offer} sources={sources} paths={paths} />
                  <div className="col-start-2 row-start-4 mt-1 min-w-0 md:col-start-5 md:row-start-1 md:mt-0">
                    {row.kind === "folder" ? <span className="text-sm text-muted-foreground">Already in Canonical Folder</span> : <Select value={chosen?.id ?? "none"} onValueChange={(value) => {
                      const ids = new Set(row.offers.map((item) => item.id));
                      onSelect([...selected.filter((id) => !ids.has(id)), ...(value === "none" ? [] : [value])]);
                      // A resolved row leaves this filter, so keep keyboard focus in the review.
                      if (needsChoice && value !== "none") requestAnimationFrame(() => choiceFilter.current?.focus());
                    }}>
                      <SelectTrigger aria-label={`Choose source for ${row.target}`} className="min-h-10 w-full text-sm pointer-coarse:min-h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Don't import</SelectItem>
                        {row.offers.map((item) => <SelectItem key={item.id} value={item.id} disabled={!allowCredentials && !!item.secrets.length}>{sourceName(item.source)}</SelectItem>)}
                      </SelectContent>
                    </Select>}
                  </div>
                </li>;
              })}
            </ul>
          </CollapsibleContent>
        </Collapsible>;
      })}
      {!visible.length && <p className="px-3 py-5 text-sm text-muted-foreground">{model.rows.length ? "No items match these filters." : "Nothing to import."}</p>}
    </div>
    <p className="text-sm text-muted-foreground">Copies selected items into <Mono>~/.canonfig/</Mono> once. Nothing is selected by default.{model.rows.some((row) => row.kind === "candidates") && " Choose a source for items with different content."}</p>
    {missing.length > 0 && <p className="text-sm text-muted-foreground">Nothing to import from {missing.map((id) => HARNESS_NAMES[id]).join(", ")}.</p>}
    {model.skippedCount > 0 && <Collapsible>
      <DisclosureTrigger>{model.skippedCount} can't be imported</DisclosureTrigger>
      <CollapsibleContent className="space-y-1 pl-4">
        {model.skipped.map(([reason, skips]) => <Collapsible key={reason}>
          <DisclosureTrigger>{reason.charAt(0).toUpperCase() + reason.slice(1)} ({skips.length})</DisclosureTrigger>
          <CollapsibleContent><ul className="space-y-1 pb-2 pl-4 text-sm text-muted-foreground">
            {skips.map((skip) => <li key={`${skip.source}/${skip.path}`}><Mono>{skip.path}</Mono></li>)}
          </ul></CollapsibleContent>
        </Collapsible>)}
      </CollapsibleContent>
    </Collapsible>}
  </section>;
}

/** Desktop columns share one grid; narrow rows stack their source and path beneath the name. */
function OfferText({ offer, sources, paths }: { offer: ImportOffer; sources: string; paths: readonly string[] }) {
  const notes = [...offer.secrets.map((secret) => `Environment reference: ${secret}`), ...offer.notes].join("; ");
  return <>
    <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-2" title={[offer.name, notes].filter(Boolean).join("\n")}>
      <Mono className="min-w-0 truncate text-foreground">{offer.name}</Mono>
      {notes && <span className="shrink-0 text-sm text-muted-foreground"><span aria-hidden>† </span>{offer.secrets.length ? "Env refs" : "Converted"}<span className="sr-only">: {notes}</span></span>}
    </span>
    <span className="col-start-2 row-start-2 min-w-0 break-words text-sm text-muted-foreground md:col-start-3 md:row-start-1 md:truncate" title={sources}>{sources}</span>
    <span className="col-start-2 row-start-3 flex min-w-0 items-center gap-1 font-mono text-sm text-muted-foreground md:col-start-4 md:row-start-1" title={paths.join("\n")}>
      <span dir="rtl" className="min-w-0 flex-1 truncate text-left"><bdi dir="ltr">{offer.path}</bdi></span>
      {paths.length > 1 && <span className="shrink-0">(+{paths.length - 1})</span>}
    </span>
  </>;
}
