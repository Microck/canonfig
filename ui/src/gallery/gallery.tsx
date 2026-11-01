// TEMPORARY component gallery, mounted by main.tsx. See main.tsx for when to delete it.
// Every component the GUI uses, rendered live with its variants, so each can be refined in isolation.
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import * as Icons from "@/components/icons";
import { ArrowRight, Laptop, PaperPlaneTilt, Desktop, SlidersHorizontal } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BloomBox, DitherPattern, DitherShader, DITHER_COLOR_NAMES, FILL_VARIANTS, FillPattern, fillStyle } from "@/lib/dither";
import { STATE_META, followers as demoFollowers, type FollowerState } from "@/shared/data";
import { DemoSwitcher } from "@/shared/demo-switcher";
import { MachineMap } from "@/shared/machine-map/machine-map";
import { AnimatedNumber, DitherBlock, DitherProgress, Hint, Logo, Mono, StateBand, StateCell, StateLabel, StatusMark, Term, type StatusKind } from "@/shared/shared";
import { CliEquivalent, DisclosureTrigger, Facts, Field as OnboardingField, FieldError, OnboardingShell, RadioRow, Stepper } from "@/onboarding/kit";
import { Tour, type TourStep } from "@/tour/tour";
import { ActionTag, Attention } from "@/workspace/follower";
import { Count, Palette, Sidebar } from "@/workspace/frame";
import { ChapterPicker, GetStarted, TourOffer, TourPicker } from "@/workspace/guide";
import {
  AnimatedRow,
  Body,
  ChangeMark,
  Cli,
  CommandBox,
  DetailPanel,
  EmptyState,
  Field,
  GroupChips,
  GroupRow,
  KIND_ICON,
  ListHead,
  ListRow,
  PageHeader,
  Prop,
  PublishButton,
  RowPresence,
  SectionLabel,
  SettingRow,
  StateHeader,
  Toolbar,
  ToolbarTab,
  WithCode,
  settingsGroup,
} from "@/workspace/kit";
import { InviteDialog } from "@/workspace/machines";
import { ScheduleFields, TimeField, type Schedule } from "@/workspace/schedule";
import { ConfirmDialog } from "@/workspace/settings";
import { PublishDialog, StatusRow } from "@/workspace/source";
import { WorkspaceProvider, useWorkspace, type View } from "@/workspace/store";
import { parseRoute, workspaceHref } from "@/workspace/routes";

/* ------------------------------------------------------------------------------------------------
 * Source locations. Read from the files themselves so the file:line labels follow edits made while
 * refining. Dev-only page, so bundling every source file as text costs nothing in the product.
 * ---------------------------------------------------------------------------------------------- */

const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

/** `?only=<id>`: render that one section full width. */
const only = new URLSearchParams(location.search).get("only");

/** 1-based line of `symbol`'s declaration in `file`. Throws so a renamed component can't leave a stale label. */
function lineOf(file: string, symbol: string) {
  const text = SOURCES[`/${file}`];
  if (text === undefined) throw new Error(`Gallery: no source file ${file}`);
  const match = new RegExp(`^(?:export\\s+)?(?:function|const)\\s+${symbol}\\b`, "m").exec(text);
  if (!match) throw new Error(`Gallery: ${symbol} is not declared in ${file}`);
  return text.slice(0, match.index).split("\n").length;
}

/* ------------------------------------------------------------------------------------------------
 * Layout helpers and fixtures
 * ---------------------------------------------------------------------------------------------- */

/** One labelled variant line: the state name on the left, the live component(s) on the right. */
function Variant({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)] items-center gap-4 py-2">
      <span className="font-mono text-xs text-faint">{label}</span>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-3", className)}>{children}</div>
    </div>
  );
}

/** A framed surface like the app's content panel, for components that expect to sit on it. */
function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-lg border border-border bg-panel", className)}>{children}</div>;
}

/**
 * A seeded demo workspace for components that read `useWorkspace`. Each fixture owns its route, so
 * navigation inside it (tabs, sidebar links) stays local and never touches the page URL.
 */
function Ws({ role = "source", view = "overview", children }: { role?: "source" | "follower"; view?: View; children: ReactNode }) {
  const [href, setHref] = useState(() => workspaceHref(role, view));
  const route = parseRoute(href);
  if (route.kind !== "workspace") throw new Error(`Gallery fixture route ${href} is not a workspace route`);
  return (
    <WorkspaceProvider route={route} navigate={setHref}>
      {children}
    </WorkspaceProvider>
  );
}

const STATES = ["converged", "drift", "human-action", "failed", "offline", "never-synced", "excluded"] as const satisfies readonly (FollowerState | "excluded")[];
const STATUS_KINDS: StatusKind[] = ["ok", "warn", "act", "bad", "offline", "off"];
const TONES = ["ok", "warn", "act", "bad", "muted", "purple"] as const;
// Every StateBand motion character; running replaces the tone's own motion, so one running band covers it.
const STATE_BANDS = [
  { tone: "ok", mode: "idle", motion: "drift" },
  { tone: "warn", mode: "idle", motion: "breath" },
  { tone: "act", mode: "idle", motion: "flow right" },
  { tone: "bad", mode: "idle", motion: "glitch" },
  { tone: "muted", mode: "idle", motion: "near still" },
  { tone: "ok", mode: "running", motion: "sweep" },
] as const;
const FOCUS_LOOK = "border-ring ring-2 ring-ring/60";

/* ------------------------------------------------------------------------------------------------
 * Primitives (src/components/ui)
 * ---------------------------------------------------------------------------------------------- */

const BUTTON_VARIANTS = ["primary", "default", "secondary", "outline", "ghost", "destructive", "link"] as const;

function ButtonDemo() {
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-x-3 border-spacing-y-2 text-left">
        <thead className="font-mono text-xs text-faint">
          <tr>
            <th className="font-normal">variant</th>
            {["xs", "sm", "default", "lg", "icon-xs", "icon-sm", "icon", "icon-lg", "disabled", "aria-expanded", "focus look", "icon start / end"].map((h) => (
              <th key={h} className="font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BUTTON_VARIANTS.map((variant) => (
            <tr key={variant}>
              <td className="font-mono text-xs text-faint">{variant}</td>
              {(["xs", "sm", "default", "lg"] as const).map((size) => (
                <td key={size}>
                  <Button variant={variant} size={size}>
                    Publish
                  </Button>
                </td>
              ))}
              {(["icon-xs", "icon-sm", "icon", "icon-lg"] as const).map((size) => (
                <td key={size}>
                  <Button variant={variant} size={size} aria-label="Settings">
                    <SlidersHorizontal />
                  </Button>
                </td>
              ))}
              <td>
                <Button variant={variant} disabled>
                  Checking files…
                </Button>
              </td>
              <td>
                <Button variant={variant} aria-expanded>
                  Open menu
                </Button>
              </td>
              <td>
                <Button variant={variant} className={FOCUS_LOOK}>
                  Focused
                </Button>
              </td>
              <td className="whitespace-nowrap">
                <Button variant={variant} size="sm">
                  <PaperPlaneTilt data-icon="inline-start" /> Send
                </Button>{" "}
                <Button variant={variant} size="sm">
                  Next <ArrowRight data-icon="inline-end" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InputDemo() {
  return (
    <div className="max-w-md">
      <Variant label="empty, placeholder">
        <Input placeholder="~/.config/canonfig" />
      </Variant>
      <Variant label="with value">
        <Input defaultValue="atlas.local:17342" />
      </Variant>
      <Variant label="focus look">
        <Input defaultValue="focused" className={FOCUS_LOOK} />
      </Variant>
      <Variant label="aria-invalid">
        <Input defaultValue="not a path" aria-invalid />
      </Variant>
      <Variant label="disabled">
        <Input defaultValue="Can't edit" disabled />
      </Variant>
      <Variant label="readOnly">
        <Input defaultValue="read only value" readOnly />
      </Variant>
      <Variant label="password">
        <Input type="password" defaultValue="hunter22" />
      </Variant>
    </div>
  );
}

function TextareaDemo() {
  return (
    <div className="max-w-md">
      <Variant label="placeholder">
        <Textarea placeholder="Why this change?" />
      </Variant>
      <Variant label="with value">
        <Textarea defaultValue={"model = \"gpt-5-codex\"\napproval_policy = \"on-request\""} />
      </Variant>
      <Variant label="aria-invalid">
        <Textarea defaultValue="broken = [" aria-invalid />
      </Variant>
      <Variant label="disabled">
        <Textarea defaultValue="Can't edit" disabled />
      </Variant>
    </div>
  );
}

function CheckboxDemo() {
  const rows: [string, Partial<{ checked: "indeterminate"; defaultChecked: boolean; disabled: boolean; "aria-invalid": boolean }>][] = [
    ["unchecked", {}],
    ["checked", { defaultChecked: true }],
    ["indeterminate", { checked: "indeterminate" }],
    ["aria-invalid", { "aria-invalid": true }],
    ["disabled", { disabled: true }],
    ["disabled checked", { disabled: true, defaultChecked: true }],
  ];
  return rows.map(([label, props], i) => (
    <Variant key={label} label={label}>
      <Checkbox id={`gallery-cb-${i}`} {...props} />
      <Label htmlFor={`gallery-cb-${i}`}>gpu</Label>
    </Variant>
  ));
}

function SwitchDemo() {
  return (["default", "sm"] as const).map((size) => (
    <Variant key={size} label={`size ${size}`}>
      <Switch size={size} aria-label="Off" />
      <Switch size={size} defaultChecked aria-label="On" />
      <Switch size={size} disabled aria-label="Disabled off" />
      <Switch size={size} disabled defaultChecked aria-label="Disabled on" />
    </Variant>
  ));
}

function RadioGroupDemo() {
  return (
    <>
      <Variant label="vertical, one disabled">
        <RadioGroup defaultValue="daily" aria-label="Cadence">
          {[
            ["daily", "Every day"],
            ["weekdays", "Weekdays"],
            ["days", "Pick days"],
          ].map(([value, label]) => (
            <div key={value} className="flex items-center gap-2">
              <RadioGroupItem id={`rg-${value}`} value={value} disabled={value === "days"} />
              <Label htmlFor={`rg-${value}`}>{label}</Label>
            </div>
          ))}
        </RadioGroup>
      </Variant>
      <Variant label="inside settingsGroup">
        <RadioGroup defaultValue="b" aria-label="Rule" className={cn(settingsGroup, "w-80")}>
          {["a", "b", "c"].map((v) => (
            <Label key={v} htmlFor={`rg2-${v}`} className="flex min-h-9 cursor-pointer items-center gap-2 px-4 py-2 text-base font-normal hover:bg-raised/40">
              <RadioGroupItem id={`rg2-${v}`} value={v} />
              Option {v.toUpperCase()}
            </Label>
          ))}
        </RadioGroup>
      </Variant>
      <Variant label="aria-invalid">
        <RadioGroup aria-label="Invalid">
          <RadioGroupItem value="x" aria-invalid aria-label="Invalid option" />
        </RadioGroup>
      </Variant>
    </>
  );
}

function SelectBox({ size, disabled, invalid, placeholder }: { size?: "sm" | "default"; disabled?: boolean; invalid?: boolean; placeholder?: boolean }) {
  return (
    <Select defaultValue={placeholder ? undefined : "codex"} disabled={disabled}>
      <SelectTrigger size={size} aria-invalid={invalid || undefined} className="w-48" aria-label="Harness">
        <SelectValue placeholder="Choose a harness" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Harness</SelectLabel>
          <SelectItem value="codex">Codex CLI</SelectItem>
          <SelectItem value="claude">Claude Code</SelectItem>
          <SelectItem value="custom" disabled>
            Custom (disabled)
          </SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Other</SelectLabel>
          <SelectItem value="none">None</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function SelectDemo() {
  return (
    <>
      <Variant label="default size">
        <SelectBox />
      </Variant>
      <Variant label="size sm">
        <SelectBox size="sm" />
      </Variant>
      <Variant label="placeholder">
        <SelectBox placeholder />
      </Variant>
      <Variant label="aria-invalid">
        <SelectBox invalid />
      </Variant>
      <Variant label="disabled">
        <SelectBox disabled />
      </Variant>
    </>
  );
}

function DropdownDemo() {
  const [compact, setCompact] = useState(true);
  const [sort, setSort] = useState("name");
  return (
    <Variant label="trigger">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" data-gallery-trigger="dropdown">
            Open menu
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>atlas, the Source</DropdownMenuLabel>
          <DropdownMenuGroup>
            <DropdownMenuItem>
              Copy profile file path <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>Source service settings</DropdownMenuItem>
            <DropdownMenuItem disabled>Disabled item</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={compact} onCheckedChange={setCompact}>
            Compact rows
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
            <DropdownMenuRadioItem value="name">Sort by name</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="state">Sort by state</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Sub item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem inset>Inset item</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Stop syncing…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Variant>
  );
}

function DialogDemo() {
  return (
    <>
      <Variant label="header, body, footer">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" data-gallery-trigger="dialog">
              Open dialog
            </Button>
          </DialogTrigger>
          <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Discard unsaved changes?</DialogTitle>
              <DialogDescription className="text-base text-pretty">Your edits to the Codex config aren't saved. Leaving now discards them.</DialogDescription>
            </DialogHeader>
            <Cli wrap>canonfig profile edit codex-config --discard</Cli>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Keep editing</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button variant="destructive">Discard changes</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Variant>
      <Variant label="no close button, footer close">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Open plain dialog</Button>
          </DialogTrigger>
          <DialogContent showCloseButton={false} className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Plain dialog</DialogTitle>
              <DialogDescription>No corner X; the footer's built-in Close is the way out.</DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton />
          </DialogContent>
        </Dialog>
      </Variant>
    </>
  );
}

function SheetDemo() {
  return (
    <Variant label="sides">
      {(["right", "left", "top", "bottom"] as const).map((side) => (
        <Sheet key={side}>
          <SheetTrigger asChild>
            <Button variant="outline" data-gallery-trigger={side === "right" ? "sheet" : undefined}>
              Open {side}
            </Button>
          </SheetTrigger>
          <SheetContent side={side}>
            <SheetHeader>
              <SheetTitle>Sheet from the {side}</SheetTitle>
              <SheetDescription>Mobile navigation and the glossary use this.</SheetDescription>
            </SheetHeader>
            <p className="px-4 text-muted-foreground">Content.</p>
            <SheetFooter>
              <SheetClose asChild>
                <Button variant="secondary">Close</Button>
              </SheetClose>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      ))}
    </Variant>
  );
}

function PopoverDemo() {
  return (
    <Variant label="trigger">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" data-gallery-trigger="popover">
            Open popover
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <PopoverHeader>
            <PopoverTitle>Popover title</PopoverTitle>
            <PopoverDescription>The time field's half-hour list is the one popover in the app.</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    </Variant>
  );
}

function TooltipDemo() {
  const [pinned, setPinned] = useState(false);
  return (
    <>
      <Variant label="hover or focus">
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <Tooltip key={side}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" data-gallery-trigger={side === "top" ? "tooltip" : undefined}>
                {side}
              </Button>
            </TooltipTrigger>
            <TooltipContent side={side}>Tooltip on the {side}</TooltipContent>
          </Tooltip>
        ))}
      </Variant>
      <Variant label="with Kbd">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close details">
              <Icons.X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Close <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
      </Variant>
      <Variant label="controlled, pinned open">
        <Tooltip open={pinned} onOpenChange={setPinned}>
          <TooltipTrigger asChild>
            <span className="text-sm text-muted-foreground">Anchor</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 text-sm">A long tooltip body wraps at max-w-64, like glossary terms and state hints do.</TooltipContent>
        </Tooltip>
        <Button size="xs" variant="secondary" onClick={() => setPinned((p) => !p)}>
          {pinned ? "Unpin" : "Pin open"}
        </Button>
      </Variant>
    </>
  );
}

function CommandDemo() {
  const [open, setOpen] = useState(false);
  const body = (
    <>
      <CommandInput placeholder="Type a command or page…" />
      <CommandList className="max-h-[300px]">
        <CommandEmpty className="text-sm text-muted-foreground">No matching page or action.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem>
            <PaperPlaneTilt className="text-muted-foreground" />
            Publish revision 9<CommandShortcut className="text-xs tracking-normal tabular-nums">3 changes</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <Icons.UsersThree className="text-muted-foreground" />
            Disabled action
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Go to">
          <CommandItem>
            <Icons.SquaresFour className="text-muted-foreground" />
            Overview
          </CommandItem>
          <CommandItem>
            <Icons.FileCode className="text-muted-foreground" />
            Profile
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </>
  );
  return (
    <>
      <Variant label="inline Command">
        <Command className="max-w-md border border-border">{body}</Command>
      </Variant>
      <Variant label="CommandDialog">
        <Button variant="outline" onClick={() => setOpen(true)} data-gallery-trigger="command">
          Open command dialog
        </Button>
        <CommandDialog open={open} onOpenChange={setOpen} className="sm:max-w-[520px]">
          <Command>{body}</Command>
        </CommandDialog>
      </Variant>
    </>
  );
}

function ToastDemo() {
  const fire: [string, () => void][] = [
    ["toast", () => toast("Command copied", { description: "canonfig publish --reviewer you" })],
    ["success", () => toast.success("Revision 9 published")],
    ["info", () => toast.info("Get started is hidden", { description: "Bring it back from search (Ctrl K)." })],
    ["warning", () => toast.warning("Two machines can't reach the Source")],
    ["error", () => toast.error("Couldn't copy. Select the text and copy it by hand.")],
    ["loading", () => toast.loading("Checking files…")],
    ["action", () => toast("Machine removed", { action: { label: "Undo", onClick: () => toast("Restored") } })],
  ];
  return (
    <Variant label="fire one">
      {fire.map(([label, run]) => (
        <Button key={label} variant="outline" size="sm" onClick={run} data-gallery-trigger={label === "toast" ? "toast" : undefined}>
          {label}
        </Button>
      ))}
      <Button variant="ghost" size="sm" onClick={() => toast.dismiss()}>
        Dismiss all
      </Button>
    </Variant>
  );
}

function CollapsibleDemo() {
  return (
    <Variant label="trigger + content">
      <Collapsible className="grid gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm" className="w-fit" data-gallery-trigger="collapsible">
            Toggle details
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="text-muted-foreground">Hidden content, shown while open.</CollapsibleContent>
      </Collapsible>
    </Variant>
  );
}

function IconsDemo() {
  const icons = Object.entries(Icons).filter((entry): entry is [string, Icons.IconComponent] => typeof entry[1] === "function");
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1">
      {icons.map(([name, Icon]) => (
        <div key={name} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised/50">
          <Icon className="size-4" />
          <Icon bold className="size-4" />
          <span className="truncate font-mono text-xs text-muted-foreground">{name}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Shared (src/shared)
 * ---------------------------------------------------------------------------------------------- */

function AnimatedNumberDemo() {
  const [value, setValue] = useState(9);
  return (
    <Variant label="value, then change it">
      <AnimatedNumber value={value} className="text-2xl" />
      <AnimatedNumber value={value * 1000} format={(n) => n.toLocaleString("en-US")} className="text-base text-muted-foreground" />
      <Button size="xs" variant="secondary" onClick={() => setValue((v) => v - 1)} data-gallery-trigger="animated-number">
        −1
      </Button>
      <Button size="xs" variant="secondary" onClick={() => setValue((v) => v + 1)}>
        +1
      </Button>
      <Button size="xs" variant="secondary" onClick={() => setValue((v) => v + 10)}>
        +10
      </Button>
    </Variant>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Workspace kit (src/workspace/kit.tsx) and screen pieces
 * ---------------------------------------------------------------------------------------------- */

const LIST_COLS = "16px minmax(150px,240px) minmax(140px,1fr) 180px 160px";

/** ListHead, GroupRow and ListRow as Profile and Machines use them; a click opens the DetailPanel. */
function ListDemo() {
  const [selected, setSelected] = useState<string | null>(null);
  const row = demoFollowers.find((f) => f.id === selected);
  return (
    <Panel className="flex h-[420px]">
      <Body
        detail={
          row && (
            <DetailPanel
              title={row.name}
              subtitle={<StateLabel state={row.state} />}
              onClose={() => setSelected(null)}
              footer={
                <>
                  <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                    Close
                  </Button>
                  <Button variant="primary" size="sm" className="ml-auto">
                    Save
                  </Button>
                </>
              }
            >
              <div className="px-4 py-3">
                <Prop label="System">{row.platform}</Prop>
                <Prop label="Revision">{row.revision ?? "none yet"}</Prop>
                <Prop label="Groups">
                  <GroupChips groups={row.groups} />
                </Prop>
                <Prop label="Last update">{row.lastRun}</Prop>
              </div>
            </DetailPanel>
          )
        }
      >
        <ListHead cols={LIST_COLS} minWidth={720}>
          <span />
          <span>Name</span>
          <span>Groups</span>
          <span>State</span>
          <span>Last update</span>
        </ListHead>
        <GroupRow icon={KIND_ICON.config} label="Machines" count={demoFollowers.length} hint="GroupRow: a band over one kind of row. The (?) shows on hover." minWidth={720} />
        {demoFollowers.map((f, i) => (
          <ListRow key={f.id} cols={LIST_COLS} minWidth={720} selected={f.id === selected} onClick={() => setSelected(f.id)}>
            <ChangeMark change={(["added", "modified", "removed", undefined] as const)[i % 4]} />
            <span className="truncate font-medium">{f.name}</span>
            <GroupChips groups={f.groups} />
            <StateLabel state={f.state} />
            <span className="text-sm text-muted-foreground">{f.lastRun}</span>
          </ListRow>
        ))}
        <ListRow cols={LIST_COLS} minWidth={720}>
          <span />
          <span className="text-muted-foreground">Static row (no onClick)</span>
        </ListRow>
      </Body>
    </Panel>
  );
}

function AnimatedRowDemo() {
  const [rows, setRows] = useState(["codex-config", "claude-settings", "gh-cli"]);
  const [n, setN] = useState(1);
  return (
    <div className="max-w-md">
      <div className="mb-2 flex gap-2">
        <Button
          size="xs"
          variant="secondary"
          data-gallery-trigger="animated-row"
          onClick={() => {
            setRows((r) => [...r, `new-item-${n}`]);
            setN(n + 1);
          }}
        >
          Add row
        </Button>
        <Button size="xs" variant="secondary" disabled={rows.length === 0} onClick={() => setRows((r) => r.slice(0, -1))}>
          Remove last
        </Button>
      </div>
      <div className="border-t border-border">
        <RowPresence>
          {rows.map((r) => (
            <AnimatedRow key={r}>
              <div className="flex h-9 items-center gap-2 border-b border-border/70 px-1 text-base">
                <ChangeMark change="added" />
                {r}
              </div>
            </AnimatedRow>
          ))}
        </RowPresence>
      </div>
    </div>
  );
}

function TimeFieldDemo() {
  const [time, setTime] = useState("09:00");
  const [bad, setBad] = useState("9:7");
  return (
    <>
      <Variant label="valid (click to open)">
        <TimeField id="gallery-time" value={time} onChange={setTime} invalid={false} />
      </Variant>
      <Variant label="invalid">
        <TimeField id="gallery-time-bad" value={bad} onChange={setBad} invalid />
      </Variant>
    </>
  );
}

function ScheduleFieldsDemo() {
  const [own, setOwn] = useState<Schedule>({ cadence: "default", days: [], time: "09:00" });
  const [custom, setCustom] = useState<Schedule>({ cadence: "days", days: [], time: "9:" });
  return (
    <div className="grid max-w-3xl gap-8 lg:grid-cols-2">
      <div>
        <p className="mb-2 font-mono text-xs text-faint">with defaultLabel (follower)</p>
        <ScheduleFields idPrefix="gallery-sched-a" value={own} onChange={setOwn} defaultLabel="daily at 09:00" />
      </div>
      <div>
        <p className="mb-2 font-mono text-xs text-faint">pick days, both errors</p>
        <ScheduleFields idPrefix="gallery-sched-b" value={custom} onChange={setCustom} />
      </div>
    </div>
  );
}

function ConfirmDialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <Variant label="trigger">
      <Button variant="destructive" onClick={() => setOpen(true)} data-gallery-trigger="confirm-dialog">
        Remove service…
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remove the Source service?"
        body="Machines can't fetch new revisions until you install it again."
        confirm="Remove service"
        onConfirm={() => toast("Service removed")}
        cli="canonfig source service remove"
      />
    </Variant>
  );
}

/** Opens one of the workspace's own dialogs, mounted in the same fixture as in Frame. */
function WsDialogTrigger({ which }: { which: "palette" | "publish" | "invite" | "tour-picker" }) {
  const ws = useWorkspace();
  const open = { palette: () => ws.setPaletteOpen(true), publish: () => ws.setPublishOpen(true), invite: () => ws.setInviteOpen(true), "tour-picker": () => ws.setTourPickerOpen(true) }[which];
  const label = { palette: "Open command palette", publish: "Open publish dialog", invite: "Open invite dialog", "tour-picker": "Open tour picker" }[which];
  return (
    <Variant label="trigger">
      <Button variant="outline" onClick={open} data-gallery-trigger={which}>
        {label}
      </Button>
      {which === "publish" && ws.pending.length === 0 && <span className="text-sm text-faint">No unpublished changes left; reload to reseed.</span>}
    </Variant>
  );
}

/** Get started, with a way back after its X hides it (the X is remembered in localStorage, shared with the app). */
function GetStartedDemo() {
  const ws = useWorkspace();
  return (
    <Panel className="@container">
      <GetStarted />
      {ws.getStartedHidden && (
        <div className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
          Hidden.
          <Button size="xs" variant="secondary" onClick={() => ws.setGetStartedHidden(false)}>
            Show again
          </Button>
        </div>
      )}
    </Panel>
  );
}

const OFFER_KEY = "canonfig-ui:guide:source:tour";

/**
 * The offer is `position: fixed`; the transformed box becomes its containing block, so it sits in
 * this frame's corner instead of the window's. Dismissing or starting the tour is remembered in
 * localStorage (shared with the app), so "Show again" clears that key and remounts a fresh workspace.
 */
function TourOfferDemo() {
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <Variant label="frame">
        <Button
          size="xs"
          variant="secondary"
          onClick={() => {
            localStorage.removeItem(OFFER_KEY);
            setGeneration((g) => g + 1);
          }}
        >
          Show again
        </Button>
        <span className="text-sm text-faint">Appears after 900ms. Hidden while any Details panel is open on the page.</span>
      </Variant>
      <div className="relative h-[300px] overflow-hidden rounded-lg border border-border bg-canvas [transform:translateZ(0)]">
        <Ws key={generation}>
          <TourOffer />
        </Ws>
      </div>
    </>
  );
}

const TOUR_STEPS: TourStep[] = [
  { target: ["gallery-tour-a"], title: "First stop", body: "The card sits beside its target: right if it fits, else below, above or left." },
  { target: ["gallery-tour-b"], title: "Second stop", body: "Moving between steps glides the spotlight and the card together." },
  { title: "A centred card", body: "A step without a target shows the card in the middle with nothing cut out.", action: { label: "Finish", run: () => toast("Tour action ran") } },
];

function TourDemo() {
  const [mode, setMode] = useState<"tour" | "tip" | null>(null);
  return (
    <>
      <div className="flex gap-6 py-2">
        <div data-tour="gallery-tour-a" className="rounded-lg border border-border bg-panel px-4 py-3">
          Target A
        </div>
        <div data-tour="gallery-tour-b" className="rounded-lg border border-border bg-panel px-4 py-3">
          Target B
        </div>
      </div>
      <Variant label="triggers">
        <Button variant="outline" onClick={() => setMode("tour")} data-gallery-trigger="tour">
          Start modal tour (3 steps)
        </Button>
        <Button variant="outline" onClick={() => setMode("tip")} data-gallery-trigger="tip">
          Show page tip (non-modal)
        </Button>
      </Variant>
      {mode && <Tour steps={mode === "tour" ? TOUR_STEPS : TOUR_STEPS.slice(0, 1)} modal={mode === "tour"} onClose={() => setMode(null)} />}
    </>
  );
}

/** A map in a fixed-height frame; the host owns the Customize sheet's open state, as Machines does. */
function MapDemo({ role, customize = null, height = 520 }: { role: "source" | "follower"; customize?: string | null; height?: number }) {
  const [customizeId, setCustomizeId] = useState<string | null>(customize);
  return (
    <div className="flex flex-col" style={{ height }}>
      <MachineMap
        role={role}
        syncing={["f_8c21"]}
        customizeId={customizeId}
        onCustomizeChange={setCustomizeId}
        className="flex-1"
        onOpenMachine={(id) => toast(`Open machine ${id}`)}
        onInvite={() => toast("Invite a follower")}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Dither (src/lib/dither)
 * ---------------------------------------------------------------------------------------------- */

const WAVE_FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  return clamp(0.5 + 0.5 * sin(uv.x * 6.0 + t) * cos(uv.y * 4.0 - t * 0.5), 0.0, 1.0);
}
`;

function DitherPatternDemo() {
  const levels = [0.0625, 0.125, 0.25, 0.375, 0.5, 0.75, 0.875, 1];
  return (
    <svg width={levels.length * 56} height={48} role="img" aria-label="Dither levels">
      <defs>
        {levels.map((level) => (
          <DitherPattern key={level} id={`gallery-dp-${level}`} level={level} color="--dither-color-green" />
        ))}
      </defs>
      {levels.map((level, i) => (
        <rect key={level} x={i * 56} y={0} width={48} height={48} rx={4} fill={`url(#gallery-dp-${level})`} />
      ))}
    </svg>
  );
}

function FillPatternDemo() {
  return (
    <svg width={FILL_VARIANTS.length * 72} height={64} role="img" aria-label="Fill variants">
      <defs>
        {FILL_VARIANTS.map((fill) => (
          <FillPattern key={fill} id={`gallery-fp-${fill}`} fill={fill} color="purple" cell={2} ramp={fill === "gradient" ? { edge: "bottom", at: 64, length: 48 } : undefined} />
        ))}
      </defs>
      {FILL_VARIANTS.map((fill, i) => (
        <rect key={fill} x={i * 72} y={0} width={64} height={64} rx={4} fill={`url(#gallery-fp-${fill})`} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------------
 * The catalogue. `file` + `symbol` give the source label; `render` shows every meaningful state.
 * ---------------------------------------------------------------------------------------------- */

interface Entry {
  id: string;
  name: string;
  group: string;
  file: string;
  /** Declaration to point at; defaults to `name`. */
  symbol?: string;
  note?: string;
  render: () => ReactNode;
}

const UI = "Primitives";
const SHARED = "Shared";
const KIT = "Workspace kit";
const SCREEN = "Workspace screens";
const GUIDE = "Tour and guidance";
const ONBOARD = "Onboarding kit";
const DITHER = "Dither";
const MAP = "Machine map";

const ENTRIES: Entry[] = [
  // Primitives
  { id: "button", name: "Button", group: UI, file: "src/components/ui/button.tsx", note: "Hover and press are live; focus is shown with the focus-visible classes applied statically.", render: () => <ButtonDemo /> },
  { id: "input", name: "Input", group: UI, file: "src/components/ui/input.tsx", render: () => <InputDemo /> },
  { id: "textarea", name: "Textarea", group: UI, file: "src/components/ui/textarea.tsx", render: () => <TextareaDemo /> },
  {
    id: "label",
    name: "Label",
    group: UI,
    file: "src/components/ui/label.tsx",
    render: () => (
      <>
        <Variant label="default">
          <Label htmlFor="gallery-label-input">Endpoint</Label>
          <Input id="gallery-label-input" className="w-56" />
        </Variant>
        <Variant label="peer disabled">
          <Input id="gallery-label-disabled" disabled className="peer w-56" />
          <Label htmlFor="gallery-label-disabled">Disabled field label</Label>
        </Variant>
      </>
    ),
  },
  { id: "checkbox", name: "Checkbox", group: UI, file: "src/components/ui/checkbox.tsx", render: () => <CheckboxDemo /> },
  { id: "switch", name: "Switch", group: UI, file: "src/components/ui/switch.tsx", render: () => <SwitchDemo /> },
  { id: "radio-group", name: "RadioGroup", group: UI, file: "src/components/ui/radio-group.tsx", render: () => <RadioGroupDemo /> },
  { id: "select", name: "Select", group: UI, file: "src/components/ui/select.tsx", render: () => <SelectDemo /> },
  { id: "dropdown-menu", name: "DropdownMenu", group: UI, file: "src/components/ui/dropdown-menu.tsx", render: () => <DropdownDemo /> },
  { id: "dialog", name: "Dialog", group: UI, file: "src/components/ui/dialog.tsx", symbol: "DialogContent", render: () => <DialogDemo /> },
  { id: "sheet", name: "Sheet", group: UI, file: "src/components/ui/sheet.tsx", symbol: "SheetContent", render: () => <SheetDemo /> },
  { id: "popover", name: "Popover", group: UI, file: "src/components/ui/popover.tsx", symbol: "PopoverContent", render: () => <PopoverDemo /> },
  { id: "tooltip", name: "Tooltip", group: UI, file: "src/components/ui/tooltip.tsx", symbol: "TooltipContent", render: () => <TooltipDemo /> },
  {
    id: "kbd",
    name: "Kbd",
    group: UI,
    file: "src/components/ui/kbd.tsx",
    render: () => (
      <>
        <Variant label="Kbd">
          <Kbd>Esc</Kbd>
          <Kbd>⌘K</Kbd>
          <Kbd className="h-4 bg-raised px-1 text-xs">Ctrl K</Kbd>
        </Variant>
        <Variant label="KbdGroup">
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>Shift</Kbd>
            <Kbd>P</Kbd>
          </KbdGroup>
        </Variant>
      </>
    ),
  },
  { id: "collapsible", name: "Collapsible", group: UI, file: "src/components/ui/collapsible.tsx", render: () => <CollapsibleDemo /> },
  { id: "command", name: "Command", group: UI, file: "src/components/ui/command.tsx", render: () => <CommandDemo /> },
  { id: "toaster", name: "Toaster (sonner)", group: UI, file: "src/components/ui/sonner.tsx", symbol: "Toaster", note: "Mounted once at the page root with App.tsx's props.", render: () => <ToastDemo /> },
  { id: "icons", name: "Icons", group: UI, file: "src/components/icons.tsx", symbol: "Solar", note: "Linear, then Bold, for every Solar icon.", render: () => <IconsDemo /> },

  // Shared
  {
    id: "term",
    name: "Term",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <Variant label="in a sentence">
        <p className="text-base">
          Each <Term term="Follower Machine" /> keeps its <Term term="Local Overlay">local settings</Term> and gets every <Term term="Profile Revision" /> you publish.
        </p>
      </Variant>
    ),
  },
  {
    id: "hint",
    name: "Hint",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <Variant label="beside a label">
        <span className="text-sm font-medium text-muted-foreground">Host key</span>
        <Hint label="Host key">The SSH host key this machine expects from the Source. A mismatch stops the tunnel.</Hint>
      </Variant>
    ),
  },
  {
    id: "status-mark",
    name: "StatusMark",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <Variant label="every kind">
        {STATUS_KINDS.map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <StatusMark kind={kind} /> {kind}
          </span>
        ))}
      </Variant>
    ),
  },
  {
    id: "state-label",
    name: "StateLabel",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <>
        <Variant label="default">
          {STATES.map((s) => (
            <StateLabel key={s} state={s} />
          ))}
        </Variant>
        <Variant label="self">
          {STATES.map((s) => (
            <StateLabel key={s} state={s} self />
          ))}
        </Variant>
        <Variant label="compact">
          {STATES.map((s) => (
            <StateLabel key={s} state={s} compact />
          ))}
        </Variant>
      </>
    ),
  },
  {
    id: "state-cell",
    name: "StateCell",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <Variant label="every state">
        {STATES.map((s) => (
          <span key={s} className="grid gap-1 text-center text-xs text-faint">
            <span className="block h-4 w-[72px]">
              <StateCell state={s} />
            </span>
            {STATE_META[s].label}
          </span>
        ))}
      </Variant>
    ),
  },
  {
    id: "dither-progress",
    name: "DitherProgress",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <>
        {TONES.map((tone) => (
          <Variant key={tone} label={`tone ${tone}`}>
            {[0, 35, 70, 100].map((v) => (
              <DitherProgress key={v} value={v} tone={tone} label={`${tone} ${v}%`} className="w-40" />
            ))}
          </Variant>
        ))}
        <Variant label="running">
          <DitherProgress value={45} running label="Reading files" className="w-80" />
        </Variant>
      </>
    ),
  },
  {
    id: "state-band",
    name: "StateBand",
    group: SHARED,
    file: "src/shared/shared.tsx",
    note: "Each state moves in its own way: ok drifts, warn breathes, act flows right, bad glitches (a stepped, torn horizon with dropouts), muted barely moves, running sweeps. Reduced motion holds one still frame per state. One WebGL context each; the page budget is 8 live contexts, so off-screen bands may show their still fallback.",
    render: () => (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STATE_BANDS.map(({ tone, mode, motion }) => (
          <div key={`${tone}-${mode}`} className="relative h-28 overflow-hidden rounded-lg border border-border">
            <StateBand tone={tone} mode={mode} />
            <span className="relative block p-3 font-mono text-xs">
              {tone} {mode} <span className="text-muted-foreground">{motion}</span>
            </span>
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "dither-block",
    name: "DitherBlock",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <>
        <Variant label="tones, edge bottom">
          {TONES.map((tone) => (
            <DitherBlock key={tone} tone={tone} className="h-20 w-28 rounded-md border border-border" />
          ))}
        </Variant>
        <Variant label="edges, muted">
          {(["top", "bottom", "left", "right"] as const).map((edge) => (
            <DitherBlock key={edge} edge={edge} className="h-20 w-28 rounded-md border border-border" />
          ))}
        </Variant>
      </>
    ),
  },
  { id: "animated-number", name: "AnimatedNumber", group: SHARED, file: "src/shared/shared.tsx", render: () => <AnimatedNumberDemo /> },
  {
    id: "logo",
    name: "Logo",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <Variant label="sizes">
        <Logo />
        <Logo className="size-8" />
        <Logo className="size-16" />
      </Variant>
    ),
  },
  {
    id: "mono",
    name: "Mono",
    group: SHARED,
    file: "src/shared/shared.tsx",
    render: () => (
      <Variant label="inline">
        <Mono>~/.codex/config.toml</Mono>
        <Mono className="text-foreground">f_8c21</Mono>
      </Variant>
    ),
  },
  {
    id: "demo-switcher",
    name: "DemoSwitcher",
    group: SHARED,
    file: "src/shared/demo-switcher.tsx",
    note: "Its links change the window's route, as in the app.",
    render: () => (
      <>
        <Variant label="full, source">
          <DemoSwitcher role="source" />
        </Variant>
        <Variant label="compact, new machine">
          <DemoSwitcher role="unconfigured" compact />
        </Variant>
      </>
    ),
  },

  // Workspace kit
  {
    id: "page-header",
    name: "PageHeader",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <Ws view="profile">
        <Panel className="grid gap-px">
          <PageHeader crumbs={["Profile"]} />
          <PageHeader crumbs={["Settings", "Service"]} actions={<Button size="sm" variant="outline">Restart</Button>} />
          <PageHeader crumbs={["Profile"]} actions={<><Button size="sm" variant="outline">Add item</Button><PublishButton /></>} />
          <PageHeader crumbs={["A very long page title that has to truncate before it reaches the actions on the right side of the bar ".repeat(2)]} actions={<Button size="sm">Action</Button>} />
        </Panel>
      </Ws>
    ),
  },
  {
    id: "publish-button",
    name: "PublishButton",
    group: KIT,
    file: "src/workspace/kit.tsx",
    note: "Renders nothing once there are no unpublished changes.",
    render: () => (
      <Ws>
        <Variant label="pending changes">
          <PublishButton />
        </Variant>
      </Ws>
    ),
  },
  {
    id: "toolbar",
    name: "Toolbar + ToolbarTab",
    group: KIT,
    file: "src/workspace/kit.tsx",
    symbol: "ToolbarTab",
    render: () => (
      <Ws view="machines">
        <Panel>
          <Toolbar right={<span className="text-sm text-faint">4 machines</span>}>
            <ToolbarTab active href={workspaceHref("source", "machines")}>
              Map
            </ToolbarTab>
            <ToolbarTab active={false} href={workspaceHref("source", "machines", { machinesMode: "list" })} count={4}>
              List
            </ToolbarTab>
            <ToolbarTab active={false} href={workspaceHref("source", "profile", { profileTab: "groups" })} count={12}>
              Groups
            </ToolbarTab>
          </Toolbar>
        </Panel>
      </Ws>
    ),
  },
  {
    id: "section-label",
    name: "SectionLabel",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <div className="max-w-xl">
        <SectionLabel>Plain section label</SectionLabel>
        <SectionLabel
          action={
            <Button variant="ghost" size="xs" className="text-muted-foreground">
              All machines <ArrowRight />
            </Button>
          }
        >
          With an action
        </SectionLabel>
      </div>
    ),
  },
  {
    id: "list-row",
    name: "ListHead + ListRow + DetailPanel",
    group: KIT,
    file: "src/workspace/kit.tsx",
    symbol: "ListRow",
    note: "Click a row to open DetailPanel (with Body and Prop). Rows show hover, selected and focus-visible fills.",
    render: () => <ListDemo />,
  },
  {
    id: "group-row",
    name: "GroupRow",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <Panel className="max-w-2xl py-1">
        {(["file", "config", "skill", "tool"] as const).map((kind, i) => (
          <GroupRow key={kind} icon={KIND_ICON[kind]} label={`${kind}s`} count={i + 2} hint={i % 2 ? undefined : `What a ${kind} is. Hover the band to show the (?).`} />
        ))}
        <GroupRow label="No icon, no count" />
      </Panel>
    ),
  },
  {
    id: "detail-panel",
    name: "DetailPanel",
    group: KIT,
    file: "src/workspace/kit.tsx",
    note: "Opens from the list above; isolate this to see it beside an empty body. Prototype: ?panel=<n> or [ and ] switch how it opens and closes (label bottom-left).",
    render: () => <DetailPanelDemo />,
  },
  {
    id: "prop",
    name: "Prop",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <div className="max-w-sm">
        <Prop label="System">Linux</Prop>
        <Prop label="Revision">8</Prop>
        <Prop label="Path">~/.config/a/very/long/path/that/keeps/going/and/breaks/across/lines/config.toml</Prop>
      </div>
    ),
  },
  {
    id: "field",
    name: "Field",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <div className="grid max-w-md gap-5">
        <Field label="Endpoint" htmlFor="gallery-f1">
          <Input id="gallery-f1" defaultValue="http://atlas.local:17342" />
        </Field>
        <Field label="Host key" htmlFor="gallery-f2" hint="The key the Source presents. A mismatch stops the tunnel." description="Paste the line from the Source's Tunnel page.">
          <Input id="gallery-f2" placeholder="ssh-ed25519 AAAA…" />
        </Field>
        <Field label="Writable path" htmlFor="gallery-f3" error="Enter a path that starts with /, ~/ or ./.">
          <Input id="gallery-f3" defaultValue="relative/path" aria-invalid aria-describedby="gallery-f3-note" />
        </Field>
      </div>
    ),
  },
  {
    id: "setting-row",
    name: "SettingRow + settingsGroup",
    group: KIT,
    file: "src/workspace/kit.tsx",
    symbol: "SettingRow",
    render: () => (
      <div className={cn(settingsGroup, "max-w-2xl")}>
        <SettingRow title="Start at login" description="Keeps the Source serving while you're away." htmlFor="gallery-s1">
          <Switch id="gallery-s1" defaultChecked />
        </SettingRow>
        <SettingRow title="Port">
          <span className="font-mono text-sm text-muted-foreground">17342</span>
        </SettingRow>
        <SettingRow title="Evidence limit" description="Largest log the agent may attach." htmlFor="gallery-s3" error="Enter a number from 1 to 1024.">
          <Input id="gallery-s3" defaultValue="4096" aria-invalid aria-describedby="gallery-s3-note" className="w-24" />
        </SettingRow>
        <SettingRow title="Title only" />
      </div>
    ),
  },
  {
    id: "cli",
    name: "Cli",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <div className="max-w-md">
        <Variant label="short">
          <Cli>canonfig publish</Cli>
        </Variant>
        <Variant label="long, truncates">
          <Cli>canonfig follower invite --groups gpu,development,regional-build --expires 24h --name workstation-42</Cli>
        </Variant>
        <Variant label="wrap">
          <Cli wrap>canonfig follower invite --groups gpu,development,regional-build --expires 24h --name workstation-42</Cli>
        </Variant>
      </div>
    ),
  },
  {
    id: "command-box",
    name: "CommandBox",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <div className="grid max-w-md gap-3">
        <CommandBox>gh auth login</CommandBox>
        <CommandBox>canonfig join https://atlas.local:17342 --token 7Q4M-2KXP-H9RW-3TNB --groups gpu,development</CommandBox>
      </div>
    ),
  },
  {
    id: "with-code",
    name: "WithCode",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <p className="max-w-xl text-base text-muted-foreground">
        <WithCode text="Run `gh auth login` on that machine, then `canonfig sync` to continue. Each chip copies its command." />
      </p>
    ),
  },
  {
    id: "empty-state",
    name: "EmptyState",
    group: KIT,
    file: "src/workspace/kit.tsx",
    note: "Grows to fill a flex-column parent, so the dither meets the card's bottom edge even when the neighbour card is taller.",
    render: () => (
      <div className="grid gap-3 md:grid-cols-2">
        <Panel className="flex flex-col">
          <EmptyState title="No machines yet" body="Create an invitation, then join from the other machine." action={<Button variant="primary" size="sm">Add a machine</Button>} />
        </Panel>
        <Panel className="flex flex-col">
          <EmptyState tone="ok" title="Nothing to review" body="Every machine is up to date." />
        </Panel>
      </div>
    ),
  },
  {
    id: "change-mark",
    name: "ChangeMark",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <Variant label="added, modified, removed, none">
        <ChangeMark change="added" />
        <ChangeMark change="modified" />
        <ChangeMark change="removed" />
        <span className="inline-flex border border-dashed border-border">
          <ChangeMark />
        </span>
      </Variant>
    ),
  },
  {
    id: "group-chips",
    name: "GroupChips",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <div className="max-w-md">
        {(
          [
            ["none", []],
            ["one", ["gpu"]],
            ["two", ["gpu", "development"]],
            ["many", ["gpu", "development", "regional-build", "release", "canonfig:secrets"]],
            ["secrets group", ["canonfig:secrets"]],
            ["long first name", ["infrastructure-team-regional-build-hosts", "gpu"]],
          ] as [string, string[]][]
        ).map(([label, groups]) => (
          <Variant key={label} label={label}>
            <span className="w-56">
              <GroupChips groups={groups} />
            </span>
          </Variant>
        ))}
        <Variant label="custom empty">
          <GroupChips groups={[]} empty="No groups" />
        </Variant>
      </div>
    ),
  },
  {
    id: "state-header",
    name: "StateHeader",
    group: KIT,
    file: "src/workspace/kit.tsx",
    render: () => (
      <Panel className="grid">
        <StateHeader tone="ok" title="Everything is published" body="4 of 4 machines have revision 8. The rest get it at their next check." />
        <StateHeader tone="warn" running title="Publishing revision 9…" body="Machines stay on revision 8 until it lands." />
      </Panel>
    ),
  },
  { id: "animated-row", name: "AnimatedRow + RowPresence", group: KIT, file: "src/workspace/kit.tsx", symbol: "AnimatedRow", render: () => <AnimatedRowDemo /> },

  // Workspace screen pieces
  {
    id: "count",
    name: "Count",
    group: SCREEN,
    file: "src/workspace/frame.tsx",
    render: () => (
      <Variant label="muted, warn, act">
        <Count value={3} label="3 need attention" />
        <Count value={12} tone="warn" label="12 unpublished changes" />
        <Count value={1} tone="act" label="1 needs you" />
      </Variant>
    ),
  },
  {
    id: "sidebar",
    name: "Sidebar",
    group: SCREEN,
    file: "src/workspace/frame.tsx",
    note: "Includes NavButton, Count badges, the machine menu and the Settings collapsible. Its links move each fixture between pages.",
    render: () => (
      <div className="flex gap-6">
        {(["source", "follower"] as const).map((role) => (
          <Ws key={role} role={role} view={role === "source" ? "overview" : "schedule"}>
            <div className="flex h-[640px] overflow-hidden rounded-lg border border-border">
              <Sidebar />
            </div>
            <TourPicker />
          </Ws>
        ))}
      </div>
    ),
  },
  {
    id: "palette",
    name: "Palette",
    group: SCREEN,
    file: "src/workspace/frame.tsx",
    note: "Also opens with Ctrl K / ⌘K anywhere on this page.",
    render: () => (
      <Ws>
        <WsDialogTrigger which="palette" />
        <Palette />
        <PublishDialog />
        <InviteDialog />
        <TourPicker />
      </Ws>
    ),
  },
  {
    id: "status-row",
    name: "StatusRow",
    group: SCREEN,
    file: "src/workspace/source.tsx",
    render: () => (
      <div className="w-80">
        {(["ok", "warn", "bad", "off"] as const).map((status) => (
          <StatusRow key={status} status={status} label={`Status ${status}`} value={status === "warn" ? "Linger is off, so the service stops when you log out" : "Running"} onClick={() => toast(`Open ${status}`)} />
        ))}
        <StatusRow label="No status" value="17342" onClick={() => toast("Open")} />
      </div>
    ),
  },
  {
    id: "attention",
    name: "Attention",
    group: SCREEN,
    file: "src/workspace/follower.tsx",
    render: () => (
      <div className="@container max-w-3xl">
        <Attention tone="warn" title="You edited 2 managed files" actions={<Button size="sm" variant="outline">Review</Button>}>
          Canonfig leaves them alone until you decide whether to keep your edits.
        </Attention>
        <Attention tone="act" title="Sign in to GitHub CLI">
          <WithCode text="Run `gh auth login` in a terminal. Syncing continues once it's done." />
        </Attention>
        <Attention tone="bad" title="The last update failed" actions={<><Button size="sm" variant="destructive">Abandon</Button><Button size="sm">Recover</Button></>}>
          Canonfig put back the files and settings it had changed.
        </Attention>
      </div>
    ),
  },
  {
    id: "action-tag",
    name: "ActionTag",
    group: SCREEN,
    file: "src/workspace/follower.tsx",
    render: () => (
      <Variant label="every action">
        {(["write", "merge", "install", "skip-drift", "keep-local", "decide"] as const).map((a) => (
          <ActionTag key={a} action={a} />
        ))}
      </Variant>
    ),
  },
  { id: "time-field", name: "TimeField", group: SCREEN, file: "src/workspace/schedule.tsx", render: () => <TimeFieldDemo /> },
  { id: "schedule-fields", name: "ScheduleFields", group: SCREEN, file: "src/workspace/schedule.tsx", render: () => <ScheduleFieldsDemo /> },
  { id: "confirm-dialog", name: "ConfirmDialog", group: SCREEN, file: "src/workspace/settings.tsx", render: () => <ConfirmDialogDemo /> },
  {
    id: "publish-dialog",
    name: "PublishDialog",
    group: SCREEN,
    file: "src/workspace/source.tsx",
    render: () => (
      <Ws>
        <WsDialogTrigger which="publish" />
        <PublishDialog />
      </Ws>
    ),
  },
  {
    id: "invite-dialog",
    name: "InviteDialog",
    group: SCREEN,
    file: "src/workspace/machines.tsx",
    render: () => (
      <Ws view="machines">
        <WsDialogTrigger which="invite" />
        <InviteDialog />
      </Ws>
    ),
  },

  // Tour and guidance
  { id: "tour", name: "Tour", group: GUIDE, file: "src/tour/tour.tsx", note: "The modal tour dims and blurs the page; the tip is the card alone.", render: () => <TourDemo /> },
  { id: "tour-offer", name: "TourOffer", group: GUIDE, file: "src/workspace/guide.tsx", render: () => <TourOfferDemo /> },
  {
    id: "tour-picker",
    name: "TourPicker",
    group: GUIDE,
    file: "src/workspace/guide.tsx",
    note: "Choosing a chapter starts it in the app; here it only closes the dialog and marks the offer as seen.",
    render: () => (
      <Ws>
        <WsDialogTrigger which="tour-picker" />
        <TourPicker />
      </Ws>
    ),
  },
  {
    id: "chapter-picker",
    name: "ChapterPicker (picker preview)",
    group: GUIDE,
    file: "src/workspace/guide.tsx",
    symbol: "ChapterPicker",
    note: "The picker's body outside its dialog: ChapterMark, ChapterPreview, RouteSidebar (md and up) and RouteRow (below md).",
    render: () => (
      <div className="grid gap-8">
        {(["source", "follower"] as const).map((role) => (
          <Ws key={role} role={role}>
            <p className="mb-2 font-mono text-xs text-faint">{role}</p>
            <div className="grid max-w-4xl gap-4">
              <ChapterPicker onChoose={(id) => toast(`Would start the ${id} chapter`)} />
            </div>
          </Ws>
        ))}
      </div>
    ),
  },
  {
    id: "get-started",
    name: "GetStarted",
    group: GUIDE,
    file: "src/workspace/guide.tsx",
    render: () => (
      <div className="grid gap-4">
        {(["source", "follower"] as const).map((role) => (
          <Ws key={role} role={role}>
            <GetStartedDemo />
          </Ws>
        ))}
      </div>
    ),
  },

  // Onboarding kit
  {
    id: "onboarding-shell",
    name: "OnboardingShell",
    group: ONBOARD,
    file: "src/onboarding/kit.tsx",
    note: "Full-height in the app; clipped to a frame here. The (?) opens the glossary Sheet.",
    render: () => (
      <div className="h-[360px] overflow-hidden rounded-lg border border-border [&>div]:h-full!">
        <OnboardingShell hostname="atlas.local">
          <div className="p-8 text-muted-foreground">Wizard content goes here.</div>
        </OnboardingShell>
      </div>
    ),
  },
  {
    id: "radio-row",
    name: "RadioRow",
    group: ONBOARD,
    file: "src/onboarding/kit.tsx",
    render: () => (
      <RadioGroup defaultValue="source" aria-label="Role" className="grid max-w-md gap-2">
        <RadioRow value="source" title="This is the Source" description="You edit and publish here." icon={Desktop} />
        <RadioRow value="follower" title="Join a Source" description="Copies its setup from another machine." icon={Laptop} />
        <RadioRow value="plain" title="Title only" />
        <RadioRow value="extra" title="With children" description="Extra content sits under the description.">
          <span className="mt-2 block text-xs text-faint">Child content.</span>
        </RadioRow>
      </RadioGroup>
    ),
  },
  {
    id: "stepper",
    name: "Stepper",
    group: ONBOARD,
    file: "src/onboarding/kit.tsx",
    render: () => (
      <>
        {[0, 1, 2, 3].map((step) => (
          <Variant key={step} label={step === 3 ? "all done" : `step ${step}`}>
            <Stepper steps={["Machine", "Profile", "Publish"]} step={step} />
          </Variant>
        ))}
      </>
    ),
  },
  {
    id: "onboarding-field",
    name: "Field + FieldError (onboarding)",
    group: ONBOARD,
    file: "src/onboarding/kit.tsx",
    symbol: "Field",
    render: () => (
      <div className="grid max-w-md gap-5">
        <OnboardingField label="Port" htmlFor="gallery-of1" hint="Followers connect here. 17342 is the default.">
          <Input id="gallery-of1" defaultValue="17342" />
        </OnboardingField>
        <OnboardingField label="Source address" htmlFor="gallery-of2" error="Enter the address the Source showed, like atlas.local:17342.">
          <Input id="gallery-of2" defaultValue="atlas" aria-invalid aria-describedby="gallery-of2-error" />
        </OnboardingField>
        <FieldError>FieldError on its own.</FieldError>
      </div>
    ),
  },
  {
    id: "facts",
    name: "Facts",
    group: ONBOARD,
    file: "src/onboarding/kit.tsx",
    render: () => (
      <Facts
        className="max-w-md"
        items={[
          ["Machine", "atlas.local"],
          ["Profile file", "~/.config/canonfig/profile.toml"],
          ["A long value", "a-very-long-unbreakable-value-that-has-to-wrap-anywhere-because-it-has-no-spaces-at-all"],
        ]}
      />
    ),
  },
  {
    id: "cli-equivalent",
    name: "CliEquivalent + DisclosureTrigger",
    group: ONBOARD,
    file: "src/onboarding/kit.tsx",
    symbol: "CliEquivalent",
    render: () => (
      <div className="grid max-w-md gap-2">
        <CliEquivalent lines={["# Install the service", "canonfig source init --port 17342", "canonfig source service install"]} />
        <Collapsible>
          <DisclosureTrigger>Advanced</DisclosureTrigger>
          <CollapsibleContent className="text-sm text-muted-foreground">DisclosureTrigger on its own, opening any content.</CollapsibleContent>
        </Collapsible>
      </div>
    ),
  },

  // Dither
  {
    id: "fill-style",
    name: "fillStyle",
    group: DITHER,
    file: "src/lib/dither/style.ts",
    note: "The CSS fill behind DitherProgress, DitherBlock, StateCell and the picker's lit pages.",
    render: () => (
      <div className="grid gap-2">
        {FILL_VARIANTS.map((variant) => (
          <Variant key={variant} label={variant}>
            {DITHER_COLOR_NAMES.map((color) => (
              <span key={color} title={color} className="size-12 rounded-md border border-border" style={fillStyle(variant, { color, cell: 2, length: 16 })} />
            ))}
          </Variant>
        ))}
      </div>
    ),
  },
  {
    id: "dither-shader",
    name: "DitherShader",
    group: DITHER,
    file: "src/lib/dither/shader.tsx",
    render: () => (
      <div className="grid grid-cols-2 gap-3">
        <div className="relative h-32 overflow-hidden rounded-lg border border-border">
          <DitherShader field={WAVE_FIELD} palette={["--dither-paper", "purple"]} cell={2} fps={20} className="absolute inset-0" />
        </div>
        <div className="relative h-32 overflow-hidden rounded-lg border border-border">
          <DitherShader field={WAVE_FIELD} palette={["--dither-paper", "green"]} cell={3} animate={false} stillTime={2} className="absolute inset-0" />
        </div>
      </div>
    ),
  },
  { id: "dither-pattern", name: "DitherPattern", group: DITHER, file: "src/lib/dither/pattern.tsx", render: () => <DitherPatternDemo /> },
  { id: "fill-pattern", name: "FillPattern", group: DITHER, file: "src/lib/dither/fill.tsx", render: () => <FillPatternDemo /> },
  {
    id: "bloom-box",
    name: "BloomBox",
    group: DITHER,
    file: "src/lib/dither/fill.tsx",
    render: () => (
      <Variant label="off, low, high">
        {(["off", "low", "high"] as const).map((bloom) => (
          <BloomBox key={bloom} bloom={bloom} color="purple" className="size-16 rounded-md" style={fillStyle("dotted", { color: "purple", cell: 2 })} />
        ))}
      </Variant>
    ),
  },

  // Machine map
  { id: "machine-map-source", name: "MachineMap (source)", group: MAP, file: "src/shared/machine-map/machine-map.tsx", symbol: "MachineMap", note: "Includes MachineNode, AddNode and SyncEdge. One follower is mid-sync.", render: () => <MapDemo role="source" /> },
  { id: "machine-map-follower", name: "MachineMap (follower)", group: MAP, file: "src/shared/machine-map/machine-map.tsx", symbol: "MachineMap", render: () => <MapDemo role="follower" /> },
  { id: "customize-sheet", name: "CustomizeSheet", group: MAP, file: "src/shared/machine-map/customize-sheet.tsx", note: "Opened inside a map for f_8c21.", render: () => <MapDemo role="source" customize="f_8c21" height={560} /> },
];

/** DetailPanel beside an empty list body, the way a page holds it. */
function DetailPanelDemo() {
  const [open, setOpen] = useState(only === "detail-panel");
  return (
    <>
      <Variant label="trigger">
        <Button variant="outline" onClick={() => setOpen((o) => !o)} data-gallery-trigger="detail-panel">
          {open ? "Close details panel" : "Open details panel"}
        </Button>
      </Variant>
      <Panel className="flex h-[360px]">
        <Body
          detail={
            open && (
              <DetailPanel title="workstation-01" subtitle="Linux" onClose={() => setOpen(false)} footer={<Button size="sm" variant="primary" className="ml-auto">Save</Button>}>
                <div className="px-4 py-3">
                  <Prop label="Revision">8</Prop>
                  <Prop label="Groups">
                    <GroupChips groups={["gpu", "development", "release"]} />
                  </Prop>
                </div>
              </DetailPanel>
            )
          }
        >
          <p className="p-6 text-muted-foreground">Body column. Drag the panel's left edge, or focus it and use the arrow keys.</p>
        </Body>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------------------------------- */

function Section({ entry, isolated }: { entry: Entry; isolated: boolean }) {
  const line = lineOf(entry.file, entry.symbol ?? entry.name);
  return (
    <section id={entry.id} data-gallery-section={entry.id} className="scroll-mt-4 border-b border-border py-8">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{entry.name}</h2>
        <code className="font-mono text-xs text-faint">
          {entry.file}:{line}
        </code>
        {!isolated && (
          <a href={`?only=${entry.id}`} className="ml-auto text-sm text-muted-foreground underline decoration-faint underline-offset-4 hover:text-foreground" data-gallery-only={entry.id}>
            Isolate
          </a>
        )}
      </header>
      {entry.note && <p className="mb-4 max-w-[70ch] text-sm text-muted-foreground">{entry.note}</p>}
      {entry.render()}
    </section>
  );
}

/** The page: a sticky index and every section, or one section full width with `?only=<id>`. */
export function Gallery() {
  if (only !== null) {
    const entry = ENTRIES.find((e) => e.id === only);
    return (
      <main className="px-8 py-6">
        <p className="mb-2 flex gap-4 text-sm text-muted-foreground">
          Temporary component gallery, not part of the product.
          <a href="/components.html" className="underline decoration-faint underline-offset-4 hover:text-foreground">
            All components
          </a>
          {entry && (
            <a href={`/components.html#${entry.id}`} className="underline decoration-faint underline-offset-4 hover:text-foreground">
              In context
            </a>
          )}
        </p>
        {entry ? <Section entry={entry} isolated /> : <p className="py-8 text-bad">No component with id "{only}".</p>}
      </main>
    );
  }
  const groups = [...new Set(ENTRIES.map((e) => e.group))];
  return (
    <div className="flex">
      <nav aria-label="Components" className="sticky top-0 h-svh w-60 shrink-0 overflow-y-auto border-r border-border px-3 py-4 text-sm">
        {groups.map((group) => (
          <div key={group} className="mb-4">
            <p className="px-2 pb-1 text-xs font-medium text-faint">{group}</p>
            <ul>
              {ENTRIES.filter((e) => e.group === group).map((e) => (
                <li key={e.id}>
                  <a href={`#${e.id}`} className="block truncate rounded-md px-2 py-1 text-muted-foreground hover:bg-raised/60 hover:text-foreground">
                    {e.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <main className="min-w-0 flex-1 px-8 py-6">
        <p className="text-sm text-muted-foreground">
          Temporary component gallery, not part of the product. {ENTRIES.length} components; each heading links to an isolated view.
        </p>
        {groups.map((group) => (
          <div key={group}>
            <h1 className="mt-10 text-xs font-medium tracking-wide text-faint uppercase">{group}</h1>
            {ENTRIES.filter((e) => e.group === group).map((e) => (
              <Section key={e.id} entry={e} isolated={false} />
            ))}
          </div>
        ))}
      </main>
    </div>
  );
}
