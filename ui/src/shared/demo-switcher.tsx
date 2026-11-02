// The demo build's marker: says the app runs on made-up data, switches between simulated machine roles without
// changing the backend, and links to the docs and the repository. Callers mount it only when DEMO is set
// (src/shared/data.ts), so the production build carries none of it.
import { useState } from "react";
import { ArrowSquareOut, CaretDown } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { Role } from "./data";
import { focusPageHeading, followLink, roleHref } from "@/workspace/routes";

const ROLES: { key: Role; label: string }[] = [
  { key: "source", label: "Source" },
  { key: "follower", label: "Follower" },
  { key: "unconfigured", label: "New machine" },
];

// The docs are published beside the demo (canonfig.micr.dev/docs/), so these stay root-relative.
const LINKS = [
  { href: "/docs/", label: "Docs" },
  { href: "/docs/tutorials/first-sync/", label: "Install" },
  { href: "https://github.com/Microck/canonfig", label: "GitHub", external: true },
];

const ITEM = "flex min-h-11 min-w-11 flex-auto items-center justify-center gap-1 rounded-md px-2 whitespace-nowrap md:min-h-10";
const ITEM_INTERACTIVE = "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground";

function RoleLinks({ role }: { role: Role | null }) {
  return (
    <div role="group" aria-label="Demo role" className="flex gap-0.5">
      {ROLES.map((r) => (
        <a
          key={r.key}
          href={roleHref(r.key)}
          aria-current={r.key === role ? "page" : undefined}
          onClick={(event) => {
            followLink(event);
            // A role change remounts the workspace, so Frame's page-change effect never sees it and the clicked link
            // unmounts, leaving focus on body. Wait for the new role to render, then focus its h1.
            if (event.defaultPrevented) requestAnimationFrame(() => requestAnimationFrame(focusPageHeading));
          }}
          // The current role reads by its fill and colour only: a heavier weight would widen it and nudge its neighbours.
          className={cn(ITEM, r.key === role ? "bg-sidebar-accent text-sidebar-accent-foreground" : ITEM_INTERACTIVE)}
        >
          {r.label}
        </a>
      ))}
    </div>
  );
}

/** What the demo is, the role links, then the way out to the docs and the repository. */
function DemoInfo({ role }: { role: Role | null }) {
  return (
    <>
      <p className="px-1.5 pt-1 leading-snug text-muted-foreground">
        <span className="font-medium text-sidebar-foreground">Interactive demo</span> with made-up data
      </p>
      <RoleLinks role={role} />
      <div className="flex gap-0.5 border-t border-sidebar-border pt-1 text-muted-foreground">
        {LINKS.map((link) => (
          <a key={link.href} href={link.href} className={cn(ITEM, ITEM_INTERACTIVE)}>
            {link.label}
            {link.external && <ArrowSquareOut className="size-3" />}
          </a>
        ))}
      </div>
    </>
  );
}

const PANEL = "rounded-lg border border-sidebar-border bg-sidebar p-1 text-xs leading-none text-sidebar-foreground";

/**
 * `compact` is for places with no room for the panel below md: the mobile workspace bar and the setup header
 * (setup, not found). There it collapses to one "Demo" button that discloses the panel, so the demo control
 * never sits on top of app content on phones; the caller places that button. From md up both forms show the
 * full panel.
 */
export function DemoSwitcher({ role, compact = false, className }: { role: Role | null; compact?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const full = (
    <div className={cn("grid gap-1", PANEL, compact && "max-md:hidden")}>
      <DemoInfo role={role} />
    </div>
  );
  return (
    <aside aria-label="Demo" className={className}>
      {full}
      {compact && (
        <div
          className="relative md:hidden"
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              setOpen(false);
              (e.currentTarget.querySelector("button") as HTMLButtonElement).focus();
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-controls="demo-panel"
            onClick={() => setOpen((v) => !v)}
            className={cn("flex min-h-11 items-center gap-1.5 px-3 font-medium", PANEL)}
          >
            Demo
            <CaretDown className={cn("size-3 transition-transform duration-150 ease-snap", open && "rotate-180")} />
          </button>
          {open && (
            <div id="demo-panel" className={cn("absolute top-full right-0 z-50 mt-1 grid w-60 gap-1", PANEL)}>
              <DemoInfo role={role} />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
