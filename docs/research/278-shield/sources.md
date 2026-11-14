# Sources

Inspected on 2026-11-13. Upstream `main` and documentation URLs can change. Installed versions and observed behavior are recorded separately in [versions.json](versions.json), the trace files, and the workflow proofs. A documented API is not a claim that its client was run here.

## Installer and package sources

| Source | What it establishes |
| --- | --- |
| [Vercel skills installer](https://github.com/vercel-labs/skills/blob/main/src/installer.ts) | `getCanonicalSkillsDir`, agent-specific destinations, global HOME selection, and symlink/copy/link modes. A linked skill must be copied and validated before its alias is removed. |
| [Vercel agent definitions](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) | Agent destinations and shared skill readers are tool-specific, not one universal harness directory. |
| [Claude configuration directories](https://code.claude.com/docs/en/claude-directory.md) | Configuration-root override and the distinction between user configuration, credentials and runtime state. The local MCP trace independently records `.claude.json` and its backup. |
| [Claude MCP installation scopes](https://code.claude.com/docs/en/mcp.md#mcp-installation-scopes) | User scope differs from project/local scope. Shield selects user scope in its staging home. |
| [Claude plugin loading](https://code.claude.com/docs/en/plugins/loading.md) | Native packages can load through a skills directory with `.claude-plugin/plugin.json`; hooks and other package capabilities remain native. The real plugin listing and SessionStart marker independently exercise this route. |
| [Codex MCP command](https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs) | `mcp add` writes global configuration through the Codex config editor; the real trace records `.codex/config.toml`. |
| [Codex plugin loader](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/loader.rs) | Enabled plugin identities resolve through the local plugin store and load package capabilities. |
| [Codex plugin store](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/store.rs) | Cache layout is marketplace, plugin, version. Runtime plugin data is separate. |
| [Codex installed-version selection](https://github.com/openai/codex/blob/main/codex-rs/core-plugin-common/src/installed.rs) | `plugins/cache`, the `local` version name, and discovery of an active installed version from cache directories. |
| [OpenCode server plugins](https://opencode.ai/docs/build/plugins/server.md) | Current plugins export an object with `setup`; `context.tool.hook("execute.before", ...)` intercepts tools and throwing rejects execution. This differs from Kilo's retained event-map contract. |
| [Kilo CLI runtime](https://kilo.ai/docs/contributing/architecture/cli-runtime) | Existing adapter reference for Kilo's OpenCode-derived runtime. No Kilo executable session was run for this task. |
| [Qwen settings source](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md) | Qwen's native configuration and extension settings are distinct from a portable skill tree. |

## Hook API evidence

| Harness | Primary source | Denial contract used by Shield |
| --- | --- | --- |
| Claude Code | [Settings and hooks](https://code.claude.com/docs/en/settings.md), [native package loading](https://code.claude.com/docs/en/plugins/loading.md) | `PreToolUse`; synchronous command hook, exit 2 with a reason on stderr. |
| Codex | [PreToolUse implementation](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs) | A trusted control hook can block with exit 2 and nonempty stderr. Hook trust still applies. The real Codex session proves the denial and retry. |
| Oh My Pi | [Extension source documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) | `tool_call` returns `{ block: true, reason }`. |
| Pi | [Extension source documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | `tool_call` returns `{ block: true, reason }`. |
| Amp | [Plugins](https://ampcode.com/docs/markdown/customize/plugins) | `tool.call` returns `action: "reject-and-continue"` with a message. |
| OpenCode | [Server plugins](https://opencode.ai/docs/build/plugins/server.md) | `execute.before` callback throws with the redirect reason. |
| Kilo | [CLI runtime](https://kilo.ai/docs/contributing/architecture/cli-runtime), [existing adapter](../../../src/projection/adapters/kilo.ts) | Existing `tool.execute.before` event-map plugin; callback throws. This row has adapter evidence, not a fresh native-runtime proof. |
| Factory Droid | [Hooks](https://docs.factory.com/harness/hooks) | `PreToolUse`, exit 2, stderr fed back to the agent. |
| Cursor | [Agent hooks](https://cursor.com/docs/agent/hooks) | `preToolUse`; JSON `permission: "deny"` and `agent_message`. Exit 2 also denies. |
| Devin | [CLI hooks](https://docs.devin.ai/cli/extensibility/hooks) | `PreToolUse`; exit 2 blocks, other nonzero exits report errors without blocking. |
| Grok Build | [Hooks](https://docs.x.ai/build/features/hooks) | `PreToolUse`; exit 2 denies, ordinary failures are fail-open. |
| Antigravity | [Hooks](https://antigravity.google/docs/hooks) | `PreToolUse`; JSON `decision: "deny"` and `reason`; `toolCall.args` carries the native inputs. |
| Copilot CLI | [Hook reference](https://docs.github.com/en/copilot/reference/hooks-reference), [using hooks](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks) | `preToolUse`; JSON `permissionDecision` and `permissionDecisionReason`; `toolArgs` carries arguments. Native timeout behavior can still be fail-open. |
| Kimi | [Hooks source documentation](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md) | `PreToolUse`; exit 2 blocks and stderr explains the rejection. |
| Hermes | [Hooks source documentation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md) | Shell `pre_tool_call`, exit 2 blocks; projected `fail_closed: true` requests failure blocking. Hook consent still applies. |
| Qwen | [Hooks source documentation](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md) | `PreToolUse`; exit 2 blocks. Native hook approval and disable settings still apply. |
| Gemini CLI, not a Target Harness | [Hook reference](https://geminicli.com/docs/hooks/reference/) | Researched separately because the issue names it. The extension trace did not finish, so no successful install or Shield coverage is claimed. |

## Canonfig contracts and observed evidence

- [ADR 0002](../../adr/0002-agent-harness-model-and-custom.md): the supported Target Harness set, including Antigravity rather than Gemini CLI.
- [ADR 0003](../../adr/0003-global-canonfig-folder.md) and [folder model](../../global-folder.md): Source ownership, Local folder admission, Local Overlays, auth/runtime exclusions and publication boundaries.
- [ADR 0004](../../adr/0004-shield-and-native-plugins.md): the approved Shield and Native Plugin design.
- [Decision record](decisions.md): scope authorization, native-plugin expansion, human-testing disclosure and execution boundaries.
- [Skills trace](skills-trace.json), [Claude MCP trace](claude-mcp-trace.json), [Codex MCP trace](codex-mcp-trace.json), [Gemini trace](gemini-extension-trace.json): commands, exits and disposable-home file listings. The adjacent `*-writes.strace` files contain write-related syscall excerpts.
- [Workflow proof](workflow-proof.json): the public installer, real agent rejection and canonical retry, projection, and hard-mode checks.
- [Native plugin proof](native-plugin-proof.json): staged marketplace install, review gate, native loader listing, executable hook marker and direct-file ingestion.
- [Verification](verification.json): exact agent-run checks and their outcomes.
