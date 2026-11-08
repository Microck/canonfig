import { useId, useMemo, useState, type ReactNode } from "react";
import { CaretRight } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { HARNESS_NAMES, type HarnessId } from "@/shared/metadata";
import { Mono } from "@/shared/shared";
import { cn } from "cn";
import type { ImportOffer, OnboardingData } from "./onboarding";

type Source = ImportOffer["source"];
type Category = ImportOffer["category"];
type Skip = OnboardingData["skipped"][number];

const CATEGORIES: readonly Category[] = ["instructions", "rules", "skills", "agents", "commands", "mcp"];
const LABELS: Record<Category, string> = { instructions: "Instructions", rules: "Rules", skills: "Skills", agents: "Agents", commands: "Commands", mcp: "MCP servers" };
// Harnesses in catalog order, then the shared skills folder that several harnesses read.
const SOURCE_ORDER: readonly Source[] = [...(Object.keys(HARNESS_NAMES) as HarnessId[]), "agents"];
const sourceName = (source: Source) => source === "agents" ? "Shared skills" : HARNESS_NAMES[source];
/** `env.TOKEN -> fromEnv TOKEN` names the variable after `fromEnv`. */
const variable = (secret: string) => secret.slice(secret.lastIndexOf(" ") + 1);

type RowState = "on" | "off" | "other" | "held";
interface SourceNode {
  source: Source;
  readers: HarnessId[];
  categories: { category: Category; offers: ImportOffer[]; duplicateNames: ReadonlySet<string> }[];
  skipped: Skip[];
}

/**
 * The Import step as a tree: source, then category, then item. An item is one source's copy of a target;
 * checking it imports that copy. Targets whose copies differ (collisions) take the copy you check,
 * and the other copies show which version is used. Identical copies check together. `choices` maps a target
 * to the chosen offer id; an absent target is not imported.
 */
export function ImportReview({ data, listed, choices, onChoices }: {
  data: OnboardingData;
  listed: readonly HarnessId[];
  choices: ReadonlyMap<string, string>;
  onChoices: (next: ReadonlyMap<string, string>) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const model = useMemo(() => {
    const present = new Set(data.present);
    const held = new Set(data.collisions.filter((collision) => collision.kind === "folder").map((collision) => collision.target));
    const differing = new Set(data.collisions.filter((collision) => collision.kind === "candidates").map((collision) => collision.target));
    const offered = data.offers.filter((offer) => offer.harnesses.some((harness) => listed.includes(harness)) && !present.has(offer.id));
    const byId = new Map(offered.map((offer) => [offer.id, offer]));
    const manualCopies = new Set<string>();
    const sources: SourceNode[] = SOURCE_ORDER.flatMap((source) => {
      const own = offered.filter((offer) => offer.source === source);
      const skipped = data.skipped.filter((skip) => skip.source === source && (source === "agents" || listed.includes(source)));
      if (!own.length && !skipped.length) return [];
      const categories = CATEGORIES.flatMap((category) => {
        const offers = own.filter((offer) => offer.category === category).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
        if (!offers.length) return [];
        const names = new Set<string>();
        const duplicateNames = new Set<string>();
        for (const offer of offers) {
          if (names.has(offer.name)) duplicateNames.add(offer.name);
          names.add(offer.name);
        }
        for (const offer of offers) {
          if (duplicateNames.has(offer.name) && differing.has(offer.target)) manualCopies.add(offer.id);
        }
        return [{ category, offers, duplicateNames }];
      });
      const readers = source === "agents" ? listed.filter((harness) => own.some((offer) => offer.harnesses.includes(harness))) : [];
      return [{ source, readers, categories, skipped }];
    });
    return { held, differing, byId, sources, manualCopies };
  }, [data.offers, data.collisions, data.present, data.skipped, listed]);

  const state = (offer: ImportOffer): RowState => {
    if (model.held.has(offer.target)) return "held";
    const pick = choices.get(offer.target);
    if (pick === undefined) return "off";
    if (pick === offer.id || (model.byId.has(pick) && !model.differing.has(offer.target))) return "on";
    // A different version, or a choice retained from a tool that is unlisted right now.
    return "other";
  };
  const toggle = (offer: ImportOffer, on: boolean) => {
    const next = new Map(choices);
    if (on) next.set(offer.target, offer.id);
    else next.delete(offer.target);
    onChoices(next);
  };
  // Bulk selection never replaces a picked version or guesses between competing copies within one tool.
  // MCP servers needing variables also require their own row's consent.
  const automatic = (offer: ImportOffer) => !offer.secrets.length && !model.manualCopies.has(offer.id);
  const bulk = (offer: ImportOffer) => state(offer) === "on" || (state(offer) === "off" && automatic(offer));
  const setAll = (offers: readonly ImportOffer[], on: boolean) => {
    const next = new Map(choices);
    for (const offer of offers) {
      const current = state(offer);
      if (on && current === "off" && automatic(offer)) next.set(offer.target, offer.id);
      if (!on && current === "on") next.delete(offer.target);
    }
    onChoices(next);
  };
  // Only rows a group click can change count, so a fully taken group shows checked and the next click clears it.
  const groupValue = (offers: readonly ImportOffer[]) => {
    const takeable = offers.filter(bulk);
    const on = takeable.filter((offer) => state(offer) === "on").length;
    return on === 0 ? false : on === takeable.length ? true : "indeterminate";
  };
  const selected = [...choices.values()].filter((id) => model.byId.has(id) && !model.held.has(model.byId.get(id)!.target)).length;

  const search = query.trim().toLocaleLowerCase();
  const includes = (text: string) => text.toLocaleLowerCase().includes(search);
  const visible = model.sources.flatMap((node) => {
    const sourceMatches = includes(`${sourceName(node.source)} ${node.source === "agents" ? "~/.agents/skills" : ""}`);
    const categories = node.categories.flatMap((group) => {
      const offers = group.offers.filter((offer) => {
        if (sourceMatches) return true;
        const readers = node.source === "agents" ? node.readers.filter((reader) => offer.harnesses.includes(reader)).map((reader) => HARNESS_NAMES[reader]).join(" ") : "";
        return includes(`${offer.name} ${offer.path} ${readers}`);
      });
      return offers.length ? [{ ...group, offers }] : [];
    });
    const skipped = node.skipped.filter((skip) => sourceMatches || includes(skip.path));
    return categories.length || skipped.length ? [{ ...node, categories, skipped }] : [];
  });
  // Searching opens every branch with a match, so a hit is never hidden behind a collapsed tool.
  const isOpen = (key: string) => !!search || open.has(key);
  const flip = (key: string) => setOpen((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return <section aria-label="Review imports" className="space-y-3">
    <div className="flex items-center gap-3">
      <Input aria-label="Search imports by name, path or tool" type="search" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1" />
      <span role="status" className="shrink-0 text-sm tabular-nums text-muted-foreground">{selected} selected</span>
    </div>
    <ul aria-label="Import items" className="max-h-[56dvh] overflow-y-auto overscroll-contain rounded-lg border border-border py-1">
      {visible.map((node) => {
        const name = sourceName(node.source);
        const offers = node.categories.flatMap((group) => group.offers);
        const on = offers.filter((offer) => state(offer) === "on").length;
        return <Collapsible key={node.source} asChild open={isOpen(node.source)} onOpenChange={() => flip(node.source)}><li>
          <Branch depth={0} open={isOpen(node.source)} name={name}
            check={offers.length > 0 && <Checkbox aria-label={`Select everything from ${name}`} checked={groupValue(offers)} onCheckedChange={(value) => setAll(offers, value === true)} />}
            label={node.source === "agents" ? <span className="min-w-0 py-1">
              <span className="block font-medium">{name}</span>
              <Mono className="block text-faint">~/.agents/skills</Mono>
            </span> : <span className="truncate font-medium">{name}</span>}
            count={offers.length ? on ? `${on} of ${offers.length}` : String(offers.length) : "Nothing new"} />
          <CollapsibleContent asChild><ul>
            {node.categories.map(({ category, offers: group, duplicateNames }) => {
              const key = `${node.source}/${category}`;
              return <Collapsible key={category} asChild open={isOpen(key)} onOpenChange={() => flip(key)}><li>
                <Branch depth={1} open={isOpen(key)} name={`${LABELS[category]} from ${name}`}
                  check={<Checkbox aria-label={`Select ${LABELS[category]} from ${name}`} checked={groupValue(group)} onCheckedChange={(value) => setAll(group, value === true)} />}
                  label={<span className="min-w-0 py-1">
                    <span className="block">{LABELS[category]}</span>
                    {node.source === "agents" && node.readers.length > 0 && <span className="block text-sm text-faint">Read by {node.readers.map((reader) => HARNESS_NAMES[reader]).join(", ")}</span>}
                  </span>} count={String(group.length)} />
                <CollapsibleContent asChild><ul>{group.map((offer) => {
                  const chosen = choices.get(offer.target);
                  const readers = node.source === "agents" ? node.readers.filter((reader) => offer.harnesses.includes(reader)) : undefined;
                  return <OfferRow key={offer.id} offer={offer} state={state(offer)} chosen={chosen} chosenOffer={model.byId.get(chosen ?? "")} differs={model.differing.has(offer.target)} showPath={duplicateNames.has(offer.name)}
                    readers={readers && readers.length < node.readers.length ? readers : undefined}
                    onToggle={(value) => toggle(offer, value)} />;
                })}</ul></CollapsibleContent>
              </li></Collapsible>;
            })}
            {node.skipped.length > 0 && <li><Skipped skips={node.skipped} searching={!!search} /></li>}
          </ul></CollapsibleContent>
        </li></Collapsible>;
      })}
      {!visible.length && <li className="px-3 py-5 text-sm text-muted-foreground">{model.sources.length ? "No matches." : "Nothing to import from the selected tools."}</li>}
    </ul>
  </section>;
}

const INDENT = ["pl-1", "pl-7", "pl-[4.25rem]"] as const;

/** A tool or category row: disclosure, group checkbox, label and count. */
function Branch({ depth, open, name, check, label, count }: {
  depth: 0 | 1; open: boolean; name: string; check: ReactNode; label: ReactNode; count: string;
}) {
  return <div className={cn("flex min-h-10 items-center gap-1 pr-3 pointer-coarse:min-h-11", INDENT[depth])}>
    <CollapsibleTrigger asChild><button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
      className="flex size-10 shrink-0 items-center justify-center rounded-md text-faint hover:text-foreground pointer-coarse:size-11">
      <CaretRight className={cn("size-3.5 transition-transform duration-150 ease-snap", open && "rotate-90")} />
    </button></CollapsibleTrigger>
    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">{check}{label}</label>
    <span className="shrink-0 text-sm tabular-nums text-faint">{count}</span>
  </div>;
}

/** One source's copy of a target. Only ambiguous names need a visible path. */
function OfferRow({ offer, state, chosen, chosenOffer, differs, showPath, readers, onToggle }: {
  offer: ImportOffer; state: RowState; chosen: string | undefined; chosenOffer: ImportOffer | undefined;
  differs: boolean; showPath: boolean; readers: readonly HarnessId[] | undefined; onToggle: (on: boolean) => void;
}) {
  const describedBy = useId();
  // Only the source/ prefix is meaningful; the rest of an offer id is opaque.
  const chosenTool = chosen && sourceName(chosen.slice(0, chosen.indexOf("/")) as Source);
  let status: string | null = null;
  if (state === "held") status = "Already in ~/.canonfig/";
  else if (state === "other") {
    if (!chosenOffer) status = `Chosen from ${chosenTool}, which isn't listed`;
    else if (chosenOffer.source === offer.source || chosenOffer.source === "agents") status = `Using ${chosenOffer.path}`;
    else status = `Using ${chosenTool}'s`;
  } else if (differs) status = "Differs in other copies";
  const details = [
    ...(readers ? [`Read by ${readers.map((reader) => HARNESS_NAMES[reader]).join(", ")}`] : []),
    ...(offer.secrets.length ? [`Needs ${offer.secrets.map((secret) => `$${variable(secret)}`).join(", ")}`] : []),
    ...(status ? [status] : []),
    ...offer.notes,
  ];
  return <li>
    <label title={offer.path}
      className={cn("flex min-h-10 items-start gap-3 rounded-md py-2.5 pr-3 pointer-coarse:min-h-11", INDENT[2], state === "held" ? "cursor-default" : "cursor-pointer hover:bg-raised/50")}>
      <Checkbox aria-label={`${offer.name} from ${sourceName(offer.source)}${showPath ? ` at ${offer.path}` : ""}`} aria-describedby={details.length ? describedBy : undefined}
        checked={state === "on"} disabled={state === "held"} onCheckedChange={(value) => onToggle(value === true)} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <Mono className="block break-all text-foreground">{offer.name}</Mono>
        {showPath && <Mono className="mt-0.5 block break-all text-xs text-faint">{offer.path}</Mono>}
        {details.length > 0 && <span id={describedBy} className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-faint">
          {details.map((detail) => <span key={detail} className={cn(detail === status && state === "on" && differs && "text-warn")}>{detail}</span>)}
        </span>}
      </span>
    </label>
  </li>;
}

/** What one tool has that can't be imported, grouped by reason. Closed until asked, open while a search matches it. */
function Skipped({ skips, searching }: { skips: readonly Skip[]; searching: boolean }) {
  const [opened, setOpened] = useState(false);
  const open = searching || opened;
  const reasons = [...new Set(skips.map((skip) => skip.reason))];
  return <Collapsible open={open} onOpenChange={setOpened}>
    <CollapsibleTrigger asChild><button type="button"
      className="flex min-h-10 w-full items-center pr-3 pl-[3.25rem] text-left text-sm text-faint hover:text-muted-foreground pointer-coarse:min-h-11">
      {skips.length} can't be imported
    </button></CollapsibleTrigger>
    <CollapsibleContent asChild><ul className="space-y-2 pr-3 pb-2 pl-[3.25rem] text-sm">
      {reasons.map((reason) => <li key={reason}>
        <span className="text-muted-foreground">{reason.charAt(0).toUpperCase() + reason.slice(1)}</span>
        <ul>{skips.filter((skip) => skip.reason === reason).map((skip) => <li key={skip.path}><Mono className="text-xs text-faint break-all">{skip.path}</Mono></li>)}</ul>
      </li>)}
    </ul></CollapsibleContent>
  </Collapsible>;
}
