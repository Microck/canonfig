// Machine map edge: the line from the Source Machine to one follower,
// styled by what that link is doing right now.
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { LinkBreak } from "@phosphor-icons/react";
import { usePrefersReducedMotion } from "@/lib/dither";
import { STATE_META } from "@/shared/data";
import { PACKET_FILL, PACKET_PATH, TONE_STROKE, type Link } from "./model";

export type SyncEdgeData = {
  link: Link;
  /** The follower's display name. */
  name: string;
  /** The link's follower or the Source is selected: draw it a step stronger. */
  emphasis: boolean;
};
export type SyncEdgeType = Edge<SyncEdgeData, "sync">;

/** Seconds for one packet to travel Source to follower, and packets in flight: slow while a revision waits, brisk during a run. */
const WAITING = { trip: 3.2, packets: 2 };
const RUNNING = { trip: 1.6, packets: 3 };
const PACKET_CELL = 2;
const PACKET_OFFSET = (-4 * PACKET_CELL) / 2;
/** Tooltip distance from the pointer, and the minimum margin it keeps from the viewport edge. */
const TIP_OFFSET = 14;
const TIP_MARGIN = 8;

/** Below-right of the pointer; flips to the other side on an axis where that overflows, then clamps into the viewport. */
function placeTip(pointer: { x: number; y: number }, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = pointer.x + TIP_OFFSET;
  let top = pointer.y + TIP_OFFSET;
  if (left + w > vw - TIP_MARGIN) left = pointer.x - TIP_OFFSET - w;
  if (top + h > vh - TIP_MARGIN) top = pointer.y - TIP_OFFSET - h;
  return {
    left: Math.max(TIP_MARGIN, Math.min(left, vw - TIP_MARGIN - w)),
    top: Math.max(TIP_MARGIN, Math.min(top, vh - TIP_MARGIN - h)),
  };
}

export const SyncEdge = memo(function SyncEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<SyncEdgeType>) {
  const reduced = usePrefersReducedMotion();
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  // Where the tooltip anchors while the edge has keyboard focus: the middle of the line on screen.
  const [focusAt, setFocusAt] = useState<{ x: number; y: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const hitRef = useRef<SVGPathElement>(null);
  const markerId = `cf-arrow-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [d, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const anchor = pointer ?? focusAt;

  // Position needs the tooltip's rendered size, so it is set before paint rather than through `style`.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!anchor || !el) return;
    const { left, top } = placeTip(anchor, el.offsetWidth, el.offsetHeight);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [anchor]);

  // React Flow renders the focusable wrapper <g> around this component, so its focus events are
  // only reachable through the DOM. The bezier is symmetric, so its box centre is the line's middle.
  useEffect(() => {
    const hit = hitRef.current;
    const wrapper = hit?.closest(".react-flow__edge");
    if (!hit || !wrapper) return;
    const onFocus = () => {
      const r = hit.getBoundingClientRect();
      setFocusAt({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    const onBlur = () => setFocusAt(null);
    wrapper.addEventListener("focus", onFocus);
    wrapper.addEventListener("blur", onBlur);
    return () => {
      wrapper.removeEventListener("focus", onFocus);
      wrapper.removeEventListener("blur", onBlur);
    };
  }, []);

  // Escape dismisses it without moving the pointer or focus (WCAG 1.4.13); it stays closed until the pointer re-enters or focus returns.
  const open = anchor !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPointer(null);
      setFocusAt(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!data) return null;

  const { link, name, emphasis } = data;
  const strong = emphasis || open;
  const stroke = TONE_STROKE[link.tone];
  const packet = PACKET_FILL[link.tone];
  const quiet = link.tone === "quiet";
  const opacity = link.broken ? (strong ? 0.75 : 0.5) : quiet ? 1 : strong ? 1 : 0.72;
  const width = (quiet ? 1 : 1.25) + (strong ? 0.5 : 0);
  const meta = STATE_META[link.state];
  const pace = link.running ? RUNNING : WAITING;

  return (
    <>
      <g style={{ opacity }}>
        {!link.broken && (
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M1.5 1.5 L8.5 5 L1.5 8.5" fill="none" stroke={quiet && strong ? "var(--muted-foreground)" : stroke} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>
        )}
        <path
          d={d}
          fill="none"
          stroke={quiet && strong ? "var(--muted-foreground)" : stroke}
          strokeWidth={width}
          strokeDasharray={link.broken ? "5 6" : undefined}
          markerEnd={link.broken ? undefined : `url(#${markerId})`}
        />
      </g>

      {link.flowing &&
        (reduced ? (
          // Still frame for reduced motion: a dotted run says "something is on its way".
          <path d={d} fill="none" stroke={packet} strokeWidth={1.5} strokeDasharray="1.5 4.5" opacity={0.9} />
        ) : (
          Array.from({ length: pace.packets }, (_, i) => {
            const begin = `${(-i * pace.trip) / pace.packets}s`;
            return (
              // Keyed by mode: SMIL timing must restart when the pace changes.
              <g key={`${link.running}-${i}`} opacity={0}>
                <animateMotion dur={`${pace.trip}s`} begin={begin} repeatCount="indefinite" path={d} />
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.82;1" dur={`${pace.trip}s`} begin={begin} repeatCount="indefinite" />
                <path d={PACKET_PATH} transform={`translate(${PACKET_OFFSET} ${PACKET_OFFSET}) scale(${PACKET_CELL})`} fill={packet} />
              </g>
            );
          })
        ))}

      {/* A wide invisible stroke so the hairline is easy to hover. */}
      <path
        ref={hitRef}
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        className="react-flow__edge-interaction"
        onPointerEnter={(e) => setPointer({ x: e.clientX, y: e.clientY })}
        onPointerMove={(e) => setPointer((p) => p && { x: e.clientX, y: e.clientY })}
        onPointerLeave={() => setPointer(null)}
      />

      {link.broken && (
        <EdgeLabelRenderer>
          <span
            aria-hidden
            className="pointer-events-none absolute grid size-5 place-items-center rounded-full border border-border bg-panel text-bad/80"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <LinkBreak className="size-3" />
          </span>
        </EdgeLabelRenderer>
      )}

      {anchor &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="pointer-events-none fixed z-50 max-w-64 animate-in rounded-md border border-border-strong bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md shadow-black/40 duration-150 ease-snap fade-in-0"
          >
            <p>
              <span className="font-medium">{name}: {meta.label}.</span> <span className="text-muted-foreground">{meta.hint}</span>
            </p>
            {link.detail && <p className="mt-1 text-muted-foreground">{link.detail}</p>}
          </div>,
          document.body,
        )}
    </>
  );
});
