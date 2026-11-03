import { TARGET_IDS, type TargetId } from "./types.ts";
import {
  enumValue,
  schema,
} from "./schema-runtime.ts";
import {
  parseAgent,
  parseCommand,
  parseHook,
  parseMcpServer,
  parseRule,
} from "./schema-components.ts";
import { parseConfig } from "./schema-config.ts";
import type {
  Agent,
  CanonfigConfig,
  Command,
  Hook,
  McpServer,
  Rule,
} from "./schema-types.ts";

export * from "./schema-types.ts";
export * from "./schema-runtime.ts";

export const TargetIdSchema = schema<TargetId>((input, validator, path) =>
  enumValue(input, TARGET_IDS, validator, path, "codex")
);
export const McpServerSchema = schema<McpServer>(parseMcpServer);
export const HookSchema = schema<Hook>(parseHook);
export const RuleSchema = schema<Rule>(parseRule);
export const AgentSchema = schema<Agent>(parseAgent);
export const CommandSchema = schema<Command>(parseCommand);
export const CanonfigConfigSchema = schema<CanonfigConfig>(parseConfig);
