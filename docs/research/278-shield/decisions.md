# Approved decisions and execution record

## Scope

The original #278 task authorizes Shield research, implementation, disposable-home proofs, commits on `feat/shield`, push, and a ready-for-review PR. No live Canonfig/harness state changes, parent-checkout edits, paid-tier upgrades, merge, PR watching or subagents.

The user explicitly selected native plugin support in the scope question:

> Extend the Canonical Folder and projection model with harness-specific native plugin items: per-harness manifest handling, executable hooks and dependencies, platform-specific variants, and follower-local policy (a follower can decline or exclude a plugin). Executable plugin content must stay inside canonfig's existing trust model (signed revisions, digest verification) and go through review, never auto-published. One canonical folder format: change it once, with no compatibility shim. Write an ADR for the folder-model change and update GLOSSARY.md.

## Execution

- Model: `maisa-codex/gpt-6-astra`, OMP, thinking max, default interaction mode.
- Additional paid spending: not authorized. No hosted research jobs.
- Temporary evidence root: `/tmp/canonfig-shield-278.1PQfGP`.
- Completed: branch based on origin/main; repository contracts read; real Claude MCP, Codex MCP and public skills installer traces saved in this folder.
Completed implementation: Shield CLI, hook projection, private-home installer routing, apply-time ingestion, Linux process-scoped hard mode, doctor/GUI status, Native Plugin folder items, digest review, signed publication and follower exclusion. Product documentation and research are complete; observed verification and limits are recorded in verification.json.
- No active remote jobs or task-owned Raft workspace.
- Raft Paris and Ashburn report no advisory headroom; other running boxes belong to other tasks. Do not use or stop them.
- Jujutsu initialization is unavailable in this colocated Git worktree. Use Git only here.
- Language service and graph unavailable; semantic discovery provider credit failure. Use narrow exact reads/searches, no paid upgrades.

## PR disclosure

The maintainer explicitly permits a ready-for-review PR without prior human testing. Set `human_testing` exactly to `none yet; maintainer to test before merge`. Agent-only checks must be labeled and report exact commands and observed outcomes. The installed CLI reports `omp/18.18.7`; `model_used` is `maisa-codex/gpt-6-astra via OMP`. `CONTRIBUTING.md` and `.github/pull_request_template.md` were read from `origin/main` after this decision. No human check is claimed.

## Observed proof

- Public `npx skills add` redirected into the Canonical Folder and re-projected.
- Codex 0.167.1 denied a native patch into `.codex/skills`, returned the canonical path, then wrote there instead.
- Linux bubblewrap returned `EROFS` for a protected write; runtime and canonical writes succeeded.
- A real Claude marketplace install staged a complete plugin. It was absent from the live disposable harness before review and listed as `shield-native-proof@skills-dir` after review and sync.
- Copied authentication files in the disposable proof home were removed after the agent proof. No live authentication files were changed.
- Whole-suite/build verification remains unavailable through Raft because the inspected hosts reported no headroom. CI is the authorized broad-verification route.
- Final focused verification: 232 Vitest cases and 30 affected UI tests passed. Backend and UI typechecks passed. Root lint passed, including 446 command examples and three skills. UI lint passed with 73 warnings.
- Website typecheck could not start because fumadocs-mdx is absent. No full-suite, release-build or macOS/Windows runtime pass is claimed.
- Inline simplification found the launcher name/path and descendant-interception gap. The shared executable resolver and corrected shims now pass the isolated process regression. No subagents or independent review were used.
