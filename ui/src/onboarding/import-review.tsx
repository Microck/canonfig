import { useMemo, useState, type ReactNode } from "react";
import { CaretRight } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
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
// Harnesses in catalog order, then the shared ~/.agents folder that several harnesses read.
const SOURCE_ORDER: readonly Source[] = [...(Object.keys(HARNESS_NAMES) as HarnessId[]), "agents"];
const sourceName = (source: Source) => source === "agents" ? "Shared skills" : HARNESS_NAMES[source];
/** `env.TOKEN -> fromEnv TOKEN` names the variable after `fromEnv`. */
const variable = (secret: string) => secret.slice(secret.lastIndexOf(" ") + 1);

type RowState = "on" | "off" | "other" | "held";
interface SourceNode { source: Source; categories: { category: Category; offers: ImportOffer[] }[]; skipped: Skip[] }

/**
 * The Import step as a tree: tool, then category, then item. An item is one tool's copy of a target;
 * checking it imports that copy. Targets whose copies differ (collisions) take the tool you check it under,
 * and the other tools show which version is used. Identical copies check together. `choices` maps a target
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
    const sources: SourceNode[] = SOURCE_ORDER.flatMap((source) => {
      const own = offered.filter((offer) => offer.source === source);
      const skipped = data.skipped.filter((skip) => skip.source === source && (source === "agents" || listed.includes(source)));
      if (!own.length && !skipped.length) return [];
      const categories = CATEGORIES.flatMap((category) => {
        const offers = own.filter((offer) => offer.category === category).sort((a, b) => a.name.localeCompare(b.name));
        return offers.length ? [{ category, offers }] : [];
      });
      return [{ source, categories, skipped }];
    });
    return { held, differing, byId, sources };
  }, [data.offers, data.collisions, data.present, data.skipped, listed]);

  const state = (offer: ImportOffer): RowState => {
    if (model.held.has(offer.target)) return "held";
    const pick = choices.get(offer.target);
    if (pick === undefined || !model.byId.has(pick)) return "off";
    return !model.differing.has(offer.target) || pick === offer.id ? "on" : "other";
  };
  const toggle = (offer: ImportOffer, on: boolean) => {
    const next = new Map(choices);
    if (on) next.set(offer.target, offer.id);
    else next.delete(offer.target);
    onChoices(next);
  };
  // Checking a tool or category takes undecided targets only: it never replaces a version picked from another tool.
  const setAll = (offers: readonly ImportOffer[], on: boolean) => {
    const next = new Map(choices);
    for (const offer of offers) {
      const current = state(offer);
      if (on && current === "off") next.set(offer.target, offer.id);
      if (!on && current === "on") next.delete(offer.target);
    }
    onChoices(next);
  };
  // Items held by the folder or using another tool's version are not this group's to take, so they don't count:
  // otherwise a fully taken tool would stay mixed and a click could never clear it.
  const groupValue = (offers: readonly ImportOffer[]) => {
    const takeable = offers.filter((offer) => state(offer) === "on" || state(offer) === "off");
    const on = takeable.filter((offer) => state(offer) === "on").length;
    return on === 0 ? false : on === takeable.length ? true : "indeterminate";
  };
  const selected = [...choices.values()].filter((id) => model.byId.has(id) && !model.held.has(model.byId.get(id)!.target)).length;

  const search = query.trim().toLocaleLowerCase();
  const matches = (offer: ImportOffer) => !search || `${offer.name} ${offer.path}`.toLocaleLowerCase().includes(search);
  const visible = model.sources.flatMap((node) => {
    const categories = node.categories.flatMap(({ category, offers }) => {
      const shown = offers.filter(matches);
      return shown.length ? [{ category, offers: shown }] : [];
    });
    const skipped = node.skipped.filter((skip) => !search || skip.path.toLocaleLowerCase().includes(search));
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
      <Input aria-label="Search imports by name or path" type="search" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1" />
      <span role="status" className="shrink-0 text-sm tabular-nums text-muted-foreground">{selected} selected</span>
    </div>
    <ul aria-label="Import items" className="max-h-[56dvh] overflow-y-auto overscroll-contain rounded-lg border border-border py-1">
      {visible.map((node) => {
        const name = sourceName(node.source);
        const offers = node.categories.flatMap((group) => group.offers);
        const on = offers.filter((offer) => state(offer) === "on").length;
        return <li key={node.source}>
          <Branch depth={0} open={isOpen(node.source)} onFlip={() => flip(node.source)} name={name}
            check={offers.length > 0 && <Checkbox aria-label={`Select everything from ${name}`} checked={groupValue(offers)} onCheckedChange={(value) => setAll(offers, value === true)} />}
            label={<span className="truncate font-medium">{name}</span>}
            count={offers.length ? on ? `${on} of ${offers.length}` : String(offers.length) : "Nothing new"} />
          {isOpen(node.source) && <ul>
            {node.categories.map(({ category, offers: group }) => {
              const key = `${node.source}/${category}`;
              return <li key={category}>
                <Branch depth={1} open={isOpen(key)} onFlip={() => flip(key)} name={`${LABELS[category]} from ${name}`}
                  check={<Checkbox aria-label={`Select ${LABELS[category]} from ${name}`} checked={groupValue(group)} onCheckedChange={(value) => setAll(group, value === true)} />}
                  label={<span>{LABELS[category]}</span>} count={String(group.length)} />
                {isOpen(key) && <ul>{group.map((offer) => <OfferRow key={offer.id} offer={offer} state={state(offer)} chosen={model.byId.get(choices.get(offer.target) ?? "")} differs={model.differing.has(offer.target)} onToggle={(value) => toggle(offer, value)} />)}</ul>}
              </li>;
            })}
            {node.skipped.length > 0 && <li><Skipped skips={node.skipped} /></li>}
          </ul>}
        </li>;
      })}
      {!visible.length && <li className="px-3 py-5 text-sm text-muted-foreground">{model.sources.length ? "No matches." : "Nothing to import from the selected tools."}</li>}
    </ul>
  </section>;
}

const INDENT = ["pl-1", "pl-7", "pl-[4.25rem]"] as const;

/** A tool or category row: disclosure, group checkbox, label and count. */
function Branch({ depth, open, onFlip, name, check, label, count }: {
  depth: 0 | 1; open: boolean; onFlip: () => void; name: string; check: ReactNode; label: ReactNode; count: string;
}) {
  return <div className={cn("flex min-h-10 items-center gap-1 pr-3 pointer-coarse:min-h-11", INDENT[depth])}>
    <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${name}`} onClick={onFlip}
      className="flex size-10 shrink-0 items-center justify-center rounded-md text-faint hover:text-foreground pointer-coarse:size-11">
      <CaretRight className={cn("size-3.5 transition-transform duration-150 ease-snap", open && "rotate-90")} />
    </button>
    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">{check}{label}</label>
    <span className="shrink-0 text-sm tabular-nums text-faint">{count}</span>
  </div>;
}

function OfferRow({ offer, state, chosen, differs, onToggle }: {
  offer: ImportOffer; state: RowState; chosen: ImportOffer | undefined; differs: boolean; onToggle: (on: boolean) => void;
}) {
  const note = state === "held" ? "Already in ~/.canonfig/"
    : state === "other" ? `Using ${sourceName(chosen!.source)}'s`
    : differs ? "Differs in other tools" : null;
  return <li>
    <label title={[offer.path, ...offer.notes].join("\n")}
      className={cn("flex min-h-10 items-center gap-3 rounded-md pr-3 pointer-coarse:min-h-11", INDENT[2], state === "held" ? "cursor-default" : "cursor-pointer hover:bg-raised/50")}>
      <Checkbox aria-label={`${offer.name} from ${sourceName(offer.source)}`} checked={state === "on"} disabled={state === "held"} onCheckedChange={(value) => onToggle(value === true)} />
      <Mono className="min-w-0 flex-1 truncate text-foreground">{offer.name}</Mono>
      {offer.secrets.length > 0 && <span className="shrink-0 text-sm text-faint">Needs <Mono>{offer.secrets.map((secret) => `$${variable(secret)}`).join(", ")}</Mono></span>}
      {note && <span className={cn("shrink-0 text-sm", state === "on" && differs ? "text-warn" : "text-faint")}>{note}</span>}
    </label>
  </li>;
}

/** What one tool has that can't be imported, grouped by reason, closed until asked. */
function Skipped({ skips }: { skips: readonly Skip[] }) {
  const [open, setOpen] = useState(false);
  const reasons = [...new Set(skips.map((skip) => skip.reason))];
  return <>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
      className="flex min-h-10 w-full items-center pr-3 pl-[3.25rem] text-left text-sm text-faint hover:text-muted-foreground pointer-coarse:min-h-11">
      {skips.length} can't be imported
    </button>
    {open && <ul className="space-y-2 pr-3 pb-2 pl-[3.25rem] text-sm">
      {reasons.map((reason) => <li key={reason}>
        <span className="text-muted-foreground">{reason.charAt(0).toUpperCase() + reason.slice(1)}</span>
        <ul>{skips.filter((skip) => skip.reason === reason).map((skip) => <li key={skip.path}><Mono className="text-xs text-faint break-all">{skip.path}</Mono></li>)}</ul>
      </li>)}
    </ul>}
  </>;
}
