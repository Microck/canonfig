# Plan: global `~/.canonfig/` folder

Implements [ADR 0003](../adr/0003-global-canonfig-folder.md). Six phases. Each merges to `main` green on `npm run typecheck`, `npm run lint` and `npm test`, plus `docs:validate`, `skills:validate` and the `ui:*` scripts when it touches those areas. Run full suites in the project's Raft workspace, not on a shared host.

Release grouping: phases 1 and 2 ship together (phase 1 leaves the translation library unwired for one merge). Cut the next release after phase 4, when followers project. Phases 5 and 6 follow.

Sizes are rough net source and test lines.

## Phase 1: remove harness projects

Goal: no `canonfig harness` command, no repository `.canonfig/`, no project GUI page. Shared code survives in its new home.

Moves (no behavior change):

- `src/harness-configuration/skills/*` to `src/skills/`; `core/{errors,filesystem,path}.ts` with them. Consumers: `src/runtime/main.ts:242-245`, `src/profile/skill-reconciliation.ts:8-9`, `src/profile/skill-reconciliation-cli.ts:3-4`, tests `acceptance/{skill-updates,automatic-skill-updates,source-skill-reconciliation}.test.ts`.
- Generic parts of `cli-output.ts` (`toCliPayload`, result rendering, IO type, lines 10-14, 50-53, 77-119) to `src/cli/command-output.ts`. Consumer `src/runtime/self-update/cli.ts:2`.
- Translation library to `src/projection/`: `core/{schema,schema-*,types,validation,frontmatter,hash,render,render-*}.ts`, `adapters/*`, `templates/runtime.ts`. Strip the project build context (`core/compiler.ts:177-225`) and repository paths; keep pure MCP, hook, frontmatter and document translators. Wired in phase 2.

Deletes:

- `src/harness-configuration/{cli,cli-arguments,watch}.ts`, `core/{config,scaffold,state,planner,diff,doctor,export,archive,compiler}.ts`, then the empty tree.
- Tests: `tests/harness-configuration{,-antigravity,-providers}.test.ts`, `tests/harness-json-config.test.ts`, `tests/acceptance/harness-{export,watch}.test.ts`, `tests/integration/harness-sync-skill.test.ts`. Move the MCP and hook mapping cases from `harness-configuration-providers.test.ts` into `tests/projection-translation.test.ts` against the translators. Keep the cancellation case from `harness-watch.test.ts:112-119` next to self-update.
- Docs and skills: `docs/harness-configuration.md`, `docs/harness-archives.md`, `skills/sync-harnesses/`, `skills/setup-canonfig/references/harness-setup.md`.

Edits:

- Routing and help: `src/runtime/main.ts:21-22,188-189,243-254`, `src/runtime/command-routing.ts:12-13,35-44`, `src/cli/help.ts:24-26,231-239`, `src/logging/command-log.ts:18-33`.
- Build: `tsconfig.json:22`, `vitest.config.ts:13-16`, `tools/release/minify-cli.ts:32-36,50-53`, `website/scripts/validate-commands.ts`, `website/scripts/validate-skills.ts`.
- Tests: `tests/foundation.test.ts:39-51`, `tests/acceptance/global-flags.test.ts:29-44,87-108`.
- Docs: `README.md:110-126`, `docs/skill-updates.md:39-49,159-163`, `website/content/docs/reference/cli.mdx:575-646`, `skills/README.md`, `skills/setup-canonfig/SKILL.md` and its `references/{configuration-choices,completion,questions,tailscale-discovery}.md` project sections.
- UI: `ui/src/workspace/settings.tsx:571-768` (keep the path validator the agent policy uses), `routes.ts:17,32`, `routes.test.ts:15,27`, `nav.ts:43,61`, `workspace.tsx:20,42,57`, `store.tsx:42,47`, `tour-steps.tsx:120-126,146-151`, `ui/src/shared/data.ts:337-342`, `ui/README.md`.

Tests: `foundation` and `global-flags` assert `canonfig harness` is gone and `canonfig harness --help` falls back to global help; skills and self-update suites pass after the moves; `packed-cli` size check passes.

Risks: an import of the old tree hidden in website scripts or release tooling (grep `harness-configuration` to zero). `canonfig agent harness` (`src/cli/cli.ts:782-879`, `src/runtime/layers.ts:1747-1794`) is a different feature and stays.

Size: about -6,500.

## Phase 2: global projection engine, local only, with backup and restore

Goal: on the Source or an unenrolled machine, `canonfig sync --plan|--apply` projects `~/.canonfig/` into the harnesses listed in `canonfig.jsonc`, with takeover snapshots and `canonfig restore`.

- `src/projection/folder.ts`: load the authoring allowlist (`canonfig.jsonc`, `AGENTS.md`, `rules/`, `skills/`, `agents/`, `commands/`, `hooks/`) and `local/` into one canonical model. `canonfig.jsonc` schema with Effect `Schema`: `version`, `harnesses`, `mcp`, `hooks`, `settings`, `local`. Rules, agents and commands come from frontmatter. Realpath-inside-folder rule from `src/profile/publication.ts:374-466`.
- `src/projection/adapters/<id>.ts` for all 16: `roots(environment, userDirectories, platform)`, owned surfaces (files, directories, key paths), never-touch list, `project(model)` returning artifacts. Facts and links from the ADR table; keep `docs` and `verifiedAt`.
- `src/projection/plan.ts`: artifacts to internal `file`, `directory` and `config` desired resources with adapter-computed targets, fed to `planSynchronization` (`src/synchronization/planner.ts:500-643`). Executor, journal, rollback and recovery are reused unchanged. Runs record origin: revision id or local folder digest (`synchronization_runs`).
- `src/projection/takeover.ts`: first-write detection per harness, snapshot under `~/.canonfig/.backups/<UTC>/<harness>/` with `manifest.json`, `keys.json` for key-owned files, retention of 5, deletion on rollback. Protected writes through the machine layer.
- State: new `harness_takeovers` table (harness, pinned root, snapshot id, run id); `applied_resources` reused with ids `harness/<id>/<surface>`.
- CLI: `sync --apply --no-backup`; `restore [<snapshot>]` as a journaled run that also writes the harness exclusion to `local/local.jsonc`. Help, `src/cli/cli.ts`, `src/runtime/layers.ts` wiring.
- Hook runner generated at `~/.canonfig/.runtime/hook-runner.mjs`.

Tests (real temp HOME, real SQLite, no mocks):

- Golden fixtures per adapter: owned outputs match; seeded never-touch files (for example `~/.codex/auth.json`, `~/.claude.json` `oauthAccount`, `~/.local/share/opencode/auth.json`) are byte-identical after apply and after restore.
- Snapshot of `~/.claude.json` contains only `mcpServers`.
- Six takeovers leave five snapshots; a failed run deletes its snapshot and rolls back every surface.
- Interrupted run recovers through `canonfig recover`.
- Foreign skill added after takeover is reported as drift and kept.
- Changing `CODEX_HOME` after takeover returns Human Action Required.
- Windows root variants (Devin `%APPDATA%`, Copilot `%USERPROFILE%`) through the Windows machine-layer test suite.

Risks: vendor paths drift (mitigated by per-release re-check); TOML and YAML codecs must preserve unowned keys and comments in shared files; mapping sync's revision-centric planner to a local origin without forking it.

Size: +3,500 source, +2,000 tests.

## Phase 3: detection and selection in setup

Goal: Source setup detects installed harnesses and preselects them; the user edits the list before the first apply; followers report listed but absent harnesses.

- `src/projection/detect.ts`: resolve each adapter's executables through the verifier search order without spawning; generic names also need the root; config roots reported as evidence.
- `src/setup/{setup.types,setup.controller,setup.plan,setup.layer}.ts`: Source plan gains a `harnesses` stage that scaffolds `~/.canonfig/` (`canonfig.jsonc`, `AGENTS.md`, `skills/`) with the detected list; `setup plan --harness <id>...` overrides; the plan digest covers the list. Remove `--scope project-only` (`setup.types.ts:7-16`, `setup.controller.ts:87,738-740`, `help.ts:185-198`, `tests/setup-controller.test.ts:149-151,517-519`).
- CLI `harnesses` (detected, listed, excluded, pinned root, snapshot) and `harnesses include|exclude <id>` editing `local/local.jsonc`. `doctor` reports the same.

Tests: fake executables in a temp `PATH` directory; `agent` without `~/.cursor` is not Cursor; setup approval invalidated when the list changes; status shows `not-installed` while the run converges.

Risks: scheduled runs see a narrower `PATH`; detection must use the same bounded search the scheduled run uses.

Size: +900, -200.

## Phase 4: publish from `~/.canonfig/`, follower materialize and project

Goal: `source publish` compiles the folder; followers mirror and project it. The old authoring path is removed in the same phase so there is one publish path.

- `src/profile/compiler.ts`, `src/profile/publication.ts`: folder model to one resource per item (ADR section 2), blobs, `groups`, `tools`, `credentials`, `scheduleDefault`, `harnesses`, `local-policy`. Signing, sequence and commit unchanged (`publication.ts:619-703`). `canonfig.jsonc` schema gains `profile`, `tools`, `credentials`, `groups`, `scheduleDefault`.
- Delete `source publish --profile-file|--proposal`, `source digest`, `source reconcile-skills`, `src/profile/skill-reconciliation{,-cli}.ts`, `docs/source-skill-reconciliation.md`, and their tests.
- `src/profile/discovery.ts`, `src/profile/tool-catalog.ts`: `source scan` reads the folder instead of `--file`; `--write` inserts accepted `tools` entries through `src/synchronization/config-jsonc.ts`.
- `src/synchronization/follower-orchestration.ts`: hydrate authorized items, plan mirror actions (targets limited to the allowlist under `~/.canonfig/`, canonical `canonfig.jsonc` render), then projection actions from the desired mirror plus `local/`; dependencies mirror item before projection, `requires` tool before MCP.
- One profile per Source: remove `profile select` and `follower enroll --profile` (`src/cli/help.ts:77,163-171`, enrollment and CLI code).
- `src/skills/cli.ts`: default root `~/.canonfig/` on the Source.

Tests:

- Loopback HTTPS end to end with two temp HOMEs: publish, enroll, sync, project.
- Group filtering hides items and their dependents.
- Mirror edit is drift, preserved, and its projections hold.
- Listed harness absent on follower is reported and the run converges.
- `local/` name collision returns Human Action Required.
- Publication rejects non-allowlisted entries, symlink escapes and literal secrets; equal content republishes idempotently.

Risks: metadata budget (`src/profile/metadata-budget.ts`) with many skill files; deterministic mirror render; ordering mirror and projection inside one journaled run.

Size: +2,500, -2,000.

## Phase 5: delete the old resource model

Goal: no authorable arbitrary targets and no code that only served them.

- `src/domain/profile.ts`, `src/domain/resource.ts`: remove authoring `MachineProfile` input with `file`, `directory`, `config` specs and `append-local`; the three kinds remain only as internal projection actions.
- `src/synchronization/{planner,resource-plans,resource-executors,executor,recovery,client-review,follower-sync-config}.ts`: remove `append-local`, `--review-local`, stored overlays and overlay planning (`planner.ts:155-159,540-549`, `resource-plans.ts:568-704`).
- Delete the `overlay` commands (`src/cli/help.ts:129-137`, `src/runtime/layers.ts:940-1015`) and `sync --review-local`.
- Delete `src/profile/legacy-revision.ts` and its callers (`src/state/state-schema.ts:437-508`, `state-repository.layer.ts:1552-1555`, `enrollment.layer.ts:236-289`); bump the state format so older state fails with a reinitialize message.
- Tests: remove or rewrite old authoring cases in `profile-contract`, `profile-compiler`, `publication`, `synchronization-planner`, `state-repository` and acceptance suites; keep tool, recipe and installer coverage.

Risks: tool and credential paths that lean on generic file code; a clear message for state from earlier versions.

Size: about -5,000.

## Phase 6: GUI, docs, skills

Goal: every surface describes and edits the folder model. The GUI still runs on simulated data (ADR 0001).

- UI: `ui/src/workspace/profile.tsx` becomes a folder view (instructions, rules, skills, agents, commands, MCP, hooks, settings, tools, groups, harness list); Source onboarding gains a Harnesses step with detected harnesses preselected (`ui/src/onboarding/onboarding.tsx:702-805`); Follower onboarding "This machine" shows listed, installed and excluded harnesses (`:1136-1177`); a Backups page per role (snapshots, restore); `/follower/local-settings` edits `local/`. Update `routes.ts`, `nav.ts`, `store.tsx`, `tour-steps.tsx`, `shared/data.ts`, `ui/README.md`.
- Docs: `docs/architecture.md` (profile contract, resource kinds, overlays, layout, CLI contract), new `docs/global-folder.md`, `docs/file-rollback.md` (takeover snapshots), `docs/discovery-scope.md`, `docs/skill-updates.md`, `docs/installer-bindings.md`, `GLOSSARY.md` (Canonical Folder, Target Harness, Projection, Takeover Snapshot; Local Overlay redefined), `README.md`, website CLI reference, `RELEASE_NOTES.md`, ADR 0001 pointer to ADR 0003.
- Skills: rewrite `skills/setup-canonfig/` for folder authoring, harness selection and backups; update `skills/README.md` and `validate-skills.ts`.

Tests: `ui/src/workspace/routes.test.ts`, `ui:typecheck`, `ui:lint`, `ui:build`, `docs:validate`, `skills:validate`, docs browser e2e.

Risks: GUI promises behavior the backend does not serve yet; keep simulated operations labeled as in ADR 0001.

Size: UI about +1,500 and -1,200; docs about +900 and -1,100.
