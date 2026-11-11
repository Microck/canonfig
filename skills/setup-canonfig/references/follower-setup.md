# Follower Machine setup

Use for enrollment, convergence, harness choice, `local/` items, scheduling, or
recovery. Keep the selected mode and use [numbered choices](questions.md) for
every unresolved field and approval.

## Inspect first

For a sandboxed agent, first follow
[setup-agent execution permissions](completion.md#setup-agent-execution-permissions).
Inspect the actual follower's native user context, not a sandbox substitute.

Observe the current user, platform, runtime, installed version, secure credential
provider, native scheduler, role, pins, last run, drift, installed harnesses, and
what `~/.canonfig/` already holds:

```bash
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig status --json
canonfig harnesses
canonfig schedule status
```

Preserve SQLite state, credentials, pins, cache, journals, Applied Resource
Records, takeover snapshots, `~/.canonfig/local/`, and follower-modified files.
An unreachable source does not justify reenrollment or pin replacement.

## Mode-aware choices

In Simple, fill the established name from evidence and ask only missing
identity, Source connection, and local invitation-input decisions. Show harness
exclusions, schedule, and agent defaults in the editable summary. In Advanced,
offer every relevant field from [the catalogue](configuration-choices.md),
including harness exclusions, `local/` items, takeover snapshots, agent bounds,
credential handling, schedule calendar/timezone/executable, and recovery. Both
modes keep numbered options, explanations, recommendations, and Other.

A Source publishes one Machine Profile and the follower follows it; there is no
profile to choose. Selecting groups is a Source authority decision, not a
follower self-service menu. The Source's `harnesses` list decides what is
projected; the follower only excludes harnesses for itself.

For machine choices, offer optional [Tailscale discovery](tailscale-discovery.md)
or manual entry. This supplies candidates, not authorization or connectivity.
Keep offline selections pending. Do not enroll the current machine when the
operator selected another one; use a separately authorized session or handoff.

Do not ask for the invitation payload in chat. Use the INVITE_INPUT menu: local
terminal variable / protected temporary file / not ready / Other. Read privately
without echo/history, use it locally, then clear/remove the temporary input.
Never put literal tokens in an agent tool call or create an unsupported file flag.

## Prepare the folder

On a follower, the authoring entries of `~/.canonfig/` (`canonfig.jsonc`,
`AGENTS.md`, `rules/`, `skills/`, `agents/`, `commands/`, `hooks/`) hold the
Source's mirror. Enrollment refuses a folder where any of them holds content:

```text
<folder> already holds authored items (<entries>), where a follower keeps its Source's mirror; move what this machine should keep into <folder>/local (rules, skills, agents and commands as files, MCP servers and settings in local.jsonc) or remove them, then enroll again
```

Show the listed entries and offer: move to `local/` / remove / stop / Other.
Moving or removing files is a mutation that needs approval. Empty directories
do not count.

A machine is a Source or a follower, never both. On a Source, `follower enroll`
exits 2 before the invitation is used (`setup plan --role follower` exits 2
with "be set up as a Follower" in place of "enroll as a Follower"):

> this machine is a Source (signing key `<fingerprint>`), so it cannot enroll as a Follower: a machine is either a Source or a Follower, never both. No command removes the Source role: run 'canonfig source service remove' if the Source service is installed, move `<folder>` aside (it keeps the authored folder, the Source identity and the run journal), then try again

Offer: enroll a different machine / retire this Source as the message says /
stop / Other. Retiring a Source strands its followers and needs approval.

## Install and enroll

Use an approved user-level install only when needed.

```bash
npm install --global @microck/canonfig@7.1.7
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

Create and review the follower bootstrap plan before enrollment:

```bash
canonfig setup plan --role follower --intent "prepare follower"
canonfig setup approve --approver operator
canonfig setup apply
canonfig setup status --json
```

Use the actual operator identity and add only explicitly approved discovery
files. `--harness` and the import flags apply only to a full Source plan. The
setup journal records optional integration exclusions separately, so an
unavailable optional recipe does not block independent follower preparation.
Resume the unchanged journal instead of repeating discovery or approval.

Required secure noninteractive storage uses Secret Service, Keychain, or Credential
Manager. Do not silently downgrade to a plaintext policy. Missing required storage
remains Human Action Required (exit 3), and the message names the store and the
command to run:

- Linux over SSH or in a background session: Secret Service is reached through
  `DBUS_SESSION_BUS_ADDRESS` or `$XDG_RUNTIME_DIR/bus`; set
  `XDG_RUNTIME_DIR=/run/user/$(id -u)` when it is unset. `dbus-run-session` is
  not a remedy. Without a user manager, lingering starts one (human decision).
- macOS over SSH: the login Keychain starts locked;
  `security unlock-keychain ~/Library/Keychains/login.keychain-db`, typed by the
  operator, unlocks it for that SSH session only, never for scheduled runs.

The source is an exact loopback HTTPS origin. A Tailscale IP/MagicDNS name is not
that endpoint. For a remote Source, start Canonfig's managed tunnel after the
Source is serving, with the Source's SSH host public key read on the Source:

```bash
canonfig tunnel start --invitation ./canonfig-invite --ssh-host source.example --ssh-user operator --ssh-host-key-file ./source-host-key.pub
```

The tunnel pins the SSH host key, TLS certificate, and signing key separately
and records itself, so `canonfig tunnel start` alone restarts it later without
the invitation. Preserve TLS/signing pins.

With the locally supplied invitation file and the explicitly selected name:

```bash
cat ./canonfig-invite | canonfig follower enroll --stdin --name laptop
```

The invitation is a single-use secret: never place it in an argument (process
listings and shell history expose arguments to other local users), never print
it, and clear the variable or remove its protected temporary file immediately
afterward, on PowerShell as well as POSIX shells. Enrollment must establish
independently revocable credentials, pinned TLS/signing fingerprints, and an
authorized profile revision. Refuse invalid/exposed/expired/replayed material
and request a fresh invitation; never reset trust or suppress verification.

An already enrolled machine is re-enrolled only on request. The same name with a
new invitation rotates the credential and keeps local settings. `--replace`
creates a new identity, revokes the old one, and resets agent policy, harness
and secret bindings, and schedule choice; it needs explicit approval.
`~/.canonfig/local/` is untouched by either.

Inspect granted groups without printing the invitation. If `canonfig:secrets` is
present, explain the automatic transfer on successful apply and obtain explicit
sharing consent before first apply in either mode. Discovery or mode selection
does not grant this authority.

## Harnesses and local items

Before the first apply, show `canonfig harnesses`: each harness with installed,
listed, excluded, pinned root, and latest snapshot. The follower projects the
harnesses the Source lists that are installed here and not excluded here. A
listed harness that is not installed is reported as not installed and never
blocks the run. To keep one harness out on this machine only:

```bash
canonfig harnesses exclude cursor
canonfig harnesses include cursor
```

Both edit only `excludeHarnesses` in `~/.canonfig/local/local.jsonc`.

Machine-local additions live in `~/.canonfig/local/`: `rules/`, `skills/`,
`agents/`, `commands/` as files, and `mcp` and `settings` in `local.jsonc`.
They are never published and never replaced. Only categories the Source admits
in `local.allow` are projected; others are reported as
`<path> is not admitted by canonfig.jsonc local.allow and was not projected`.
A local item named like a published one stops the run with Human Action Required
(`local <kind> <name> has the same name as a published one; rename or remove one of them`).

## First plan and apply

```bash
canonfig sync --plan
```

Show the actual revision, the mirror items written into `~/.canonfig/`, every
harness surface it takes over with `takeover snapshot` or `no backup`, tools
and recipes, login requirements, agent tasks/bounds, conflicts, and independent
verification. Whole files and directories Canonfig owns in a harness are
replaced, with the prior content kept in the snapshot; shared files are
key-owned. Collapse no-ops by default; keep every blocker visible in both modes.

```text
Question: [APPLY] Apply this exact synchronization plan?
Why it matters: Harness surfaces are taken over; external installers are not fully reversible.
Recommended: No automatic recommendation; first review the revision and every takeover.
Options:
1. Apply reviewed changes: execute this stage with independent verification.
2. Keep plan only: make no target changes.
3. Revise configuration: reopen affected numbered settings before replanning.
4. Other (type your own): narrow the stage or ask about its consequences.
```

After approval:

```bash
canonfig sync --apply
canonfig status --json
```

`--no-backup` is a separate approval, never a default. A downloaded blob is not
Convergence. Inspect the actual recorded outcome and fresh evidence; exit zero
alone is not enough. An approved shared-secret transfer must be checked
separately and reported using names/references only.

After apply, give the client trust steps; Canonfig never copies trust between
machines. Restart Claude Code and review `/hooks` if it reports hooks changed
outside the app; trust project folders in Claude Code and Codex; open `/hooks` in
Codex to trust hooks from `~/.codex/hooks.json`; for Antigravity MCP config,
start `agy` in the project and invoke a managed tool to check the server.
`clientLoaded` stays `not-verified`; report it that way.

## Schedule last, only when selected

Offer Keep existing/manual / verified profile default / proposed daily or weekly
calendar / Other. Timezone and executable path remain editable, separately in
Advanced. Do not invent local working hours. Manual operation is a valid choice,
not permission to delete an existing schedule. Sync never installs the Source's
`scheduleDefault`; it reports "schedule available" until the operator accepts it.

After first convergence and explicit scheduling selection, use the chosen values
rather than copying this illustrative calendar:

```bash
canonfig schedule set daily@09:00 --timezone Europe/Madrid
canonfig schedule set --default
canonfig schedule status
```

Use `--default` only for the profile default choice; it takes no calendar,
timezone, or executable. `schedule set` prints the resolved zone and next run,
runs nothing immediately, and warns when the time falls into a daylight-saving
gap in the next 12 months; recommend a time outside the change window. Native
jobs execute:

```text
canonfig sync --apply --no-input --scheduled
```

Verify the systemd user timer, launchd user agent, or per-user Task Scheduler
under the same user, with executable, noninteractive secure storage, source,
tunnel when needed, and visible failures. A scheduled run that resolves a
harness root other than the one pinned at takeover (for example without
`CODEX_HOME`) stops with Human Action Required. Linux jobs run while logged out
only with lingering; macOS jobs need the logged-in desktop session; Windows
jobs run while the user is logged on. A job disabled or deleted outside
Canonfig is respected and reported as "automation disabled outside Canonfig",
never recreated. Disabled/drifted/overridden or unavailable jobs cannot count
as verified automatic operation.

## Resume, recovery, and drift

Preserve answers/mode; re-observe rather than restarting. Recover only when a
persisted interrupted run exists and the recovery stage is approved:

```bash
canonfig status
canonfig recover --no-input --json
```

Recovery uses the journal, not a new revision or invented rollback of installers.
When Canonfig reports the run cannot be recovered, `canonfig abandon` closes it
without rollback (approval required), then `canonfig sync --apply` reconciles.
For Human Action Required show resource, reason, and exact non-secret instruction.

A mirror file edited on this machine is Follower Drift: kept, reported, and the
projections built from it hold at their last applied state. A projected harness
file edited after Canonfig applied it is drift too: kept and reported. Offer
numbered Keep the local edit (copy it into `local/` under another name when
`local.allow` admits that category, then restore the mirror copy) / Restore the
Source content (move the edited copy aside, then sync) / Ask the Source
operator to publish the change / Other. Replan after resolution; never force
ownership to escape an error.

To hand a harness back, `canonfig restore` writes the latest takeover snapshot
back and excludes its harnesses here; `canonfig restore <snapshot>` picks an
older one. It refuses a surface that changed since Canonfig last applied it.

## Completion

Report actual identity/name, profile/revision, groups, pins, projected and
excluded harnesses, takeover snapshots, verified convergence, authorized secret
outcome, client trust steps given, and requested scheduler state. Plan-only work
is complete only as a plan-only request, never as a configured follower. The
Source has no fleet view: report selected remote devices separately until each
has its own `canonfig status` evidence.
