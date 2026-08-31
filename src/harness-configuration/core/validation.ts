import fs from "node:fs/promises";
import path from "node:path";
import type { CanonfigConfig } from "./schema.ts";
import type { Diagnostic } from "./types.ts";
import { parseSkill } from "./frontmatter.ts";
import { walkFiles } from "./filesystem.ts";
import { assertSafeRelativePath } from "./path.ts";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function validateProject(root: string, config: CanonfigConfig): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const canonfigDir = path.join(root, ".canonfig");
  const referenced: Array<{ kind: string; relative: string }> = [
    { kind: "instruction", relative: config.instructions.root },
    ...config.instructions.rules.map((rule) => ({ kind: `rule ${rule.id}`, relative: rule.file })),
    ...config.agents.map((agent) => ({ kind: `agent ${agent.id}`, relative: agent.file })),
    ...config.commands.map((command) => ({ kind: `command ${command.id}`, relative: command.file })),
  ];

  for (const item of referenced) {
    const safe = assertSafeRelativePath(item.relative);
    if (!await exists(path.join(canonfigDir, safe))) {
      diagnostics.push({
        level: "error",
        code: "SOURCE_MISSING",
        path: `.canonfig/${safe}`,
        message: `Missing source for ${item.kind}: .canonfig/${safe}`,
      });
    }
  }

  const skillNames = new Map<string, { readonly path: string; readonly root: string }>();
  for (const rootRelative of config.skills.roots) {
    const safeRoot = assertSafeRelativePath(rootRelative);
    const absoluteRoot = path.join(canonfigDir, safeRoot);
    if (!await exists(absoluteRoot)) {
      diagnostics.push({
        level: "info",
        code: "SKILL_ROOT_MISSING",
        path: `.canonfig/${safeRoot}`,
        message: `Skill root .canonfig/${safeRoot} does not exist; it contributes no skills.`,
      });
      continue;
    }

    const manifests = (await walkFiles(absoluteRoot)).filter((file) => path.basename(file) === "SKILL.md");
    for (const manifest of manifests.sort()) {
      const relative = `.canonfig/${safeRoot}/${manifest}`;
      try {
        const source = await fs.readFile(path.join(absoluteRoot, manifest), "utf8");
        const parsed = parseSkill(source);
        const directoryName = path.basename(path.dirname(manifest));
        if (parsed.data.name !== directoryName) {
          diagnostics.push({
            level: "warning",
            code: "SKILL_NAME_DIRECTORY_MISMATCH",
            path: relative,
            message: `Skill name ${parsed.data.name} does not match its directory ${directoryName}.`,
          });
        }
        const previous = skillNames.get(parsed.data.name);
        if (previous?.root === safeRoot) {
          diagnostics.push({
            level: "error",
            code: "SKILL_NAME_DUPLICATE",
            path: relative,
            message: `Skill name ${parsed.data.name} is duplicated by ${previous.path} and ${relative}.`,
          });
        } else {
          // Roots are ordered from lowest to highest precedence. A project
          // root can intentionally replace the same skill from a user root.
          skillNames.set(parsed.data.name, { path: relative, root: safeRoot });
        }
      } catch (error) {
        diagnostics.push({
          level: "error",
          code: "SKILL_INVALID",
          path: relative,
          message: `Invalid Agent Skill manifest ${relative}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  for (const hook of config.hooks) {
    if (hook.matcher.inputRegex) {
      try {
        new RegExp(hook.matcher.inputRegex);
      } catch (error) {
        diagnostics.push({
          level: "error",
          code: "HOOK_REGEX_INVALID",
          message: `Hook ${hook.id} has an invalid inputRegex: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  for (const [name, server] of Object.entries(config.mcp.servers)) {
    const values = server.transport === "stdio" ? Object.values(server.env) : Object.values(server.headers);
    for (const value of values) {
      if (typeof value !== "string" && value.default !== undefined) {
        diagnostics.push({
          level: "warning",
          code: "SECRET_DEFAULT_PRESENT",
          message: `MCP server ${name} gives ${value.fromEnv} a default value. Generated files may therefore contain a credential-like literal.`,
        });
      }
    }
  }

  return diagnostics;
}
