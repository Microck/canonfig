# Agent harnesses: built-in codex and claude, a model choice, and a custom harness

Status: accepted

## Context

Canonfig ran three built-in agent CLIs: `codex`, `claude` and `gemini`. Users could not pick the model, and could not use any other agent. Gemini CLI has since been replaced by Google's Antigravity CLI, so the `gemini` adapter targets a tool that no longer ships.

## Decision

- **Built-ins are `codex` and `claude`.** `gemini` is removed from the harness kinds, the CLI, doctor, docs and tests. No migration: a stored `gemini` harness fails validation and must be configured again (hard cut; no installed base).
- **Built-ins take an optional `model`.** Canonfig adds `--model <name>` in front of its fixed flags. Both CLIs accept it as a top-level option (`codex --model <m> exec ...`, `claude --model <m> --print ...`; checked against codex-cli 0.166.0 and Claude Code 2.1.293). The name must not start with `-` or contain whitespace, so it can never become a second flag. Built-ins do not accept free-form arguments: their read-only flags (`--sandbox read-only`, `--permission-mode plan`) stay Canonfig's.
- **`custom` runs any agent under a fixed contract.**
  - Canonfig runs `executable` with exactly the configured `arguments`, one argv entry each, without a shell, through the same controlled executor as the built-ins (environment, secret bindings, time and output limits).
  - Standard input: the `canonfig.agent-task/v1` JSON document.
  - Standard output: the proposal JSON object (`summary`, `actions`). Anything else is refused, as with the built-ins.
  - `--model` is rejected for `custom`; its model belongs in its own arguments.

## Consequences

- Canonfig cannot force a custom agent's own process into a read-only mode. That becomes the user's responsibility, stated in the docs. What does not change: every proposed action is still checked against the path, executable, origin and capability allowlists before it runs, `agent-propose` never executes anything, and `agent-apply` still verifies with an independent observer. A custom agent can therefore propose only what a built-in could.
- Antigravity or any future agent can be used as `custom` once it can read the task on stdin and print the proposal on stdout, without a Canonfig release.

## Rejected

- **A shell command string.** Quoting and injection rules differ per platform, and the controlled executor's argv model would be lost.
- **Free-form arguments for built-ins.** One `--dangerously-skip-permissions` would silently undo the read-only flags Canonfig depends on.
- **Keeping `gemini` for compatibility.** It targets a discontinued CLI and would be a second untested path.
