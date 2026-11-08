import { harnesses, machine, profile, type HarnessId } from "@/shared/data";
import { Onboarding, type ImportOffer, type Setup } from "./onboarding";

/** One offer, with its id and folder destination derived the way src/projection/import.ts does (targetOf). */
function offer(
  source: ImportOffer["source"],
  category: ImportOffer["category"],
  name: string,
  path: string,
  { harnesses = [source as HarnessId], secrets = [], notes = [] }: { harnesses?: HarnessId[]; secrets?: ImportOffer["secrets"]; notes?: string[] } = {},
): ImportOffer {
  const target =
    category === "instructions" ? "AGENTS.md" : category === "skills" ? `skills/${name}` : category === "mcp" ? `canonfig.jsonc#mcp.${name}` : `${category}/${name}.md`;
  return { id: `${source}/${category}/${name}`, source, harnesses, category, name, path, target, secrets, notes };
}

// Example harness content on atlas, each item with its own content: when two are offered for
// one target they differ, so the CLI lists them as a collision until one is named. Here Claude
// Code's CLAUDE.md and Codex's AGENTS.md both import as AGENTS.md. The MCP servers show
// credential-looking values becoming `fromEnv` references, named as ServerDecoder in
// src/projection/import.ts names them: an env key keeps its name, a header becomes <SERVER>_<KEY>.
const IMPORT_OFFERS: ImportOffer[] = [
  offer("claude-code", "instructions", "AGENTS.md", "~/.claude/CLAUDE.md"),
  offer("claude-code", "rules", "typescript", "~/.claude/rules/typescript.md"),
  offer("claude-code", "skills", "review", "~/.claude/skills/review"),
  offer("claude-code", "agents", "researcher", "~/.claude/agents/researcher.md", {
    notes: ["Canonfig does not copy the metadata field tools because this tool names permissions differently. Review the imported agent's permissions before use."],
  }),
  offer("claude-code", "commands", "ship", "~/.claude/commands/ship.md"),
  offer("claude-code", "mcp", "github", "~/.claude.json", { secrets: ["env.GITHUB_TOKEN -> fromEnv GITHUB_TOKEN"] }),
  offer("codex", "instructions", "AGENTS.md", "~/.codex/AGENTS.md"),
  offer("codex", "mcp", "linear", "~/.codex/config.toml", {
    secrets: ["headers.Authorization -> fromEnv LINEAR_AUTHORIZATION"],
    notes: ["Its X-Timeout header isn't copied, because its value isn't text."],
  }),
  offer("opencode", "commands", "review-pr", "~/.config/opencode/commands/review-pr.md"),
  offer("agents", "skills", "release-notes", "~/.agents/skills/release-notes", { harnesses: ["codex", "cursor"] }),
];

/**
 * What the scan found but can't import, with the reason it gives (ImportSkip in src/projection/import.ts). Setup lists
 * these for review; they stay in the harness until Canonfig takes it over, and in its backup after that.
 */
const IMPORT_SKIPPED: { source: HarnessId; path: string; reason: string }[] = [
  { source: "claude-code", path: "~/.claude/skills/scratch", reason: "Missing SKILL.md. Add a SKILL.md file with a name and description to import this skill." },
  { source: "opencode", path: "~/.config/opencode/agents/helper.yaml", reason: "Only .md agent files can be imported. Convert this agent to Markdown, or continue without it." },
];

export function SimulatedOnboarding({ onDone }: { onDone: (setup: Setup) => void }) {
  return <Onboarding onDone={onDone} data={{
    hostname: machine.hostname, endpoint: machine.endpoint, profileName: profile.name,
    harnesses, offers: IMPORT_OFFERS, skipped: IMPORT_SKIPPED,
    present: [],
    collisions: [{
      kind: "candidates", target: "AGENTS.md",
      candidates: IMPORT_OFFERS.filter((item) => item.category === "instructions").map(({ id, source, path }) => ({ id, source, path })),
    }],
    followerInstalled: ["codex", "claude-code", "oh-my-pi", "opencode"],
  }} />;
}
