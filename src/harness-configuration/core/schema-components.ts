import { TARGET_IDS, type TargetId } from "./types.ts";
import {
  booleanValue,
  enumValue,
  idValue,
  objectValue,
  optionalString,
  positiveInteger,
  relativePath,
  secretRecord,
  stringArray,
  stringValue,
  type PathPart,
  type Validator,
} from "./schema-runtime.ts";
import {
  CAPABILITIES,
  HOOK_EVENTS,
  type Agent,
  type CanonfigConfig,
  type Capability,
  type Command,
  type Hook,
  type HookMatcher,
  type McpServer,
  type PermissionRule,
  type Rule,
  type TargetEntry,
} from "./schema-types.ts";

export const MCP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

export function parseMcpServer(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): McpServer {
  const value = objectValue(input, validator, path);
  const transport = enumValue(
    value.transport,
    ["stdio", "streamable-http", "sse"] as const,
    validator,
    [...path, "transport"],
    "stdio",
  );
  const enabled = booleanValue(value.enabled, validator, [...path, "enabled"], true);
  const timeoutMs = positiveInteger(value.timeoutMs, validator, [...path, "timeoutMs"]);
  const enabledTools = value.enabledTools === undefined
    ? undefined
    : stringArray(value.enabledTools, validator, [...path, "enabledTools"]);
  const disabledTools = value.disabledTools === undefined
    ? undefined
    : stringArray(value.disabledTools, validator, [...path, "disabledTools"]);
  const common = {
    enabled,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(enabledTools === undefined ? {} : { enabledTools }),
    ...(disabledTools === undefined ? {} : { disabledTools }),
  };

  if (transport === "stdio") {
    const cwd = optionalString(value.cwd, validator, [...path, "cwd"]);
    return {
      ...common,
      transport,
      command: stringValue(value.command, validator, [...path, "command"], {
        min: 1,
      }),
      args: stringArray(value.args, validator, [...path, "args"]),
      ...(cwd === undefined ? {} : { cwd }),
      env: secretRecord(value.env, validator, [...path, "env"]),
    };
  }

  const url = stringValue(value.url, validator, [...path, "url"], { min: 1 });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      validator.issue([...path, "url"], "Expected an HTTP(S) URL.");
    }
  } catch {
    validator.issue([...path, "url"], "Expected a valid URL.");
  }
  return {
    ...common,
    transport,
    url,
    headers: secretRecord(value.headers, validator, [...path, "headers"]),
  };
}

export function parseHook(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): Hook {
  const value = objectValue(input, validator, path);
  const matcherValue = value.matcher === undefined
    ? {}
    : objectValue(value.matcher, validator, [...path, "matcher"]);
  const inputRegex = optionalString(
    matcherValue.inputRegex,
    validator,
    [...path, "matcher", "inputRegex"],
  );
  let capabilities: Capability[] = [];
  if (matcherValue.capabilities !== undefined) {
    if (!Array.isArray(matcherValue.capabilities)) {
      validator.issue([...path, "matcher", "capabilities"], "Expected an array.");
    } else {
      capabilities = matcherValue.capabilities.map((item, index) =>
        enumValue(
          item,
          CAPABILITIES,
          validator,
          [...path, "matcher", "capabilities", index],
          "read",
        )
      );
    }
  }
  const matcher: HookMatcher = {
    capabilities,
    tools: stringArray(
      matcherValue.tools,
      validator,
      [...path, "matcher", "tools"],
    ),
    ...(inputRegex === undefined ? {} : { inputRegex }),
  };
  const run = stringArray(value.run, validator, [...path, "run"]);
  if (run.length === 0) {
    validator.issue([...path, "run"], "Expected at least one command argument.");
  }
  return {
    id: idValue(value.id, validator, [...path, "id"]),
    event: enumValue(
      value.event,
      HOOK_EVENTS,
      validator,
      [...path, "event"],
      "before_tool",
    ),
    enabled: booleanValue(value.enabled, validator, [...path, "enabled"], true),
    matcher,
    run,
    timeoutMs: positiveInteger(
      value.timeoutMs,
      validator,
      [...path, "timeoutMs"],
      600_000,
    ) ?? 10_000,
    onFailure: value.onFailure === undefined
      ? "block"
      : enumValue(
        value.onFailure,
        ["block", "warn", "ignore"] as const,
        validator,
        [...path, "onFailure"],
        "block",
      ),
  };
}

export function parseRule(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): Rule {
  const value = objectValue(input, validator, path);
  const activation = value.activation === undefined
    ? undefined
    : enumValue(
      value.activation,
      ["always", "path", "manual", "model"] as const,
      validator,
      [...path, "activation"],
      "always",
    );
  const description = optionalString(
    value.description,
    validator,
    [...path, "description"],
  );
  return {
    id: idValue(value.id, validator, [...path, "id"]),
    file: relativePath(value.file, validator, [...path, "file"]),
    paths: stringArray(value.paths, validator, [...path, "paths"]),
    ...(activation === undefined ? {} : { activation }),
    ...(description === undefined ? {} : { description }),
  };
}

export function parseAgent(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): Agent {
  const value = objectValue(input, validator, path);
  const toolInput = value.tools === undefined ? ["read", "search"] : value.tools;
  let tools: Capability[] = [];
  if (!Array.isArray(toolInput)) {
    validator.issue([...path, "tools"], "Expected an array.");
  } else {
    tools = toolInput.map((item, index) =>
      enumValue(
        item,
        CAPABILITIES,
        validator,
        [...path, "tools", index],
        "read",
      )
    );
  }
  return {
    id: idValue(value.id, validator, [...path, "id"]),
    file: relativePath(value.file, validator, [...path, "file"]),
    description: stringValue(
      value.description,
      validator,
      [...path, "description"],
      { min: 1 },
    ),
    model: value.model === undefined
      ? "inherit"
      : stringValue(value.model, validator, [...path, "model"]),
    tools,
    writable: booleanValue(value.writable, validator, [...path, "writable"], false),
  };
}

export function parseCommand(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): Command {
  const value = objectValue(input, validator, path);
  const argumentHint = optionalString(
    value.argumentHint,
    validator,
    [...path, "argumentHint"],
  );
  return {
    id: idValue(value.id, validator, [...path, "id"]),
    file: relativePath(value.file, validator, [...path, "file"]),
    description: stringValue(
      value.description,
      validator,
      [...path, "description"],
      { min: 1 },
    ),
    ...(argumentHint === undefined ? {} : { argumentHint }),
  };
}

export function parsePermissionRule(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): PermissionRule {
  const value = objectValue(input, validator, path);
  const reason = optionalString(value.reason, validator, [...path, "reason"]);
  return {
    pattern: stringValue(value.pattern, validator, [...path, "pattern"], {
      min: 1,
    }),
    action: enumValue(
      value.action,
      ["allow", "ask", "deny"] as const,
      validator,
      [...path, "action"],
      "ask",
    ),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function parseTargetEntry(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): TargetEntry {
  const value = objectValue(input, validator, path);
  return {
    enabled: booleanValue(value.enabled, validator, [...path, "enabled"], true),
    options: value.options === undefined
      ? {}
      : objectValue(value.options, validator, [...path, "options"]),
  };
}

export function parseTargets(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): CanonfigConfig["targets"] {
  if (Array.isArray(input)) {
    return input.map((value, index) =>
      enumValue(value, TARGET_IDS, validator, [...path, index], "codex")
    );
  }
  const value = objectValue(input, validator, path);
  const output: Partial<Record<TargetId, TargetEntry>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!TARGET_IDS.includes(key as TargetId)) {
      validator.issue(
        [...path, key],
        `Unknown target. Expected one of: ${TARGET_IDS.join(", ")}.`,
      );
      continue;
    }
    output[key as TargetId] = parseTargetEntry(
      entry,
      validator,
      [...path, key],
    );
  }
  return output;
}
