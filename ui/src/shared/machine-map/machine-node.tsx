// Machine map nodes: one card per machine, plus the dashed "Add machine" slot. A machine that reports its
// harnesses grows a body with its folder and harness cards (./harnesses).
import { memo, use, type ComponentProps } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowSquareOut, PaintBrush, Plus } from "@/components/icons";
import { cn, SNAP } from "@/lib/utils";
import { DitherShader, fillStyle, usePrefersReducedMotion } from "@/lib/dither";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Mono, StateLabel, Term } from "@/shared/shared";
import type { Follower, FollowerState, HarnessReport, ItemCategory } from "@/shared/metadata";
import { HarnessBody } from "./harnesses";
import { ADD_W, DEVICE_ICONS, HEADER_H, ICON_TILE_TINT, machineSize, MapActionsContext, NODE_H, type ResolvedLook } from "./model";

// Platform reads as a word ahead of the purpose: Solar has no brand logos, and a name is clearer than a 14px glyph
// behind a tooltip. It sits on the purpose line so the footer keeps its width for the revision and state.
const PLATFORM: Record<NonNullable<Follower["platform"]>, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

export type MachineNodeData = {
  kind: "source" | "follower";
  hostname: string;
  endpoint?: string;
  platform: Follower["platform"] | undefined;
  look: ResolvedLook;
  revision: number | null | undefined;
  latest: number | undefined;
  /** Follower state; `null` for the Source. */
  state: FollowerState | null;
  isSelf: boolean;
  /** Work in progress: a follower's Synchronization Run, or on the Source a publish or any run. */
  active: boolean;
  /** Source only: a new Profile Revision is being published. */
  publishing: boolean;
  /** The machine's managed harnesses, when it reports them; undefined keeps the plain card. */
  harnesses?: readonly HarnessReport[];
  /** Source only: the categories its Canonical Folder holds, shown as chips. */
  categories?: readonly ItemCategory[];
};
export type MachineNodeType = Node<MachineNodeData, "machine">;
export type AddNodeType = Node<Record<string, never>, "add">;

// The Source's glow: a soft dithered halo that drifts while data moves. The
// box runs past the card on every side; the card hides the centre, so only
// the falloff around it shows.
const GLOW_X = 96;
const GLOW_Y = 64;
const GLOW_FIELD = `
float field(vec2 uv, vec2 res, float t) {
  vec2 p = (uv - 0.5) * 2.0;
  vec2 drift = 0.06 * vec2(sin(t * 0.23), cos(t * 0.17));
  float body = 1.0 - smoothstep(0.15, 0.9, length(p - drift));
  float grain = smoothstep(0.2, 0.85, fbm(p * 2.2 + vec2(t * 0.08, -t * 0.06)));
  return pow(body, 1.4) * (0.15 + 0.85 * grain) * 0.8;
}
`;
const GLOW_PALETTE = ["transparent", "green"] as const;

function ToolbarButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <Button
      type="button"
      variant="outline"
      className={cn(
        "min-h-10 min-w-10 rounded-[5px] px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A machine's icon: a Solar preset, or the uploaded image drawn as a mask so only its alpha counts and it takes
 * the accent through `currentColor`, like the presets. Loaded as an image, an SVG upload never runs scripts or
 * fetches anything, so it needs no sanitising.
 */
export function LookIcon({ look, bold, className }: { look: Pick<ResolvedLook, "icon" | "iconSrc">; bold?: boolean; className?: string }) {
  if (look.icon !== "custom") {
    const { Icon } = DEVICE_ICONS[look.icon];
    return <Icon className={className} bold={bold} />;
  }
  const mask = `url("${look.iconSrc}") center / contain no-repeat`;
  return <span aria-hidden className={cn("block bg-current", className)} style={{ mask, WebkitMask: mask }} />;
}

export const MachineNode = memo(function MachineNode({ id, data, selected }: NodeProps<MachineNodeType>) {
  const { look } = data;
  const actions = use(MapActionsContext);
  const reduced = usePrefersReducedMotion();
  const customizing = actions.customizingId === id;
  // The sheet's machine keeps its ring even when the sheet was opened from outside the map.
  const lit = selected || customizing;
  const accent = look.color;
  // Revision 0 means nothing applied yet (a just-joined follower) or nothing published (a new Source): show it as missing.
  const revision = data.revision === 0 ? null : data.revision;
  const behind = data.kind === "follower" && data.latest !== undefined && revision !== undefined && (revision === null || revision < data.latest);
  const rich = data.harnesses !== undefined;
  const size = machineSize(data.harnesses?.length, data.categories !== undefined);

  const revisionText = revision === undefined ? "Revision not reported" : revision === null ? (
    "No revision yet"
  ) : (
    <span className="truncate font-mono">
      rev {revision}
      {behind && <span className="text-muted-foreground"> → {data.latest}</span>}
    </span>
  );
  const status = data.state ? (
    <StateLabel state={data.state} self={data.isSelf} />
  ) : data.publishing ? (
    <span className="text-sm text-ok">Publishing…</span>
  ) : (
    <span className="text-sm text-muted-foreground">
      <Term term={data.kind === "source" ? "Source Machine" : "Follower Machine"} />
    </span>
  );
  const identity = (
    <>
      <span
        className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-md"
        style={{ color: accent, backgroundColor: `color-mix(in oklab, ${accent} ${Math.round(ICON_TILE_TINT * 100)}%, transparent)` }}
      >
        <span aria-hidden className="absolute inset-0 opacity-70" style={fillStyle("gradient", { color: accent, cell: 1.5, edge: "bottom", length: 12, from: 0.5, to: 0 })} />
        {/* A working machine's tile carries a still hatch; the source's dither glow is the map's one moving signal. */}
        {data.active && <span aria-hidden className="absolute inset-0 opacity-30" style={fillStyle("hatched", { color: accent, cell: 1.5 })} />}
        <span aria-hidden className="absolute inset-0 rounded-md border" style={{ borderColor: `color-mix(in oklab, ${accent} 40%, transparent)` }} />
        <LookIcon look={look} bold={lit} className="relative size-5" />
      </span>
      <div className="min-w-0 flex-1">
        {/* A renamed machine shows only its chosen name; the hostname commands use stays in the tooltip and the Customize sheet. */}
        <div className="truncate text-lg leading-[18px] font-semibold text-foreground" title={look.name === data.hostname ? undefined : data.hostname}>{look.name}</div>
        <div className="truncate text-sm text-muted-foreground" title={data.endpoint}>
          {data.endpoint ? <Mono>{data.endpoint}</Mono> : <>{data.platform && <>{PLATFORM[data.platform]} · </>}{look.purpose || <span className="text-faint">No purpose set</span>}</>}
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Outside viewport scaling; above the Source, below followers, away from the edges between them. */}
      <NodeToolbar isVisible={selected} position={data.kind === "source" ? Position.Top : Position.Bottom} offset={8} align="end">
        <div
          className={cn(
            "nodrag nopan flex animate-in items-center gap-0.5 rounded-md border border-border-strong bg-popover p-0.5 shadow-md shadow-black/40 duration-150 ease-snap fade-in-0",
            data.kind === "source" ? "slide-in-from-bottom-1" : "slide-in-from-top-1",
          )}
        >
          <ToolbarButton onClick={() => actions.open(id)}>
            <ArrowSquareOut />
            Open
          </ToolbarButton>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToolbarButton aria-label={`Customize ${look.name}`} aria-expanded={customizing} onClick={() => actions.toggleCustomize(id)}>
                <PaintBrush bold={customizing} />
                Customize
              </ToolbarButton>
            </TooltipTrigger>
            <TooltipContent>Customize</TooltipContent>
          </Tooltip>
        </div>
      </NodeToolbar>

      {/* The map's only WebGL surface, mounted only while something is moving. */}
      <AnimatePresence>
        {data.kind === "source" && data.active && (
          <motion.div
            key="glow"
            aria-hidden
            className="pointer-events-none absolute"
            style={{ inset: `-${GLOW_Y}px -${GLOW_X}px` }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.8 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.6, ease: SNAP }}
          >
            <DitherShader field={GLOW_FIELD} palette={GLOW_PALETTE} cell={2} fps={16} stillTime={4} className="size-full" />
          </motion.div>
        )}
      </AnimatePresence>

      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        className={cn(
          "relative flex flex-col rounded-lg border bg-raised text-left shadow-sm shadow-black/30",
          lit ? "border-transparent" : "hover:border-border-strong",
        )}
        style={{
          width: size.w,
          height: size.h,
          boxShadow: lit ? `0 0 0 1px ${accent}, 0 0 0 4px color-mix(in oklab, ${accent} 16%, transparent)` : undefined,
        }}
      >
        {data.isSelf && (
          <span className="absolute -top-2 left-3 rounded-[4px] border border-border bg-raised px-1 text-xs leading-4 text-muted-foreground">
            This machine
          </span>
        )}
        {rich ? (
          <>
            {/* The film's header: revision and state move up beside the name, so the body can hold the harnesses. */}
            <div className="flex shrink-0 items-center gap-3 px-3" style={{ height: HEADER_H }}>
              {identity}
              <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-faint">
                {revisionText}
                {status}
              </div>
            </div>
            {/* Inside the card's 1px border on each side. */}
            <HarnessBody width={size.w - 2} harnesses={data.harnesses ?? []} categories={data.categories} self={data.isSelf} />
          </>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 items-center gap-3 px-3">{identity}</div>
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-t border-border px-3 text-xs">
              <span className="flex min-w-0 items-center gap-1.5 text-faint">{revisionText}</span>
              {status}
            </div>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
});

export const AddNode = memo(function AddNode() {
  const { invite } = use(MapActionsContext);
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Button
        type="button"
        variant="outline"
        onClick={invite}
        className="nodrag pointer-events-auto flex-col gap-2 border-border-strong px-3 text-center"
        style={{ width: ADD_W, height: NODE_H }}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border-strong">
          <Plus className="size-5" />
        </span>
        <span className="leading-tight">
          <span className="block font-medium">Add machine</span>
          <span className="block text-xs text-faint">Invite a follower</span>
        </span>
      </Button>
    </>
  );
});
