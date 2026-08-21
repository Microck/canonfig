import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { TARGET_IDS, type TargetId } from "./types.ts";
import { CanonfigError } from "./errors.ts";
import { assertRealPathInside, resolveInside } from "./path.ts";

export interface ScaffoldOptions {
  targets?: readonly TargetId[] | undefined;
  force?: boolean | undefined;
}

const ROOT_INSTRUCTIONS = `# Repository instructions

Describe the project, architecture, validation commands, constraints, and definition of done here.
`;

const EXAMPLE_RULE = `# Source-code rules

- Keep changes scoped.
- Run the smallest relevant validation command before finishing.
`;

const EXAMPLE_AGENT = `Review the requested change for correctness, security, regressions, and missing tests.
Return concrete findings before general commentary.
`;

const EXAMPLE_COMMAND = `Inspect the current changes, run relevant checks, and produce a release-readiness report.
`;

const EXAMPLE_SKILL = `---
name: repository-checks
description: Discover and run the repository's relevant validation commands.
---

# Repository checks

1. Inspect package and build metadata.
2. Select the narrowest relevant checks.
3. Report commands, results, and unresolved failures.
`;

async function writeNew(root: string, relativePath: string, content: string, force: boolean): Promise<boolean> {
  const filePath = resolveInside(root, relativePath);
  await assertRealPathInside(root, filePath);
  try {
    await fs.access(filePath);
    if (!force) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await assertRealPathInside(root, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await assertRealPathInside(root, filePath);
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

export async function scaffoldProject(root: string, options: ScaffoldOptions = {}): Promise<string[]> {
  const targets = [...new Set(options.targets ?? TARGET_IDS)];
  if (targets.length === 0) throw new CanonfigError("TARGET_EMPTY", "At least one target is required for init.");
  const force = options.force ?? false;

  const config = {
    version: 1,
    project: { name: path.basename(path.resolve(root)) },
    targets: Object.fromEntries(targets.map((target) => [target, { enabled: true, options: {} }])),
    instructions: {
      root: "instructions/AGENTS.md",
      rules: [{
        id: "source",
        file: "rules/source.md",
        paths: ["src/**", "tests/**"],
        activation: "path",
        description: "Rules for source and test files",
      }],
    },
    skills: { roots: ["skills"] },
    mcp: { servers: {} },
    hooks: [],
    agents: [{
      id: "reviewer",
      file: "agents/reviewer.md",
      description: "Reviews changes for correctness and regressions",
      model: "inherit",
      tools: ["read", "search", "test", "git"],
      writable: false,
    }],
    commands: [{
      id: "release-check",
      file: "commands/release-check.md",
      description: "Run a release-readiness review",
      argumentHint: "[scope]",
    }],
    permissions: { rules: [] },
    extensions: {},
  };

  const files: Array<[string, string]> = [
    [".canonfig/harness.yaml", YAML.stringify(config, { lineWidth: 120 })],
    [".canonfig/instructions/AGENTS.md", ROOT_INSTRUCTIONS],
    [".canonfig/rules/source.md", EXAMPLE_RULE],
    [".canonfig/agents/reviewer.md", EXAMPLE_AGENT],
    [".canonfig/commands/release-check.md", EXAMPLE_COMMAND],
    [".canonfig/skills/repository-checks/SKILL.md", EXAMPLE_SKILL],
  ];

  const written: string[] = [];
  for (const [relativePath, content] of files) {
    if (await writeNew(root, relativePath, content, force)) written.push(relativePath);
  }
  return written;
}
