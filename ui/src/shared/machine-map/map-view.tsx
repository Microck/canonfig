// Machine map: the Source Machine on top, an arrow to each follower,
// each edge styled by that follower's state. Pan, zoom and drag; positions and
// per-machine looks stay in this browser (see ./model).
import "@xyflow/react/dist/base.css";
import "./machine-map.css";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { AnimatePresence, cubicBezier } from "motion/react";
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type FitViewOptions,
  type NodeChange,
} from "@xyflow/react";
import { ArrowCounterClockwise, CornersOut, EyeSlash, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@/components/icons";
import { cn, SNAP } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/dither";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Term } from "@/shared/shared";
import { STATE_META, type Follower } from "@/shared/metadata";
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
  fromPublishedLook,
  toPublishedLook,
  SOURCE_ID,
  TONE_STROKE,
  useMapStore,
  type Link,
  type MapActions,
  type MapRole,
  type PublishedLook,
  type ResolvedLook,
} from "./model";

export type MapFollower = Pick<Follower, "id" | "name"> & Partial<Pick<Follower, "platform" | "state" | "revision" | "schedule" | "behind">>;

export interface MachineMapProps {
  role: MapRole;
  /** Double-click, Enter or "Open" on a machine. The Source's id is `SOURCE_ID`. */
  onOpenMachine?: (id: string) => void;
  /** The dashed "Add machine" node (Source role only). */
  onInvite?: () => void;
  className?: string;
  source: { hostname: string; platform?: Follower["platform"]; endpoint?: string; look?: PublishedLook | undefined };
  followers: readonly MapFollower[];
  /** Newest Profile Revision sequence. Followers below it show packets on their way. */
  latestRevision?: number;
  /** Follower ids with a Synchronization Run in progress. */
  syncing?: readonly string[];
  /** Follower role: the enrolled identity of this machine. */
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
  /** Source role: the Source card's Customize sheet closed; publish what it saved (undefined after a reset) to Followers. */
  onSourceLookSave?: (look: PublishedLook | undefined) => void;
}

type MapNode = MachineNodeType | AddNodeType;

const nodeTypes = { machine: MachineNode, add: AddNode };
const edgeTypes = { sync: SyncEdge };
// Cards stay readable at fit: a 4-follower row fills most of an 1100px panel without blowing up a 1-machine map.
// minZoom 1 keeps 11px card text at true size in narrow panels: fit centres the map and the user pans to the rest
// (wide panels already fit above 1, so they are unaffected). Manual zoom-out still goes to the ReactFlow minZoom.
const FIT: FitViewOptions = { padding: 0.2, minZoom: 1, maxZoom: 1.15 };
const NO_SYNCING: readonly string[] = [];

// Viewport feel. The mouse wheel and trackpad scroll zoom around the pointer, a pinch zooms, and dragging the
// background pans: React Flow's default controls. useSmoothZoom keeps React Flow's wheel-to-zoom rate (one 100px
// mouse notch is 1.15x) and only changes how a step lands, easing it instead of jumping.
/** Low enough that the first fit shows every machine, even many followers in a narrow panel. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 1.75;
/** One zoom button press, and the most a single wheel event may zoom (one mouse-wheel notch). */
const ZOOM_STEP = 1.2;
/** Smooth zoom closes 63% of the remaining distance every ZOOM_TAU ms: 95% within 90ms, done (ZOOM_DONE) by ~130ms. */
const ZOOM_TAU = 30;
/** Within 0.3% of the target the zoom snaps there and stops: under a pixel across a card. */
const ZOOM_DONE = 0.003;
/** A pinch moves zoom a few percent per event and applies at once; a larger Ctrl + scroll step eases instead. */
const SMOOTH_ABOVE = Math.log(1.08);
/** The app's --ease-snap curve, for fit, reset and focus pans. */
const VIEW_EASE = cubicBezier(...SNAP);
/** React Flow multiplies Ctrl + wheel deltas by 10 on macOS, where a trackpad pinch arrives as Ctrl + wheel. */
const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/**
 * Zoom for the wheel, trackpad pinch and the zoom buttons, anchored at a point in the pane.
 *
 * Takes over React Flow's wheel zoom with the same rate (its d3 wheelDelta: 2^(-deltaY * 0.002), x10 for Ctrl on
 * macOS) but caps one event at ZOOM_STEP, so a Ctrl + mouse notch on macOS no longer jumps 4x, and eases each
 * wheel step toward its target instead of jumping. A pinch still tracks the fingers at once. The easing is an
 * exponential approach rather than a fixed tween, so a new notch mid-animation retargets without restarting,
 * and nothing coasts once the target is reached.
 */
function useSmoothZoom(containerRef: RefObject<HTMLDivElement | null>, reduced: boolean) {
  const { getViewport, setViewport } = useReactFlow();
  const anim = useRef<{ target: number; x: number; y: number; frame: number; last: number } | null>(null);

  const stop = useCallback(() => {
    if (anim.current) cancelAnimationFrame(anim.current.frame);
    anim.current = null;
  }, []);

  const zoomBy = useCallback(
    (factor: number, x: number, y: number, smooth: boolean) => {
      // Keeps the flow point under (px, py) fixed on screen while the zoom changes.
      const zoomAround = (px: number, py: number, zoom: number) => {
        const vp = getViewport();
        const k = zoom / vp.zoom;
        void setViewport({ x: px - (px - vp.x) * k, y: py - (py - vp.y) * k, zoom });
      };
      // Steps compound on the pending target, so three quick notches zoom three steps, not three from mid-flight.
      const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (anim.current?.target ?? getViewport().zoom) * factor));
      if (!smooth || reduced) {
        stop();
        zoomAround(x, y, target);
        return;
      }
      if (anim.current) {
        Object.assign(anim.current, { target, x, y });
        return;
      }
      const a = { target, x, y, frame: 0, last: 0 };
      const tick = (now: number) => {
        // The first frame has no previous timestamp; count it as one 60Hz frame.
        const dt = a.last ? now - a.last : 1000 / 60;
        a.last = now;
        const zoom = getViewport().zoom;
        const left = Math.log(a.target / zoom);
        const next = Math.abs(left) < ZOOM_DONE ? a.target : zoom * Math.exp(left * (1 - Math.exp(-dt / ZOOM_TAU)));
        zoomAround(a.x, a.y, next);
        if (next === a.target) anim.current = null;
        else a.frame = requestAnimationFrame(tick);
      };
      anim.current = a;
      a.frame = requestAnimationFrame(tick);
    },
    [getViewport, setViewport, reduced, stop],
  );

  useEffect(() => {
    const root = containerRef.current!;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element;
      const pane = target.closest(".react-flow__renderer");
      if (!pane || target.closest(".nowheel")) return;
      // Capture phase on an ancestor: stopping here keeps the event from React Flow's own zoom, and
      // preventDefault keeps the page from scrolling, or a pinch from zooming the whole page.
      e.preventDefault();
      e.stopPropagation();
      const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002) * (e.ctrlKey && IS_MAC ? 10 : 1);
      const cap = Math.log(ZOOM_STEP);
      const step = Math.min(cap, Math.max(-cap, delta * Math.LN2));
      const box = pane.getBoundingClientRect();
      // Ctrl marks a pinch (or Ctrl + scroll); a bare wheel always eases.
      zoomBy(Math.exp(step), e.clientX - box.left, e.clientY - box.top, !e.ctrlKey || Math.abs(step) > SMOOTH_ABOVE);
    };
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel, { capture: true });
      stop();
    };
  }, [containerRef, zoomBy, stop]);

  return { zoomBy, stop };
}

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
  source: machine,
  followers,
  latestRevision,
  syncing = NO_SYNCING,
  selfId,
  publishing = false,
  customizeId,
  onCustomizeChange,
  onSourceLookSave,
}: MachineMapProps) {
  const store = useMapStore();
  const { fitView, getViewport, setViewport } = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const viewportDuration = (event: MouseEvent<HTMLButtonElement>, duration: number) => reduced || event.detail === 0 ? 0 : duration;
  const containerRef = useRef<HTMLDivElement>(null);
  const { zoomBy, stop: stopZoom } = useSmoothZoom(containerRef, reduced);
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  const latest = latestRevision;
  const self = role === "follower" ? followers.find((f) => f.id === selfId) : undefined;
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
  // The Source card's local look when its sheet opened, so closing it publishes only a real change; undefined when it opened from outside this map.
  const sourceLookAtOpen = useRef<string | undefined>(undefined);
  // Every way the sheet opens, closes or switches machine goes through here, so the Source card is published on each of them.
  const setCustomize = useCallback(
    (id: string | null) => {
      if (onSourceLookSave && id === SOURCE_ID && sheetId !== SOURCE_ID) {
        // A browser with nothing saved starts from the shared look, so editing one field or reopening never drops the rest of it.
        const seeded = store.looks[SOURCE_ID] ?? fromPublishedLook(machine.look);
        if (store.looks[SOURCE_ID] === undefined && seeded !== undefined) mapStore.setLook(SOURCE_ID, seeded);
        sourceLookAtOpen.current = JSON.stringify(seeded ?? null);
      }
      if (onSourceLookSave && sheetId === SOURCE_ID && id !== SOURCE_ID) {
        const local = mapStore.look(SOURCE_ID);
        const before = sourceLookAtOpen.current;
        // A reset removes the local look and so clears the shared one; an untouched sheet publishes nothing.
        if (before === undefined ? local !== undefined : JSON.stringify(local ?? null) !== before) onSourceLookSave(toPublishedLook(local));
        sourceLookAtOpen.current = undefined;
      }
      setOwnCustomizeId(id);
      onCustomizeChange?.(id);
    },
    [onCustomizeChange, onSourceLookSave, sheetId, store.looks, machine.look],
  );

  const looks = useMemo(() => {
    const out: Record<string, ResolvedLook> = {
      // The Source's published look is the base; a look customized in this browser wins over it.
      [SOURCE_ID]: resolveLook(SOURCE_ID, machine.hostname, machine.platform, { ...fromPublishedLook(machine.look), ...store.looks[SOURCE_ID] }),
    };
    for (const f of visible) out[f.id] = resolveLook(f.id, f.name, f.platform, store.looks[f.id]);
    return out;
  }, [store.looks, visible, machine.hostname, machine.platform, machine.look]);

  const built = useMemo((): MapNode[] => {
    // Saved positions only seed nodes; a later move must not rebuild the rest.
    const saved = mapStore.positions(role);
    const sourceNode: MachineNodeType = {
      id: SOURCE_ID,
      type: "machine",
      position: saved[SOURCE_ID] ?? layout[SOURCE_ID],
      ariaLabel: `${looks[SOURCE_ID].name}, the Source${role === "source" ? ", this machine" : ""}${latest === undefined ? "" : `, revision ${latest}`}${publishing ? ", publishing" : ""}`,
      data: {
        kind: "source",
        hostname: machine.hostname,
        endpoint: role === "follower" ? machine.endpoint : undefined,
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
      const behind = latest !== undefined && f.revision !== undefined && (f.revision === null || f.revision < latest);
      return {
        id: f.id,
        type: "machine",
        position: saved[f.id] ?? layout[f.id],
        ariaLabel: `${look.name}${f.state === undefined ? "" : `, ${STATE_META[f.state].label}`}${f.revision === undefined ? "" : `, revision ${f.revision ?? "none"}`}${behind ? `, revision ${latest} waiting` : ""}${role === "follower" ? ", this machine" : ""}`,
        data: {
          kind: "follower",
          hostname: f.name,
          platform: f.platform,
          look,
          revision: f.revision,
          latest,
          state: f.state ?? null,
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
  }, [role, visible, looks, latest, layout, sourceActive, publishing, syncingIds, machine.hostname, machine.platform, machine.endpoint]);

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
    stopZoom();
    mapStore.resetPositions(role);
    setNodes((prev) => prev.map((n) => ({ ...n, position: layout[n.id] ?? n.position })));
    requestAnimationFrame(() => void fitView({ ...FIT, duration, ease: VIEW_EASE }));
  };

  const links = useMemo(
    () => Object.fromEntries(visible.flatMap((f) => f.state === undefined || f.revision === undefined || f.schedule === undefined || latest === undefined ? [] : [[f.id, linkFor({ state: f.state, revision: f.revision, schedule: f.schedule, behind: f.behind }, latest, syncingIds.has(f.id))]])),
    [visible, latest, syncingIds],
  );

  const edges = useMemo((): (SyncEdgeType | Edge)[] => {
    const out: (SyncEdgeType | Edge)[] = visible.map((f) => {
      const link = links[f.id];
      if (link === undefined) return {
        id: `e-${f.id}`, source: SOURCE_ID, target: f.id, selectable: false,
        ariaLabel: `Enrollment relationship with ${looks[f.id].name}; remote health is not reported`,
        style: { stroke: "var(--border-strong)", strokeWidth: 1 },
      };
      return {
        id: `e-${f.id}`,
        source: SOURCE_ID,
        target: f.id,
        type: "sync",
        selectable: false,
        // Focusable so its explanation, otherwise shown only on hover, is reachable with Tab:
        // SyncEdge shows the same tooltip on focus, and the label carries the full text for screen readers.
        focusable: true,
        ariaLabel: `${looks[f.id].name}: ${STATE_META[link.state].label}. ${STATE_META[link.state].hint}${link.detail ? ` ${link.detail}` : ""}`,
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
  const zoomFromCentre = (factor: number, event: MouseEvent<HTMLButtonElement>) => zoomBy(factor, paneWidth / 2, paneHeight / 2, event.detail !== 0);
  const focusNode = (id: string) => containerRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.focus();

  // Pans just enough that a node and its toolbar sit inside the map, keeping the zoom. ReactFlow's own
  // autoPanOnNodeFocus only recentres fully hidden nodes and ignores the toolbar, which at 390px (fit zoom 1)
  // left half-visible nodes and their Open/Customize buttons off-screen. Runs on keyboard focus and selection,
  // never on hover; reduced motion jumps instantly.
  const reveal = useCallback(
    (id: string) => {
      requestAnimationFrame(() => {
        const root = containerRef.current;
        if (!root) return;
        const sel = `[data-id="${CSS.escape(id)}"]`;
        const rects = [...root.querySelectorAll<HTMLElement>(`.react-flow__node${sel}, .react-flow__node-toolbar${sel}`)].map((el) => el.getBoundingClientRect());
        if (!rects.length) return;
        const box = root.getBoundingClientRect();
        const pad = 12;
        const left = Math.min(...rects.map((r) => r.left));
        const right = Math.max(...rects.map((r) => r.right));
        const top = Math.min(...rects.map((r) => r.top));
        const bottom = Math.max(...rects.map((r) => r.bottom));
        // Shift toward whichever edge is crossed; when the target is wider than the map, keep its start edge.
        const shift = (lo: number, hi: number, min: number, max: number) => (lo < min ? min - lo : hi > max ? Math.max(max - hi, min - lo) : 0);
        const dx = shift(left, right, box.left + pad, box.right - pad);
        const dy = shift(top, bottom, box.top + pad, box.bottom - pad);
        if (!dx && !dy) return;
        const vp = getViewport();
        void setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: reduced ? 0 : 200, ease: VIEW_EASE });
      });
    },
    [getViewport, setViewport, reduced],
  );
  useEffect(() => {
    if (selectedId) reveal(selectedId);
  }, [selectedId, reveal]);

  return (
    <MapActionsContext value={actions}>
      <div
        ref={containerRef}
        className={cn("cf-map relative isolate h-full min-h-[420px] w-full overflow-hidden rounded-lg border border-border bg-panel", className)}
        onFocus={(e) => {
          // Keyboard focus only: a pointer press also focuses the node, and selection already covers that case.
          if (!e.target.matches(":focus-visible")) return;
          const owner = e.target.closest<HTMLElement>(".react-flow__node, .react-flow__node-toolbar");
          if (owner?.dataset.id) reveal(owner.dataset.id);
        }}
      >
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
            if (e.key !== "Enter" || !el.classList.contains("react-flow__node") || !el.dataset.id || el.dataset.id === ADD_ID) return;
            // Consume the key: below md the opened panel moves focus to its close button during this keydown,
            // and an unconsumed Enter would then activate that button and close the panel at once.
            e.preventDefault();
            onOpenMachine?.(el.dataset.id);
          }}
          fitView
          autoPanOnNodeFocus={false}
          fitViewOptions={FIT}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          // A click that wobbles a few pixels still counts as a click (closes the sheet, clears selection), not a pan.
          paneClickDistance={4}
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

          {/* The hint passes scroll and drags through to the pane (at 390px it covers a fair share of it); only the
              focusable glossary term takes the pointer. */}
          <Panel position="top-left" className="pointer-events-none !m-3 flex max-w-[60%] items-center gap-1.5 text-xs text-muted-foreground [&_[tabindex]]:pointer-events-auto">
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
          <Panel position="bottom-left" className="pointer-events-none right-0 !m-3 flex flex-row-reverse flex-wrap-reverse items-stretch gap-2">
            <div className="pointer-events-auto flex items-center gap-px rounded-md border border-border bg-panel/95 p-0.5 shadow-sm shadow-black/30">
              <ControlButton label="Zoom out" onClick={(event) => zoomFromCentre(1 / ZOOM_STEP, event)}>
                <MagnifyingGlassMinus />
              </ControlButton>
              <ControlButton label="Zoom in" onClick={(event) => zoomFromCentre(ZOOM_STEP, event)}>
                <MagnifyingGlassPlus />
              </ControlButton>
              <ControlButton
                label="Fit to screen"
                onClick={(event) => {
                  stopZoom();
                  void fitView({ ...FIT, duration: viewportDuration(event, 200), ease: VIEW_EASE });
                }}
              >
                <CornersOut />
              </ControlButton>
              <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
              <Button
                type="button"
                variant="outline"
                disabled={!store.positions[role]}
                onClick={resetLayout}
                className="min-h-10 min-w-10 rounded-[5px] px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 [&_svg]:size-3.5"
              >
                <ArrowCounterClockwise />
                Reset layout
              </Button>
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
              shared={sheetId === SOURCE_ID && onSourceLookSave !== undefined}
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={onClick}
          className="size-10 rounded-[5px] text-muted-foreground pointer-coarse:size-11"
        >
          {children}
        </Button>
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
    // No backdrop-filter here or on the controls: a blur under a panning canvas re-filters every frame, and behind
    // the near-opaque fill it barely showed. mr-auto keeps the key at the left edge, on the controls' line or above them.
    <ul aria-label="Line key" data-tour="map-key" className="pointer-events-auto mr-auto flex flex-wrap items-center gap-x-3.5 gap-y-1 rounded-md border border-border bg-panel/95 px-2.5 py-1.5 text-xs text-muted-foreground">
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
