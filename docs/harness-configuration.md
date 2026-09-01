# Harness configuration projection

Canonfig can compile one project-local `.canonfig/` source into native
configuration for multiple AI development harnesses. This feature is separate
from Source/Follower Machine Profile synchronization: it does not change the
published profile contract, transport, synchronization planner, recovery, or
AgentResolution runtime.

## Canonical layout

```text
.canonfig/
  harness.yaml or harness.json
  instructions/
    AGENTS.md
  rules/
  skills/
  hooks/
  agents/
  commands/
```

`harness.yaml`, `harness.yml`, and `harness.json` are accepted. Generated-file
ownership is stored in `.canonfig/.harness-state.json`; it contains hashes and
cleanup metadata, never credential values. Initialize strict, pretty-printed
JSON with `canonfig harness init --format json`; YAML remains the default.

## Commands

```bash
canonfig harness init
canonfig harness init --format json
canonfig harness validate
canonfig harness targets
canonfig harness plan
canonfig harness diff
canonfig harness apply
canonfig harness status
canonfig harness clean
canonfig harness doctor
```

Use repeatable `--target <id>` or comma-separated `--targets <ids>` to select
specific harnesses. `--strict` rejects mappings classified as `shim`, `lossy`,
or `unsupported`. `--force` is required to take ownership of an existing native
entry or externally edited generated file. Canonfig rejects a directory that
contains more than one supported harness config format instead of silently
selecting one.

## Target identifiers

| Identifier | Harness |
| --- | --- |
| `codex` | OpenAI Codex |
| `claude-code` | Claude Code |
| `amp` | Amp |
| `oh-my-pi` | Oh My Pi |
| `pi` | Pi Coding Agent |
| `factory-droid` | Factory Droid CLI |
| `cursor` | Cursor Agent CLI |
| `devin` | Devin CLI / Devin Local |
| `opencode` | OpenCode |
| `grok-build` | Grok Build CLI |
| `antigravity` | Google Antigravity CLI |
| `copilot-cli` | GitHub Copilot CLI |
| `kimi` | Kimi Code CLI |
| `kilo` | Kilo Code CLI |
| `hermes` | Hermes Agent |
| `qwen` | Qwen Code |

Each adapter declares a verification date, documentation references, executable
probes, feature support levels, and target-specific notes. Adapter code is pure:
it converts the canonical model into desired artifacts and diagnostics. A
shared planner owns collision detection, external-edit detection, path safety,
atomic writes, cleanup, and idempotence.

### Kimi, Kilo, Hermes, and Qwen mappings

- Kimi uses `.kimi-code/mcp.json` and `.kimi-code/agents/`. It already scans
  `.agents/skills`, so canonical skills remain shared. Canonical commands become
  prefixed Agent Skills. Hooks and permanent permissions remain profile-scoped
  in Kimi's user `config.toml` and are reported as lossy project mappings.
- Kilo shares an OpenCode-family compiler with OpenCode. The adapter emits
  `kilo.json` plus `.kilo/skills`, `.kilo/plugins`, `.kilo/agents`, and
  `.kilo/commands`, using Kilo's schema and target identity.
- Hermes natively consumes project `AGENTS.md` and `.hermes.md`, but skills,
  MCP servers, hooks, and permanent permissions live under the active
  `HERMES_HOME`. Canonfig therefore emits a project-context bridge and reports
  profile-scoped features instead of writing outside the repository.
- Qwen uses `.qwen/settings.json` for MCP and hooks, `.qwen/skills` for Agent
  Skills, `.qwen/agents` for subagents, and `.qwen/commands` for project slash
  commands. Streamable HTTP MCP servers map to `httpUrl`; legacy SSE keeps
  `url`.

## Safety and ownership

- Native files and keys not owned by Canonfig are preserved.
- Existing conflicting keys become plan conflicts unless `--force` is explicit.
- A generated replacement edited outside Canonfig is never overwritten silently.
- Generated paths are constrained to the repository root, including symlink
  resolution.
- MCP secrets remain symbolic environment references.
- Executable hook and plugin shims are shown in the plan before they are written.
- `clean` removes only artifacts represented in the ownership state.

## Canonical example

```yaml
version: 1
project:
  name: example

targets:
  codex:
    enabled: true
    options: {}
  claude-code:
    enabled: true
    options: {}

instructions:
  root: instructions/AGENTS.md
  rules:
    - id: frontend
      file: rules/frontend.md
      paths:
        - apps/web/**
      activation: path
      description: Frontend rules

skills:
  roots:
    - skills

mcp:
  servers:
    docs:
      transport: streamable-http
      url: https://example.invalid/mcp
      headers:
        Authorization:
          fromEnv: DOCS_MCP_TOKEN

hooks: []
agents: []
commands: []
permissions:
  rules: []
extensions: {}
```

The canonical model intentionally carries semantic features rather than raw
native file shapes. When a harness changes, its adapter and fixtures can be
updated without changing the loader, planner, ownership model, or other
adapters.
