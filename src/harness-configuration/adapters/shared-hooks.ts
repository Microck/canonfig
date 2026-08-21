import type { Hook } from "../core/schema.ts";
import type { BuildContext, Diagnostic, TargetId } from "../core/types.ts";

export function hookCommand(target: TargetId, hook: Hook): string {
  return `node \".canonfig/.runtime/hook-runner.mjs\" --hook ${hook.id} --target ${target} --event ${hook.event}`;
}

export const CLAUDE_EVENT_MAP: Partial<Record<Hook["event"], string>> = {
  session_start: "SessionStart",
  session_end: "SessionEnd",
  prompt_submit: "UserPromptSubmit",
  before_agent: "PreInvocation",
  after_agent: "PostInvocation",
  before_tool: "PreToolUse",
  after_tool: "PostToolUse",
  before_compact: "PreCompact",
  after_compact: "PostCompact",
  stop: "Stop",
  subagent_start: "SubagentStart",
  subagent_stop: "SubagentStop",
};

export function claudeStyleHooks(
  context: BuildContext,
  eventMap: Partial<Record<Hook["event"], string>> = CLAUDE_EVENT_MAP,
): { hooks: Record<string, unknown[]>; diagnostics: Diagnostic[] } {
  const hooks: Record<string, unknown[]> = {};
  const diagnostics: Diagnostic[] = [];
  for (const hook of context.config.hooks.filter((candidate) => candidate.enabled)) {
    const nativeEvent = eventMap[hook.event];
    if (!nativeEvent) {
      diagnostics.push({
        level: "warning",
        code: "HOOK_EVENT_UNSUPPORTED",
        target: context.target,
        message: `${context.target} cannot directly map hook event ${hook.event}; it was skipped.`,
      });
      continue;
    }
    const entry = {
      matcher: ".*",
      hooks: [{
        type: "command",
        command: hookCommand(context.target, hook),
        timeout: Math.ceil(hook.timeoutMs / 1000),
      }],
    };
    (hooks[nativeEvent] ??= []).push(entry);
  }
  return { hooks, diagnostics };
}

export function cursorHooks(context: BuildContext): { hooks: Record<string, unknown[]>; diagnostics: Diagnostic[] } {
  const eventMap: Partial<Record<Hook["event"], string>> = {
    session_start: "sessionStart",
    session_end: "sessionEnd",
    prompt_submit: "beforeSubmitPrompt",
    before_tool: "preToolUse",
    after_tool: "postToolUse",
    before_compact: "preCompact",
    stop: "stop",
    subagent_start: "subagentStart",
    subagent_stop: "subagentStop",
  };
  const hooks: Record<string, unknown[]> = {};
  const diagnostics: Diagnostic[] = [];
  for (const hook of context.config.hooks.filter((candidate) => candidate.enabled)) {
    const event = eventMap[hook.event];
    if (!event) {
      diagnostics.push({
        level: "warning",
        code: "HOOK_EVENT_UNSUPPORTED",
        target: "cursor",
        message: `Cursor cannot directly map hook event ${hook.event}; it was skipped.`,
      });
      continue;
    }
    (hooks[event] ??= []).push({
      command: hookCommand("cursor", hook),
      ...(event === "preToolUse" || event === "postToolUse" ? { matcher: ".*" } : {}),
    });
  }
  return { hooks, diagnostics };
}

export function copilotHooks(context: BuildContext): { hooks: Record<string, unknown[]>; diagnostics: Diagnostic[] } {
  const eventMap: Partial<Record<Hook["event"], string>> = {
    session_start: "sessionStart",
    session_end: "sessionEnd",
    prompt_submit: "userPromptSubmitted",
    before_tool: "preToolUse",
    after_tool: "postToolUse",
    stop: "agentStop",
    subagent_stop: "subagentStop",
  };
  const hooks: Record<string, unknown[]> = {};
  const diagnostics: Diagnostic[] = [];
  for (const hook of context.config.hooks.filter((candidate) => candidate.enabled)) {
    const event = eventMap[hook.event];
    if (!event) {
      diagnostics.push({
        level: "warning",
        code: "HOOK_EVENT_UNSUPPORTED",
        target: "copilot-cli",
        message: `Copilot CLI cannot directly map hook event ${hook.event}; it was skipped.`,
      });
      continue;
    }
    const command = hookCommand("copilot-cli", hook);
    (hooks[event] ??= []).push({
      type: "command",
      bash: command,
      powershell: command,
      cwd: ".",
      timeoutSec: Math.ceil(hook.timeoutMs / 1000),
      ...(event === "preToolUse" || event === "postToolUse" ? { matcher: ".*" } : {}),
    });
  }
  return { hooks, diagnostics };
}

export function antigravityHooks(context: BuildContext): { entries: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const eventMap: Partial<Record<Hook["event"], string>> = {
    before_tool: "PreToolUse",
    after_tool: "PostToolUse",
    before_agent: "PreInvocation",
    after_agent: "PostInvocation",
    stop: "Stop",
  };
  const entries: Record<string, unknown> = {};
  const diagnostics: Diagnostic[] = [];
  for (const hook of context.config.hooks.filter((candidate) => candidate.enabled)) {
    const event = eventMap[hook.event];
    if (!event) {
      diagnostics.push({
        level: "warning",
        code: "HOOK_EVENT_UNSUPPORTED",
        target: "antigravity",
        message: `Antigravity cannot map hook event ${hook.event}; it was skipped.`,
      });
      continue;
    }
    const handler = {
      type: "command",
      command: hookCommand("antigravity", hook),
      timeout: Math.ceil(hook.timeoutMs / 1000),
    };
    entries[`canonfig-${hook.id}`] = {
      enabled: true,
      [event]: event === "PreToolUse" || event === "PostToolUse"
        ? [{ matcher: ".*", hooks: [handler] }]
        : [handler],
    };
  }
  return { entries, diagnostics };
}
