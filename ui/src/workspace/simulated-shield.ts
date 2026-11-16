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
    status: { enabled: true, hard: false, scope: role === "source" ? "canonical" : "local", destination: role === "source" ? folder : `${folder}/local`,
      projected: ["amp", "claude-code", "codex", "copilot-cli", "opencode"], excludedPlugins: ["scrape-everything"], note: NOTE },
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
    // scrape-everything is excluded here, so like the live folder loader the list leaves it out.
    plugins: [
      { id: "session-notes", harnesses: ["claude-code"], entries: [".claude-plugin/hooks/session-end.js"], requires: [], digest: "a".repeat(64), reviewed: false },
      { id: "opencode-git-guard", harnesses: ["opencode"], entries: ["index.js"], requires: ["tools/gh"], digest: "b".repeat(64), reviewed: false },
      { id: "commit-helper", harnesses: ["claude-code"], entries: [".claude-plugin/commands/commit.md"], requires: [], digest: "c".repeat(64), reviewed: true },
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
    case "exclude": return {
      ...shield,
      status: { ...status, excludedPlugins: [...new Set([...status.excludedPlugins, request.id])] },
      plugins: shield.plugins.filter((plugin) => plugin.id !== request.id),
    };
  }
}

/** The demo provider is keyed by role (simulated-app.tsx), so each role starts from its own seed. */
export function useSimulatedShield(role: "source" | "follower", folder: string): ShieldSlice {
  const [shield, setShield] = useState(() => seed(role, folder));
  return {
    data: shield, state: READY, action: READY,
    run: async (request) => { setShield((current) => apply(current, request)); return true; },
  };
}
