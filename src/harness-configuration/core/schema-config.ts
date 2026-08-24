import { TARGET_IDS, type TargetId } from "./types.ts";
import {
  objectValue,
  optionalString,
  relativePath,
  type PathPart,
  type Validator,
} from "./schema-runtime.ts";
import {
  MCP_NAME_PATTERN,
  parseAgent,
  parseCommand,
  parseHook,
  parseMcpServer,
  parsePermissionRule,
  parseRule,
  parseTargets,
} from "./schema-components.ts";
import type {
  Agent,
  CanonfigConfig,
  Command,
  Hook,
  McpServer,
  PermissionRule,
  Rule,
} from "./schema-types.ts";

function parsedArray<T>(
  input: unknown,
  validator: Validator,
  path: PathPart[],
  parser: (value: unknown, validator: Validator, path: PathPart[]) => T,
): T[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    validator.issue(path, "Expected an array.");
    return [];
  }
  return input.map((item, index) => parser(item, validator, [...path, index]));
}

function duplicateIds(
  validator: Validator,
  label: string,
  items: ReadonlyArray<{ id: string }>,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) validator.issue([], `Duplicate ${label} id: ${item.id}`);
    seen.add(item.id);
  }
}

export function parseConfig(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): CanonfigConfig {
  const value = objectValue(input, validator, path);
  if (value.version !== 1) validator.issue(["version"], "Expected literal value 1.");

  const projectValue = value.project === undefined
    ? {}
    : objectValue(value.project, validator, ["project"]);
  const projectName = optionalString(
    projectValue.name,
    validator,
    ["project", "name"],
  );

  const instructionsValue = value.instructions === undefined
    ? {}
    : objectValue(value.instructions, validator, ["instructions"]);
  const rules: Rule[] = parsedArray(
    instructionsValue.rules,
    validator,
    ["instructions", "rules"],
    parseRule,
  );

  const skillsValue = value.skills === undefined
    ? {}
    : objectValue(value.skills, validator, ["skills"]);
  const rootsInput = skillsValue.roots === undefined ? ["skills"] : skillsValue.roots;
  let roots: string[] = [];
  if (!Array.isArray(rootsInput)) {
    validator.issue(["skills", "roots"], "Expected an array.");
  } else {
    roots = rootsInput.map((item, index) =>
      relativePath(item, validator, ["skills", "roots", index])
    );
  }

  const mcpValue = value.mcp === undefined
    ? {}
    : objectValue(value.mcp, validator, ["mcp"]);
  const serversValue = mcpValue.servers === undefined
    ? {}
    : objectValue(mcpValue.servers, validator, ["mcp", "servers"]);
  const servers: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(serversValue)) {
    if (!MCP_NAME_PATTERN.test(name)) {
      validator.issue(["mcp", "servers", name], "Invalid MCP server name.");
    }
    servers[name] = parseMcpServer(
      server,
      validator,
      ["mcp", "servers", name],
    );
  }

  const hooks: Hook[] = parsedArray(
    value.hooks,
    validator,
    ["hooks"],
    parseHook,
  );
  const agents: Agent[] = parsedArray(
    value.agents,
    validator,
    ["agents"],
    parseAgent,
  );
  const commands: Command[] = parsedArray(
    value.commands,
    validator,
    ["commands"],
    parseCommand,
  );

  const permissionsValue = value.permissions === undefined
    ? {}
    : objectValue(value.permissions, validator, ["permissions"]);
  const permissionRules: PermissionRule[] = parsedArray(
    permissionsValue.rules,
    validator,
    ["permissions", "rules"],
    parsePermissionRule,
  );

  const extensionsValue = value.extensions === undefined
    ? {}
    : objectValue(value.extensions, validator, ["extensions"]);
  const extensions: Partial<Record<TargetId, Record<string, unknown>>> = {};
  for (const [key, extension] of Object.entries(extensionsValue)) {
    if (!TARGET_IDS.includes(key as TargetId)) {
      validator.issue(
        ["extensions", key],
        `Unknown target. Expected one of: ${TARGET_IDS.join(", ")}.`,
      );
      continue;
    }
    extensions[key as TargetId] = objectValue(
      extension,
      validator,
      ["extensions", key],
    );
  }

  duplicateIds(validator, "rule", rules);
  duplicateIds(validator, "hook", hooks);
  duplicateIds(validator, "agent", agents);
  duplicateIds(validator, "command", commands);

  const targets = value.targets === undefined
    ? (validator.issue(["targets"], "Required."), [])
    : parseTargets(value.targets, validator, ["targets"]);

  return {
    version: 1,
    project: projectName === undefined ? {} : { name: projectName },
    targets,
    instructions: {
      root: relativePath(
        instructionsValue.root,
        validator,
        ["instructions", "root"],
        "instructions/AGENTS.md",
      ),
      rules,
    },
    skills: { roots },
    mcp: { servers },
    hooks,
    agents,
    commands,
    permissions: { rules: permissionRules },
    extensions,
  };
}
