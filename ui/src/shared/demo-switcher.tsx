// Demo controls switch between simulated machine roles without changing the backend.
import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { Role } from "./data";
import { focusPageHeading, followLink, roleHref } from "@/workspace/routes";

const ROLES: { key: Role; label: string }[] = [
  { key: "source", label: "Source" },
  { key: "follower", label: "Follower" },
  { key: "unconfigured", label: "New machine" },
];

function RoleLinks({ role }: { role: Role | null }) {
  return (
    <div className="flex gap-0.5">
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
          className={cn(
            "flex min-h-11 min-w-11 flex-auto items-center justify-center rounded-md px-2 whitespace-nowrap md:min-h-10",
            r.key === role
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          {r.label}
        </a>
      ))}
    </div>
  );
}

const PANEL = "rounded-lg border border-sidebar-border bg-sidebar p-1 text-xs leading-none text-sidebar-foreground";

/**
 * `compact` is for the floating copy on pages without a sidebar (setup, not found). Below md it collapses to one
 * "Demo" button that discloses the role links, so the demo control never sits on top of app content on phones;
 * the caller places that button in a reserved header slot. From md up both forms show the full group.
 */
export function DemoSwitcher({ role, compact = false }: { role: Role | null; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const full = (
    <div role="group" aria-label="Demo role" className={cn("grid gap-1", PANEL, compact && "max-md:hidden")}>
      <span aria-hidden className="px-1.5 pt-1 font-medium text-muted-foreground">
        Demo
      </span>
      <RoleLinks role={role} />
    </div>
  );
  if (!compact) return full;
  return (
    <>
      {full}
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
          aria-controls="demo-role-menu"
          onClick={() => setOpen((v) => !v)}
          className={cn("flex min-h-11 items-center gap-1.5 px-3 font-medium", PANEL)}
        >
          Demo
          <CaretDown className={cn("size-3 transition-transform duration-150 ease-snap", open && "rotate-180")} />
        </button>
        {open && (
          <div id="demo-role-menu" role="group" aria-label="Demo role" className={cn("absolute top-full right-0 mt-1 w-max", PANEL)}>
            <RoleLinks role={role} />
          </div>
        )}
      </div>
    </>
  );
}
