import type { LocalCategory, LocalItem } from "@/shared/metadata";
import type { Workspace } from "./workspace-types";

/** Singular names as Canonfig's collision message uses them (src/projection/folder.ts addLocal). */
export const LOCAL_ONE: Record<LocalCategory, string> = { instructions: "instructions", rules: "rule", skills: "skill", agents: "agent", commands: "command", mcp: "MCP server", settings: "setting" };

/** Whether two settings key paths name the same key or one sits inside the other. */
export const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/**
 * A local item's name collision with a published item, as Canonfig's message words it (addLocal and
 * mergeLocalSettings in src/projection/folder.ts), or null. Items outside local.allow aren't loaded, so they never
 * collide, and local/AGENTS.md is appended rather than compared. The message leaves out the command it suggests:
 * here that choice is a button.
 */
export function collisionOf(l: LocalItem, ws: Pick<Workspace, "profile" | "resources">): string | null {
  if (l.category === "instructions" || !ws.profile.localAllow.includes(l.category)) return null;
  const name = l.id.slice(l.category.length + 1);
  if (l.category === "settings") {
    const published = Object.keys(ws.resources.find((r) => r.id === l.id)?.keys ?? {});
    for (const key of Object.keys(l.keys ?? {})) {
      const clash = published.find((p) => overlaps(key, p));
      if (clash) return `local setting ${name} ${key} overlaps published setting ${clash}; remove one of them`;
    }
    return null;
  }
  return ws.resources.some((r) => r.change !== "added" && r.id === l.id) ? `local ${LOCAL_ONE[l.category]} ${name} has the same name as a published one; rename or remove one of them` : null;
}

/** Local items whose collision no overlay settles. Any one stops the whole update before it changes anything. */
export function unsettledCollisions(local: LocalItem[], overlays: string[], ws: Pick<Workspace, "profile" | "resources">) {
  return local.filter((l) => !overlays.includes(l.id) && collisionOf(l, ws) !== null);
}
