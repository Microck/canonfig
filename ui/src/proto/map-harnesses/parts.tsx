import type { CSSProperties, ReactNode } from "react";
import { Handle, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import { Desktop, Folder, Laptop } from "@/components/icons";
import { StatusMark } from "@/shared/shared";
import { cn } from "@/lib/utils";
import { states, summary, type Harness, type Machine } from "./fixtures";
import { useActions } from "./actions";
import { fillStyle } from "@/lib/dither";
import geminiMonochrome from "./logos/gemini-monochrome.svg";

// Asset colours are identity, never status. Neutral entries have no selected chromatic accent.
// Provenance and restrictions: docs/research/290-map-harnesses/brand-research.md.
const brands: Record<string, string> = {
  "claude-code": "oklch(0.672 0.131 38.8)",
  codex: "oklch(1 0 0)",
  cursor: "oklch(0.944 0.001 17.2)",
  opencode: "oklch(0.949 0 0)",
  "copilot-cli": "oklch(1 0 0)",
  amp: "oklch(0.469 0.047 129.6)",
  "factory-droid": "oklch(1 0 0)",
  "grok-build": "oklch(1 0 0)",
  "oh-my-pi": "oklch(0.705 0.187 47.6)",
  pi: "oklch(0.751 0.119 29)",
  kimi: "oklch(1 0 0)",
  qwen: "oklch(0.479 0.295 264.6)",
  gemini: "oklch(1 0 0)",
};
function brandStyle(id: string): CSSProperties {
  return { "--brand": brands[id], "--brand-ink": id === "amp" || id === "qwen" ? "oklch(1 0 0)" : "oklch(0 0 0)" } as CSSProperties;
}

const glyphDither = fillStyle("gradient", { color: "var(--foreground)", cell: 1, edge: "bottom", length: 18, from: 1, to: 0.375 });
const cardDither = fillStyle("gradient", { color: "var(--brand)", cell: 1.5, edge: "bottom", length: 32, from: 0.5, to: 0 });

export type MapNode = Node<{ machine: Machine; expanded: boolean }, "machine">;
export type MapNodeProps = NodeProps<MapNode>;
const logoFiles = import.meta.glob<string>("./logos/*.png", { eager: true, import: "default" });
// Gemini's colour icon has an opaque backdrop; its supplied monochrome asset preserves the glyph.
const logoMasks: Record<string, string> = { ...logoFiles, "./logos/gemini.png": geminiMonochrome };

export function HarnessLogo({ harness }: { harness: Harness }) {
  const file = `./logos/${harness.logo}.png`;
  const src = logoFiles[file];
  const mask = { maskImage: `url("${logoMasks[file]}")`, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center" };
  return <span aria-hidden="true" className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border border-border-strong bg-raised" style={brandStyle(harness.id)}>
    <span style={{ display: "var(--logo-original, block)" }}><img src={src} width={22} height={22} alt="" className="size-5.5 object-contain" /></span>
    <span className="size-5.5" style={{ ...mask, display: "var(--logo-mono, none)", backgroundColor: "var(--foreground)" }} />
    <span className="relative size-5.5" style={{ ...mask, display: "var(--logo-dither, none)" }}><span className="absolute inset-0" style={glyphDither} /></span>
    <span className="absolute inset-0 place-items-center" style={{ display: "var(--logo-tile, none)", backgroundColor: "var(--brand)" }}>
      <span className="size-5.5" style={{ ...mask, backgroundColor: "var(--brand-ink)" }} />
    </span>
  </span>;
}
export function MachineHeader({ machine, expanded }: { machine: Machine; expanded?: boolean }) {
  const { select } = useActions();
  const distant = useStore(state => state.transform[2] < 0.55);
  const Icon = machine.platform === "macOS" ? Laptop : Desktop;
  return <button type="button" className={cn("nodrag nopan flex w-full items-center rounded-t-xl text-left hover:bg-raised focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2", distant ? "h-full gap-5 px-5 text-[42px]" : "h-[76px] gap-3 border-b border-border px-4")} onClick={() => select(machine.id)} onFocus={() => select(machine.id)} aria-label={`Inspect ${machine.name}, ${summary(machine).label}`} aria-expanded={expanded}>
    {distant ? <><span className="shrink-0 [&_svg]:size-12"><StatusMark kind={summary(machine).kind} /></span><bdi className="min-w-0 truncate font-semibold">{machine.name}</bdi></> : <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-raised text-muted-foreground"><Icon className="size-5" /></span>
      <span className="min-w-0 flex-1"><bdi className="block truncate font-semibold">{machine.name}</bdi><span className="block truncate text-sm text-muted-foreground">{machine.platform} · {machine.purpose}</span></span>
      {machine.source && <span className="shrink-0 text-xs text-muted-foreground">Source</span>}
    </>}
  </button>;
}
export function Frame({ machine, selected, children }: { machine: Machine; selected?: boolean; children: ReactNode }) {
  return <article className={cn("pointer-events-auto h-full overflow-visible rounded-xl border bg-panel text-foreground", selected ? "border-ring" : "border-border-strong")} aria-label={`${machine.name} machine`}>
    {!machine.source && <Handle type="target" position={Position.Top} className="invisible" />}
    {children}
    {machine.source && <Handle type="source" position={Position.Bottom} className="invisible" />}
  </article>;
}
export function CompactInventory({ machine }: { machine: Machine }) {
  const distant = useStore(state => state.transform[2] < 0.55);
  if (distant) return null;
  const status = summary(machine);
  return <div className="flex h-[66px] items-center gap-3 px-4">
    <div className="flex -space-x-2" aria-hidden="true">{machine.harnesses.slice(0, 3).map(h => <HarnessLogo key={h.id} harness={h} />)}</div>
    <div className="min-w-0"><p className="flex items-center gap-1.5 text-sm"><StatusMark kind={status.kind} />{status.label}</p><p className="text-xs text-muted-foreground">{machine.report === "missing" ? "Inventory unavailable" : `${machine.harnesses.length} harnesses`} · inspect</p></div>
  </div>;
}
export function HarnessCard({ machine, harness, row = false }: { machine: Machine; harness: Harness; row?: boolean }) {
  const { inspect } = useActions();
  const status = states[harness.state];
  const stale = machine.report === "stale";
  return <button type="button" data-harness={harness.id} className={cn("nodrag nopan relative flex min-h-[70px] min-w-0 items-center gap-2.5 overflow-hidden px-3 text-left hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2", row ? "w-full border-b border-border" : "rounded-lg border border-border-strong bg-raised")} style={{ ...brandStyle(harness.id), backgroundColor: "color-mix(in oklab, var(--brand) var(--harness-tint, 0%), var(--raised))", borderColor: "color-mix(in oklab, var(--brand) var(--harness-border-tint, 0%), var(--border-strong))" }} aria-label={`${harness.name} on ${machine.name}: ${stale ? "last reported " : ""}${status.label}. View evidence`} onClick={event => inspect(machine, harness, event.currentTarget)}>
    <span aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ ...cardDither, display: "var(--card-dither, none)", opacity: "var(--tint-opacity, 0.18)" }} />
    <HarnessLogo harness={harness} />
    <span className="relative min-w-0 flex-1 rounded-sm px-1" style={{ backgroundColor: "var(--harness-label-fill, transparent)" }}><span className={cn("block font-medium", row ? "[overflow-wrap:anywhere]" : "truncate")}>{harness.name}</span><span data-harness-state={harness.state} className={cn("mt-0.5 flex w-fit items-center gap-1.5 rounded-sm bg-black px-1 text-sm", stale ? "text-muted-foreground" : status.text)}><StatusMark kind={stale ? "offline" : status.kind} />{stale ? "Last: " : ""}{status.label}</span></span>
  </button>;
}
export function CanonicalFolder({ source = false }: { source?: boolean }) {
  return <div className="rounded-lg border border-border-strong bg-raised px-3 py-2.5">
    <div className="flex items-center gap-2"><Folder className="size-5 shrink-0 text-muted-foreground" /><code className="font-mono text-base">~/.canonfig</code>{source && <span className="ml-auto text-xs text-muted-foreground">Canonical Folder</span>}</div>
    {source && <div className="mt-2 flex flex-wrap gap-1">{["Skills", "MCP servers", "Rules", "Hooks", "Commands", "Subagents"].map(name => <span key={name} className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs">{name}</span>)}</div>}
  </div>;
}
export function EmptyInventory({ machine }: { machine: Machine }) {
  return <p className="px-3 py-6 text-sm text-muted-foreground">{machine.report === "missing" ? "This machine has not reported its harness inventory. Its installed harnesses are unknown." : "No harnesses detected in this report. Install a supported harness on this machine, then synchronize."}</p>;
}
export function ExpandedInventory({ machine }: { machine: Machine }) {
  const count = Math.min(3, machine.harnesses.length);
  return <div className="px-5 pb-5 pt-5">
    <CanonicalFolder source={machine.source} />
    {count > 0 ? <>
      <svg aria-hidden="true" viewBox="0 0 540 48" preserveAspectRatio="none" className="pointer-events-none h-12 w-full text-border-strong" fill="none" stroke="currentColor" strokeWidth="1.5">
        {Array.from({ length: count }, (_, i) => { const x = 540 * (i + 0.5) / count; return <path key={i} d={`M270 0 C270 24 ${x} 22 ${x} 44 m-4 -5 4 5 4 -5`} />; })}
      </svg>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>{machine.harnesses.map(h => <HarnessCard key={h.id} machine={machine} harness={h} />)}</div>
    </> : <EmptyInventory machine={machine} />}
    <p className="mt-3 text-xs text-muted-foreground">{machine.report === "stale" ? "Last report 3 days ago. Current state unknown." : machine.report === "missing" ? "No observation received" : "Checked 2 min ago"} · Client loaded: not verified</p>
  </div>;
}
export function Inspector({ machine }: { machine: Machine }) {
  return <aside aria-label={`Harnesses on ${machine.name}`} className="max-h-[min(72vh,840px)] min-w-0 overflow-y-auto border-border bg-panel p-5 @min-[760px]:w-[360px] @min-[760px]:shrink-0 @min-[760px]:border-l">
    <h2 className="font-mono text-lg [overflow-wrap:anywhere]">{machine.name}</h2>
    <p className="mb-5 mt-1 flex items-center gap-2 text-sm text-muted-foreground"><StatusMark kind={summary(machine).kind} />{summary(machine).label}</p>
    <CanonicalFolder source={machine.source} />
    <h3 className="mb-1 mt-6 font-semibold">Harnesses <span className="ml-1 font-mono text-muted-foreground">{machine.report === "missing" ? "unknown" : machine.harnesses.length}</span></h3>
    {machine.harnesses.length ? machine.harnesses.map(h => <HarnessCard key={h.id} machine={machine} harness={h} row />) : <EmptyInventory machine={machine} />}
    <p className="mt-5 text-xs text-muted-foreground">{machine.report === "stale" ? "Last report 3 days ago. Current state unknown." : machine.report === "missing" ? "No observation received." : "Checked 2 min ago."} Client loaded: not verified.</p>
  </aside>;
}
