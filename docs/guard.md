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

Keep machine-local Guard policy in `guard.jsonc` beside `canonfig.jsonc`, or
in the explicit skill worker root when using one. Policy and results stay on
this machine. Profile Revisions, archives and mirrors exclude them.

## Local rule overrides

Use `rules` to set any built-in rule to `block`, `warn` or `off`. Omitted
rules use their defaults. Unknown rule codes are configuration errors (exit 2).
Status and scan reports retain suppressed findings with severity `off` and
mark changed findings with `overriddenBy: "rule"`. External checker verdicts
keep their original severity under rule overrides.

```jsonc
{
  "version": 1,
  "rules": {
    "instruction-credential-concealment": "warn",
    "unscanned-file": "off"
  }
}
```

| Default | Built-in rule codes |
| --- | --- |
| Block | `instruction-credential-concealment`, `unverified-download-execute` |
| Warn | `instruction-risk-mention`, `download-execute`, `invisible-control`, `encoded-looking-text`, `credential-file-reference`, `tool-call-steering`, `unscanned-file` |

Set `"builtInRules": false` to turn every built-in rule off, for example when
the Skill Update 396M model checks updates instead. Guard still records what
the rules would have found, with severity `off`, so a Source that publishes
with the rules off still warns that Followers on default rules may hold the
revision.

## Approve an exact version

After reviewing a held item, use the item ID and full digest from its finding.
Replace the sample digest below with the one Guard reports.

```sh
canonfig guard approve skills:demo --digest 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --note "Reviewed this version"
canonfig guard status
canonfig guard revoke skills:demo
```

Retry the held operation after approval. The approval changes that version's
static and checker blocks into warnings marked with `overriddenBy: "approval"`.
Changing any byte re-arms the block. Approving a new digest replaces the item's
previous approval. `guard status` marks an approval stale when the latest scan
saw a different digest for its item, or unseen when that scan has no observation
for the item. The file stores approvals as `{ item, digest, note? }` entries
in the optional `approvals` array.

On Source and Follower Machines, Settings > Guard has an on/off switch and a
Block, Warn or Off choice for each built-in rule, approval revocation and an
**Approve this exact version** action for items in the latest held result. On a Follower, local rules and approvals apply to offline checks
for both received and Local items before Sync. The Follower sends no candidate
text to an external checker.

## Skill Update 396M

Skill Update 396M is an optional AI model that runs on the Source or a
standalone machine. It compares each changed Markdown file in a skill update
with the installed, approved version of the same file and flags edits that
change what the skill does. It catches reworded instructions the built-in
rules miss. It only scores skill updates: a newly tracked skill, an import and
a publish have no approved version to compare against, so the built-in rules
check those alone. The [model card](https://huggingface.co/Microck/canonfig-guard-skill-update-396m)
lists its benchmarks and limits.

In Settings > Guard, select **Install**. Canonfig downloads one pinned model
revision (1.6 GB) into the user cache, outside `~/.canonfig`, verifies every
file's SHA-256 digest and prepares a Python runtime with
[uv](https://docs.astral.sh/uv/). The model needs about 2 GB of memory while it
runs. Set `CANONFIG_GUARD_MODEL_DIR` to keep it somewhere else, in every
environment that runs Canonfig. Without the GUI, run
`canonfig guard model install` and set the checker in `guard.jsonc`:

```jsonc
{
  "version": 1,
  "checker": { "kind": "skill-update", "onUnavailable": "block" }
}
```

Canonfig starts the model on loopback the first time a check needs it, from the
CLI, the skills worker or the GUI, and the model exits after 15 idle minutes.
The first check after a start waits for the model to load. File text never
leaves the machine, so this checker needs no outbound consent. `onUnavailable`
works as for other checkers: the default holds the update when the model can't
answer, and `warn` lets it through checked by the built-in rules only. Turn the
checker off before `canonfig guard model remove` or **Remove model**.
Followers can't run the model.

## Other checkers

Source and standalone operators can configure a different checker in
`guard.jsonc`. The policy holds one checker.

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

The HTTP adapter accepts a POST with the following body. For a skill update,
`item.baseline` carries the approved version of the same files.

```json
{"schema":"canonfig.guard/v1","item":{"kind":"skills","digest":"<sha256>","files":[{"path":"SKILL.md","text":"Summarize the meeting notes."}],"baseline":[{"path":"SKILL.md","text":"Summarize the notes."}]}}
```

Return `{"schema":"canonfig.guard/v1","verdict":"allow","findings":[]}`.
For `warn` or `block`, supply findings with a `code` and optional `path`
and 1-based `line`. Codes are `prompt-injection`, `credential-disclosure`,
`unsafe-execution`, `obfuscation` and `other-risk`.

The versioned [checker contract](../src/guard/checker-wire.json) defines the
request and response byte caps, the maximum findings per verdict, and the
ordered line breaks. CRLF counts as one break. An empty file has one line, and
a trailing break starts an empty last line. Skill Update 396M's own adapter,
[skill-update-checker.py](../src/guard/skill-update-checker.py), implements
the same contract.

Guard checks declared content. Disabled hooks stay in scope so enabling one
later cannot bypass the check. Its coverage excludes live MCP tool lists,
downloaded packages, runtime tool calls and direct changes to a harness.

Existing setup items can finish before Guard holds a harness import. Correct
the selected material or select fewer items, then review a new setup plan.
Archive previews and upstream skill checks use offline rules. Apply checks the
candidate again and runs the optional checker where configured.
