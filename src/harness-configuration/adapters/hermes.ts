import type {
  BuildContext,
  DesiredArtifact,
  Diagnostic,
  HarnessAdapter,
} from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import { enabledHooks, readCanonfigText } from "./shared.ts";

function projectContext(context: BuildContext, root: string): string {
  const rules = context.config.instructions.rules.length === 0
    ? ["- No additional scoped rules are configured."]
    : context.config.instructions.rules.map((rule) => {
        const scope = rule.paths.length ? rule.paths.join(", ") : "all files";
        return `- ${scope}: read \`.canonfig/${rule.file}\`.`;
      });
  const agents = context.config.agents.length === 0
    ? ["- No canonical agent profiles are configured."]
    : context.config.agents.map((agent) =>
        `- ${agent.id}: ${agent.description} (source: \`.canonfig/${agent.file}\`).`
      );
  const commands = context.config.commands.length === 0
    ? ["- No canonical commands are configured."]
    : context.config.commands.map((command) =>
        `- ${command.id}: ${command.description} (source: \`.canonfig/${command.file}\`).`
      );
  const skills = context.config.skills.roots.length === 0
    ? ["- No canonical skill roots are configured."]
    : context.config.skills.roots.map((skillRoot) =>
        `- Inspect \`.canonfig/${skillRoot}\` or the projected \`.agents/skills\` directory for relevant SKILL.md packages.`
      );

  return [
    "# Canonfig project context for Hermes",
    "",
    root.trim(),
    "",
    "## Scoped rules",
    "",
    ...rules,
    "",
    "## Canonical skills",
    "",
    ...skills,
    "",
    "Hermes does not discover project-local skills as native profile skills. Read the relevant SKILL.md package before applying a documented workflow.",
    "",
    "## Canonical agent profiles",
    "",
    ...agents,
    "",
    "Treat an explicitly requested profile as task-specific instructions; Hermes does not install these as native profile agents.",
    "",
    "## Canonical commands",
    "",
    ...commands,
    "",
    "When the user invokes one of these command names, read its source and execute that workflow.",
  ].join("\n");
}

export const hermesAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "hermes",
    "Hermes Agent",
    ["hermes"],
    [
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/context-files.md",
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md",
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md",
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md",
    ],
    {
      instructions: "native",
      rules: "translated",
      skills: "translated",
      mcp: "lossy",
      hooks: "lossy",
      agents: "translated",
      commands: "translated",
      permissions: "lossy",
    },
    [
      "Hermes natively loads project AGENTS.md and .hermes.md context, including nested AGENTS.md discovery.",
      "Hermes skills, MCP servers, hooks, and permanent permissions are stored under the active HERMES_HOME profile, outside Canonfig's repository-confined writer.",
      "The adapter projects skills, agents, and commands into .hermes.md as explicit source references rather than mutating profile-scoped state.",
    ],
    "2026-08-26",
  ),
  async build(context) {
    const diagnostics: Diagnostic[] = [];
    const root = await readCanonfigText(context, context.config.instructions.root);
    const artifacts: DesiredArtifact[] = [{
      kind: "managed-text",
      path: ".hermes.md",
      owner: "hermes",
      marker: "project-context",
      comments: "html",
      placement: "end",
      content: projectContext(context, root),
    }];

    if (Object.keys(context.config.mcp.servers).length > 0) {
      diagnostics.push({
        level: "warning",
        code: "HERMES_PROFILE_MCP_REQUIRED",
        target: "hermes",
        message: "Hermes MCP servers live in the active profile's config.yaml; Canonfig left them uninstalled rather than writing outside the repository.",
      });
    }
    if (enabledHooks(context).length > 0) {
      diagnostics.push({
        level: "warning",
        code: "HERMES_PROFILE_HOOKS_REQUIRED",
        target: "hermes",
        message: "Hermes shell hooks live in the active profile's config.yaml; Canonfig left them uninstalled rather than writing outside the repository.",
      });
    }
    if (context.config.permissions.rules.length > 0) {
      diagnostics.push({
        level: "warning",
        code: "HERMES_PROFILE_PERMISSIONS_REQUIRED",
        target: "hermes",
        message: "Hermes permission state is profile-scoped; canonical project permission rules were not installed automatically.",
      });
    }

    return { artifacts, diagnostics };
  },
};
