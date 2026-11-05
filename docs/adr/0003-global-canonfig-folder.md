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
  canonfig.jsonc        harness list, MCP, hooks, settings, tools, credentials, groups, schedule, local policy, resources
  AGENTS.md             global instructions
  rules/<id>.md         frontmatter: description, paths, activation
  skills/<name>/...     Agent Skills trees (SKILL.md)
  agents/<id>.md        subagents; frontmatter: description, model, tools, writable
  commands/<id>.md      slash commands; frontmatter: description, argumentHint
  hooks/...             scripts referenced by canonfig.jsonc hooks
  files/...             content of authored resources (section 11)
  local/                machine-local items and overlays (sections 8 and 11), never published, never replaced
  .backups/             takeover snapshots (section 6)
  .reviews/             private append-local adoption reviews (section 11)
  .runtime/             generated hook runner
  state.sqlite, setup.json, policy.json, canonfig.log, installers/, skills-sources.json
```

The compiler reads only the eight authoring entries at the top (an allowlist, not a denylist). Everything else under `~/.canonfig/` is machine-local by definition and never published, mirrored or replaced. The canonical model is the existing harness model (`src/harness-configuration/core/schema-types.ts:97-112`) minus `project`, with rules, agents and commands discovered from their directories instead of listed. YAML authoring is dropped; `canonfig.jsonc` is the one format, edited by hand or by the GUI's comment-preserving writer.

### 2. Roles

- **Source.** `canonfig source publish --reviewer <name>` compiles `~/.canonfig/` into a revision: one Profile Resource per item (`instructions`, `rules/<id>`, `skills/<name>`, `agents/<id>`, `commands/<id>`, `hooks/<id>`, `mcp/<name>`, `settings/<harness>`, `tools/<id>`, `credentials/<id>`, `resources/<id>`, one file item per file under `files/`, `harnesses`, `local-policy`). Files stay content-addressed blobs. Signing, sequence, idempotent republish, enrollment, group authorization, transport and blob ranges are unchanged.
- **Follower.** Sync fetches and verifies the revision as today, then (a) materializes the authorized items into its own `~/.canonfig/` as a managed mirror, with `canonfig.jsonc` rendered canonically from the authorized subset, and (b) projects mirror plus `local/` into its selected harnesses.
- **Projection runs on every machine.** On the Source, or a machine that is not enrolled, `canonfig sync` projects the local folder; on a Follower it projects the mirror. One planner, executor, journal and recovery path (architecture invariant 9). A run records either a Profile Revision id or the local folder digest.

One Source publishes one Machine Profile, the folder. Follower Groups provide per-machine variation.

### 3. Projection and ownership

Each adapter declares, per harness, its roots and a positive list of **owned surfaces**: whole files, whole directories, or key paths inside files the harness shares with its own state. Projection turns the canonical model into plan actions of three internal kinds that the executor already journals and rolls back: `file` (replace), `directory` (replace), `config` (merge on owned keys). Adapters produce the harness targets; the only other targets are the authored resources of section 11, which are bounded away from every harness.

- **Whole files and directories Canonfig writes are replaced**, unless `local.appendLocal` shares them with the machine (section 11). At takeover the prior content is snapshotted (section 6) and removed. Afterward the surface holds exactly the published items plus `local/` items.
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
- **Subagents default to read and search capabilities.** Omitting `tools` must not grant write or shell access. Explicit empty tool lists remain empty in generated Amp registrations, never unrestricted.
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
- **`surfaces.<harness>` narrows a harness to categories.** Categories are `instructions`, `rules`, `skills`, `agents`, `commands`, `hooks`, `mcp`, `settings`; an unnamed harness gets all of them. Projection empties the other categories in that harness's model, so no second code path exists: outputs a harness stops getting retire like a removed harness's outputs. Naming an unlisted harness is a validation error. The shared skills directory follows the union of harnesses that read it and get `skills`, so it cannot be withheld from one of them.

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
  "local": { "allow": ["instructions", "skills", "mcp", "settings"], "appendLocal": ["instructions", "skills"] },
  "resources": { "gitconfig": { "kind": "file", "target": "~/.gitconfig", "source": "files/gitconfig" } }
}
```

`groups` lists items visible only to followers in that group; unlisted items go to every follower, the same semantics as today's grouped and ungrouped resources (`src/enrollment/enrollment.layer.ts:104-152`). `requires` becomes a resource dependency. `settings.<harness>` keys are merged into that harness's settings file; adapters reject keys on their never-touch list, and values pass the existing publication credential checks (`src/profile/publication-credentials.ts`).

### 8. Tools, installers and local overlays

- **Tools** keep today's spec: platform recipes, exact versions, `buildPolicy`, `verify`, `login`, `agentInstall`. They compile to the existing `tool` resource and run through the existing planner, executor and Configuration Agent policy. `canonfig source scan` scans the Canonical Folder (instructions, skills, hook scripts, MCP commands) instead of `--file` lists and proposes `tools` entries for review. Installer bindings stay machine-local in `~/.canonfig/installers/`.
- **Authored resources are bounded, not arbitrary.** `resources.<id>` in `canonfig.jsonc` (section 11) authors a file, directory or config file under the home directory, outside every harness. Harness surfaces stay the adapters' alone.
- **Local items** live in `~/.canonfig/local/`: the same layout plus `AGENTS.md` and `local.jsonc` (MCP servers, settings, harness and resource exclusions, overlays, `backups`). It is never published and never replaced. Projection adds local items to published ones within `local.allow`; a name that collides with a published item is Human Action Required unless a Local Overlay (section 11) names it. Keys a harness file holds outside Canonfig's owned set are follower-owned without any declaration.

### 9. Security

- Ownership is a positive allowlist per adapter; nothing outside an owned surface is written, read into a plan, or backed up. Tests assert, per adapter, that no planned target or snapshot path equals or contains a never-touch path.
- Every target is resolved under the pinned root with the existing no-follow, lexical and realpath checks; symlinked components are refused for writes.
- Publication reads only the authoring allowlist, enforces the existing realpath-inside-source rule, keeps MCP secrets as `fromEnv` references, and rejects credential-looking literals.
- Hooks and MCP stdio commands run code on followers; the plan lists every command before apply, as project hooks do today.
- Snapshots and journals are local, private and never transferred. Takeover, restore and every run stay in the SQLite journal.

### 10. Deleted, and what came back

- `canonfig harness` and everything behind it: `src/harness-configuration/{cli,cli-arguments,watch}.ts`, `core/{config,scaffold,state,planner,diff,doctor,export,archive}.ts`, `.harness-state.json`, the project build context, `docs/harness-configuration.md`, `docs/harness-archives.md`, `skills/sync-harnesses/`, `skills/setup-canonfig/references/harness-setup.md`, seven test files, the GUI harness page and routes.
- Hand-written `profile.jsonc`/`tools.jsonc`, `source publish --profile-file`/`--proposal`, `source digest`, `source reconcile-skills`, multi-profile `profile select` and `follower enroll --profile`, `setup --scope project-only`, and `src/profile/legacy-revision.ts`.
- **Restored (2026-11-05), adapted to the folder:** `append-local` and `sync --review-local`, the `overlay` commands with stored Local Overlays, and authorable `file`/`directory`/`config` resources. Section 11 describes each. The owner never approved their deletion; the folder model made the follower's own content harder to keep, not less needed.
- **Not restored:** v5.0.1 resources with arbitrary `skill` targets (a skill belongs in `skills/`, or in a `directory` resource when it lives outside every harness); inline `content`, base64 and `symlinkTo` file specs (files come from `files/`, links are never authoring input); the `mirror-owned` directory policy as an authored choice (`append-local` replaces it with drift protection); `config` resources with `replace` or YAML anchors as authored policy (a config resource always merges owned keys); `--key`/`--target` overlay claims on config keys (section 11 explains why). State from v5.0.1 is migrated separately, not read by this design.

### 11. Machine-owned content: append-local, Local Overlays, authored resources

The motivating case: Source A publishes skills, rules and `AGENTS.md`. Follower B has its own skills and its own instructions. B must get A's items and keep its own while Canonfig projects both into B's Codex (`~/.codex/AGENTS.md`, shared `~/.agents/skills/`). Three mechanisms cover it, all on the one planner, executor, journal and recovery path.

**Local instructions.** `instructions` joins `local.allow`. With it, `~/.canonfig/local/AGENTS.md` is appended after the published `AGENTS.md` in every harness's instructions, inside Canonfig's section. This is the folder-native way to add text to all of B's harnesses at once.

**`append-local` (Source-declared, `local.appendLocal`).** `canonfig.jsonc` `local.appendLocal` names harness categories whose outputs Canonfig shares with each machine: `instructions` and `skills`. It travels with `local.allow` in the `local-policy` item, so the Source decides for every follower, as v5.0.1's per-resource `policy` did. Authored `file` and `directory` resources take the same policy (`"policy": "append-local"`).

- *Text files* keep the v5.0.1 format: `<!-- canonfig:source:start -->`, the Source text, `<!-- canonfig:source:end -->`, a blank line, then the machine's text. The Applied Resource Record and verification hold the digest of the Source text only. Drift is the three-way rule on that section; the machine's text is never drift. First adoption keeps the whole existing file as the machine's text, even when it equals the Source text, because matching bytes do not prove ownership. The plan says so and names `canonfig sync --plan --review-local`. A file Canonfig owned whole under another policy converts without keeping its old copy as local text when it is unchanged, and is Follower Drift when it was edited. Removal (and `restore`) takes out only the Source section. Source text must be UTF-8 without NUL or the reserved markers; publication and projection refuse it otherwise.
- *Directories* are new: Canonfig owns the top-level entries it writes (one skill directory, one file) and everything beneath them. Every other top-level entry belongs to the machine: not compared, not drift, not removed. A machine's file added inside one of Canonfig's entries is drift, as in any owned tree. On first adoption an entry the machine already holds under a name Canonfig would write is Follower Drift (rename one), mirroring the `local/` name-collision rule; Canonfig never replaces what it did not write. This is how B's own skills in `~/.agents/skills/` survive.
- *Review.* `sync --plan --review-local` writes one private JSON per first text adoption (`sourceAddition`, `retainedLocal`, `proposedText`, digests, revision, plan digest) under `~/.canonfig/.reviews/adoption-review-<uuid>/` (directory 0700, files 0600). The text never enters the plan, the journal or the command output. It works on the Source, unenrolled machines and followers, and only with an interactive `--plan`.
- *Restore.* A takeover snapshot is still taken. `restore` of an append-local surface does not write the snapshot back over the machine's later edits: it retires Canonfig's section or entries, which leaves exactly the machine's content (first adoption kept all of it).
- *Turning it off* switches the surface back to whole-file ownership, which reports Follower Drift wherever the machine's text or entries remain. The person moves that content (for example into `local/AGENTS.md`) and syncs again. Canonfig does not guess.

**Local Overlays (machine-declared, `local/local.jsonc` `overlays`).** An overlay is a machine's explicit decision that its `local/` item replaces the published item of the same name, instead of the name collision stopping the run. Items are `rules/<id>`, `skills/<name>`, `agents/<id>`, `commands/<id>`, `mcp/<name>` and `settings/<harness>` (local keys replace the published keys they overlap; other published keys stay). `canonfig overlay list|set|remove` edits and reports them; `list` says whether each finds a local item and a published one, and the plan warns about an overlay with no local item. The Source's `local.allow` still gates the category, overlays are never published or mirrored, and a new revision does not touch them. v5.0.1 overlays claimed config keys of authored resources so that dropped keys stayed; in the folder model every key Canonfig does not declare is already the follower's, and a key it stops declaring is better kept by declaring it in `local.jsonc` settings, so that form is not restored.

**Authored resources (`resources.<id>` plus `files/`).** `kind` is `file` (`source` under `files/`, `policy` `replace` or `append-local`), `directory` (`source` directory under `files/`, same policies) or `config` (`format` json, toml or yaml, `keys` as `settings` keys, always merged on owned keys). They publish as a `resources:<id>` JSON item plus one file item per file under `files/` (every file must be read by a resource), mirror like every other item, honor Follower Groups through `resources/<id>` (a file follows the resources reading it), and are untouched by `surfaces`, which selects harness categories. Projection makes each one a surface of the pseudo-harness `resources` rooted at the home directory (resource id `harness:resources:<id>`), so takeover snapshots, root pinning, three-way drift, removal and `restore` work unchanged; a restored resource goes into `local.jsonc` `excludeResources`, the counterpart of `excludeHarnesses`. Targets are written `~/...` with no `.` or `..` segment, must not overlap each other, and must not overlap the Canonical Folder, `~/.agents/`, or any adapter's root, surface target or never-touch path, whether or not that harness is listed. That bound replaces v5.0.1's unbounded targets: a resource cannot reach `~/.codex/auth.json`. Moving a resource to a new target needs a new id, so the old target retires through the normal path.

### 12. State from earlier releases

State that Canonfig 4.0.0 through 5.0.1 wrote (state format 4) is read and carried forward, not refused (`src/state/earlier-state.ts`). The first command that opens it upgrades it in place:

- **Checked first, written never on refusal.** Items with no equivalent stop the upgrade with the item and its recovery, before any write: an unfinished run, a Source that published more than one profile (multi-profile is deferred to issue #254), or a row this release cannot decode.
- **Authored resources released, not mapped.** Applied records of authored `file`, `directory`, `config` and `skill` resources are dropped and listed in `state_upgrades`; their files and keys stay where they are. Mapping them to `resources.<id>` would leave records nothing can own: most 5.0.1 targets are inside harness roots, which `resources.<id>` may not author, so the next sync would retire them while the harness projection takes over the same paths. Released, they are ordinary takeovers the next time the Source authors those paths, snapshot first. Mapping only targets outside harness roots would need the adapters' environment-dependent reserved paths inside the state upgrade; not worth that coupling.
- **One transaction under the write lock.** The upgrade takes SQLite's write lock (`BEGIN IMMEDIATE`) before it reads anything, so a still-running earlier release cannot start a run or change a record between the checks and the rewrite. Inside it, it rereads the history, runs every check, then copies the checked state next to the database through SQLite's backup API from a second, read-only connection (`state-before-format-6-<UTC time>.sqlite`, created exclusively, no symlink followed, mode 0600). Only then does it rebuild the format 6 schema and history exactly as a new database gets them, copy every row, check foreign keys, and commit once. A refusal rolls back before any write; a failure after the copy removes it.
- **Journaled.** The append-only `state_upgrades` table records the replaced history, the backup path, the build, and every resource released, revision emptied and overlay dropped.
- **Carried over.** Enrollment, run journals, receipts, approvals, blobs, schedules, secret references and the records of tools and credentials carry over unchanged. `selectedProfile` becomes `profile`. Overlay keys are dropped and listed: the config records they overlaid are released, and every key Canonfig does not own is follower-owned now. Earlier revisions keep id, profile, sequence, digest, signature and signed bytes but list no resources, so the next publication from `~/.canonfig/` continues the sequence.
- **Idempotent.** A format 6 database is never upgraded again. State from before 4.0.0 is asked to pass through 5.0.1 once; an unknown history (a newer release) is refused.

## Consequences

- Users author one folder in the shapes harnesses already use; Canonfig owns paths, formats and translation.
- Taking over a harness removes configuration the user had there. The snapshot and `restore` make that reversible, and drift rules keep later local edits.
- Adapter correctness now affects global setup on every follower, so adapters need golden fixtures for all three OSes and a per-release documentation re-check.
- Followers keep their own content beside published items where the Source allows it (`local/`, `local.appendLocal`) and may replace a published item on one machine with a Local Overlay. Everything else they change is Follower Drift or a question for the Source.

## Rejected

- **Keep the JSONC Machine Profile and add harness resources to it.** Authors keep writing native paths and formats by hand, and arbitrary targets stay possible.
- **Folder next to the profile** (`~/.canonfig/` projected locally, `profile.jsonc` still published). Two sources of truth, two engines, and followers never get the folder.
- **Whole-folder replace of each harness home.** Auth, sessions and history share those directories and files (`~/.claude.json`, Devin's Windows root, `agent.db`), and a denylist cannot keep up with vendors adding state files.
- **Symlink harness surfaces into `~/.canonfig/`.** Windows symlinks need privileges, several harnesses mix state into config files, and drift would be invisible.
- **Project per harness on the Source and publish native files.** Roots depend on each follower's OS, environment and installed harnesses.

### Direct hook execution on Windows

A Windows Source cannot observe POSIX executable bits. When an enabled hook directly names a script under `hooks/`, publication treats that explicit command as executable intent for followers. A script referenced only by disabled hooks retains its observed mode. Unix Sources continue to publish their actual mode. This preserves execute permission, not interpreter availability or shell compatibility across operating systems.
