// Machine map: the Source Machine on top, an arrow to each follower,
// each edge styled by that follower's state. Pan, zoom and drag; positions and
// per-machine looks stay in this browser (see ./model).
import "@xyflow/react/dist/base.css";
import "./machine-map.css";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type FitViewOptions,
  type NodeChange,
} from "@xyflow/react";
import { ArrowCounterClockwise, CornersOut, EyeSlash, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/dither";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Term } from "@/shared/shared";
import { followers as seedFollowers, followerSelf, machine, revisions, STATE_META, type Follower } from "@/shared/data";
import { AddNode, MachineNode, type AddNodeType, type MachineNodeType } from "./machine-node";
import { CustomizeSheet } from "./customize-sheet";
import { SyncEdge, type SyncEdgeType } from "./sync-edge";
import {
  ADD_ID,
  defaultLayout,
  linkFor,
  MapActionsContext,
  mapStore,
  PACKET_FILL,
  PACKET_PATH,
  resolveLook,
  SOURCE_ID,
  TONE_STROKE,
  useMapStore,
  type Link,
  type MapActions,
  type MapRole,
  type ResolvedLook,
} from "./model";

export interface MachineMapProps {
  role: MapRole;
  /** Double-click, Enter or "Open" on a machine. The Source's id is `SOURCE_ID`. */
  onOpenMachine?: (id: string) => void;
  /** The dashed "Add machine" node (Source role only). */
  onInvite?: () => void;
  className?: string;
  /** Followers to draw. Default: the mock followers. */
  followers?: readonly Follower[];
  /** Newest Profile Revision sequence. Followers below it show packets on their way. */
  latestRevision?: number;
  /** Follower ids with a Synchronization Run in progress. */
  syncing?: readonly string[];
  /** Follower role: which follower is this machine. Default: the mock `followerSelf`. */
  selfId?: string;
  /** The Source is publishing a new Profile Revision: it glows until this turns false. */
  publishing?: boolean;
  /**
   * The machine whose Customize sheet is open (`SOURCE_ID` for the Source), or `null` for none.
   * Set it to control the sheet from outside; leave it `undefined` and the map keeps its own.
   */
  customizeId?: string | null;
  /** The sheet opened for a machine (its id) or closed (`null`). Called in both modes. */
  onCustomizeChange?: (id: string | null) => void;
}

type MapNode = MachineNodeType | AddNodeType;

const nodeTypes = { machine: MachineNode, add: AddNode };
const edgeTypes = { sync: SyncEdge };
// Cards stay readable at fit: a 4-follower row fills most of an 1100px panel without blowing up a 1-machine map.
const FIT: FitViewOptions = { padding: 0.2, maxZoom: 1.15 };
const NO_SYNCING: readonly string[] = [];

export function MachineMap(props: MachineMapProps) {
  return (
    <ReactFlowProvider>
      <MapCanvas {...props} />
    </ReactFlowProvider>
  );
}

function MapCanvas({
  role,
  onOpenMachine,
  onInvite,
  className,
  followers = seedFollowers,
  latestRevision,
  syncing = NO_SYNCING,
  selfId,
  publishing = false,
  customizeId,
  onCustomizeChange,
}: MachineMapProps) {
  const store = useMapStore();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const viewportDuration = (event: MouseEvent<HTMLButtonElement>, duration: number) => reduced || event.detail === 0 ? 0 : duration;
  const latest = latestRevision ?? revisions[0].sequence;
  const self = role === "follower" ? followers.find((f) => (selfId ? f.id === selfId : f.name === followerSelf.name)) : undefined;
  const visible = useMemo(() => (role === "source" ? followers : self ? [self] : []), [role, followers, self]);
  const rowKey = visible.map((f) => f.id).join();
  const layout = useMemo(() => defaultLayout(role === "source" ? [...rowKey.split(","), ADD_ID] : rowKey.split(",")), [role, rowKey]);
  const syncingKey = syncing.join();
  const syncingIds = useMemo(() => new Set(syncingKey.split(",")), [syncingKey]);
  // The Source glows while anything it sent is moving: a publish, or a run on a machine shown here.
  const sourceActive = publishing || visible.some((f) => syncingIds.has(f.id));

  const [ownCustomizeId, setOwnCustomizeId] = useState<string | null>(null);
  const requestedId = customizeId === undefined ? ownCustomizeId : customizeId;
  // Only a machine on this map can have a sheet; an id for a hidden follower shows none.
  const sheetId = requestedId === SOURCE_ID || visible.some((f) => f.id === requestedId) ? requestedId : null;
  const setCustomize = useCallback(
    (id: string | null) => {
      setOwnCustomizeId(id);
      onCustomizeChange?.(id);
    },
    [onCustomizeChange],
  );

  const looks = useMemo(() => {
    const out: Record<string, ResolvedLook> = {
      [SOURCE_ID]: resolveLook(SOURCE_ID, machine.hostname, machine.platform, store.looks[SOURCE_ID]),
    };
    for (const f of visible) out[f.id] = resolveLook(f.id, f.name, f.platform, store.looks[f.id]);
    return out;
  }, [store.looks, visible]);

  const built = useMemo((): MapNode[] => {
    // Saved positions only seed nodes; a later move must not rebuild the rest.
    const saved = mapStore.positions(role);
    const sourceNode: MachineNodeType = {
      id: SOURCE_ID,
      type: "machine",
      position: saved[SOURCE_ID] ?? layout[SOURCE_ID],
      ariaLabel: `${looks[SOURCE_ID].name}, the Source${role === "source" ? ", this machine" : ""}, on revision ${latest}${publishing ? ", publishing" : ""}`,
      data: {
        kind: "source",
        hostname: machine.hostname,
        platform: machine.platform,
        look: looks[SOURCE_ID],
        revision: latest,
        latest,
        state: null,
        isSelf: role === "source",
        active: sourceActive,
        publishing,
      },
    };
    const followerNodes = visible.map((f): MachineNodeType => {
      const look = looks[f.id];
      const behind = f.revision === null || f.revision < latest;
      return {
        id: f.id,
        type: "machine",
        position: saved[f.id] ?? layout[f.id],
        ariaLabel: `${look.name}, ${STATE_META[f.state].label}, ${f.revision === null ? "no revision yet" : `revision ${f.revision}`}${behind ? `, revision ${latest} waiting` : ""}${role === "follower" ? ", this machine" : ""}`,
        data: {
          kind: "follower",
          hostname: f.name,
          platform: f.platform,
          look,
          revision: f.revision,
          latest,
          state: f.state,
          isSelf: role === "follower",
          active: syncingIds.has(f.id),
          publishing: false,
        },
      };
    });
    const out: MapNode[] = [sourceNode, ...followerNodes];
    if (role === "source") {
      out.push({ id: ADD_ID, type: "add", position: layout[ADD_ID], draggable: false, selectable: false, focusable: false, data: {} });
    }
    return out;
  }, [role, visible, looks, latest, layout, sourceActive, publishing, syncingIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>(built);
  const selectedId = nodes.find((n) => n.selected && n.type === "machine")?.id ?? null;

  const actions = useMemo(
    (): MapActions => ({
      open: (id) => onOpenMachine?.(id),
      invite: () => onInvite?.(),
      toggleCustomize: (id) => setCustomize(sheetId === id ? null : id),
      customizingId: sheetId,
    }),
    [onOpenMachine, onInvite, setCustomize, sheetId],
  );

  // New data (looks, followers, revision) replaces node data but keeps where each node is.
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return built.map((b) => {
        const p = byId.get(b.id);
        return p ? ({ ...p, data: b.data, ariaLabel: b.ariaLabel } as MapNode) : b;
      });
    });
  }, [built, setNodes]);

  // Persist only after the user moves something (drag end or arrow keys).
  const moved = useRef(false);
  const handleNodesChange = useCallback(
    (changes: NodeChange<MapNode>[]) => {
      onNodesChange(changes);
      if (changes.some((c) => c.type === "position" && !c.dragging)) moved.current = true;
    },
    [onNodesChange],
  );
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    mapStore.setPositions(role, Object.fromEntries(nodes.filter((n) => n.type === "machine").map((n) => [n.id, n.position])));
  }, [nodes, role]);

  const resetLayout = (event: MouseEvent<HTMLButtonElement>) => {
    const duration = viewportDuration(event, 200);
    mapStore.resetPositions(role);
    setNodes((prev) => prev.map((n) => ({ ...n, position: layout[n.id] ?? n.position })));
    requestAnimationFrame(() => void fitView({ ...FIT, duration }));
  };

  const links = useMemo(
    () => Object.fromEntries(visible.map((f) => [f.id, linkFor(f, latest, syncingIds.has(f.id))])),
    [visible, latest, syncingIds],
  );

  const edges = useMemo((): (SyncEdgeType | Edge)[] => {
    const out: (SyncEdgeType | Edge)[] = visible.map((f) => {
      const link = links[f.id];
      return {
        id: `e-${f.id}`,
        source: SOURCE_ID,
        target: f.id,
        type: "sync",
        selectable: false,
        // Focusable so its explanation, otherwise shown only on hover, is reachable with Tab:
        // SyncEdge shows the same tooltip on focus, and the label carries the full text for screen readers.
        focusable: true,
        ariaLabel: `${looks[f.id].name}: ${STATE_META[f.state].label}. ${STATE_META[f.state].hint}${link.detail ? ` ${link.detail}` : ""}`,
        data: { link, name: looks[f.id].name, emphasis: selectedId === f.id || selectedId === SOURCE_ID },
      };
    });
    if (role === "source") {
      out.push({
        id: `e-${ADD_ID}`,
        source: SOURCE_ID,
        target: ADD_ID,
        selectable: false,
        focusable: false,
        ariaLabel: "Room for another follower",
        style: { stroke: "var(--border-strong)", strokeWidth: 1, strokeDasharray: "2 4" },
      });
    }
    return out;
  }, [visible, links, looks, selectedId, role]);

  const sheetFollower = visible.find((f) => f.id === sheetId);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusNode = (id: string) => containerRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.focus();

  return (
    <MapActionsContext value={actions}>
      <div ref={containerRef} className={cn("cf-map relative isolate h-full min-h-[420px] w-full overflow-hidden rounded-lg border border-border bg-panel", className)}>
        <ReactFlow<MapNode, SyncEdgeType | Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onNodeDoubleClick={(_, n) => n.type === "machine" && onOpenMachine?.(n.id)}
          onPaneClick={() => sheetId && setCustomize(null)}
          onKeyDown={(e) => {
            const el = e.target as HTMLElement;
            if (e.key === "Enter" && el.classList.contains("react-flow__node") && el.dataset.id && el.dataset.id !== ADD_ID) onOpenMachine?.(el.dataset.id);
          }}
          fitView
          fitViewOptions={FIT}
          // Low enough that the first fit shows every machine, even many followers in a narrow panel.
          minZoom={0.1}
          maxZoom={1.75}
          nodesConnectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomOnDoubleClick={false}
          attributionPosition="top-right"
          ariaLabelConfig={{
            "node.a11yDescription.default": "Press Enter to open this machine, or Space to select it. Tab to its Open and Customize controls. Use arrow keys to move a selected machine.",
            // Edges are focusable only to explain themselves; the default text offers selection and deletion they don't have.
            "edge.a11yDescription.default": "The link from the Source to this machine. Press Escape to hide its explanation.",
          }}
          aria-label="Machine map"
        >
          {/* A flat 1.5px dot lattice that pans with the map; calmer than an ambient shader and costs no WebGL context. */}
          <Background variant={BackgroundVariant.Dots} gap={14} size={1.5} color="color-mix(in oklab, var(--border-strong) 75%, transparent)" />

          <Panel position="top-left" className="!m-3 flex max-w-[60%] items-center gap-1.5 text-xs text-faint">
            {role === "follower" ? (
              <>
                <EyeSlash className="size-3.5 shrink-0" />
                <span>
                  Followers can't see each other. Only the <Term term="Source Machine" /> sees every machine.
                </span>
              </>
            ) : (
              <span>Select a machine, then choose Customize. Double-click to open it. Drag to arrange.</span>
            )}
          </Panel>

          {/* One bottom bar: the controls keep the bottom-right corner and the key sits left of them,
              wrapping above them when the panel is too narrow for both, so neither covers the other.
              The bar itself passes pointer events through so the strip between them still pans. */}
          <Panel position="bottom-left" className="pointer-events-none right-0 !m-3 flex flex-row-reverse flex-wrap-reverse items-end gap-2">
            <div className="pointer-events-auto flex items-center gap-px rounded-md border border-border bg-panel/90 p-0.5 shadow-sm shadow-black/30 backdrop-blur-sm">
              <ControlButton label="Zoom out" onClick={(event) => void zoomOut({ duration: viewportDuration(event, 150) })}>
                <MagnifyingGlassMinus />
              </ControlButton>
              <ControlButton label="Zoom in" onClick={(event) => void zoomIn({ duration: viewportDuration(event, 150) })}>
                <MagnifyingGlassPlus />
              </ControlButton>
              <ControlButton label="Fit to screen" onClick={(event) => void fitView({ ...FIT, duration: viewportDuration(event, 200) })}>
                <CornersOut />
              </ControlButton>
              <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
              <button
                type="button"
                disabled={!store.positions[role]}
                onClick={resetLayout}
                className="inline-flex min-h-[40px] min-w-[40px] shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:text-faint pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] [&_svg]:size-3.5"
              >
                <ArrowCounterClockwise />
                Reset layout
              </button>
            </div>
            {role === "source" && <Legend links={Object.values(links)} />}
          </Panel>
        </ReactFlow>

        <AnimatePresence>
          {sheetId && (
            <CustomizeSheet
              key="customize"
              id={sheetId}
              hostname={sheetId === SOURCE_ID ? machine.hostname : (sheetFollower?.name ?? sheetId)}
              saved={store.looks[sheetId]}
              look={looks[sheetId]}
              onClose={() => {
                setCustomize(null);
                focusNode(sheetId);
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </MapActionsContext>
  );
}

function ControlButton({ label, onClick, children }: { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="grid size-[40px] shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:size-[44px] [&_svg]:size-4"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const LEGEND: { key: string; label: string; match: (l: Link) => boolean; swatch: ReactNode }[] = [
  { key: "converged", label: STATE_META.converged.label, match: (l) => l.tone === "quiet" && !l.flowing, swatch: <line x1="0" y1="3" x2="18" y2="3" stroke={TONE_STROKE.quiet} strokeWidth="1.5" /> },
  {
    key: "flowing",
    label: "Update on its way",
    match: (l) => l.flowing,
    swatch: (
      <>
        <line x1="0" y1="3" x2="18" y2="3" stroke={TONE_STROKE.quiet} strokeWidth="1" />
        <path d={PACKET_PATH} transform="translate(6 0) scale(1.5)" fill={PACKET_FILL.quiet} />
      </>
    ),
  },
  { key: "drift", label: STATE_META.drift.label, match: (l) => l.tone === "warn", swatch: <line x1="0" y1="3" x2="18" y2="3" stroke={TONE_STROKE.warn} strokeWidth="1.5" /> },
  { key: "act", label: STATE_META["human-action"].label, match: (l) => l.tone === "act", swatch: <line x1="0" y1="3" x2="18" y2="3" stroke={TONE_STROKE.act} strokeWidth="1.5" /> },
  {
    key: "broken",
    label: STATE_META.offline.label,
    match: (l) => l.broken,
    swatch: <line x1="0" y1="3" x2="18" y2="3" stroke={TONE_STROKE.bad} strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="4 3" />,
  },
  { key: "failed", label: STATE_META.failed.label, match: (l) => l.tone === "bad" && !l.broken, swatch: <line x1="0" y1="3" x2="18" y2="3" stroke={TONE_STROKE.bad} strokeWidth="1.5" /> },
];

/** Only the line styles currently on the map, so the key never explains something absent. */
function Legend({ links }: { links: Link[] }) {
  const items = LEGEND.filter((item) => links.some(item.match));
  if (items.length === 0) return null;
  return (
    // mr-auto keeps the key at the left edge, on the controls' line or above them.
    <ul aria-label="Line key" className="pointer-events-auto mr-auto flex flex-wrap items-center gap-x-3.5 gap-y-1 rounded-md border border-border bg-panel/90 px-2.5 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <svg aria-hidden width="18" height="6" className="shrink-0">
            {item.swatch}
          </svg>
          {item.label}
        </li>
      ))}
    </ul>
  );
}
