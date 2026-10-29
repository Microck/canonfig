// Demo controls switch between simulated machine roles without changing the backend.
import { cn } from "@/lib/utils";
import type { Role } from "./data";
import { followLink, roleHref } from "@/workspace/routes";

const ROLES: { key: Role; label: string }[] = [
  { key: "source", label: "Source" },
  { key: "follower", label: "Follower" },
  { key: "unconfigured", label: "New machine" },
];

export function DemoSwitcher({ role }: { role: Role | null }) {
  return (
    <div
      role="group"
      aria-label="Demo role"
      className="grid gap-1 rounded-lg border border-sidebar-border bg-sidebar p-1 text-xs leading-none text-sidebar-foreground"
    >
      <span aria-hidden className="px-1.5 pt-1 font-medium text-muted-foreground">
        Demo
      </span>
      <div className="flex gap-0.5">
        {ROLES.map((r) => (
          <a
            key={r.key}
            href={roleHref(r.key)}
            aria-current={r.key === role ? "page" : undefined}
            onClick={followLink}
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
    </div>
  );
}
