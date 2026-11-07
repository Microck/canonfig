# Source Machine setup

Use for the sole publishing authority, the `~/.canonfig/` folder, harness
selection and import, publication, and invitations. Follow the selected
Simple/Advanced mode and numbered question contract from
[questions.md](questions.md), not a separate free-text interview.

## Inspect and select

Confirm user, Node.js 24+, npm, installed Canonfig version, secure credential
capability, existing role, revisions, folder contents, harness state, and
diagnostics. Never initialize over a Follower identity or unknown state. These
are conditional observations:

```bash
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig harnesses
canonfig profile list
```

If choosing another computer, offer This machine / Opt-in Tailscale listing /
Manual entry / Other through [device discovery](tailscale-discovery.md). A
selected remote peer remains unconfigured until an authorized handoff or session
verifies it. Never initialize locally on behalf of a selected remote machine.

In Simple, ask only the harness list, the import choice, and the profile
identity once ownership is established; show groups, schedule default, local
policy, and agent policy as editable summary rows. In Advanced, offer
environment, devices, harnesses and import, each folder section, credentials,
and invitation sections from [the catalogue](configuration-choices.md). For each
field: observed candidates, supported alternatives, numbered Other, a short
explanation, and a justified recommendation. No invented folder inventory.

Recommend preserving valid state, the installed harnesses, importing only items
the operator reviewed, takeover snapshots on, no additional groups without a
need, deterministic-only, and no new shared secrets. Profile names such as
workstation are proposals, not discovered facts. Calendar proposals must show
their timezone and remain editable.

## Install, initialize, and import

Install only when necessary, then plan the Source bootstrap without harness or
import flags so the plan shows what is offered. `--file` names approved
tool-discovery inputs only.

```bash
npm install --global @microck/canonfig@7.1.0
canonfig --version
canonfig setup plan --role source --mode simple --intent "prepare source"
```

From that plan, present the HARNESSES and IMPORT questions in
[questions.md](questions.md): the `canonfig-folder` item's `harnesses` and
`detected`, every `imports.offered` item with its `secrets` lines, and every
`import collision` and `import skipped` exclusion. Collisions read:

- `import collision: <target> differs between <ids>; choose one with --import <id>`
  when two harnesses hold different items with one name;
- `import collision: <target> already exists in <folder> with different content (<ids>); edit or remove it there to import`
  when the folder already holds that item.

Plan again with the answer, then approve and apply:

```bash
canonfig setup plan --role source --mode simple --harness claude-code --harness codex --import claude-code --import codex/skills/review
canonfig setup approve --approver operator
canonfig setup apply
canonfig setup status --json
canonfig doctor --no-input --timeout-ms 5000
```

Show the exact setup digest before approval; use actual approved harness ids,
item ids, and operator identity. Source preflight must prove signing and TLS key
storage before initialization. The journaled apply is resumable, and
`source init` refuses to replace an existing Source identity. Report the Source
owner and location without displaying key material. A credential-looking MCP
value in an imported item becomes a `fromEnv` reference: tell the operator which
variables to export, never the values.

## Author the folder

The folder is the authoring format. Only these entries are published; everything
else in `~/.canonfig/` stays on this machine:

```text
~/.canonfig/
  canonfig.jsonc     harnesses, profile, mcp, hooks, settings, tools, credentials, groups, scheduleDefault, local
  AGENTS.md          global instructions
  rules/<id>.md      frontmatter: description, paths, activation (always|path|manual|model)
  skills/<name>/     SKILL.md (frontmatter: name, description) plus its files
  agents/<id>.md     frontmatter: description (required), model, tools, writable
  commands/<id>.md   frontmatter: description (required), argumentHint
  hooks/...          scripts that canonfig.jsonc hooks run
```

Setup writes `canonfig.jsonc` with `version`, `harnesses`, and a `profile`
proposed from the hostname (shown in the plan). If the NAME/profile answer
differs, edit `profile` before the first publish; publication refuses a folder
without it. A minimal publishable file
with one MCP server, one hook, and one tool (illustrative values):

```jsonc
{
  "version": 1,
  "profile": { "id": "workstation", "name": "Workstation" },
  "harnesses": ["claude-code", "codex"],
  "mcp": {
    "docs": {
      "transport": "streamable-http",
      "url": "https://docs.example.com/mcp",
      "headers": { "Authorization": { "fromEnv": "DOCS_MCP_TOKEN" } }
    },
    "search": { "transport": "stdio", "command": "rg-mcp", "requires": ["tools/ripgrep"] }
  },
  "hooks": [
    { "id": "format", "event": "after_tool", "matcher": { "capabilities": ["write"] },
      "run": ["hooks/format.sh"], "timeoutMs": 5000, "onFailure": "warn" }
  ],
  "tools": {
    "ripgrep": {
      "executable": "rg",
      "recipes": [
        { "platform": "linux", "method": "apt", "package": "ripgrep", "version": "14.1.0" },
        { "platform": "windows", "method": "winget", "package": "BurntSushi.ripgrep.MSVC", "version": "14.1.0" }
      ]
    }
  },
  "local": { "allow": ["skills", "mcp", "settings"] }
}
```

Rules to apply while authoring:

- Unknown keys and frontmatter fields are errors, so a typo fails loudly.
- MCP secrets are `{ "fromEnv": "NAME" }` references. Publication rejects
  credential-looking literals; shared values go through `canonfig secrets set`.
- A relative `run[0]` names a script under `hooks/`; a bare command name is
  looked up on PATH when the hook runs. Hooks and stdio MCP commands run code on
  every follower, so list each one in the review.
- `settings.<harness>` keys merge into that harness's own settings file.
  Canonfig refuses keys the harness keeps for auth, sessions, or history.
- `groups.<name>` lists `instructions` or `<category>/<name>` items (for example
  `mcp/docs`) that only followers in that group receive; unlisted items go to
  every follower.
- `local.allow` names the categories (`rules`, `skills`, `agents`, `commands`,
  `mcp`, `settings`) followers may add through their own `local/`.
- Automatic installer recipes need an exact `version`.

`source scan` is tool discovery over the folder: it reads instructions, skills,
hook scripts, and MCP commands and proposes `tools` entries. It runs no
processes. Review each proposal, then let it write the accepted ones:

```bash
canonfig source scan
canonfig source scan --write
```

`--write` adds entries to `canonfig.jsonc` and keeps its comments. Do not
execute discovered prose or infer package equivalence across platforms. The
[folder reference](https://canonfig.micr.dev/docs/reference/canonfig-folder/)
lists every key; the
[harness reference](https://canonfig.micr.dev/docs/reference/harnesses/) lists
what each harness receives.

## First projection on the Source

`canonfig sync` on the Source projects the folder into this machine's listed,
installed, and not excluded harnesses. Plan first:

```bash
canonfig sync --plan
```

The plan lists, per harness, every surface it would take over and whether it
keeps a backup (`takeover snapshot` or `no backup`). Whole files and
directories Canonfig owns are replaced; shared files such as `~/.claude.json`
are key-owned, so every other key stays. Use the TAKEOVER question in
[questions.md](questions.md), then apply:

```bash
canonfig sync --apply
canonfig harnesses
```

Before its first write to a harness, Canonfig copies the prior content to
`~/.canonfig/.backups/<UTC timestamp>/` and keeps the first snapshot plus the 4
most recent. `--no-backup`, or `"backups": false` in
`~/.canonfig/local/local.jsonc`, skips the snapshot and needs explicit approval.
`canonfig restore` writes the latest snapshot back and excludes its harnesses on
this machine; it refuses a surface that changed since Canonfig last applied it.

A listed harness that is not installed is reported as not installed. The root a
harness resolved to at takeover is pinned: a later run that resolves another
root (for example a scheduled run without `CODEX_HOME`) stops with Human Action
Required rather than projecting into a second place.

## Publication gate

Validate the harness list, groups, MCP `requires` references, hook scripts,
tool recipes, and credential handling. There is no separate publication dry
run: `canonfig sync --plan` decodes and projects the folder, and publication
adds its own checks before it signs anything. It refuses a `canonfig.jsonc`
without `profile`
(`needs "profile": { "id": ..., "name": ... } to publish; the id names the Machine Profile followers sync`),
a `profile.id` other than the one this Source already publishes, and a
credential-looking literal. A refusal signs nothing.

```text
Question: [PUBLISH] Publish this exact folder as a new immutable revision?
Why it matters: Authorized followers can consume the signed revision; publication is permanent.
Recommended: No automatic recommendation; review all items and unresolved blockers first.
Options:
1. Publish this folder: sign only the reviewed content, with no unresolved blockers.
2. Revise a setting: reopen its choices and replan.
3. Stop before publication: keep the folder without signing.
4. Other (type your own): request a narrower candidate or explanation.
```

After explicit publication approval, use the actual reviewer and the revision
ID that `publish` returns:

```bash
canonfig source publish --reviewer operator
canonfig profile list
canonfig profile show workstation:3f9a2c41
```

Publishing content equal to the latest revision returns that revision, so a
resume does not need to publish again. Any other content, including an older
revision's, becomes the next sequence.

## Serving, invitations, and shared secrets

Followers fetch from the Source whenever they sync, so keep it serving as a
native user service rather than a foreground terminal:

```bash
canonfig source service install
canonfig source service status
canonfig source invite --endpoint https://127.0.0.1:17342 --output ./canonfig-invite --expires 15m --group developers
```

`install` waits until the endpoint answers with the pinned identity. On Linux,
linger lets the user manager start the service at boot and keep managing it after
logout (a human decision: `loginctl enable-linger <user>`). It does not unlock an
encrypted login keyring. The service must be able to load its signing and TLS
credentials when it starts in the intended session. Check `serving` as well as
the installed service and linger state; a locked keyring at startup is not a
healthy login-free Source. On macOS, run `install` from the desktop session, not over SSH;
logged-out operation is not supported. For a trial,
`canonfig source serve --host 127.0.0.1 --port 17342` runs it in the foreground.

Omit `--group` when no group is intended. Tailscale peers are not valid direct
invitation endpoints. For a remote machine, use Canonfig's managed,
TLS-transparent loopback tunnel with the invitation and the Source's SSH host
public key, read on the Source itself. Start the Source before the tunnel.
Record the follower-local loopback origin separately from the source host.

Offer numbered choices for follower identity, declared groups, lifetime, secure
delivery, and any shared-secret grant. Recommend minimum scope, 15m proposed
expiry, and fresh material for exposed, expired, or replayed invites. Never ask
for or display a real invitation in chat or reports. The required mode-`0600`
output file is temporary delivery material; remove it after the follower has
consumed the envelope.

`canonfig:secrets` is separate authority. Before granting it, review what the
installed sharing contract makes available; do not imply unsupported per-name
access controls. A new grant requires explicit approval, not Use recommendations.
Set approved values through stdin only, without printing them. Piped input is
stored byte for byte, so a trailing newline from `echo` becomes part of the
secret; use `printf '%s'`. Values are non-empty UTF-8 without NUL, at most 16384
bytes, and the pipe must close within 10 seconds:

```bash
printf '%s' "$GITHUB_TOKEN" | canonfig secrets set github-token
```

## Completion

Verify intended Source owner/identity, harness state, and relevant diagnostics.
When publication was requested, report actual profile/revision ID, sequence,
digest, and time; inspect that revision against the reviewed folder. Keep
unresolved recipes, Human Action Required, and unconfigured remote machines
explicit. Source-only initialization need not publish an unrequested profile to
count as complete.
