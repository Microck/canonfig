import { sha256Hex } from "../../profile/profile-codec.ts";
import type { ProjectedFile } from "../harness.ts";
import { type FrontmatterData, markdownWithFrontmatter } from "../frontmatter.ts";
import type {
  AgentDocument,
  CanonicalModel,
  CommandDocument,
  RuleDocument,
  SkillTree,
} from "../model.ts";

type Activation = NonNullable<RuleDocument["activation"]>;

/** A rule without an explicit activation is path-scoped when it names paths. */
export function ruleActivation(rule: RuleDocument): Activation {
  return rule.activation ?? (rule.paths.length > 0 ? "path" : "always");
}

function ruleScope(rule: RuleDocument): string {
  switch (ruleActivation(rule)) {
    case "always":
      return "always applies";
    case "path":
      return `applies to ${rule.paths.map((pattern) => `\`${pattern}\``).join(", ")}`;
    case "manual":
      return "applies only when the user asks for it";
    case "model":
      return "applies when its description matches the task";
  }
}

/**
 * The global instruction file: the canonical instructions, plus, for a harness
 * without a native global rules location, one link per rule to its authored
 * file under `~/.canonfig/rules/`. Undefined when there is nothing to say.
 */
export function instructionsText(model: CanonicalModel, linkRules: boolean): string | undefined {
  const sections: Array<string> = [];
  const instructions = model.instructions?.trim();
  if (instructions) sections.push(instructions);
  if (linkRules && model.rules.length > 0) {
    sections.push([
      "## Canonfig rules",
      "",
      "Read a rule file before doing work it covers:",
      "",
      ...model.rules.map((rule) => {
        const description = rule.description ? `: ${rule.description}` : "";
        return `- \`${rule.source}\` (${ruleScope(rule)})${description}`;
      }),
    ].join("\n"));
  }
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : undefined;
}

/** Windsurf-style `trigger` values that Devin and Antigravity rule frontmatter share. */
const TRIGGERS = {
  always: "always_on",
  path: "glob",
  manual: "manual",
  model: "model_decision",
} satisfies Record<Activation, string>;

/** Rule frontmatter with `trigger`, `description` and comma-separated `globs`. */
export function triggerRuleMarkdown(rule: RuleDocument): string {
  const data: Array<[string, string]> = [["trigger", TRIGGERS[ruleActivation(rule)]]];
  if (rule.description) data.push(["description", rule.description]);
  if (rule.paths.length > 0) data.push(["globs", rule.paths.join(", ")]);
  return markdownWithFrontmatter(Object.fromEntries(data), rule.content);
}

/** Rule frontmatter in the Cursor style (`description`, `globs`, `alwaysApply`). */
export function globRuleMarkdown(rule: RuleDocument): string {
  const data: Array<[string, string | boolean | ReadonlyArray<string>]> = [
    ["description", rule.description ?? `Canonfig rule: ${rule.id}`],
  ];
  if (rule.paths.length > 0) data.push(["globs", rule.paths]);
  data.push(["alwaysApply", ruleActivation(rule) === "always"]);
  return markdownWithFrontmatter(Object.fromEntries(data), rule.content);
}

/** Subagent markdown with `name`, `description`, optional `model` and `tools`. */
export function agentMarkdown(
  agent: AgentDocument,
  tools: ReadonlyArray<string>,
  extra: FrontmatterData = {},
): string {
  const data: Array<[string, FrontmatterData[string]]> = [
    ["name", agent.id],
    ["description", agent.description],
  ];
  if (agent.model !== "inherit") data.push(["model", agent.model]);
  data.push(["tools", tools]);
  return markdownWithFrontmatter({ ...Object.fromEntries(data), ...extra }, agent.content);
}

/** Slash-command markdown with `description` and an optional `argument-hint`. */
export function commandMarkdown(command: CommandDocument): string {
  const data: Array<[string, string]> = [["description", command.description]];
  if (command.argumentHint) data.push(["argument-hint", command.argumentHint]);
  return markdownWithFrontmatter(Object.fromEntries(data), command.content);
}

/** The portable skill name reserved by a command ID. */
export function commandSkillName(id: string): string {
  const normalized = `command-${id.toLowerCase().replace(/[-_]+/gu, "-").replace(/-$/u, "")}`;
  return normalized.length <= 64
    ? normalized
    : `${normalized.slice(0, 51).replace(/-$/u, "")}-${sha256Hex(id).slice(0, 12)}`;
}

/** Render a command as a portable Agent Skill, including a directory-safe manifest name. */
export function commandSkill(command: CommandDocument): SkillTree {
  const name = commandSkillName(command.id);
  const description = [...command.description.trim()].slice(0, 1024).join("") || `Run the ${command.id} command.`;
  const body = command.argumentHint ? `${command.content}\n\nArgument hint: ${command.argumentHint}` : command.content;
  const markdown = markdownWithFrontmatter({ name, description }, body);
  return {
    name,
    description,
    files: [{ path: "SKILL.md", content: new TextEncoder().encode(markdown), executable: false }],
  };
}

/** One file per document, named `<id><suffix>`. */
export function documentFiles<Document extends { readonly id: string }>(
  documents: ReadonlyArray<Document>,
  suffix: string,
  render: (document: Document) => string,
): Array<ProjectedFile> {
  return documents.map((document) => ({ path: `${document.id}${suffix}`, content: render(document) }));
}

/** The files of one skill, relative to that skill's own directory. */
export function skillTreeFiles(skill: SkillTree): Array<ProjectedFile> {
  return skill.files.map((file) => ({ path: file.path, content: file.content, executable: file.executable }));
}

/** Every skill as `<name>/<path>`, for a harness-private skills directory. */
export function skillDirectoryFiles(skills: ReadonlyArray<SkillTree>): Array<ProjectedFile> {
  return skills.flatMap((skill) =>
    skill.files.map((file) => ({ path: `${skill.name}/${file.path}`, content: file.content, executable: file.executable }))
  );
}
