// Machine map nodes: one card per machine, plus the dashed "Add machine" slot.
import { memo, use, type ComponentProps } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from "@xyflow/react";
import { AppleLogo, ArrowSquareOut, LinuxLogo, PaintBrush, Plus, WindowsLogo, type Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { DitherShader, fillStyle, usePrefersReducedMotion } from "@/lib/dither";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StateLabel, Term } from "@/shared/shared";
import type { Follower, FollowerState } from "@/shared/data";
import { ACCENTS, ADD_W, DEVICE_ICONS, MapActionsContext, NODE_H, NODE_W, type ResolvedLook } from "./model";

const PLATFORM: Record<Follower["platform"], { label: string; Icon: Icon }> = {
  macos: { label: "macOS", Icon: AppleLogo },
  linux: { label: "Linux", Icon: LinuxLogo },
  windows: { label: "Windows", Icon: WindowsLogo },
};

export type MachineNodeData = {
  kind: "source" | "follower";
  hostname: string;
  platform: Follower["platform"];
  look: ResolvedLook;
  revision: number | null;
  latest: number;
  /** Follower state; `null` for the Source. */
  state: FollowerState | null;
  isSelf: boolean;
  /** Work in progress: a follower's Synchronization Run, or on the Source a publish or any run. */
  active: boolean;
  /** Source only: a new Profile Revision is being published. */
  publishing: boolean;
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
    <button
      type="button"
      className={cn(
        "inline-flex min-h-[40px] min-w-[40px] shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export const MachineNode = memo(function MachineNode({ id, data, selected }: NodeProps<MachineNodeType>) {
  const { look } = data;
  const actions = use(MapActionsContext);
  const reduced = usePrefersReducedMotion();
  const customizing = actions.customizingId === id;
  // The sheet's machine keeps its ring even when the sheet was opened from outside the map.
  const lit = selected || customizing;
  const { Icon } = DEVICE_ICONS[look.icon];
  const accent = ACCENTS[look.accent].color;
  // Revision 0 means nothing applied yet (a just-joined follower) or nothing published (a new Source): show it as missing.
  const revision = data.revision === 0 ? null : data.revision;
  const behind = data.kind === "follower" && (revision === null || revision < data.latest);

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
                <PaintBrush weight={customizing ? "fill" : "regular"} />
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
            transition={{ duration: reduced ? 0 : 0.6, ease: [0.175, 0.885, 0.32, 1.1] }}
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
          width: NODE_W,
          height: NODE_H,
          boxShadow: lit ? `0 0 0 1px ${accent}, 0 0 0 4px color-mix(in oklab, ${accent} 16%, transparent)` : undefined,
        }}
      >
        {data.isSelf && (
          <span className="absolute -top-2 left-3 rounded-[4px] border border-border bg-raised px-1 text-[10.5px] leading-4 text-muted-foreground">
            This machine
          </span>
        )}
        <div className="flex min-h-0 flex-1 items-center gap-3 px-3">
          <span
            className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-md"
            style={{ color: accent, backgroundColor: `color-mix(in oklab, ${accent} 9%, transparent)` }}
          >
            <span aria-hidden className="absolute inset-0 opacity-70" style={fillStyle("gradient", { color: accent, cell: 1.5, edge: "bottom", length: 12, from: 0.5, to: 0 })} />
            {data.active && <span aria-hidden className="cf-map-tile-run absolute inset-0 opacity-30" style={fillStyle("hatched", { color: accent, cell: 1.5 })} />}
            <span aria-hidden className="absolute inset-0 rounded-md border" style={{ borderColor: `color-mix(in oklab, ${accent} 40%, transparent)` }} />
            <Icon className="relative size-5" weight={lit ? "fill" : "regular"} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-[14px] leading-[18px] font-semibold text-foreground">{look.name}</span>
              {look.name !== data.hostname && <span className="truncate font-mono text-[11px] text-faint">{data.hostname}</span>}
            </div>
            <div className="truncate text-sm text-muted-foreground">{look.purpose || <span className="text-faint">No purpose set</span>}</div>
          </div>
        </div>
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-t border-border px-3 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 text-faint">
            <PlatformMark platform={data.platform} />
            {revision === null ? (
              "No revision yet"
            ) : (
              <span className="truncate font-mono">
                rev {revision}
                {behind && <span className="text-muted-foreground"> → {data.latest}</span>}
              </span>
            )}
          </span>
          {data.state ? (
            <StateLabel state={data.state} self={data.isSelf} />
          ) : data.publishing ? (
            <span className="text-sm text-ok">Publishing…</span>
          ) : (
            <span className="text-sm text-muted-foreground">
              <Term term="Source Machine" />
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
});

function PlatformMark({ platform }: { platform: Follower["platform"] }) {
  const { label, Icon } = PLATFORM[platform];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export const AddNode = memo(function AddNode() {
  const { invite } = use(MapActionsContext);
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <button
        type="button"
        onClick={invite}
        className="nodrag pointer-events-auto flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong px-3 text-center text-muted-foreground hover:border-faint hover:bg-raised/50 hover:text-foreground"
        style={{ width: ADD_W, height: NODE_H }}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-dashed border-border-strong">
          <Plus className="size-5" />
        </span>
        <span className="leading-tight">
          <span className="block font-medium">Add machine</span>
          <span className="block text-xs text-faint">Invite a follower</span>
        </span>
      </button>
    </>
  );
});
