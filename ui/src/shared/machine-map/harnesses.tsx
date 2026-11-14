// The body of a machine card that reports its harnesses, drawn after the film's map: the machine's ~/.canonfig/
// folder, branches down to each harness, and one card per harness with its state. Geometry comes from
// machineSize in ./model so the default layout and the rendered card always agree.
import { Folder } from "@/components/icons";
import { Mono, StateLabel, Term } from "@/shared/shared";
import { CATEGORY_LABEL, HARNESS_NAMES, type HarnessId, type HarnessReport, type ItemCategory } from "@/shared/metadata";
import { BRANCH_H, CARD_PAD, FOLDER_CHIPS_H, FOLDER_H, HARNESS_COLS, HARNESS_GAP, HARNESS_H, HARNESS_W } from "./model";

// Official marks at 48px, shown unaltered: several brands forbid recolouring or otherwise changing their logo
// (docs/research/290-map-harnesses/brand-research.md). Harnesses without a mark here show their initial.
const LOGOS = import.meta.glob<string>("./harness-logos/*.png", { eager: true, import: "default" });

export function HarnessLogo({ id }: { id: HarnessId }) {
  const src = LOGOS[`./harness-logos/${id}.png`];
  return (
    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-background">
      {src ? (
        <img src={src} alt="" width={18} height={18} draggable={false} className="size-[18px] object-contain" />
      ) : (
        <span className="text-xs font-semibold text-muted-foreground">{HARNESS_NAMES[id].charAt(0)}</span>
      )}
    </span>
  );
}

function HarnessCard({ harness, self }: { harness: HarnessReport; self: boolean }) {
  const name = HARNESS_NAMES[harness.id];
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-background/40 px-2.5" style={{ width: HARNESS_W, height: HARNESS_H }}>
      <HarnessLogo id={harness.id} />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-medium text-foreground" title={name}>{name}</div>
        {/* StateLabel's text span ellipsizes inside the card; its tooltip carries the full label. */}
        <div className="flex min-w-0 text-xs [&_.text-sm]:min-w-0 [&_.text-sm]:truncate [&_.text-sm]:text-xs [&>span]:max-w-full">
          {harness.state ? <StateLabel state={harness.state} self={self} /> : <span className="text-muted-foreground">Managed</span>}
        </div>
      </div>
    </div>
  );
}

/** Branches from the folder's bottom centre to the top centre of each card in the first harness row. */
function Branches({ width, count }: { width: number; count: number }) {
  const cols = Math.min(Math.max(count, 1), HARNESS_COLS);
  const row = cols * HARNESS_W + (cols - 1) * HARNESS_GAP;
  const start = (width - row) / 2;
  const mid = width / 2;
  const h = BRANCH_H;
  return (
    <svg aria-hidden width={width} height={h} className="block overflow-visible text-border-strong">
      {Array.from({ length: cols }, (_, i) => {
        const x = start + i * (HARNESS_W + HARNESS_GAP) + HARNESS_W / 2;
        return (
          <g key={i} fill="none" stroke="currentColor" strokeWidth={1}>
            <path d={`M ${mid} 0 C ${mid} ${h / 2}, ${x} ${h / 2}, ${x} ${h - 3}`} />
            <path d={`M ${x - 3} ${h - 6} L ${x} ${h - 3} L ${x + 3} ${h - 6}`} />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * `categories` lists what the Canonical Folder holds; only the Source knows it, so only its card shows chips.
 * `self` words each state for this machine, as StateLabel does elsewhere.
 */
export function HarnessBody({ width, harnesses, categories, self }: { width: number; harnesses: readonly HarnessReport[]; categories?: readonly ItemCategory[]; self: boolean }) {
  const inner = width - 2 * CARD_PAD;
  return (
    <div className="border-t border-border" style={{ padding: CARD_PAD }}>
      <div className="rounded-md border border-border bg-background/40 px-3" style={{ height: categories ? FOLDER_CHIPS_H : FOLDER_H }}>
        <div className="flex h-[38px] items-center gap-2">
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <Mono className="text-sm text-foreground">~/.canonfig</Mono>
          {categories && <span className="ml-auto text-xs text-faint"><Term term="Canonical Folder" /></span>}
        </div>
        {categories && (
          <div className="flex gap-1.5 overflow-hidden">
            {categories.map((category) => (
              <span key={category} className="shrink-0 rounded-[4px] border border-border bg-raised px-1.5 text-xs leading-5 text-muted-foreground">
                {CATEGORY_LABEL[category].label}
              </span>
            ))}
          </div>
        )}
      </div>
      <Branches width={inner} count={harnesses.length} />
      <div className="flex flex-wrap justify-center" style={{ gap: HARNESS_GAP }}>
        {harnesses.length === 0 ? (
          <div className="grid place-items-center rounded-md border border-dashed border-border text-sm text-muted-foreground" style={{ width: HARNESS_W, height: HARNESS_H }}>
            No harnesses here
          </div>
        ) : (
          harnesses.map((harness) => <HarnessCard key={harness.id} harness={harness} self={self} />)
        )}
      </div>
    </div>
  );
}
