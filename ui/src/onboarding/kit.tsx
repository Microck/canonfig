// Shared components for the simulated first-run flow.
import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";
import { CaretRight, Check, Copy, Question, WarningCircle } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger, Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { GLOSSARY, Logo } from "@/shared/shared";

/**
 * Moves focus to the returned element when it mounts. The flow swaps whole
 * screens (choice, wizard, finished), so without this the control the person
 * just used disappears and keyboard focus falls back to <body>.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/** Top bar for a machine that isn't set up yet: brand, machine, glossary. */
export function OnboardingShell({ hostname, children }: { hostname: string; children: ReactNode }) {
  const [help, setHelp] = useState(false);
  return (
    <div className="flex h-svh flex-col bg-canvas text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo />
          <span className="text-[13px] font-semibold tracking-[-0.01em]">canonfig</span>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <span className="truncate text-[13px] text-muted-foreground">{hostname}</span>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Glossary" onClick={() => setHelp(true)} className="text-muted-foreground">
          <Question />
        </Button>
      </header>
      <main className="mx-2 mb-2 min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-background">{children}</main>
      <Sheet open={help} onOpenChange={setHelp}>
        <SheetContent side="right" className="gap-0 border-border bg-panel p-0 data-[side=right]:w-[440px] data-[side=right]:sm:max-w-[440px]">
          <div className="border-b border-border px-6 pt-5 pb-4">
            <SheetTitle className="text-[15px] font-medium">Glossary</SheetTitle>
            <SheetDescription className="sr-only">Definitions of Canonfig terms.</SheetDescription>
          </div>
          <dl className="min-h-0 flex-1 divide-y divide-border overflow-y-auto px-6 pb-24">
            {Object.entries(GLOSSARY).map(([term, { plain, meaning }]) => (
              <div key={term} className="py-3.5">
                <dt className="font-medium">{plain.charAt(0).toUpperCase() + plain.slice(1)}</dt>
                <dd className="mt-1 leading-relaxed text-muted-foreground">
                  {meaning} <span className="text-faint">Canonfig calls this {term}.</span>
                </dd>
              </div>
            ))}
          </dl>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function RadioRow({
  value,
  title,
  description,
  icon: Icon,
  children,
  className,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50",
        "has-data-[state=checked]:border-border-strong has-data-[state=checked]:bg-raised",
        className,
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-px" />
      {Icon && <Icon className="mt-px size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className="block leading-none font-medium">{title}</span>
        {description && <span className="mt-1.5 block text-sm text-muted-foreground">{description}</span>}
        {children}
      </span>
    </label>
  );
}

/** A copyable block of commands. Lines starting with `#` are notes, not commands. */
function CodeBlock({ lines, className }: { lines: string[]; className?: string }) {
  const [copied, setCopied] = useState(false);
  // Confirm only once the browser accepts the write; a denied or missing clipboard says so instead.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      toast.error("Couldn't copy. Select the text and copy it by hand.");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={cn("relative rounded-md border border-border bg-canvas/70", className)}>
      <pre className="px-3 py-2.5 pr-10 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">
        {lines.map((line, i) => (
          <div key={i} className={cn("pl-[2ch] -indent-[2ch]", line.startsWith("#") && "text-faint")}>
            {!line.startsWith("#") && <span className="text-faint select-none">$ </span>}
            {line}
          </div>
        ))}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? "Copied" : "Copy commands"}
        className="absolute top-1.5 right-1.5 text-faint hover:text-foreground"
        onClick={copy}
      >
        {copied ? <Check className="text-ok" /> : <Copy />}
      </Button>
    </div>
  );
}

/** Quiet disclosure with the CLI commands that do the same thing. */
export function CliEquivalent({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <Collapsible className={cn("text-sm", className)}>
      <DisclosureTrigger>Command line equivalent</DisclosureTrigger>
      <CollapsibleContent>
        <CodeBlock lines={lines} className="mt-2" />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Shown instead of the hint once the person has tried to continue. */
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? <FieldError id={htmlFor && `${htmlFor}-error`}>{error}</FieldError> : hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Inline error next to the control that caused it: colour, icon and text. */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-sm text-bad">
      <WarningCircle className="mt-0.5 size-3.5 shrink-0" />
      {children}
    </p>
  );
}

export function Stepper({ steps, step }: { steps: string[]; step: number }) {
  return (
    <ol aria-label="Steps" className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
      {steps.map((title, i) => (
        <li key={title} className="flex items-center gap-2" aria-current={i === step ? "step" : undefined}>
          <span
            className={cn(
              "grid size-[18px] place-items-center rounded-full border text-[11px] font-medium tabular-nums",
              i < step && "border-transparent bg-ok/15 text-ok",
              i === step && "border-foreground/50 text-foreground",
              i > step && "border-border text-faint",
            )}
          >
            {i < step ? (
              <>
                <Check aria-hidden weight="bold" className="size-3" />
                <span className="sr-only">Done:</span>
              </>
            ) : (
              i + 1
            )}
          </span>
          <span className={cn(i === step ? "text-foreground" : i < step ? "text-muted-foreground" : "text-faint")}>{title}</span>
          {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-5 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

/** Small key/value lines. */
export function Facts({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[120px_1fr] gap-x-4 gap-y-2", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Run a fake job: ticks progress 0..100 then resolves. */
export function simulate(ms: number, onTick: (value: number) => void, onDone: () => void) {
  const started = performance.now();
  const id = window.setInterval(() => {
    const value = Math.min(100, ((performance.now() - started) / ms) * 100);
    onTick(value);
    if (value >= 100) {
      window.clearInterval(id);
      onDone();
    }
  }, 60);
  return () => window.clearInterval(id);
}

/** Quiet disclosure label, for "Advanced" fields and the CLI equivalent. */
export function DisclosureTrigger({ children }: { children: ReactNode }) {
  return (
    <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded-sm text-sm text-faint hover:text-muted-foreground">
      <CaretRight className="size-3.5 transition-transform duration-150 ease-snap group-data-[state=open]:rotate-90" />
      {children}
    </CollapsibleTrigger>
  );
}
