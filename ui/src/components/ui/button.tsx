import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/*
 * Button rule (u32). One variant language for the whole UI:
 * - primary: gold fill. The single commit/create action of a view (Publish, Add,
 *   Apply, Save). At most one per view. Gold on a button means "do the thing".
 * - default / secondary: neutral fill. Every other action, including onboarding
 *   and tour CTAs. Green is never a button fill: green and gold elsewhere are
 *   status colours (ok / warn) only.
 * - outline: neutral bordered, for toolbar and row actions.
 * - ghost: no chrome until hover, for low-weight and icon actions.
 * - link: inline text action, foreground with underline (not green).
 * - destructive: red text on a faint red tint, for every irreversible action
 *   (Stop syncing, Remove service, Abandon) and their confirm buttons.
 * Disabled (every variant): fill and shadow removed, dashed strong border, faint
 * text, not-allowed cursor, no hover or press feedback. No enabled variant uses
 * a dashed border, so a disabled control never reads as available, while the
 * border keeps a busy action ("Checking files...") reading as a button. Faint
 * text stays ~4.4:1 on the panel. Hover/press use `not-disabled:` (also matches asChild links).
 * Call sites pick a variant and must not restyle fills via className; the old
 * `goldButton` string (shared.tsx) is replaced by variant="primary".
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none transition-[scale] duration-150 ease-snap focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/60 not-disabled:active:not-aria-[haspopup]:scale-[0.97] disabled:cursor-not-allowed disabled:border-dashed disabled:border-border-strong disabled:bg-transparent disabled:text-faint disabled:shadow-none disabled:no-underline aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "bg-gold text-gold-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] not-disabled:hover:bg-gold-hover",
        default:
          "bg-secondary text-secondary-foreground not-disabled:hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)] aria-expanded:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)]",
        outline:
          "border-border bg-background not-disabled:hover:bg-muted not-disabled:hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:not-disabled:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground not-disabled:hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)] aria-expanded:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)]",
        ghost:
          "not-disabled:hover:bg-muted not-disabled:hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:not-disabled:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive not-disabled:hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:not-disabled:hover:bg-destructive/25 dark:focus-visible:ring-destructive/40",
        link: "text-foreground underline decoration-faint underline-offset-4 not-disabled:hover:decoration-foreground",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        // 28px matches Linear's header and toolbar controls.
        sm: "h-[28px] gap-1 rounded-lg px-2.5 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        // Secondary icon actions are 28px circles, like Linear's toolbar icon buttons.
        "icon-sm":
          "size-[28px] rounded-full in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
