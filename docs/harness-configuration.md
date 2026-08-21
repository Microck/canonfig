# Harness configuration projection

Canonfig can compile one project-local `.canonfig/` source into native
configuration for multiple AI development harnesses. This feature is separate
from Source/Follower Machine Profile synchronization: it does not change the
published profile contract, transport, synchronization planner, recovery, or
AgentResolution runtime.

## Canonical layout

```text
.canonfig/
  harness.yaml
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
cleanup metadata, never credential values.

## Commands

```bash
canonfig harness init
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
entry or externally edited generated file.

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

Each adapter declares a verification date, documentation references, executable
probes, feature support levels, and target-specific notes. Adapter code is pure:
it converts the canonical model into desired artifacts and diagnostics. A
shared planner owns collision detection, external-edit detection, path safety,
atomic writes, cleanup, and idempotence.

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
