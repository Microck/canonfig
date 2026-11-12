---
name: Bug report
about: Something in the CLI, the browser UI or the docs does not work as described
title: "[bug] "
labels: ["bug", "needs-triage"]
---

<!--
Do not paste credentials, tokens, invitation envelopes, ~/.canonfig/secrets.json,
anything under ~/.canonfig/credentials/, or private MCP server values.
Report security problems privately: https://github.com/Microck/canonfig/security/advisories/new
-->

## Summary

What went wrong, in one or two sentences.

## Steps to reproduce

1. Run, or open in `canonfig ui`:
   ```sh
   canonfig ...
   ```
2. See:

## Expected

What should have happened instead?

## Environment

- `canonfig --version`:
- OS and architecture (for example Ubuntu 24.04 arm64, macOS 15 arm64, Windows 11 x64):
- `node --version`:
- This machine's role: Source / Follower / not set up yet
- How Canonfig runs here: terminal / `canonfig ui` / Source service / scheduled sync

## Output

Paste the full output of the failing command with `--json`, if it has one.

If the problem is about setup, credentials, harnesses or sync, also paste:

```sh
canonfig doctor --no-input --json
```

Remove anything private before pasting.
