// Workspace sidebar and command palette.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowsClockwise,
  CalendarDots,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  Devices,
  FileCode,
  GitBranch,
  HardDrives,
  Key,
  ListChecks,
  MagnifyingGlass,
  Monitor,
  Package,
  PaperPlaneTilt,
  Plug,
  Robot,
  Signpost,
  SquaresFour,
  Stack,
  Stethoscope,
  UserPlus,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { AnimatedNumber, Logo } from "@/shared/shared";
import { PLAIN, machine } from "@/shared/data";
import { DemoSwitcher } from "@/shared/demo-switcher";
import { useSharedState, useWorkspace, type View } from "./store";
import { copy } from "./kit";
import { followLink, workspaceHref } from "./routes";

interface NavItem {
  view: View;
  label: string;
  icon: Icon;
}

const SOURCE_NAV: NavItem[] = [
  { view: "overview", label: "Overview", icon: SquaresFour },
  { view: "profile", label: "Profile", icon: FileCode },
  { view: "machines", label: "Machines", icon: Devices },
  { view: "revisions", label: "Revisions", icon: ClockCounterClockwise },
  { view: "secrets", label: "Secrets", icon: Key },
];

const SOURCE_SETTINGS: NavItem[] = [
  { view: "service", label: "Source service", icon: HardDrives },
  { view: "agent", label: "Agent policy", icon: Robot },
  { view: "harness", label: "Harness projects", icon: GitBranch },
  { view: "installers", label: "Installers", icon: Package },
  { view: "setup", label: "Setup", icon: ListChecks },
  { view: "doctor", label: "Health check", icon: Stethoscope },
];

const FOLLOWER_NAV: NavItem[] = [
  { view: "overview", label: "Overview", icon: SquaresFour },
  { view: "machines", label: "Machines", icon: Devices },
  { view: "sync", label: "Sync", icon: ArrowsClockwise },
  { view: "schedule", label: "Schedule", icon: CalendarDots },
  { view: "overlays", label: PLAIN.localNav, icon: Stack },
  { view: "secrets", label: "Secrets", icon: Key },
];

const FOLLOWER_SETTINGS: NavItem[] = [
  { view: "tunnel", label: "SSH tunnel", icon: Plug },
  { view: "agent", label: "Agent policy", icon: Robot },
  { view: "harness", label: "Harness projects", icon: GitBranch },
  { view: "doctor", label: "Health check", icon: Stethoscope },
  { view: "machine", label: "This machine", icon: Monitor },
];

function navFor(role: "source" | "follower") {
  return role === "source" ? { main: SOURCE_NAV, settings: SOURCE_SETTINGS } : { main: FOLLOWER_NAV, settings: FOLLOWER_SETTINGS };
}

/** ⌘ on Apple platforms, Ctrl elsewhere; the palette listens for both. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";

/*
 * Sidebar rows sit 12px in from the sidebar edge with 7px of padding. Icons are Phosphor regular at 16px: the
 * glyph fills about 13px of the box, close to the ~12px glyphs beside Linear's 13px labels, where regular at 14px
 * painted only 10-11px and bold at 14px stayed as small but heavier. A 16px box at x19 puts the icon's centre
 * at x27 and, with a 5px gap, the label at x40: the same centre and label edge as Linear's 14px box at x20 with 6px.
 * Inactive rows use the muted tier so the active page reads first; hover brings them to full foreground.
 */
function NavButton({ item, active, badge }: { item: NavItem; active: boolean; badge?: React.ReactNode }) {
  const ws = useWorkspace();
  const Icon = item.icon;
  return (
    <a
      href={workspaceHref(ws.role, item.view)}
      data-tour={`nav-${item.view}`}
      onClick={(event) => followLink(event, ws.navigate)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-[28px] w-full items-center gap-[5px] rounded-lg pr-[9px] pl-[7px] text-base font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <Icon weight={active ? "fill" : "regular"} className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
      {badge && <span className="ml-auto">{badge}</span>}
    </a>
  );
}

/** A sidebar count. Neutral counts are plain digits; only states that ask for action get a tinted chip. */
function Count({ value, tone = "muted", label }: { value: number; tone?: "muted" | "warn" | "act"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-xs font-medium tabular-nums",
        tone === "warn" ? "bg-warn/15 text-warn" : tone === "act" ? "bg-act/15 text-act" : "text-faint",
      )}
    >
      <span aria-hidden>
        <AnimatedNumber value={value} />
      </span>
      <span className="sr-only">, {label}</span>
    </span>
  );
}

export function Sidebar() {
  const ws = useWorkspace();
  const role = ws.role === "source" ? "source" : "follower";
  const { main, settings } = navFor(role);
  const inSettings = settings.some((s) => s.view === ws.view);
  const [open, setOpen] = useState(inSettings);
  useEffect(() => {
    if (inSettings) setOpen(true);
  }, [inSettings]);

  const attention = ws.followers.filter((f) => f.state !== "converged").length;
  // Same keys and initials as the Source service and SSH tunnel pages that own them.
  const [serviceInstalled] = useSharedState("service-installed", true);
  const [tunnelUp] = useSharedState("tunnel-up", true);
  const badges: Partial<Record<View, React.ReactNode>> =
    role === "source"
      ? {
          profile: ws.pending.length > 0 ? <Count tone="warn" value={ws.pending.length} label={`${ws.pending.length} unpublished changes`} /> : undefined,
          machines: attention > 0 ? <Count value={attention} label={`${attention} need attention`} /> : undefined,
        }
      : {
          // A stopped machine cannot apply, so it must not advertise a ready revision.
          sync: ws.phase !== "done" && !ws.unenrolled ? <Count tone="warn" value={1} label={`Revision ${ws.targetRevision} ready to apply`} /> : undefined,
          overlays: <Count value={ws.overlays.length} label={`${ws.overlays.length} files with keys kept here`} />,
        };

  return (
    <aside className="flex w-[244px] shrink-0 flex-col overflow-y-auto overscroll-contain bg-sidebar px-[12px] pt-[8px] pb-3 [&>*]:shrink-0" aria-label="Main navigation">
      {/* One 28px line in a 44px top band, like Linear's workspace switcher; the full role sentence lives in the menu. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-tour="machine"
            className="flex h-[28px] items-center gap-2 rounded-lg px-[8px] text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Logo />
            <span className="flex min-w-0 items-baseline gap-1.5 text-base">
              <span className="truncate font-semibold">{ws.machineName}</span>
              <span className="shrink-0 text-sm text-muted-foreground">{role === "source" ? "Source" : "Follower"}</span>
            </span>
            <CaretDown className="ml-auto size-3.5 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="grid gap-0.5 font-normal">
            <span className="text-sm text-muted-foreground">{role === "source" ? "The Source: you edit here" : "Gets its setup from atlas"}</span>
            <span className="text-xs text-faint">
              Canonfig {machine.version} on {role === "source" ? "Linux" : "macOS"}
            </span>
          </DropdownMenuLabel>
          {role === "source" ? (
            <>
              <DropdownMenuItem onSelect={() => copy(ws.profileFile, "Profile path copied")}>
                Copy profile file path
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => copy(ws.endpoint, "Endpoint copied")}>Copy source endpoint</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ws.setView("service")}>Source service settings</DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => ws.setView("machine")}>Profile and enrollment</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ws.setView("tunnel")}>SSH tunnel</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" disabled={ws.unenrolled} onSelect={() => ws.setUnenrollOpen(true)}>
                {PLAIN.unenroll}…
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => toast("Open Canonfig on that machine to manage it")}>Manage another machine…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        data-tour="search"
        onClick={() => ws.setPaletteOpen(true)}
        className="mt-[8px] flex h-[28px] items-center gap-[6px] rounded-lg border border-border bg-panel/60 px-[7px] text-sm text-muted-foreground outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <MagnifyingGlass className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate whitespace-nowrap">Search or jump to…</span>
        <Kbd className="ml-auto h-4 bg-raised px-1 text-[10px]">{MOD}K</Kbd>
      </button>

      <nav className="mt-4 grid gap-px">
        {main.map((item) => (
          <NavButton key={item.view} item={item} active={ws.view === item.view} badge={badges[item.view]} />
        ))}
      </nav>

      <Collapsible open={open} onOpenChange={setOpen} className="mt-5">
        <CollapsibleTrigger
          data-tour="settings"
          className="flex h-6 w-full items-center gap-1 rounded-md px-[8px] text-xs font-medium text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          Settings
          <CaretRight className={cn("size-3 transition-transform duration-150 ease-snap", open && "rotate-90")} />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-px grid gap-px">
          {settings.map((item) => (
            <NavButton key={item.view} item={item} active={ws.view === item.view} />
          ))}
        </CollapsibleContent>
      </Collapsible>

      {/* Keep demo controls in flow so short windows never place them over navigation links. */}
      <div className="mt-auto pt-3">
        <DemoSwitcher role={role} />
      </div>

      {/* Footer icons and dots line up with the nav icons (x20) and their text with the nav labels (x40). */}
      <div className="grid gap-0.5 px-[8px] pt-3">
        <button
          type="button"
          data-tour="tour"
          onClick={() => ws.setTourOpen(true)}
          className="flex h-7 w-full items-center gap-[6px] rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Signpost className="size-3.5" />
          Take the tour
        </button>
        {role === "source" ? (
          <button type="button" onClick={() => ws.setView("service")} className="flex h-7 w-full items-center gap-[6px] rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
            <span className={cn("mx-[4px] size-1.5 rounded-full", serviceInstalled ? "bg-ok" : "bg-faint")} />
            {serviceInstalled ? "Source service running" : "Source service not installed"}
          </button>
        ) : (
          <button type="button" onClick={() => ws.setView("tunnel")} className="flex h-7 w-full items-center gap-[6px] rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
            <span className={cn("mx-[4px] size-1.5 rounded-full", !ws.tunnelConfigured ? "bg-faint" : tunnelUp ? "bg-ok" : "bg-bad")} />
            {!ws.tunnelConfigured ? "No SSH tunnel set up" : tunnelUp ? "Tunnel connected to atlas" : "Tunnel stopped"}
          </button>
        )}
      </div>
    </aside>
  );
}

/** ⌘K: navigation plus the handful of actions people reach for. */
export function Palette() {
  const ws = useWorkspace();
  const role = ws.role === "source" ? "source" : "follower";
  const { main, settings } = navFor(role);

  const { setPaletteOpen, tourOpen } = ws;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // The tour is modal and owns focus; opening the palette under it would leave the
        // keyboard in a dialog the user can't see.
        if (!tourOpen) setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen, tourOpen]);

  const run = (fn: () => void) => {
    ws.setPaletteOpen(false);
    fn();
  };

  return (
    <CommandDialog open={ws.paletteOpen} onOpenChange={ws.setPaletteOpen} title="Command palette" description="Go to a page or run an action" className="sm:max-w-[520px]">
      <Command>
      <CommandInput placeholder="Type a command or page…" />
      <CommandList className="max-h-[360px]">
        <CommandEmpty className="text-sm text-muted-foreground">No matching page or action.</CommandEmpty>
        <CommandGroup heading="Actions">
          {role === "source" ? (
            <>
              <CommandItem disabled={ws.pending.length === 0} onSelect={() => run(() => ws.setPublishOpen(true))}>
                <PaperPlaneTilt className="text-muted-foreground" />
                Publish revision {ws.nextSequence}
                <CommandShortcut className="text-xs tracking-normal tabular-nums">{ws.pending.length === 0 ? "No changes" : `${ws.pending.length} changes`}</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => run(() => ws.setInviteOpen(true))}>
                <UserPlus className="text-muted-foreground" />
                Add a machine
              </CommandItem>
              <CommandItem disabled={ws.followers.length === 0} onSelect={() => run(() => ws.setChangeGroups({}))}>
                <UsersThree className="text-muted-foreground" />
                Change a machine's groups
              </CommandItem>
              <CommandItem onSelect={() => run(() => ws.go("profile", "new"))}>
                <FileCode className="text-muted-foreground" />
                Add to the profile
              </CommandItem>
            </>
          ) : (
            <>
              <CommandItem onSelect={() => run(() => ws.setView("sync"))}>
                <ArrowsClockwise className="text-muted-foreground" />
                Review what will change
              </CommandItem>
              <CommandItem onSelect={() => run(() => ws.go("overlays", "new"))}>
                <Stack className="text-muted-foreground" />
                Keep a key on this machine
              </CommandItem>
            </>
          )}
          <CommandItem onSelect={() => run(() => ws.setTourOpen(true))}>
            <Signpost className="text-muted-foreground" />
            Take the tour
          </CommandItem>
          {ws.getStartedHidden && (
            <CommandItem onSelect={() => run(() => (ws.setGetStartedHidden(false), ws.setView("overview")))}>
              <ListChecks className="text-muted-foreground" />
              Show Get started
            </CommandItem>
          )}
          <CommandItem onSelect={() => run(() => ws.go("doctor", "run"))}>
            <Stethoscope className="text-muted-foreground" />
            Run health check
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Go to">
          {main.map((n) => (
            <CommandItem key={n.view} value={`go ${n.label}`} onSelect={() => run(() => ws.setView(n.view))}>
              <n.icon className="text-muted-foreground" />
              {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Settings">
          {settings.map((n) => (
            <CommandItem key={n.view} value={`settings ${n.label}`} onSelect={() => run(() => ws.setView(n.view))}>
              <n.icon className="text-muted-foreground" />
              {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
