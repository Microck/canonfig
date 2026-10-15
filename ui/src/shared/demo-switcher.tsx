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
      className="grid gap-1 rounded-xl bg-white p-1 text-[11px] leading-none text-black shadow-[0_4px_16px_rgba(0,0,0,0.5)]"
    >
      <span aria-hidden className="px-1.5 pt-1 font-medium text-black/60">
        Demo
      </span>
      <div className="flex gap-0.5">
        {ROLES.map((r) => (
          <a
            key={r.key}
            href={roleHref(r.key)}
            aria-current={r.key === role ? "page" : undefined}
            onClick={followLink}
            className={cn("rounded-full px-2.5 py-1.5 whitespace-nowrap", r.key === role ? "bg-black text-white" : "hover:bg-black/10")}
          >
            {r.label}
          </a>
        ))}
      </div>
    </div>
  );
}
