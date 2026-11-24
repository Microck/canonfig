import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

const tooltipSurface =
  "w-fit rounded-md border border-border-strong bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md shadow-black/40 has-data-[slot=kbd]:pr-1.5"

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // whitespace-pre-line: a "\n" in tooltip text starts a new line, so a longer tip can put each idea on its own line.
        className={cn(
          tooltipSurface,
          "z-50 max-w-xs origin-(--radix-tooltip-content-transform-origin) whitespace-pre-line duration-200 ease-snap data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-97 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-97 data-closed:duration-150",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/** A shortcut hint follows its control's hover and focus without adding a dismissable layer. */
function ShortcutHint({ children, hint, className }: { children: React.ReactNode; hint: React.ReactNode; className?: string }) {
  return (
    <span className={cn("group/shortcut relative inline-flex", className)}>
      {children}
      <span aria-hidden className="absolute top-full right-0 z-50 hidden pt-1.5 pointer-coarse:pointer-events-none group-hover/shortcut:block group-has-focus-visible/shortcut:block">
        <span className={cn(tooltipSurface, "flex items-center gap-1 whitespace-nowrap")}>{hint}</span>
      </span>
    </span>
  )
}

export { ShortcutHint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
