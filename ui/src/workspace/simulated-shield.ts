// The demo's Shield page: made-up log entries and plugins in the shape /api/shield returns, so the same page
// renders live and demo data. Changes stay in memory, like the rest of the demo.
import { useState } from "react";
import type { GuiShield, GuiShieldRequest } from "../../../src/gui/contract/shield";
import type { ShieldSlice } from "./workspace-types";

const READY = { loading: false, error: null };
const NOTE = "Hooks apply after sync and client reload. Hard protection applies only to shield run. Mixed config files stay writable for native authentication.";

/** Times count back from when the demo opened, so the entries always read as today, yesterday and this week. */
function seed(role: "source" | "follower", folder: string): GuiShield {
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  return {
    status: { enabled: true, hard: false, scope: role === "source" ? "canonical" : "local", destination: role === "source" ? folder : `${folder}/local`, projected: true, excludedPlugins: ["scrape-everything"], note: NOTE },
    log: [
      { at: ago(1.5), kind: "blocked", harness: "claude-code", path: "~/.claude/skills/pdf-tools/SKILL.md" },
      { at: ago(2), kind: "blocked", harness: "codex", installer: "codex mcp add" },
      { at: ago(2.1), kind: "installed", installer: "mcp", items: ["mcp/linear"] },
      { at: ago(5), kind: "installed", installer: "skills", items: ["skills/web-design-guidelines"] },
      { at: ago(26), kind: "installed", installer: "plugin", items: ["plugins/session-notes"] },
      { at: ago(30), kind: "ingested", path: "~/.codex/config.toml", item: "mcp/postgres" },
      { at: ago(30), kind: "ingested", path: "~/.config/opencode/plugins/opencode-git-guard", item: "plugins/opencode-git-guard" },
      { at: ago(75), kind: "ingested", path: "~/.claude/plugins/commit-helper", item: "plugins/commit-helper" },
      { at: ago(98), kind: "blocked", harness: "amp", path: "~/.config/amp/skills/scrape-everything/SKILL.md" },
      { at: ago(98), kind: "ingested", path: "~/.config/amp/plugins/scrape-everything", item: "plugins/scrape-everything" },
    ],
    plugins: [
      { id: "session-notes", harnesses: ["claude-code"], entries: [".claude-plugin/hooks/session-end.js"], requires: [], files: 6, digest: "a".repeat(64), reviewed: false, excluded: false },
      { id: "opencode-git-guard", harnesses: ["opencode"], entries: ["index.js"], requires: ["tools/gh"], files: 3, digest: "b".repeat(64), reviewed: false, excluded: false },
      { id: "commit-helper", harnesses: ["claude-code"], entries: [".claude-plugin/commands/commit.md"], requires: [], files: 4, digest: "c".repeat(64), reviewed: true, excluded: false },
      { id: "scrape-everything", harnesses: ["amp"], entries: ["index.js"], requires: [], files: 9, digest: "d".repeat(64), reviewed: false, excluded: true },
    ],
  };
}

/** The same transitions `canonfig shield` makes: policy changes wait for a sync, reviews and exclusions apply at once. */
function apply(shield: GuiShield, request: GuiShieldRequest): GuiShield {
  const { status } = shield;
  switch (request.action) {
    case "enable": return { ...shield, status: { ...status, enabled: true, hard: request.hard } };
    case "disable": return { ...shield, status: { ...status, enabled: false, hard: false } };
    case "review": return { ...shield, plugins: shield.plugins.map((plugin) => plugin.id === request.id ? { ...plugin, reviewed: true } : plugin) };
    case "exclude":
    case "include": {
      const excludedPlugins = request.action === "exclude" ? [...new Set([...status.excludedPlugins, request.id])] : status.excludedPlugins.filter((id) => id !== request.id);
      return { ...shield, status: { ...status, excludedPlugins }, plugins: shield.plugins.map((plugin) => ({ ...plugin, excluded: excludedPlugins.includes(plugin.id) })) };
    }
  }
}

/** Each demo machine has its own Shield, so switching between Source and Follower keeps both pages' changes. */
export function useSimulatedShield(role: "source" | "follower", folder: string): ShieldSlice {
  const [machines, setMachines] = useState(() => ({ source: seed("source", folder), follower: seed("follower", folder) }));
  return {
    data: machines[role], state: READY, action: READY,
    run: async (request) => { setMachines((current) => ({ ...current, [role]: apply(current[role], request) })); return true; },
  };
}
