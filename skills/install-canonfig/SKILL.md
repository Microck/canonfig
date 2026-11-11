---
name: install-canonfig
description: Install Canonfig 7.1.7 from its scoped npm package and initialize a Source Machine or securely enroll a Linux, macOS, or Windows Follower Machine. Use for Canonfig prerequisites, package installation, first-time source setup, the ~/.canonfig/ folder and its first publication, follower invitations and pinned trust, harness takeover, native schedule setup, installation verification, or installation troubleshooting.
---

# Install Canonfig

Install the shipped package, establish exactly one machine role, and stop at any
security or human-action boundary.

## Workflow

1. Identify the operating system, machine role, user account, and whether the
   request is interactive.
2. Read exactly one platform branch:
   - Linux: [references/linux.md](references/linux.md)
   - macOS: [references/macos.md](references/macos.md)
   - Windows: [references/windows.md](references/windows.md)
3. Confirm Node.js 24 or newer and npm are available.
4. Install the exact `@microck/canonfig@7.1.7` package version. The installed
   executable remains `canonfig`. The Source and followers must run the same
   major.minor release; a mismatch fails with "source/follower version
   mismatch" (exit 2).
5. Run `canonfig --version` and bounded diagnostics. Read the `credentials`
   probe; follow its recovery text before continuing.
6. Initialize a Source Machine **or** enroll a Follower Machine. Never initialize
   both roles in the same state directory.
7. Plan before the first apply on either role, then configure the native
   schedule on followers.
8. Report the role, installed version, diagnostics, projected harnesses,
   takeover snapshots, schedule, and every unresolved Human Action Required
   record. Installation is complete only when these observations are explicit.

For guided harness selection and a reviewed import of what the harnesses
already hold, use `$setup-canonfig` instead of the direct commands below.

## Source Machine

Initialize local source authority:

```bash
canonfig source init
canonfig doctor --no-input --timeout-ms 5000
```

`source init` creates the signing key and TLS certificate and refuses to
replace an existing Source identity. It publishes nothing.

The Source authors `~/.canonfig/`: `canonfig.jsonc`, `AGENTS.md`, and
`rules/`, `skills/`, `agents/`, `commands/`, `hooks/`, `files/`. Nothing else in the
folder is published. Publication needs `version`, `harnesses`, and `profile` in
`canonfig.jsonc`; Source setup writes all three, for example:

```jsonc
{
  "version": 1,
  "profile": { "id": "workstation", "name": "Workstation" },
  "harnesses": ["claude-code", "codex"]
}
```

The [folder reference](https://canonfig.micr.dev/docs/reference/canonfig-folder/)
lists every key and file. `canonfig source scan` reads the folder and proposes
`tools` entries; `--write` adds the accepted ones.

Project the folder into this machine's harnesses, then publish after the
operator reviews the plan:

```bash
canonfig sync --plan
canonfig sync --apply
canonfig source publish --reviewer operator
canonfig profile list
```

Before its first write to a harness, `sync --apply` copies what it replaces to
a takeover snapshot in `~/.canonfig/.backups/`; `canonfig restore` writes it
back. `--no-backup` skips the snapshot and needs explicit approval.

Keep the loopback-only server running as a native user service, then create a
short-lived, single-use invitation:

```bash
canonfig source service install
canonfig source service status
canonfig source invite --endpoint https://127.0.0.1:17342 --output ./canonfig-invite --expires 15m --group developers
```

`canonfig source serve --host 127.0.0.1 --port 17342` runs the same server in
the foreground instead. Treat the mode-`0600` envelope as temporary sensitive
material. For a remote follower, transfer it over an authenticated private
channel together with the Source's SSH host public key, read on the Source
itself.

## Follower Machine

On a follower, `~/.canonfig/` holds the Source's mirror. Enrollment refuses a
folder whose authoring entries already hold content and names them; move what
the machine should keep into `~/.canonfig/local/` or remove it, with approval,
then enroll again.

When the Source is another host, start the managed tunnel after the Source is
serving:

```bash
canonfig tunnel start --invitation ./canonfig-invite --ssh-host source.example --ssh-user operator --ssh-host-key-file ./source-host-key.pub
```

The tunnel records its configuration, so later restarts need only
`canonfig tunnel start`. Pipe the bounded envelope into enrollment:

```bash
cat ./canonfig-invite | canonfig follower enroll --stdin --name laptop
canonfig sync --plan
```

Enrollment pins the source TLS and signing fingerprints and issues an
independently revocable follower credential in the native store.
Refuse an expired, replayed, exposed, or fingerprint-mismatched invitation.
Request a new invitation from the Source Machine;
never reset trust or suppress verification.
Enrolling again under the same name with a new invitation rotates the
credential and keeps local settings. `--replace` enrolls a new identity,
revokes the old one, and resets agent policy, harness and secret bindings, and
schedule choice; get explicit approval first.

The plan lists the mirror items, every harness surface it takes over with
`takeover snapshot` or `no backup`, and harnesses the Source lists that are not
installed here. `canonfig harnesses exclude <harness>` keeps one out on this
machine. Apply interactively only after the plan matches the intended targets:

```bash
canonfig sync --apply
canonfig status
canonfig harnesses
```

`Converged` means the files are in place and verified, not that each client
accepted them. Tell the operator to restart Claude Code and review `/hooks` if
it reports hooks changed outside the app, to trust project folders in Claude
Code and Codex, and to trust Codex hooks from `~/.codex/hooks.json` in
`/hooks`. For Antigravity MCP configuration, start `agy` in the project and
invoke a managed MCP tool to confirm it loaded. `clientLoaded` stays
`not-verified`.

Configure and inspect the native schedule once the operator picks a time:

```bash
canonfig schedule set daily@09:00
canonfig schedule status
```

The schedule invokes `canonfig sync --apply --no-input --scheduled`. The
Source's `scheduleDefault` is never installed automatically;
`canonfig schedule set --default` accepts it.

## Safety boundary

- Keep source signing material, follower credentials, invitation payloads, and
  the SQLite state database out of repositories, logs, screenshots, and chat.
- Store credentials through Secret Service, Keychain, or Credential Manager.
  If secure noninteractive storage is unavailable, preserve the Human Action
  Required outcome and present its exact instructions.
- Keep secrets out of command arguments, folder content, recipes, and
  environment examples. MCP secrets are `{ "fromEnv": "NAME" }` references.
- Preserve certificate pins, action journals, takeover snapshots,
  `~/.canonfig/local/`, follower-modified files, and existing state while
  troubleshooting.
- Use user-level installation and schedulers. Treat elevation, login, restart,
  reboot, and enabling linger as explicit human decisions.

## Troubleshooting

Run:

```bash
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig status --json
canonfig harnesses
```

`doctor` runs eight probes: `runtime`, `state`, `credentials`, `source`,
`scheduler`, `package-managers`, `agent-adapter`, and `harnesses` (listed
harnesses that are not installed, pinned roots, snapshots).

Interpret exit code `2` as usage, configuration, or version mismatch, `3` as
Human Action Required (including a locked or unavailable local credential
store, or a harness root that differs from the one pinned at takeover), `4` as
conflict or Follower Drift, `5` as authentication or revocation, `6` as
transport (including a down managed tunnel), and `7` as verification or apply
failure. Preserve evidence and resolve the reported cause instead of deleting
state. `canonfig follower unenroll` removes an enrollment on purpose; it is not
a repair step.
