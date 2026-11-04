# One `~/.canonfig/` folder replaces each harness's global configuration

Status: proposed (2026-11-03). Replaces the Machine Profile JSONC authoring model and the repository harness projection feature. Supersedes the sentence in ADR 0001 that makes the Machine Profile JSONC file the only source of truth.

## Context

Canonfig ships two engines that never meet:

- **Signed Machine Profile sync.** The Source hand-writes `profile.jsonc` with `file`, `directory`, `config`, `skill`, `tool` and `credential` resources whose targets are arbitrary paths (`src/domain/profile.ts:66-156`, `src/domain/resource.ts:24-64`). Target validation rejects `..`, NUL and globs but has no allowlist (`src/domain/profile.ts:1048-1097`). The author must know every harness's native path and format, and nothing stops a profile from targeting `~/.codex/auth.json`.
- **Repository harness projection** (`canonfig harness ...`, `src/harness-configuration/`, about 7,900 lines, 2,000 lines of tests). It compiles a repository's `.canonfig/harness.yaml` into project-local files for 16 harnesses, keeps ownership in `.canonfig/.harness-state.json`, and applies with in-memory snapshots only (`core/planner.ts:270-380`). Sync never triggers it (`docs/harness-configuration.md:3-7`).

What a user wants is neither. They have one personal agent setup (instructions, skills, rules, MCP servers, hooks, commands, subagents, settings, and the tools those need) and want every harness they use, on every machine, to use it globally. The adapters already know how to translate that setup per harness; they just write to the wrong place, and the sync engine that knows how to transfer, journal and roll back has no idea what a harness is.

## Decision

### 1. The Canonical Folder

`~/.canonfig/` is the authoring format. The signed Profile Revision stays the wire format.

```text
~/.canonfig/
  canonfig.jsonc        harness list, MCP, hooks, settings, tools, credentials, groups, schedule, local policy
  AGENTS.md             global instructions
  rules/<id>.md         frontmatter: description, paths, activation
  skills/<name>/...     Agent Skills trees (SKILL.md)
  agents/<id>.md        subagents; frontmatter: description, model, tools, writable
  commands/<id>.md      slash commands; frontmatter: description, argumentHint
  hooks/...             scripts referenced by canonfig.jsonc hooks
  local/                machine-local overlay (section 8), never published, never replaced
  .backups/             takeover snapshots (section 6)
  .runtime/             generated hook runner
  state.sqlite, setup.json, policy.json, canonfig.log, installers/, skills-sources.json
```

The compiler reads only the seven authoring entries at the top (an allowlist, not a denylist). Everything else under `~/.canonfig/` is machine-local by definition and never published, mirrored or replaced. The canonical model is the existing harness model (`src/harness-configuration/core/schema-types.ts:97-112`) minus `project`, with rules, agents and commands discovered from their directories instead of listed. YAML authoring is dropped; `canonfig.jsonc` is the one format, edited by hand or by the GUI's comment-preserving writer.

### 2. Roles

- **Source.** `canonfig source publish --reviewer <name>` compiles `~/.canonfig/` into a revision: one Profile Resource per item (`instructions`, `rules/<id>`, `skills/<name>`, `agents/<id>`, `commands/<id>`, `hooks/<id>`, `mcp/<name>`, `settings/<harness>`, `tools/<id>`, `credentials/<id>`, `harnesses`, `local-policy`). Files stay content-addressed blobs. Signing, sequence, idempotent republish, enrollment, group authorization, transport and blob ranges are unchanged.
- **Follower.** Sync fetches and verifies the revision as today, then (a) materializes the authorized items into its own `~/.canonfig/` as a managed mirror, with `canonfig.jsonc` rendered canonically from the authorized subset, and (b) projects mirror plus `local/` into its selected harnesses.
- **Projection runs on every machine.** On the Source, or a machine that is not enrolled, `canonfig sync` projects the local folder; on a Follower it projects the mirror. One planner, executor, journal and recovery path (architecture invariant 9). A run records either a Profile Revision id or the local folder digest.

One Source publishes one Machine Profile, the folder. Follower Groups provide per-machine variation.

### 3. Projection and ownership

Each adapter declares, per harness, its roots and a positive list of **owned surfaces**: whole files, whole directories, or key paths inside files the harness shares with its own state. Projection turns the canonical model into plan actions of three internal kinds that the executor already journals and rolls back: `file` (replace), `directory` (replace), `config` (merge on owned keys). These kinds are no longer authorable; only adapters produce targets.

- **Whole files and directories Canonfig writes are replaced.** At takeover the prior content is snapshotted (section 6) and removed. Afterward the surface holds exactly the published items plus `local/` items.
- **Shared files are key-owned.** In `~/.claude.json`, `config.toml`, `opencode.json` and similar files, Canonfig owns only the listed keys (for example `mcpServers`). Every other key, including auth, trust and history, stays follower-owned and byte-preserved by the format codecs (`src/synchronization/config-*.ts`).
- **Drift rule is the existing three-way rule** (`docs/architecture.md`, skill drift rule): observed equals desired, nothing to do; observed equals last applied, update; otherwise Follower Drift, preserve and report. It applies to mirror files and to projected outputs. A foreign entry that appears in an owned directory after takeover is drift: kept and reported, never deleted by a scheduled run. A drifted mirror item holds its projections at their last applied state.
- **One location per harness per feature.** When a harness reads the shared `~/.agents/skills/`, its skills go there and its private skills directory is left alone. Alternative native locations Canonfig does not write are listed at takeover, not touched.
- **Unsupported features are reported, never approximated into the wrong file.** Examples: Cursor keeps user rules outside the filesystem; Hermes's `SOUL.md` is an identity, not instructions. Capability levels stay as today (`native`, `translated`, `lossy`, `unsupported`).
- **Hook runtime precedes harness outputs.** When hooks are configured, projection resources depend on the generated runner and registry. Followers preserve these dependencies alongside mirror and tool prerequisites so an early stop cannot leave an installed plugin without its runtime.
- **Hook runtimes are content-addressed.** Runner and registry filenames include the digest of the runner implementation and registry. A new projection cannot replace the registry an unchanged, drifted, or held consumer still uses; old versions retire only after consumer updates.
- **Held outputs keep their runtime.** When excluded or temporarily unavailable harnesses retain applied outputs, removing canonical hooks must not retire the runner or registry those outputs still reference.
- **Runtime retirement follows consumer updates and removals.** A drift or human-action stop must leave the runner and registry intact while any planned harness output still needs them.
- **Follower linked-file retirement follows consumer updates too.** Removed mirrored `hooks/` scripts and `rules/` documents remain while a consumer is held, and otherwise depend on planned harness updates and removals so drift cannot strand an installed plugin or instruction link.
- **Dropped config keys retain drift protection.** A revision replacing all owned keys must compare the previous keys against their applied values before removing them; a disjoint new key set is not a fresh takeover of the file.
- **Generated Amp identifiers preserve distinct agent IDs.** Escape underscores and hyphens separately; `review-fast` and `review_fast` must register different callable tools.

### 4. Per-harness global paths

Root shows the environment override first, then the default. "Declared" means keys named under `settings.<harness>` in `canonfig.jsonc`. Permission keys named in a row are owned only when declared there: permission syntax differs per harness and no adapter translates it today (`src/harness-configuration/adapters/descriptor.ts:3-18`). Checked against vendor documentation on 2026-11-03; each adapter keeps its `docs` and `verifiedAt` and is re-checked per release.

| Harness | Root | Canonfig owns | Keys owned in shared files | Never touches | Sources |
|---|---|---|---|---|---|
| `codex` | `$CODEX_HOME`, `~/.codex` | `AGENTS.md`, `agents/`, `hooks.json`; skills in `~/.agents/skills/` | `config.toml`: `mcp_servers`, declared | `auth.json`, `history.jsonl`, `log/`, `sessions/`, SQLite state, `rules/` (execution policy Codex writes) | [AGENTS.md](https://developers.openai.com/codex/guides/agents-md), [config](https://developers.openai.com/codex/config-reference), [skills](https://developers.openai.com/codex/skills), [auth](https://developers.openai.com/codex/auth) |
| `claude-code` | `$CLAUDE_CONFIG_DIR`, `~/.claude` | `CLAUDE.md`, `rules/`, `skills/`, `agents/`, `commands/` | `settings.json`: `hooks`, `permissions`, declared; `~/.claude.json`: `mcpServers` only | `.credentials.json`, Keychain, `projects/`, `sessions/`, `history.jsonl`, `file-history/`, caches, every other `.claude.json` key | [directory](https://code.claude.com/docs/en/claude-directory.md), [settings](https://code.claude.com/docs/en/settings.md), [MCP scopes](https://code.claude.com/docs/en/mcp.md#mcp-installation-scopes) |
| `amp` | `~/.config/amp` | `AGENTS.md`, `plugins/canonfig.ts` (hooks, agents, commands); skills in `~/.agents/skills/` | `settings.json`: `amp.mcpServers`, declared | `~/.local/share/amp/secrets.json`, threads, logs, plugin cache | [settings](https://ampcode.com/docs/markdown/cli/settings), [AGENTS.md](https://ampcode.com/docs/markdown/customize/agents-md), [skills](https://ampcode.com/docs/markdown/customize/skills), [security](https://ampcode.com/security#client-security) |
| `oh-my-pi` | `PI_CONFIG_DIR`, `~/.omp/agent` | `AGENTS.md`, `rules/`, `skills/`, `agents/`, `commands/`, `extensions/canonfig.ts` | `mcp.json`: `mcpServers`; `config.yml`: declared | `agent.db` (holds auth), `history.db`, `models.db`, `sessions/`, `blobs/`, `memories/`, logs, `install-id` | [config](https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md), [MCP](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md), [paths](https://github.com/can1357/oh-my-pi/blob/main/packages/utils/src/dirs.ts) |
| `pi` | `$PI_CODING_AGENT_DIR`, `~/.pi/agent` | `AGENTS.md`, `skills/`, `prompts/` (commands), `extensions/canonfig.ts` | `mcp.json`: `mcpServers`; `settings.json`: declared | `auth.json`, `mcp-auth.json`, `models.json`, `sessions/`, logs | [configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md), [MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) |
| `factory-droid` | `~/.factory` | `AGENTS.md`, `skills/`, `droids/`, `commands/`, `hooks.json` | `mcp.json`: `mcpServers`; `settings.json`: `permissionRules`, declared | keyring and OAuth fallback file (name unverified), `projects/`, sessions, logs | [settings](https://docs.factory.com/droid-cli/settings), [MCP](https://docs.factory.com/harness/mcp), [hooks](https://docs.factory.com/harness/hooks) |
| `cursor` | `CURSOR_CONFIG_DIR` (CLI), `~/.cursor` | `agents/`, `hooks.json`; skills in `~/.agents/skills/`; instructions and rules unsupported | `mcp.json`: `mcpServers`; `cli-config.json`: `permissions`, declared | login credentials (path unverified), IDE state, chats, `worktrees/`, extensions | [CLI config](https://cursor.com/docs/cli/reference/configuration), [MCP](https://cursor.com/docs/mcp), [user rules](https://cursor.com/docs/rules#user-rules) |
| `devin` | `~/.config/devin` (Windows `%APPDATA%\devin`); `~/.devin/rules` | `AGENTS.md`, `agents/`, `~/.devin/rules/`; skills in `~/.agents/skills/` | `config.json`: `hooks`, `permissions`; `mcp_config.json`: `mcpServers` | `credentials.toml` (inside the root on Windows), `cli/logs/`, sessions | [config](https://docs.devin.ai/cli/extensibility/configuration), [rules](https://docs.devin.ai/cli/extensibility/rules), [MCP](https://docs.devin.ai/cli/extensibility/mcp/configuration), [auth](https://docs.devin.ai/cli/enterprise/devin-auth#credentials-file-location) |
| `opencode` | `$XDG_CONFIG_HOME/opencode`, `~/.config/opencode` | `AGENTS.md`, `skills/`, `agents/`, `commands/`, `plugins/canonfig.ts` | `opencode.json[c]`: `mcp`, `permission`, declared | `~/.local/share/opencode/` (`auth.json`, `opencode.db`), `~/.cache/opencode/`, `provider` | [config](https://opencode.ai/docs/config/), [storage](https://opencode.ai/docs/troubleshooting/) |
| `grok-build` | `$GROK_HOME`, `~/.grok` | `AGENTS.md`, `agents/`, `hooks/canonfig.json`; skills in `~/.agents/skills/` | `config.toml`: `mcp_servers`, `permission`, declared | `sessions/`, `logs/`, `crash/`, `mcp_credentials.json`, `trusted_folders.toml`, `model.*.api_key` | [settings](https://docs.x.ai/build/settings/reference), [MCP](https://docs.x.ai/build/features/mcp-servers), [hooks](https://docs.x.ai/build/features/hooks) |
| `antigravity` | `~/.gemini` (no override found) | `AGENTS.md`, `config/rules/`, `config/skills/`, `config/agents/`, `config/hooks.json` | `config/mcp_config.json`: `mcpServers`; `antigravity-cli/settings.json`: `permissions`, declared | `antigravity-cli/brain/`, `antigravity/` (App), `antigravity-ide/`, keyring, `trustedWorkspaces`, `gcp` | [discovery](https://antigravity.google/docs/customization-discovery?tab=cli), [settings](https://antigravity.google/docs/settings?tab=cli), [MCP](https://antigravity.google/docs/mcp) |
| `copilot-cli` | `$COPILOT_HOME`, `~/.copilot` | `copilot-instructions.md`, `instructions/`, `skills/`, `agents/`, `hooks/canonfig.json` | `mcp-config.json`: `mcpServers`; `settings.json`: declared | `config.json`, `mcp-oauth-config/`, `mcp-secrets/`, `session-state/`, `session-store.db`, `command-history-state/`, `logs/`, `ide/`, `plugin-data/`, `permissions-config.json`, `providers.json` | [config dir](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference) |
| `kimi` | `$KIMI_CODE_HOME`, `~/.kimi-code` | `AGENTS.md`, `agents/`; skills in `~/.agents/skills/` | `mcp.json`: `mcpServers`; `config.toml`: `hooks`, `permission.rules` | `credentials/`, `sessions/`, `session_index.jsonl`, `user-history/`, `logs/`, `bin/`, provider keys | [data locations](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/data-locations.md), [config](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md) |
| `kilo` | `$KILO_CONFIG_DIR`, `~/.config/kilo` | `AGENTS.md`, `agent/`, `commands/`, `plugin/canonfig.ts`; skills in `~/.agents/skills/` | `kilo.jsonc`: `mcp`, `permission`, declared | `~/.local/share/kilo/` (`auth.json`, `kilo.db`), `daemon.json`, caches, `provider` | [settings](https://kilo.ai/docs/getting-started/settings), [skills](https://kilo.ai/docs/customize/skills), [runtime](https://kilo.ai/docs/contributing/architecture/cli-runtime) |
| `hermes` | `$HERMES_HOME`, `~/.hermes` (active profile) | one directory per published skill in `skills/`; instructions unsupported | `config.yaml`: `mcp_servers`, `hooks` | `SOUL.md`, `.env`, `auth.json`, `sessions/`, `state.db`, logs, cache, memories, `skills/.hub/`, `.bundled_manifest` | [configuration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md), [profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles) |
| `qwen` | `$QWEN_HOME`, `~/.qwen` | `QWEN.md`, `agents/`, `commands/`; skills in `~/.agents/skills/` | `settings.json`: `mcpServers`, `hooks`, declared | `oauth_creds.json`, `mcp-oauth-tokens.json`, `google_accounts.json`, `.env`, `installation_id`, `projects/`, `tmp/`, `memory.md`, `file-history/`, `ide/` | [settings](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md), [storage](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/storage.ts) |

`~/.agents/skills/` is one shared surface, owned while any of `codex`, `amp`, `cursor`, `devin`, `grok-build`, `kimi`, `kilo` or `qwen` is projected. Rules without a native global location are linked from the projected instructions by absolute path into `~/.canonfig/rules/`, as the project adapters do today.

### 5. Detection and selection

- **Installed** means the adapter's executable resolves through Canonfig's verifier search order (recipe install directories, `~/.local/bin`, then `PATH`), without spawning it. Generic names (Cursor's `agent`) also require the harness root to exist. A config root alone is evidence, not installation: `~/.gemini` is shared by the Antigravity CLI, App and IDE.
- **Source setup** detects installed harnesses and preselects them in `canonfig.jsonc` `harnesses`. The user edits the list before the first apply. The list is published.
- **Import before takeover.** Source setup offers a one-time, reviewed import of each selected harness's existing instructions, skills, rules, agents, commands and MCP servers into `~/.canonfig/`. The user picks what to keep; duplicates by name are listed for a choice. Declined items are still covered by the takeover snapshot.
- **Follower** projects `harnesses` ∩ installed ∩ not locally excluded. A listed harness that is not installed is reported in plan and status (`not-installed`); the run can still converge. An installed harness that is not listed is ignored. A harness installed later is taken over on the next run, with a snapshot.
- **Roots are pinned.** The root resolved at takeover (including `CODEX_HOME` and similar overrides) is recorded per harness. A later run, for example a scheduled run without the shell's environment, that resolves a different root stops with Human Action Required instead of projecting into a second location. Roots must resolve inside the user's home directory.
- **Applied surface paths are pinned too.** A newly appearing config alternative must not redirect an already-owned resource. If resolution differs from its Applied Resource Record, stop with Human Action Required before writes or backup capture.
- **Every surface stays inside home.** Validate each resolved output path, not only the harness root: environment overrides can place individual plugin surfaces elsewhere. Snapshot capture independently rejects external targets and copy paths that escape the snapshot directory.
- **Removing a harness from the list** retires its unmodified owned outputs through the normal removal path. It does not restore the snapshot; `canonfig restore` does that explicitly.

### 6. Backups and restore

- **Takeover snapshot.** Before Canonfig first writes any owned surface of a harness, it copies every owned file and directory into `~/.canonfig/.backups/<UTC timestamp>/<harness>/...` and writes `~/.canonfig/.backups/<UTC timestamp>/manifest.json` (harness, resolved root, path, object kind, mode, symlink text, SHA-256, `absent` markers, run id). For key-owned files the snapshot stores only the owned keys' prior values in `keys.json`, never the whole file, so `~/.claude.json` OAuth data never enters a backup. Directories are mode 0700, files 0600, Windows ACLs through the existing protected writer.
- **Retention.** Keep the first snapshot (the state before Canonfig ever wrote) plus the 4 most recent; prune the oldest of the recent ones after writing a new one. Delete a failed run's snapshot only after rollback completes. If rollback fails, retain the affected takeover entries and original content for `canonfig restore`; discard only entries whose rollback completed or whose writes never started.
- **Later applies** use the existing per-run journal and rollback material under the cache directory (`docs/file-rollback.md`). Snapshots are not taken per run.
- **`canonfig restore [<snapshot>]`** (default: latest) runs as a journaled Synchronization Run: it writes the snapshot back, removes Canonfig-owned entries the snapshot marks absent, deletes the Applied Resource Records for those surfaces, and adds the harness to the local exclusion list so the next sync does not take it over again. Config keys a later run took over in the same file are not in the snapshot: they stay written and owned. It refuses a harness whose owned surfaces have drifted since Canonfig's last apply.
- **Restore requires current ownership of every captured config key.** A remaining file-level record does not authorize rewriting keys that an earlier restore released.
- **Local exclusion pauses projection, not ownership.** Existing owned surfaces remain untouched and restorable across subsequent syncs, including surfaces captured by a different snapshot from the one just restored. Removing a harness from the Source list still retires its outputs unless that machine locally excludes it.
- **Restoring shared skills excludes their consumers.** A shared-skills-only snapshot excludes the selected harnesses that use `~/.agents/skills/`, so the next sync cannot immediately replace the restored directory.
- **Off switch.** `--no-backup` on `sync --apply`, or `"backups": false` in `local/local.jsonc`. The setting is machine-local on purpose: a Source cannot turn off a follower's safety net. The plan states `no backup` for every takeover it performs without one.

### 7. `canonfig.jsonc`

```jsonc
{
  "version": 1,
  "profile": { "id": "workstation", "name": "Workstation" },
  "harnesses": ["claude-code", "codex", "opencode"],
  "mcp": {
    "docs": { "transport": "streamable-http", "url": "https://example.invalid/mcp",
              "headers": { "Authorization": { "fromEnv": "DOCS_MCP_TOKEN" } } },
    "git": { "transport": "stdio", "command": "uvx", "args": ["mcp-server-git"], "requires": ["tools/uv"] }
  },
  "hooks": [{ "id": "format", "event": "after_tool", "matcher": { "capabilities": ["write"] },
              "run": ["hooks/format.sh"], "timeoutMs": 5000, "onFailure": "warn" }],
  "settings": { "codex": { "model_reasoning_effort": "high" }, "claude-code": { "model": "opus" } },
  "tools": { "uv": { "upstream": "https://github.com/astral-sh/uv", "recipes": { /* today's tool spec */ } } },
  "credentials": { "docs-token": { "reference": "DOCS_MCP_TOKEN" } },
  "groups": { "work": ["mcp/docs", "skills/deploy"] },
  "scheduleDefault": "daily@09:00",
  "local": { "allow": ["skills", "mcp", "settings"] }
}
```

`groups` lists items visible only to followers in that group; unlisted items go to every follower, the same semantics as today's grouped and ungrouped resources (`src/enrollment/enrollment.layer.ts:104-152`). `requires` becomes a resource dependency. `settings.<harness>` keys are merged into that harness's settings file; adapters reject keys on their never-touch list, and values pass the existing publication credential checks (`src/profile/publication-credentials.ts`).

### 8. Tools, installers and local overlays

- **Tools** keep today's spec: platform recipes, exact versions, `buildPolicy`, `verify`, `login`, `agentInstall`. They compile to the existing `tool` resource and run through the existing planner, executor and Configuration Agent policy. `canonfig source scan` scans the Canonical Folder (instructions, skills, hook scripts, MCP commands) instead of `--file` lists and proposes `tools` entries for review. Installer bindings stay machine-local in `~/.canonfig/installers/`.
- **Arbitrary file resources do not survive.** Tools need install and verify, not dotfiles, and every harness surface is covered by an adapter. An escape hatch would bring back unbounded targets.
- **Local Overlay** becomes `~/.canonfig/local/`: the same layout plus `local.jsonc` (MCP servers, settings, harness exclusions, `backups`). It is never published and never replaced. Projection adds local items to published ones within `local.allow`; a name that collides with a published item is Human Action Required, as an overlay overlapping a canonical key is today (`src/synchronization/resource-plans.ts:643-704`). Keys a harness file holds outside Canonfig's owned set are follower-owned without any declaration.

### 9. Security

- Ownership is a positive allowlist per adapter; nothing outside an owned surface is written, read into a plan, or backed up. Tests assert, per adapter, that no planned target or snapshot path equals or contains a never-touch path.
- Every target is resolved under the pinned root with the existing no-follow, lexical and realpath checks; symlinked components are refused for writes.
- Publication reads only the authoring allowlist, enforces the existing realpath-inside-source rule, keeps MCP secrets as `fromEnv` references, and rejects credential-looking literals.
- Hooks and MCP stdio commands run code on followers; the plan lists every command before apply, as project hooks do today.
- Snapshots and journals are local, private and never transferred. Takeover, restore and every run stay in the SQLite journal.

### 10. Deleted

- `canonfig harness` and everything behind it: `src/harness-configuration/{cli,cli-arguments,watch}.ts`, `core/{config,scaffold,state,planner,diff,doctor,export,archive}.ts`, `.harness-state.json`, the project build context, `docs/harness-configuration.md`, `docs/harness-archives.md`, `skills/sync-harnesses/`, `skills/setup-canonfig/references/harness-setup.md`, seven test files, the GUI harness page and routes.
- Hand-written `profile.jsonc`/`tools.jsonc`, `source publish --profile-file`/`--proposal`, `source digest`, `source reconcile-skills`, authorable `file`/`directory`/`config` resources, `append-local` and `sync --review-local`, the `overlay` commands and stored overlays, multi-profile `profile select` and `follower enroll --profile`, `setup --scope project-only`, and `src/profile/legacy-revision.ts`. State from earlier versions fails decoding with a reinitialize message (hard cut).

## Consequences

- Users author one folder in the shapes harnesses already use; Canonfig owns paths, formats and translation.
- Taking over a harness removes configuration the user had there. The snapshot and `restore` make that reversible, and drift rules keep later local edits.
- Adapter correctness now affects global setup on every follower, so adapters need golden fixtures for all three OSes and a per-release documentation re-check.
- Followers cannot customize published items in place; they add through `local/` or ask the Source.

## Rejected

- **Keep the JSONC Machine Profile and add harness resources to it.** Authors keep writing native paths and formats by hand, and arbitrary targets stay possible.
- **Folder next to the profile** (`~/.canonfig/` projected locally, `profile.jsonc` still published). Two sources of truth, two engines, and followers never get the folder.
- **Whole-folder replace of each harness home.** Auth, sessions and history share those directories and files (`~/.claude.json`, Devin's Windows root, `agent.db`), and a denylist cannot keep up with vendors adding state files.
- **Symlink harness surfaces into `~/.canonfig/`.** Windows symlinks need privileges, several harnesses mix state into config files, and drift would be invisible.
- **Project per harness on the Source and publish native files.** Roots depend on each follower's OS, environment and installed harnesses.
