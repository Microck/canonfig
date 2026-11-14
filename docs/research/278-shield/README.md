# Canonfig Shield research

Issue: https://github.com/Microck/canonfig/issues/278

## Findings and selected design

Use layered redirection, with the Canonical Folder as the only authored format. A Source installation becomes an unpublished folder change. A Follower installation goes into `local/`, subject to `local.allow` and Local Overlays. Native plugins remain whole packages and need digest review before activation or publication. [ADR 0004](../../adr/0004-shield-and-native-plugins.md) records the design.

No single interception mechanism covers agent tools, external installers and direct filesystem writes. The implementation combines the following layers:

| Layer | Implemented behavior | Boundary |
| --- | --- | --- |
| Instructions | Projected instructions and `canonfig-shield` skill name the writable destination and review workflow. | Advisory. Only the instruction and skill readers a harness supports receive them. |
| Harness hooks | A before-tool hook denies recognized native-path writes and tells the agent where to retry. It resolves path aliases and handles structured write arguments, patch text and common shell writes. | Enforced only when the harness loads and trusts the hook. Shell recognition is not a complete parser. |
| Installer routing | `shield install` runs supported installers in a private HOME, then uses the same admission path as sync. `shield run` intercepts supported descendant installers with process-local PATH shims. | Explicit commands and PATH lookups only. Absolute descendant binaries can bypass PATH interception. A private HOME is not a hostile-code sandbox. |
| Sync ingestion | Apply-mode sync admits recognized foreign items before projection. Copies validate before cleanup. Managed edits remain Follower Drift rather than being reimported. | Recovery after a write, not prevention. Plan mode does not ingest. Collisions and disallowed Local categories refuse admission without deleting input. |
| Hard protection | Linux `shield run` mounts dedicated configuration paths read-only in a bubblewrap child process tree. | Other processes and mixed auth/config files are outside that boundary. macOS and Windows reject `--hard` explicitly. |

Projection reuses the existing authoring, takeover, three-way drift and retirement machinery. It runs outside the hard-protected child tree. No daemon, automatic publication, global PATH change, immutable home or auth-directory relocation is introduced.

## Coverage matrix

All rows use the same explicit skills-installer admission and adapter-based sync ingestion for recognized skills, documents and MCP entries. Native-package ingestion runs before skill discovery. Unsupported package formats are not flattened into skills or reported as installed. Every hook row links its primary API or the retained adapter contract in [sources.md](sources.md#hook-api-evidence).

| Target Harness | Agent-write interception | Installer/package route | Native-runtime evidence in this task |
| --- | --- | --- | --- |
| Claude Code | [PreToolUse, exit 2 with reason](https://code.claude.com/docs/en/settings.md) | [Skills, MCP, marketplace and native package](../../../src/projection/shield-install.ts) | [Real MCP trace](claude-mcp-trace.json); [marketplace, listing and hook](native-plugin-proof.json). Agent inference unavailable because copied OAuth credentials had expired. |
| Codex | [Trusted PreToolUse, exit 2 with reason](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs) | [Skills, MCP and native cache packages](../../../src/projection/shield-install.ts) | [MCP trace](codex-mcp-trace.json) and [agent denial with canonical retry](workflow-proof.json). Native cache ingestion observed; projected plugin activation not separately run. |
| Oh My Pi | [tool_call, block/reason](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) | [Skills and native module packages](../../../src/projection/shield-plugins.ts) | [Projection observed](native-plugin-proof.json); no native agent session. |
| Pi | [tool_call, block/reason](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | [Skills and native module packages](../../../src/projection/shield-plugins.ts) | [API and generated adapter evidence](verification.json) only. |
| Amp | [tool.call, reject-and-continue](https://ampcode.com/docs/markdown/customize/plugins) | [Skills and native module packages](../../../src/projection/shield-plugins.ts) | [API and generated adapter evidence](verification.json) only. |
| Factory Droid | [PreToolUse, exit 2](https://docs.factory.com/harness/hooks) | [Recognized adapter imports](../../../src/projection/shield-ingest.ts); no Native Plugin loader | [API and generated adapter evidence](verification.json) only. |
| Cursor | [preToolUse, permission/agent_message](https://cursor.com/docs/agent/hooks) | [Recognized adapter imports](../../../src/projection/shield-ingest.ts); no Native Plugin loader | [Native-shaped payload and denial-envelope test](../../../tests/integration/shield.test.ts); no Cursor session. |
| Devin | [PreToolUse, exit 2](https://docs.devin.ai/cli/extensibility/hooks) | [Recognized adapter imports](../../../src/projection/shield-ingest.ts); no Native Plugin loader | [API and generated adapter evidence](verification.json) only. |
| OpenCode | [execute.before, throw reason](https://opencode.ai/docs/build/plugins/server.md) | [Skills and native module packages](../../../src/projection/shield-plugins.ts) | [Projection](native-plugin-proof.json) and [generated-module execution](../../../tests/projection-translation.test.ts); no native agent session. |
| Grok Build | [PreToolUse, exit 2](https://docs.x.ai/build/features/hooks) | [Recognized adapter imports](../../../src/projection/shield-ingest.ts); no Native Plugin loader | [API and generated adapter evidence](verification.json) only. |
| Antigravity | [PreToolUse, decision/reason](https://antigravity.google/docs/hooks) | [Recognized adapter imports](../../../src/projection/shield-ingest.ts); no Native Plugin loader | [Native-shaped file/shell payload and denial tests](../../../tests/integration/shield.test.ts); no IDE session. |
| Copilot CLI | [preToolUse, permissionDecision/reason](https://docs.github.com/en/copilot/reference/hooks-reference) | [Recognized adapter imports](../../../src/projection/shield-ingest.ts); no Native Plugin loader | [API and generated adapter evidence](verification.json) only. |
| Kimi | [PreToolUse, exit 2](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md) | [Recognized adapter imports](../../../src/projection/shield-ingest.ts); no Native Plugin loader | [API and generated adapter evidence](verification.json) only. |
| Kilo | [tool.execute.before, throw reason](../../../src/projection/templates/runtime.ts) | [Skills and native module packages](../../../src/projection/shield-plugins.ts) | [Retained adapter contract](../../../src/projection/adapters/kilo.ts); no native session. |
| Hermes | [Shell pre_tool_call, exit 2 and fail_closed](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md) | [Recognized adapter imports](../../../src/projection/shield-ingest.ts); no Native Plugin loader | [API and generated adapter evidence](verification.json) only. |
| Qwen | [PreToolUse, exit 2](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md) | [Skills, MCP and native extension install/link](../../../src/projection/shield-install.ts) | [API and generated adapter evidence](verification.json) only. |

Gemini CLI was researched because the issue names it, but [ADR 0002](../../adr/0002-agent-harness-model-and-custom.md) excludes it from the Target Harness set. Its real extension install timed out after 60 seconds. The trace proves startup writes only, not extension installation. Shield rejects that installer rather than claiming support.

## Write traces and executable proofs

All runs used disposable homes under `/tmp/canonfig-shield-278.1PQfGP`. [versions.json](versions.json) records Claude Code 2.1.293, Codex 0.167.1, OpenCode 2.2.6, OMP 18.18.7, bubblewrap 0.6.1 and strace 5.16. Only the authentication files needed for the Codex/Claude attempts were copied; those copies were removed afterward. Live config, credentials, services, schedules and the parent checkout were not changed.

Installer tracing used `strace -f -e trace=file -o <trace> <installer...>` with isolated HOME and configuration directories. `*-trace.json` records each exact command and file listing; `*-writes.strace` retains write-related syscall excerpts, not every read syscall. Complete temporary traces remain outside the branch.

| Proof | Observed result | Artifact |
| --- | --- | --- |
| Unprotected public skills install | `npx --yes skills add vercel-labs/agent-skills --skill web-design-guidelines --global --agent claude-code --yes` exited 0; native skill and installer lock appeared under the disposable home. | [Trace](skills-trace.json), [writes](skills-writes.strace) |
| Unprotected Claude MCP add | User-scope add exited 0 and wrote `.claude.json` plus its backup. | [Trace](claude-mcp-trace.json), [writes](claude-mcp-writes.strace) |
| Unprotected Codex MCP add | Exited 0 and wrote `.codex/config.toml`. | [Trace](codex-mcp-trace.json), [writes](codex-mcp-writes.strace) |
| Gemini extension install | Timed out; only project/history startup paths appeared. | [Trace](gemini-extension-trace.json), [writes](gemini-extension-writes.strace) |
| Shield public installer | `shield install -- npx --yes skills add ...` exited 0. The skill appeared in `.canonfig/skills`, then sync projected it into native readers, including `.agents/skills`. Those were managed projections, not foreign leftovers. | [Before/after and commands](workflow-proof.json) |
| Real agent redirect | Codex attempted an `apply_patch` into `.codex/skills`. Its stderr recorded `Command blocked by PreToolUse hook` and the canonical destination. The agent wrote the same skill there; canonical file existed and foreign file did not. | [Transcript](workflow-proof.json) |
| Direct-write recovery | A skill existed only in `.claude/skills` before sync. After sync its exact content existed in `.canonfig/skills`, Claude, the shared Codex reader, OpenCode and OMP. | [Before/after](native-plugin-proof.json) |
| Native plugin review | The real Claude installer staged a marketplace package. It was inactive before review. After digest review and sync, `claude plugin list --json` listed `shield-native-proof@skills-dir` enabled, and its SessionStart hook wrote the expected marker. The session later failed authentication; inference success is not claimed. | [Installer commands](workflow-proof.json), [native proof](native-plugin-proof.json) |
| Hard protection | A write under `.claude/skills` returned `EROFS`; writes to a harness runtime path and the Canonical Folder succeeded. | [Command and output](workflow-proof.json) |
| Canonfig projection | The same apply runs reported Converged and verified native surfaces while Shield was enabled. | [Workflow](workflow-proof.json), [native proof](native-plugin-proof.json) |
| Enrolled Follower | A real temporary Source/Follower integration test kept ingestion in `local/`, removed an excluded plugin's projection, preserved its signed mirror, and converged again. | [Test](../../../tests/integration/follower-orchestration.test.ts), [verification](verification.json) |
| GUI | The actual WorkspaceEvidence component rendered a real Shield status payload; pending-sync and disabled fixtures rendered the corresponding states without horizontal overflow. Temporary page, tab and server were removed. | [Screenshot](shield-status.png), [verification](verification.json) |

## Prior art and rejected alternatives

- The skills CLI handles multiple native destinations and symlinks, but its shared `.agents` tree is not Canonfig's Source/Follower ownership model. Use it inside staging, then admit regular canonical files.
- Native MCP commands preserve their own schema and transport handling. Changing HOME/config roots in staging is safer than rewriting their argument semantics or editing live auth-bearing files.
- Native hooks provide useful deny-and-retry feedback, but their trust, timeout and disable policies differ. Instructions and hooks alone do not cover standalone installers.
- Blanket read-only modes, `chattr +i`, macOS `uchg`, or Windows ACLs on harness homes were rejected. They would also protect login refresh, sessions and update state, and require lifecycle or permission handling outside Canonfig's authored ownership. Linux process-scoped mounts keep those exclusions explicit.
- Symlinking entire harness roots to `.canonfig` was rejected because it combines auth/runtime state with authored files and undermines Follower mirror ownership.
- Arbitrary shell rewriting was rejected because token substitution cannot preserve shell semantics. The hook recognizes common writes; the launcher matches explicit installer forms.
- Inert plugin quarantine was rejected as an installation outcome. Reviewable native packages now have real loader registrations and executable payloads, with no automatic publication.
- A resident ingestion daemon was rejected. Apply-mode sync and the existing schedule provide the recovery boundary.

## Risks and verification limits

- This is accidental-install protection, not a sandbox against a determined same-user adversary. Hooks and PATH can be bypassed; hard mode is scoped to its launched process tree and excludes mixed auth/config files.
- Native packages execute with harness privileges. Digest review pins bytes, declarations and executable intent; it does not establish that third-party code is safe. Bundle dependencies or declare existing tool resources. Projection performs no unsigned dependency installation.
- Source imports are reviewable unpublished changes. Native packages require an explicit digest review. Ordinary skills/documents can project after admission; publication remains an explicit Source action.
- The launcher is a bounded, output-capturing command runner with a five-minute timeout, not an interactive terminal multiplexer.
- Only the runtime proofs listed above were exercised. API documentation and generated-module tests do not prove all sixteen installed clients, every platform, or every native package format.
- macOS and Windows runtime checks were not run. Full builds and the full repository suite were not run locally because the inspected Raft hosts had no headroom. CI is the broad verification route.
- Website typecheck could not start because `fumadocs-mdx` was absent. Backend and UI typechecks, lint, focused tests and document validation are recorded in [verification.json](verification.json).
- There has been no human testing. The maintainer-approved disclosure is `none yet; maintainer to test before merge`.

Keep this research in separate commits. Remove `docs/research/278-shield/` before merging; the product docs and ADR remain.

Captured outputs redact one user-specific Codex plugin identifier. Other package names are fixture names or built-in package identities.
