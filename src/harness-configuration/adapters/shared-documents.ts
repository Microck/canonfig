import fs from "node:fs/promises";
import path from "node:path";

import type { Agent, Command, Rule } from "../core/schema.ts";
import type { ArtifactOwner, BuildContext, DesiredArtifact, TargetId } from "../core/types.ts";
import { assertRealPathInside, assertSafeRelativePath, resolveInside, toPosix } from "../core/path.ts";
import { markdownWithFrontmatter } from "../core/frontmatter.ts";
import { walkFiles } from "../core/filesystem.ts";

export const RUNTIME_MARKER = ".canonfig/.runtime/hook-runner.mjs";

export async function readCanonfigText(context: BuildContext, relativePath: string): Promise<string> {
  const safe = assertSafeRelativePath(relativePath);
  const absolute = resolveInside(context.canonfigDir, safe);
  await assertRealPathInside(context.canonfigDir, absolute);
  return fs.readFile(absolute, "utf8");
}

export async function copyDirectoryArtifacts(
  context: BuildContext,
  sourceRelative: string,
  destination: string,
  owner: ArtifactOwner,
): Promise<DesiredArtifact[]> {
  const source = resolveInside(context.canonfigDir, assertSafeRelativePath(sourceRelative));
  try {
    await assertRealPathInside(context.canonfigDir, source);
    await fs.access(source);
  } catch {
    return [];
  }

  const files = await walkFiles(source);
  const artifacts: DesiredArtifact[] = [];
  for (const file of files.sort()) {
    const absolute = path.join(source, file);
    const [content, stat] = await Promise.all([fs.readFile(absolute), fs.stat(absolute)]);
    const executable = (stat.mode & 0o111) !== 0;
    artifacts.push({
      kind: "replace",
      path: toPosix(path.posix.join(destination, toPosix(file))),
      owner,
      content,
      ...(executable ? { mode: 0o755 } : {}),
    });
  }
  return artifacts;
}

export async function skillArtifacts(
  context: BuildContext,
  destination: string,
  owner: ArtifactOwner,
): Promise<DesiredArtifact[]> {
  const artifacts = new Map<string, DesiredArtifact>();
  for (const root of context.config.skills.roots) {
    const rootArtifacts = await copyDirectoryArtifacts(context, root, destination, owner);
    const replacedSkillDirectories = rootArtifacts
      .filter((artifact) => path.posix.basename(artifact.path) === "SKILL.md")
      .map((artifact) => path.posix.dirname(artifact.path));
    for (const skillDirectory of replacedSkillDirectories) {
      for (const artifactPath of artifacts.keys()) {
        if (artifactPath === skillDirectory || artifactPath.startsWith(`${skillDirectory}/`)) {
          artifacts.delete(artifactPath);
        }
      }
    }
    for (const artifact of rootArtifacts) {
      // Skill roots are layered in declaration order. Later roots represent
      // narrower scopes, and a manifest replaces its complete prior skill tree.
      artifacts.set(artifact.path, artifact);
    }
  }
  return [...artifacts.values()];
}

export async function ruleDocuments(context: BuildContext): Promise<Array<{ rule: Rule; content: string }>> {
  return Promise.all(context.config.instructions.rules.map(async (rule) => ({
    rule,
    content: await readCanonfigText(context, rule.file),
  })));
}

export async function agentDocuments(context: BuildContext): Promise<Array<{ agent: Agent; content: string }>> {
  return Promise.all(context.config.agents.map(async (agent) => ({
    agent,
    content: await readCanonfigText(context, agent.file),
  })));
}

export async function commandDocuments(context: BuildContext): Promise<Array<{ command: Command; content: string }>> {
  return Promise.all(context.config.commands.map(async (command) => ({
    command,
    content: await readCanonfigText(context, command.file),
  })));
}

export function agentMarkdown(agent: Agent, content: string, tools: string[]): string {
  return markdownWithFrontmatter({
    name: agent.id,
    description: agent.description,
    ...(agent.model === "inherit" ? {} : { model: agent.model }),
    tools,
  }, content);
}

export function commandMarkdown(command: Command, content: string): string {
  return markdownWithFrontmatter({
    description: command.description,
    ...(command.argumentHint ? { "argument-hint": command.argumentHint } : {}),
  }, content);
}

export function ruleMarkdown(rule: Rule, content: string, extra: Record<string, unknown> = {}): string {
  return markdownWithFrontmatter({
    description: rule.description ?? `Canonfig rule: ${rule.id}`,
    ...(rule.paths.length ? { globs: rule.paths } : {}),
    ...extra,
  }, content);
}

export function skillMarkdown(
  name: string,
  description: string,
  content: string,
  metadata: Record<string, unknown> = {},
): string {
  return markdownWithFrontmatter({ name, description, ...metadata }, content);
}

function translatedSkillName(owner: TargetId, kind: "command" | "agent", id: string): string {
  return `canonfig-${owner}-${kind}-${id}`;
}

export async function commandSkillArtifacts(
  context: BuildContext,
  destination: string,
  owner: TargetId,
): Promise<DesiredArtifact[]> {
  const documents = await commandDocuments(context);
  return documents.map(({ command, content }) => {
    const name = translatedSkillName(owner, "command", command.id);
    return {
      kind: "replace",
      path: `${destination}/${name}/SKILL.md`,
      owner,
      content: skillMarkdown(name, command.description, content, {
        metadata: { canonfig: { kind: "command", sourceId: command.id, argumentHint: command.argumentHint ?? null } },
      }),
    };
  });
}

export async function agentSkillArtifacts(
  context: BuildContext,
  destination: string,
  owner: TargetId,
): Promise<DesiredArtifact[]> {
  const documents = await agentDocuments(context);
  return documents.map(({ agent, content }) => {
    const name = translatedSkillName(owner, "agent", agent.id);
    return {
      kind: "replace",
      path: `${destination}/${name}/SKILL.md`,
      owner,
      content: skillMarkdown(name, agent.description, content, {
        metadata: { canonfig: { kind: "agent", sourceId: agent.id, model: agent.model, tools: agent.tools } },
      }),
    };
  });
}
