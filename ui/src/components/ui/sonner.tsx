import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CheckCircle, Info, Warning, XCircle, HourglassMedium } from "@/components/icons"

/*
 * Each type tints its own toast: the icon takes the full state colour, the border a strong mix
 * of it and the background a faint one, both over the popover surface. Title and description
 * stay in the popover text colours so they keep their contrast. Success, warning and error use
 * the machine-state tokens (ok, warn, bad); info uses the focus violet (--ring), the guidance
 * hue, so it never reads as a status. Plain and loading toasts stay neutral.
 *
 * The mixes are set as --normal-bg/--normal-border on the toast element itself: Sonner's
 * unlayered stylesheet paints every toast from those variables, so overriding them per toast
 * wins without fighting its selectors (Tailwind's layered utilities would lose to them).
 * --tint picks the colour per type; the classes stay literal so Tailwind can find them.
 */
const TINTED =
  "[--normal-bg:color-mix(in_oklab,var(--tint)_12%,var(--popover))] [--normal-border:color-mix(in_oklab,var(--tint)_45%,var(--popover))]"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CheckCircle bold className="size-4 text-ok" />
        ),
        info: (
          <Info bold className="size-4 text-ring" />
        ),
        warning: (
          <Warning bold className="size-4 text-warn" />
        ),
        error: (
          <XCircle bold className="size-4 text-bad" />
        ),
        loading: (
          <HourglassMedium className="size-4" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // Sonner's stylesheet sets a system font stack on the toaster; inline wins, so toasts use Manrope.
          fontFamily: "var(--font-sans)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          // A "\n" in a description starts a new line: the outcome, what happens next and the demo note each get one.
          description: "whitespace-pre-line",
          success: `${TINTED} [--tint:var(--ok)]`,
          info: `${TINTED} [--tint:var(--ring)]`,
          warning: `${TINTED} [--tint:var(--warn)]`,
          error: `${TINTED} [--tint:var(--bad)]`,
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
