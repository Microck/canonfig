"use client"

import { Collapsible as CollapsiblePrimitive } from "radix-ui"
import { cn } from "cn"

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

/**
 * Opens and closes with a height + fade (collapsible-open/close keyframes in index.css).
 * Radix keeps the content mounted until the close animation ends and skips the animation
 * on first mount, so a group that starts open does not animate in.
 */
function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        "data-[state=open]:animate-[collapsible-open_200ms_var(--ease-snap)] data-[state=closed]:animate-[collapsible-close_150ms_var(--ease-snap)]",
        className
      )}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
