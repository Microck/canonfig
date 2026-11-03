import type { ConfigValue } from "../../domain/resource.ts";
import type { Diagnostic, ProjectionRuntime } from "../harness.ts";
import type { Hook, HookEvent, TargetId } from "../model.ts";

/**
 * The command a harness hook config runs. It names the generated runner by
 * absolute path, so a hook works from any working directory.
 */
export function hookCommand(runtime: ProjectionRuntime, harness: TargetId, hook: Hook): string {
  return `node "${runtime.hookRunner}" --hook ${hook.id} --target ${harness} --event ${hook.event}`;
}

/** Whole-second hook timeout; a rounded value is reported. */
export function hookTimeoutSeconds(harness: TargetId, hook: Hook, diagnostics: Array<Diagnostic>): number {
  const seconds = Math.max(1, Math.ceil(hook.timeoutMs / 1000));
  if (seconds * 1000 !== hook.timeoutMs) {
    diagnostics.push({
      level: "warning",
      code: "HOOK_TIMEOUT_ROUNDED",
      harness,
      message: `${harness} takes hook timeouts in whole seconds, so hook ${hook.id} timeoutMs ${hook.timeoutMs} was rounded up to ${seconds}s.`,
    });
  }
  return seconds;
}

/** A hook with the harness's native name for its event. */
export interface NativeHook {
  readonly hook: Hook;
  readonly event: string;
}

/**
 * Hooks whose canonical event the harness has a native name for. Every other
 * hook is reported and skipped.
 */
export function nativeHooks(
  harness: TargetId,
  hooks: ReadonlyArray<Hook>,
  events: ReadonlyMap<HookEvent, string>,
  diagnostics: Array<Diagnostic>,
): Array<NativeHook> {
  const mapped: Array<NativeHook> = [];
  for (const hook of hooks) {
    const event = events.get(hook.event);
    if (event === undefined) {
      diagnostics.push({
        level: "warning",
        code: "HOOK_EVENT_UNSUPPORTED",
        harness,
        message: `${harness} has no hook event for ${hook.event}, so hook ${hook.id} was skipped.`,
      });
      continue;
    }
    mapped.push({ hook, event });
  }
  return mapped;
}

/** Groups entries under their native event name, keeping hook order. */
export function byEvent(entries: ReadonlyArray<readonly [string, ConfigValue]>): Record<string, Array<ConfigValue>> {
  const grouped = new Map<string, Array<ConfigValue>>();
  for (const [event, entry] of entries) {
    const list = grouped.get(event) ?? [];
    list.push(entry);
    grouped.set(event, list);
  }
  return Object.fromEntries(grouped);
}

/**
 * Claude Code's hook map, which Codex, Factory, Devin and Grok also read:
 * `{ <Event>: [{ matcher, hooks: [{ type: "command", command, timeout }] }] }`.
 * The matcher is `.*` because the runner applies the canonical matcher.
 */
export function claudeStyleHooks(
  runtime: ProjectionRuntime,
  harness: TargetId,
  hooks: ReadonlyArray<NativeHook>,
  diagnostics: Array<Diagnostic>,
): Record<string, Array<ConfigValue>> {
  return byEvent(hooks.map(({ hook, event }) => [event, {
    matcher: ".*",
    hooks: [{
      type: "command",
      command: hookCommand(runtime, harness, hook),
      timeout: hookTimeoutSeconds(harness, hook, diagnostics),
    }],
  }]));
}

/** Pretty JSON file content with a trailing newline. */
export function jsonFile(value: ConfigValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Event tables are Maps: a partial table annotated as a Record trips the
// known-value-widening lint, and `satisfies` would reject lookups by any
// canonical event the table leaves out.
export const CLAUDE_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "SessionStart"],
  ["session_end", "SessionEnd"],
  ["prompt_submit", "UserPromptSubmit"],
  ["before_tool", "PreToolUse"],
  ["after_tool", "PostToolUse"],
  ["before_compact", "PreCompact"],
  ["after_compact", "PostCompact"],
  ["stop", "Stop"],
  ["subagent_start", "SubagentStart"],
  ["subagent_stop", "SubagentStop"],
]);

/** Codex and Grok document the same event set as Claude Code. */
export const CODEX_EVENTS = CLAUDE_EVENTS;
export const GROK_EVENTS = CLAUDE_EVENTS;

/** Factory documents a smaller event set than Claude Code. */
export const DROID_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "SessionStart"],
  ["session_end", "SessionEnd"],
  ["prompt_submit", "UserPromptSubmit"],
  ["before_tool", "PreToolUse"],
  ["after_tool", "PostToolUse"],
  ["before_compact", "PreCompact"],
  ["stop", "Stop"],
  ["subagent_stop", "SubagentStop"],
]);

/** https://docs.devin.ai/cli/extensibility/hooks (event table). */
export const DEVIN_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "SessionStart"],
  ["session_end", "SessionEnd"],
  ["prompt_submit", "UserPromptSubmit"],
  ["before_tool", "PreToolUse"],
  ["after_tool", "PostToolUse"],
  ["after_compact", "PostCompaction"],
  ["stop", "Stop"],
]);
