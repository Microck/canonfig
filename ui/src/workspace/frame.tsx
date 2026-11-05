// Workspace sidebar and command palette.
import { useEffect, useId, useRef, useState } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  FileCode,
  ListChecks,
  MagnifyingGlass,
  PaperPlaneTilt,
  FoldedMap,
  Stack,
  Stethoscope,
  UserPlus,
  UsersThree,
} from "@/components/icons";
import { cn, SNAP } from "@/lib/utils";
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
import { AnimatedNumber, Logo, StatusMark } from "@/shared/shared";
import { APP_VERSION, DEMO, PLAIN, machine } from "@/shared/data";
import { DemoSwitcher } from "@/shared/demo-switcher";
import { useSharedState, useWorkspace, type View } from "./store";
import { copy } from "./kit";
import { useSelfUpdate } from "./settings";
import { focusPageHeading, followLink, workspaceHref } from "./routes";
import { NAV, type NavItem } from "./nav";

/** ⌘ on Apple platforms, Ctrl elsewhere; the palette listens for both. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";

/*
 * Sidebar rows sit 12px in from the sidebar edge with 7px of padding. Icons are Solar Linear at 16px (Bold for the
 * active page): the glyph fills about 13px of the box, close to the ~12px glyphs beside Linear's 13px labels; a 14px
 * box would paint only ~11px. A 16px box at x19 puts the icon's centre
 * at x27 and, with a 5px gap, the label at x40: the same centre and label edge as Linear's 14px box at x20 with 6px.
 * Inactive rows use the muted tier so the active page reads first; hover brings them to full foreground.
 * The current page's fill is one shared element (`layoutId`) that glides to the clicked item in 150ms
 * on --ease-snap instead of jumping, so the eye follows the selection. Navigation is frequent, so it
 * stays short and transform-only; reduced motion makes it instant.
 */
function NavButton({ item, active, badge, onNavigate }: { item: NavItem; active: boolean; badge?: React.ReactNode; onNavigate?: () => void }) {
  const ws = useWorkspace();
  const reduce = useReducedMotion();
  const Icon = item.icon;
  return (
    <a
      href={workspaceHref(ws.role, item.view)}
      data-tour={`nav-${item.view}`}
      onClick={(event) => followLink(event, (href) => {
        onNavigate?.();
        ws.navigate(href);
      })}
      aria-current={active ? "page" : undefined}
      className={cn(
        // 44px rows for touch (DESIGN.md rule 13); active gives touch a press state, since it has no hover.
        "relative isolate flex h-[28px] w-full items-center gap-[5px] rounded-lg pr-[9px] pl-[7px] text-base font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11",
        active ? "text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground active:bg-sidebar-accent/60 active:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          aria-hidden
          className="absolute inset-0 -z-10 rounded-lg bg-sidebar-accent"
          transition={reduce ? { duration: 0 } : { duration: 0.15, ease: SNAP }}
        />
      )}
      <Icon bold={active} className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
      {badge && <span className="ml-auto">{badge}</span>}
    </a>
  );
}

/** A sidebar count. Neutral counts are plain digits; only states that ask for action get a tinted chip. */
export function Count({ value, tone = "muted", label }: { value: number; tone?: "muted" | "warn" | "act"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded px-1 pt-[0.5px] text-xs leading-none font-medium tabular-nums",
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

/**
 * The full navigation column. Frame shows it inline from md up and inside a Sheet below md, where
 * `onOpenTours` waits for the sheet to close before opening the tour picker.
 */
export function Sidebar({ className, onNavigate, onOpenTours }: { className?: string; onNavigate?: () => void; onOpenTours?: () => void }) {
  const ws = useWorkspace();
  const role = ws.role === "source" ? "source" : "follower";
  const { main, settings } = NAV[role];
  const inSettings = settings.some((s) => s.view === ws.view);
  const [open, setOpen] = useState(inSettings);
  const navGroup = useId();
  const menuNavigated = useRef(false);
  // Choosing a page counts even when it is already shown: the user asked to land on it, so focus goes to its h1
  // rather than back to the switcher.
  const navigateFromMenu = (view: View) => {
    menuNavigated.current = true;
    ws.setView(view);
  };
  useEffect(() => {
    if (inSettings) setOpen(true);
  }, [inSettings]);

  const attention = ws.followers.filter((f) => f.state !== "converged").length;
  // Same keys and initials as the Source service and SSH tunnel pages that own them.
  const [serviceInstalled] = useSharedState("service-installed", true);
  const [tunnelUp] = useSharedState("tunnel-up", true);
  const [selfUpdate] = useSelfUpdate();
  const newer = selfUpdate.latest !== null && selfUpdate.latest !== (selfUpdate.installed ?? APP_VERSION) ? selfUpdate.latest : null;
  const badges: Partial<Record<View, React.ReactNode>> =
    role === "source"
      ? {
          profile: ws.pending.length > 0 ? <Count tone="warn" value={ws.pending.length} label={`${ws.pending.length} unpublished changes`} /> : undefined,
          machines: attention > 0 ? <Count value={attention} label={`${attention} need attention`} /> : undefined,
        }
      : {
          // A stopped machine cannot apply, so it must not advertise a ready revision.
          sync: ws.phase !== "done" && !ws.unenrolled ? <Count tone="warn" value={1} label={`Revision ${ws.targetRevision} ready to apply`} /> : undefined,
          // Like the Source's counts, a badge only appears when there is something to count.
          local: ws.local.length > 0 ? <Count value={ws.local.length} label={`${ws.local.length} items in the local folder`} /> : undefined,
        };

  return (
    <aside className={cn("flex w-[244px] shrink-0 flex-col overflow-y-auto overscroll-contain bg-sidebar px-[12px] pt-[8px] pb-3 [&>*]:shrink-0", className)} aria-label="Main navigation">
      {/* One 28px line in a 44px top band, like Linear's workspace switcher; the full role sentence lives in the menu. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-tour="machine"
            className="flex h-[28px] items-center gap-2 rounded-lg px-[8px] text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11"
          >
            <Logo />
            <span className="flex min-w-0 items-baseline gap-1.5 text-base">
              <span className="truncate font-semibold">{ws.machineName}</span>
              <span className="shrink-0 text-sm text-muted-foreground">{role === "source" ? "Source" : "Follower"}</span>
            </span>
            <CaretDown className="ml-auto size-3.5 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-60"
          onCloseAutoFocus={(event) => {
            // The mobile sheet can unmount this sidebar before its new view reaches this callback.
            // Record the navigation at selection time instead of comparing a teardown closure's view.
            const navigated = menuNavigated.current;
            menuNavigated.current = false;
            if (!navigated) return;
            event.preventDefault();
            focusPageHeading();
          }}
        >
          <DropdownMenuLabel className="grid gap-0.5 font-normal">
            <span className="text-sm text-muted-foreground">{role === "source" ? "The Source: you edit here" : "Gets its setup from atlas"}</span>
            <span className="text-xs text-faint">
              Canonfig {APP_VERSION} on {role === "source" ? "Linux" : "macOS"}
            </span>
          </DropdownMenuLabel>
          {role === "source" ? (
            <>
              <DropdownMenuItem onSelect={() => copy(machine.folder, "Folder path copied")}>
                Copy Canonfig folder path
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => copy(ws.endpoint, "Endpoint copied")}>Copy source endpoint</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigateFromMenu("service")}>Source service settings</DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => navigateFromMenu("machine")}>Enrollment</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigateFromMenu("tunnel")}>SSH tunnel</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" disabled={ws.unenrolled} onSelect={() => ws.setUnenrollOpen(true)}>
                {PLAIN.unenroll}…
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onSelect={() => navigateFromMenu("version")}>{newer ? `Canonfig ${newer} is available` : "Canonfig version"}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => toast("Open Canonfig on that machine to manage it")}>Manage another machine…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        data-tour="search"
        onClick={() => ws.setPaletteOpen(true)}
        className="mt-[8px] flex h-[28px] items-center gap-[6px] rounded-lg border border-border bg-panel/60 px-[7px] text-sm text-muted-foreground outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:border-border-strong active:text-foreground pointer-coarse:h-11"
      >
        <MagnifyingGlass className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate whitespace-nowrap">Search or jump to…</span>
        <Kbd className="ml-auto h-4 bg-raised px-1 text-xs">{MOD}K</Kbd>
      </button>

      {/* One group per sidebar instance, so the desktop sidebar and the mobile sheet never trade the highlight. */}
      <LayoutGroup id={navGroup}>
        <nav className="mt-4 grid gap-px">
          {main.map((item) => (
            <NavButton key={item.view} item={item} active={ws.view === item.view} badge={badges[item.view]} onNavigate={onNavigate} />
          ))}
        </nav>

        <Collapsible open={open} onOpenChange={setOpen} className="mt-5">
          <CollapsibleTrigger
            data-tour="settings"
            className="flex h-6 w-full items-center gap-1 rounded-md px-[8px] text-xs font-medium text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11"
          >
            Settings
            <CaretRight className={cn("size-3 transition-transform duration-150 ease-snap", open && "rotate-90")} />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-px grid gap-px">
            {settings.map((item) => (
              <NavButton key={item.view} item={item} active={ws.view === item.view} onNavigate={onNavigate} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      </LayoutGroup>

      {/* mt-auto keeps the footer at the bottom. The demo panel stays in flow so short windows never place it over
          navigation links; below md the mobile bar's Demo button (workspace.tsx) replaces it in the sheet. */}
      <div className="mt-auto">{DEMO && <DemoSwitcher role={role} className="pt-3 max-md:hidden" />}</div>

      {/* Footer icons and dots line up with the nav icons (x20) and their text with the nav labels (x40). */}
      <div className="grid gap-0.5 px-[8px] pt-3">
        <button
          type="button"
          data-tour="tour"
          onClick={onOpenTours ?? (() => ws.setTourPickerOpen(true))}
          className="flex h-7 w-full items-center gap-[6px] rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11"
        >
          <FoldedMap className="size-3.5" />
          Take the tour
        </button>
        {role === "source" ? (
          <button type="button" onClick={() => ws.setView("service")} className="flex h-7 w-full items-center gap-[6px] rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11">
            <StatusMark kind={serviceInstalled ? "ok" : "off"} />
            <span>{serviceInstalled ? "Source service running" : "Source service not installed"}</span>
          </button>
        ) : (
          <button type="button" onClick={() => ws.setView("tunnel")} className="flex h-7 w-full items-center gap-[6px] rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11">
            <StatusMark kind={!ws.tunnelConfigured ? "off" : tunnelUp ? "ok" : "offline"} />
            <span>{!ws.tunnelConfigured ? "No SSH tunnel set up" : tunnelUp ? "Tunnel connected to atlas" : "Tunnel stopped"}</span>
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
  const { main, settings } = NAV[role];

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

  // The page a command ran from. The opener may be gone after a page change, so focus goes to the new heading.
  const ranFrom = useRef<View | null>(null);
  const run = (fn: () => void) => {
    ranFrom.current = ws.view;
    ws.setPaletteOpen(false);
    fn();
  };

  return (
    <CommandDialog
      open={ws.paletteOpen}
      onOpenChange={ws.setPaletteOpen}
      onCloseAutoFocus={(event) => {
        const from = ranFrom.current;
        ranFrom.current = null;
        if (from === null || from === ws.view) return;
        event.preventDefault();
        focusPageHeading();
      }}
      title="Command palette"
      description="Go to a page or run an action"
      className="sm:max-w-[520px]"
    >
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
                <CommandShortcut className="text-xs tracking-normal tabular-nums">{ws.pending.length === 0 ? "No changes" : ws.pending.length === 1 ? "1 change" : `${ws.pending.length} changes`}</CommandShortcut>
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
                Add to the folder
              </CommandItem>
            </>
          ) : (
            <>
              <CommandItem onSelect={() => run(() => ws.setView("sync"))}>
                <ArrowsClockwise className="text-muted-foreground" />
                Review what will change
              </CommandItem>
              <CommandItem onSelect={() => run(() => ws.go("local", "new"))}>
                <Stack className="text-muted-foreground" />
                Add a local item
              </CommandItem>
            </>
          )}
          <CommandItem onSelect={() => run(() => ws.setTourPickerOpen(true))}>
            <FoldedMap className="text-muted-foreground" />
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
