// The side sheet that changes how one machine looks in this app.
import { useId } from "react";
import { motion } from "motion/react";
import { RadioGroup } from "radix-ui";
import { ArrowCounterClockwise, X } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePrefersReducedMotion } from "@/lib/dither";
import { Hint } from "@/shared/shared";
import { ACCENTS, DEVICE_ICONS, mapStore, type Accent, type DeviceIcon, type Look, type ResolvedLook } from "./model";

const SNAP = [0.175, 0.885, 0.32, 1.1] as const;

export interface CustomizeSheetProps {
  id: string;
  hostname: string;
  /** What the user saved, so cleared fields show the default as a placeholder. */
  saved: Look | undefined;
  look: ResolvedLook;
  onClose: () => void;
}

export function CustomizeSheet({ id, hostname, saved, look, onClose }: CustomizeSheetProps) {
  const uid = useId();
  // Reduced motion keeps the fade (a state change) and drops the slide.
  const slide = usePrefersReducedMotion() ? 0 : 12;
  const set = (patch: Look) => mapStore.setLook(id, patch);

  return (
    <motion.aside
      role="dialog"
      aria-labelledby={`${uid}-title`}
      initial={{ opacity: 0, x: slide }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: slide, transition: { duration: 0.15 } }}
      transition={{ duration: 0.18, ease: SNAP }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      className="absolute top-2 right-2 z-10 flex max-h-[calc(100%-1rem)] w-[284px] flex-col overflow-hidden rounded-lg border border-border-strong bg-popover shadow-xl shadow-black/50"
    >
      <header className="flex items-start gap-2 border-b border-border px-3.5 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 id={`${uid}-title`} className="truncate font-medium">
            Customize {look.name}
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
            Only changes how it looks here
            <Hint label="where these changes apply">
              These settings only change how this machine looks in canonfig ui on this computer. Nothing is sent to the Source or to
              other machines, and its hostname stays <span className="font-mono">{hostname}</span>.
            </Hint>
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-mt-0.5 -mr-1.5 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-3.5 py-3.5">
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-name`}>Name</Label>
          <Input
            id={`${uid}-name`}
            autoFocus
            maxLength={32}
            value={saved?.name ?? ""}
            placeholder={hostname}
            onChange={(e) => set({ name: e.target.value })}
          />
          <p className="text-xs text-faint">
            Commands still use the hostname, <span className="font-mono">{hostname}</span>.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-purpose`}>Purpose</Label>
          <Input
            id={`${uid}-purpose`}
            maxLength={40}
            value={saved?.purpose ?? look.purpose}
            placeholder="e.g. Work laptop"
            onChange={(e) => set({ purpose: e.target.value })}
          />
        </div>

        <div className="grid gap-1.5">
          <span id={`${uid}-icon`} className="text-sm font-medium">
            Icon
          </span>
          <RadioGroup.Root
            aria-labelledby={`${uid}-icon`}
            value={look.icon}
            onValueChange={(v) => set({ icon: v as DeviceIcon })}
            className="grid grid-cols-6 gap-1"
          >
            {(Object.keys(DEVICE_ICONS) as DeviceIcon[]).map((key) => {
              const { label, Icon } = DEVICE_ICONS[key];
              const checked = key === look.icon;
              return (
                <Tooltip key={key}>
                  <TooltipTrigger asChild>
                    <RadioGroup.Item
                      value={key}
                      aria-label={label}
                      className="grid h-9 place-items-center rounded-md border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground data-[state=checked]:border-border-strong data-[state=checked]:bg-raised data-[state=checked]:text-foreground"
                      style={checked ? { color: ACCENTS[look.accent].color } : undefined}
                    >
                      <Icon className="size-[18px]" weight={checked ? "fill" : "regular"} />
                    </RadioGroup.Item>
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              );
            })}
          </RadioGroup.Root>
        </div>

        <div className="grid gap-1.5">
          <span id={`${uid}-accent`} className="text-sm font-medium">
            Accent
          </span>
          <RadioGroup.Root
            aria-labelledby={`${uid}-accent`}
            value={look.accent}
            onValueChange={(v) => set({ accent: v as Accent })}
            className="flex gap-2"
          >
            {(Object.keys(ACCENTS) as Accent[]).map((key) => (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <RadioGroup.Item
                    value={key}
                    aria-label={ACCENTS[key].label}
                    className="grid size-7 place-items-center rounded-full border border-transparent hover:border-border-strong data-[state=checked]:border-foreground/70"
                  >
                    <span className="size-[18px] rounded-full" style={{ backgroundColor: ACCENTS[key].color }} />
                  </RadioGroup.Item>
                </TooltipTrigger>
                <TooltipContent>{ACCENTS[key].label}</TooltipContent>
              </Tooltip>
            ))}
          </RadioGroup.Root>
        </div>
      </div>

      <footer className="border-t border-border px-2 py-1.5">
        <button
          type="button"
          disabled={!saved}
          onClick={() => mapStore.resetLook(id)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:text-faint [&_svg]:size-3.5"
        >
          <ArrowCounterClockwise />
          Reset this machine's look
        </button>
      </footer>
    </motion.aside>
  );
}
