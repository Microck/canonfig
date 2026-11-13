import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type ReactFlowInstance, type Viewport as FlowViewport } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { StatusMark } from "@/shared/shared";
import { HarnessLogo, Inspector, type MapNode } from "./parts";
import { Actions } from "./actions";
import { expandedSize, states, summary, type Harness, type Machine, type Mode } from "./fixtures";
import { FilmNode } from "./film";
import { FocusNode } from "./focus";
import { RailNode } from "./rail";

const nodeTypes = { film: { machine: FilmNode }, focus: { machine: FocusNode }, rail: { machine: RailNode } };
const buttonSize = "min-h-10 min-w-10 pointer-coarse:min-h-11 pointer-coarse:min-w-11";
function layout(machines: Machine[], mode: Mode, selected: string | null) {
  const expanded = machines.map(machine => mode !== "rail" && (machine.id === selected || mode === "film" && machines.length <= 13));
  const sizes = machines.map((machine, index) => expanded[index] ? expandedSize(machine) : { width: 302, height: 142 });
  const columns = machines.length <= 4 ? Math.max(1, machines.length - 1) : Math.ceil(Math.sqrt(machines.length - 1));
  const cell = Math.max(302, ...sizes.slice(1).map(size => size.width)) + 64;
  const span = Math.min(columns, machines.length - 1) * cell;
  let y = sizes[0].height + 100;
  const nodes: MapNode[] = machines.map((machine, index) => {
    const rowIndex = (index - 1) % columns;
    if (index > 1 && rowIndex === 0) y += Math.max(...sizes.slice(index - columns, index).map(size => size.height)) + 88;
    return { id: machine.id, type: "machine", position: { x: index === 0 ? (span - sizes[0].width) / 2 : rowIndex * cell + (cell - sizes[index].width) / 2, y: index === 0 ? 0 : y }, ...sizes[index], style: sizes[index], selected: machine.id === selected, data: { machine, expanded: expanded[index] } };
  });
  const edges: Edge[] = machines.slice(1).map(machine => ({ id: machine.id, source: machines[0].id, target: machine.id, type: "default", style: { stroke: "var(--border-strong)", strokeWidth: 1.5 } }));
  return { nodes, edges };
}

function Viewport({ selected, nodes }: { selected: string | null; nodes: MapNode[] }) {
  const { fitView, viewportInitialized } = useReactFlow<MapNode>();
  // Fixed node dimensions let the camera fit before offscreen nodes mount.
  useEffect(() => {
    if (!viewportInitialized) return;
    void fitView({ nodes: selected ? [{ id: selected }] : undefined, padding: selected ? 0.2 : 0.12, minZoom: 0.025, maxZoom: selected ? 1 : 0.95, duration: 0 });
  }, [viewportInitialized, selected, nodes, fitView]);
  return null;
}

type PanMeasurement = { samples: number[]; median: number; p95: number; max: number; over33ms: number };
async function measurePan(setViewport: ReactFlowInstance["setViewport"], start: FlowViewport): Promise<PanMeasurement> {
  const intervals: number[] = [];
  let previous = 0;
  // Real React Flow viewport updates, not a transform written around its state.
  for (let frame = 0; frame <= 180; frame++) {
    const { promise, resolve } = Promise.withResolvers<number>();
    requestAnimationFrame(resolve);
    const now = await promise;
    if (previous) intervals.push(now - previous);
    previous = now;
    void setViewport({ ...start, x: start.x + Math.sin(frame / 20) * 90, y: start.y + Math.cos(frame / 20) * 45 });
  }
  await setViewport(start);
  const sorted = [...intervals].sort((a, b) => a - b);
  return { samples: intervals, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1], over33ms: intervals.filter(n => n > 33.34).length };
}

function Experience({ mode, machines, embedded = false }: { mode: Mode; machines: Machine[]; embedded?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState("map");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [evidence, setEvidence] = useState<{ machine: Machine; harness: Harness } | null>(null);
  const evidenceTrigger = useRef<HTMLButtonElement | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [benchmark, setBenchmark] = useState<PanMeasurement | null>(null);
  const { fitView, zoomIn, zoomOut, getViewport, setViewport } = useReactFlow<MapNode>();
  const select = useCallback((id: string) => setSelected(id), []);
  const inspect = useCallback((machine: Machine, harness: Harness, trigger: HTMLButtonElement) => {
    evidenceTrigger.current = trigger;
    setEvidence({ machine, harness });
  }, []);
  const actions = useMemo(() => ({ select, inspect }), [select, inspect]);
  const graph = useMemo(() => layout(machines, mode, selected), [machines, mode, selected]);
  const visible = useMemo(() => {
    const search = query.toLocaleLowerCase();
    return machines.filter(machine => `${machine.name} ${machine.harnesses.map(h => h.name).join(" ")}`.toLocaleLowerCase().includes(search));
  }, [machines, query]);
  const chosen = machines.find(machine => machine.id === selected) ?? machines[0];
  const current = machines.slice(1).filter(machine => summary(machine).current).length;
  function overview() {
    setSelected(null);
    void fitView({ padding: 0.12, minZoom: 0.025, maxZoom: 0.95, duration: 0 });
  }
  return <Actions value={actions}>
    <div className={`@container flex flex-col overflow-hidden bg-background ${embedded ? "min-h-0 flex-1" : "min-h-[640px] rounded-xl border border-border-strong"}`} data-variant={mode}>
      {!embedded && <header className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-2">
        <h1 className="mr-3 text-lg font-semibold">Machines</h1>
        <Button variant={view === "map" ? "outline" : "ghost"} className={buttonSize} aria-pressed={view === "map"} onClick={() => setView("map")}>Map</Button>
        <Button variant={view === "list" ? "outline" : "ghost"} className={buttonSize} aria-pressed={view === "list"} onClick={() => setView("list")}>List</Button>
        <p className="ml-auto flex items-center gap-2 text-sm text-muted-foreground"><StatusMark kind={current === machines.length - 1 && current > 0 ? "ok" : "warn"} /><span className="tabular-nums">{current} of {machines.length - 1} followers up to date</span></p>
      </header>}
      <form className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3" onSubmit={event => { event.preventDefault(); if (visible[0]) { setSelected(visible[0].id); setView("map"); } }}>
        <label className="min-w-0 flex-1 text-xs text-muted-foreground" htmlFor="machine-search">Find a machine or harness<Input id="machine-search" type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} autoComplete="off" spellCheck={false} className="mt-1 h-10 text-[16px]" /></label>
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">Inspect machine<select aria-label="Inspect machine" className="mt-1 h-10 w-full rounded-lg border border-input bg-panel px-2 text-[16px] text-foreground focus-visible:outline-2 focus-visible:outline-ring" value={selected ?? ""} onChange={event => { setSelected(event.target.value || null); setView("map"); }}>
          <option value="">Fleet overview</option>{visible.map(machine => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
        </select></label>
        <Button type="submit" variant="outline" className={buttonSize} disabled={!visible.length}>Find</Button>
      </form>
      {query && <p role="status" className="border-b border-border px-4 py-2 text-sm text-muted-foreground">{visible.length} matching machines. Search narrows the inspector picker and list; the map keeps fleet context.</p>}
      {view === "map" ? <div className="flex min-h-0 flex-1 flex-col @min-[760px]:flex-row">
        <div className="relative flex min-w-0 flex-1 flex-col" style={{ height: embedded ? undefined : "min(72vh, 840px)", minHeight: embedded ? 240 : 420 }}>
          <div className="min-h-0 flex-1">
          <ReactFlow<MapNode> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes[mode]} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} minZoom={0.025} maxZoom={1.5} panOnScroll zoomOnScroll={false} preventScrolling={false} onlyRenderVisibleElements colorMode="dark" attributionPosition="top-right">
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
            <Viewport selected={selected} nodes={graph.nodes} />
          </ReactFlow>
          </div>
          <div className="mx-3 mb-3 mt-2 flex flex-wrap items-center gap-1 rounded-md border border-border bg-panel p-1">
            <Button variant="ghost" className={buttonSize} onClick={overview}>Fit fleet</Button>
            <Button variant="ghost" className={buttonSize} aria-label="Zoom in" onClick={() => void zoomIn({ duration: 0 })}>+</Button>
            <Button variant="ghost" className={buttonSize} aria-label="Zoom out" onClick={() => void zoomOut({ duration: 0 })}>−</Button>
            <Button variant="ghost" className={`${buttonSize} ml-auto`} disabled={measuring} onClick={async () => { setMeasuring(true); setBenchmark(await measurePan(setViewport, getViewport())); setMeasuring(false); }}>Measure pan</Button>
          </div>
        </div>
        {mode === "rail" && <Inspector machine={chosen} />}
        {mode !== "rail" && selected && <div className="@min-[760px]:hidden"><Inspector machine={chosen} /></div>}
      </div> : <div className="max-h-[72vh] overflow-y-auto p-4">
        {!visible.length && <p className="py-8 text-muted-foreground">No machines match. Clear the search to see the fleet.</p>}
        {visible.slice(page * 20, (page + 1) * 20).map(machine => <section key={machine.id} className="mb-3 rounded-lg border border-border">
          <div className="flex min-w-0 flex-wrap items-center gap-3 p-3"><h2 className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">{machine.name}</h2><span className="flex items-center gap-1.5 text-sm text-muted-foreground"><StatusMark kind={summary(machine).kind} />{summary(machine).label}</span><Button variant="outline" className={buttonSize} onClick={() => { setSelected(machine.id); setView("map"); }}>Show on map</Button></div>
          <details className="border-t border-border"><summary className="cursor-pointer px-3 py-3 focus-visible:outline-2 focus-visible:outline-ring">{machine.report === "missing" ? "Inventory not reported" : `${machine.harnesses.length} harnesses`}</summary><Inspector machine={machine} /></details>
        </section>)}
        {visible.length > 20 && <nav aria-label="Machine list pages" className="flex items-center gap-3"><Button variant="outline" className={buttonSize} disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page + 1} of {Math.ceil(visible.length / 20)}</span><Button variant="outline" className={buttonSize} disabled={(page + 1) * 20 >= visible.length} onClick={() => setPage(page + 1)}>Next</Button></nav>}
      </div>}
      <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground"><p>{machines.length} machines · {mode === "film" ? "Harness cards collapse at fleet zoom. Inspect a machine to read them." : mode === "focus" ? "Inspect a machine to expand its harnesses in the map." : "Inspect a machine to read its harnesses beside the map."} Client loaded is not verified.</p>{benchmark && <output data-benchmark={JSON.stringify(benchmark)} className="mt-1 block font-mono">Pan: median {benchmark.median.toFixed(1)} ms · p95 {benchmark.p95.toFixed(1)} ms · max {benchmark.max?.toFixed(1)} ms</output>}</footer>
    </div>
    <Dialog open={evidence !== null} onOpenChange={open => { if (!open) setEvidence(null); }}>
      <DialogContent animated={false} onCloseAutoFocus={event => { event.preventDefault(); evidenceTrigger.current?.focus(); }}>
        {evidence && <>
          <DialogTitle className="flex min-w-0 items-center gap-3 pr-6"><HarnessLogo harness={evidence.harness} /><span className="[overflow-wrap:anywhere]">{evidence.harness.name}</span></DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{evidence.machine.name} · example report</DialogDescription>
          <p className="flex items-center gap-2"><StatusMark kind={evidence.machine.report === "stale" ? "offline" : states[evidence.harness.state].kind} />{evidence.machine.report === "stale" ? "Last reported: " : ""}{states[evidence.harness.state].label}</p>
          <p>{states[evidence.harness.state].reason}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"><dt className="text-muted-foreground">Observation</dt><dd>{evidence.machine.report === "stale" ? "3 days ago. Current state unknown." : "2 minutes ago"}</dd><dt className="text-muted-foreground">Client loaded</dt><dd>Not verified</dd></dl>
        </>}
      </DialogContent>
    </Dialog>
  </Actions>;
}
export function MapExperience(props: { mode: Mode; machines: Machine[]; embedded?: boolean }) {
  return <ReactFlowProvider><Experience {...props} /></ReactFlowProvider>;
}
