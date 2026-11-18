# Canonfig Guard

Canonfig checks candidate configuration before tracking or updating upstream
skills, importing an archive or harness setup, accepting discovered tools,
publishing a Profile Revision, or planning a Follower sync. The built-in check
runs offline. It looks for specific credential disclosure instructions,
concealment, unsafe execution patterns and other signals. The prose check covers
global instructions, rules, agents, commands and skills. Warnings allow the
operation. The GUI shows the warnings after importing an archive, publishing a
revision, tracking a skill or accepting discovered tools. A block holds the
batch before it changes the installed or published state.

The built-in rules use text heuristics without parsing shell or language
syntax. A literal `curl -k ... | sh` can trigger a hold in executable or
script-like files and inline execution declarations, even in comments or
quoted strings. The same pattern in prose only triggers a warning. The rules
can miss reworded instructions or commands padded or split beyond their fixed
limits, so configure the optional checker for broader coverage.

Run `canonfig guard scan --json` to check the current folder and
`canonfig guard status --json` to see the latest recorded result. Status does
not contact the checker. Folder scans retain up to 1 MiB per document or
attachment and 64 MiB total for those files. Larger files and files beyond the
remaining budget count as unsupported. If an optional checker needs one of
those files, Guard reports the item as unavailable. A hold is a record of one attempt. Fix the content,
pin a clean upstream ref, or deselect it and replan. On a Follower, ask the
Source operator to publish the correction, then retry Sync.

A Source or standalone operator can put `guard.jsonc` beside
`canonfig.jsonc`, or in the explicit skill worker root. Source Settings also
lets operators configure the checker. Followers use the built-in checker.

```jsonc
{
  "version": 1,
  "checker": {
    "kind": "openai-compatible",
    "endpoint": "http://127.0.0.1:11434/v1/chat/completions",
    "model": "local-model",
    "protocolRevision": "1",
    "onUnavailable": "block"
  }
}
```

Set `kind` to `http` and omit `model` for a Canonfig HTTP adapter.
Loopback literals are permitted by default. Other destinations require HTTPS
and `allowRemote: true`. Canonfig connects directly to both kinds of endpoint
and ignores environment proxy settings. Configure `authentication: "bearer-env"` to use
`CANONFIG_GUARD_API_KEY` from the Canonfig process environment, including the
environment of any unattended worker or GUI service.

An optional checker receives eligible instruction and script text. If an
eligible text file contains a recognized credential or the configured bearer
key, Canonfig withholds the item and reports the check as unavailable. Eligible
text can still include confidential material, and a checker can forward it. A required
checker outage holds the operation. Set `onUnavailable: "warn"` to allow
operations with incomplete coverage. Completed checker verdicts are cached for
24 hours. Change `protocolRevision` when the checker model or policy changes
behind the configured endpoint.

The HTTP adapter accepts a POST with the following body.

```json
{"schema":"canonfig.guard/v1","item":{"kind":"skills","digest":"<sha256>","files":[{"path":"SKILL.md","text":"Summarize the meeting notes."}]}}
```

Return `{"schema":"canonfig.guard/v1","verdict":"allow","findings":[]}`.
For `warn` or `block`, supply findings with a `code` and optional `path`
and 1-based `line`. Codes are `prompt-injection`, `credential-disclosure`,
`unsafe-execution`, `obfuscation` and `other-risk`.

Guard checks declared content. Disabled hooks stay in scope so enabling one
later cannot bypass the check. Its coverage excludes live MCP tool lists,
downloaded packages, runtime tool calls and direct changes to a harness.

Existing setup items can finish before Guard holds a harness import. Correct
the selected material or select fewer items, then review a new setup plan.
Archive previews and upstream skill checks use offline rules. Apply checks the
candidate again and runs the optional checker where configured.
