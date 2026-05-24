<h1 align="center">codexport</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/codexport"><img src="https://img.shields.io/npm/v/codexport?style=flat-square&label=npm&color=000000" alt="npm badge"></a>
  <a href="https://www.npmjs.com/package/codexport"><img src="https://img.shields.io/npm/dt/codexport?style=flat-square&label=downloads&color=000000" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-mit-000000?style=flat-square" alt="license badge"></a>
</p>

---

`codexport` replicates a canonical Machine1 Codex setup to follower machines. it is built for operators who want one trusted `~/.codex` source of truth, follower-local overlays, and a low-friction `npx` join path without committing plaintext secrets to GitHub.

Machine1 serves a content-hashed bundle from its `~/.codex` directory. followers pin the master's fingerprint on join, fetch updates over a Tailscale-reachable HTTP address, and apply updates at Codex `SessionStart` through a short best-effort hook.

[npm](https://www.npmjs.com/package/codexport) | [github](https://github.com/Microck/codexport)

## why

if you keep a carefully tuned Codex setup on one machine and want the same defaults elsewhere, `codexport` gives you a practical pull-based sync path.

- keep Machine1 as the canonical Codex configuration source
- let followers preserve local MCPs, local skills, trust entries, and path overrides
- sync auth-bearing files through the private Tailscale path instead of a plaintext GitHub commit
- refresh followers at Codex session startup without interrupting active sessions
- use content-hash revisions and pinned master fingerprints instead of blind file copies

## quickstart

`codexport` requires Node.js 20+.

on Machine1:

```bash
npx codexport master init
npx codexport master service install
npx codexport master link --host machine1.tailnet.ts.net
```

on a follower:

```bash
npx codexport follower join "codexport://join?host=machine1.tailnet.ts.net&port=17342&fingerprint=..."
npx codexport hook install
```

manual sync remains available:

```bash
npx codexport sync --apply
npx codexport status
```

## sync model

```text
Machine1 ~/.codex
  -> codexport master serve
  -> Tailscale-reachable HTTP bundle
  -> follower sync/apply
  -> generated follower ~/.codex
```

followers trust the provided Tailscale address and store the master fingerprint. later syncs refuse changed fingerprints by default, so a changed master identity requires intentional re-enrollment.

## included state

the master bundle includes canonical Codex config, auth files, hooks, prompts,
rules, skills, skill libraries, `AGENTS.md`, `RTK.md`, and `mise.toml` when
present.

runtime state such as logs, caches, sessions, history, compact handoffs, and
SQLite databases is excluded.

## local follower state

follower-local state lives under `~/.codexport`:

```text
~/.codexport/local.toml
~/.codexport/mcps.local.toml
~/.codexport/skills/
~/.codexport/overrides/
```

canonical MCP and skill names win by default. same-name local MCPs or skills
fail unless explicitly allowed in `local.toml`:

```toml
allowMcpOverrides = ["local-name"]
allowSkillOverrides = ["local-skill"]

[pathVariables]
workspaceRoot = "D:/workspace"
```

path variables in canonical config such as `${workspaceRoot}` are expanded from
the follower's `local.toml` before writing the generated `~/.codex/config.toml`.

## command surface

| command | purpose |
| --- | --- |
| `codexport master init` | create or refresh Machine1 master identity and bundle state |
| `codexport master serve` | serve the current canonical bundle over HTTP |
| `codexport master link` | print a durable follower join link and fallback command |
| `codexport master rebuild` | force rebuild the master bundle for repair/debugging |
| `codexport master service install` | install the user-level master background service |
| `codexport follower join` | enroll a follower from a join link or explicit master URL |
| `codexport sync` | fetch the latest master bundle |
| `codexport apply` | apply the last staged bundle |
| `codexport hook install` | install the follower-only Codex `SessionStart` hook |
| `codexport status` | report role, master URL, fingerprint, revision, and reachability |

## platform support

| platform | master service | follower hook | manual sync |
| --- | --- | --- | --- |
| linux with systemd user services | supported | supported | supported |
| windows 10/11 scheduled tasks | supported | supported | supported |

followers do not need a background service in v1. the hook runs a short best-effort sync at Codex session startup, and `codexport sync --apply` is available when an immediate refresh is needed.

## examples

generate a copy-paste join command:

```bash
codexport master link --host machine1.tailnet.ts.net
```

join with explicit trust metadata:

```bash
codexport follower join \
  --master http://machine1.tailnet.ts.net:17342 \
  --fingerprint <fingerprint> \
  --apply
```

check current follower state:

```bash
codexport status
```

## development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## license

[mit license](LICENSE)
