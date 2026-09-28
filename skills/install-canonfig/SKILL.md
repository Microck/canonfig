---
name: install-canonfig
description: Install Canonfig 4.0.0 from its scoped npm package and initialize a Source Machine or securely enroll a Linux, macOS, or Windows Follower Machine. Use for Canonfig prerequisites, package installation, first-time source setup, profile authoring and publication, follower invitations and pinned trust, native schedule setup, installation verification, or installation troubleshooting.
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
4. Install the exact `@microck/canonfig@4.0.0` package version in a new
   installation. The installed executable remains `canonfig`. Do not install
   over a 3.2.x installation: an in-place upgrade is unsupported and unverified.
   Preserve its state and use the [fresh-install guide](../../website/content/docs/how-to/upgrade.mdx).
   The new Source and followers must run the same major.minor release; 4.0.0
   refuses 3.2.x peers with "source/follower version mismatch" (exit 2).
5. Run `canonfig --version` and bounded diagnostics. Read the `credentials`
   probe; follow its recovery text before continuing.
6. Initialize a Source Machine **or** enroll a Follower Machine. Never initialize
   both roles in the same state directory.
7. On a follower, plan before the first apply, then configure the native
   schedule.
8. Report the role, installed version, diagnostics, selected profile, schedule,
   and every unresolved Human Action Required record. Installation is complete
   only when these observations are explicit.

## Source Machine

Initialize local source authority:

```bash
canonfig source init
canonfig doctor --no-input --timeout-ms 5000
```

`source init` creates the signing key and TLS certificate and refuses to
replace an existing Source identity. It publishes nothing.

Synced content comes from an authored JSONC profile file, for example
`~/canonfig.profile.jsonc`, that lists `file`, `config`, and `skill` resources.
Each `source` path is relative to the profile file's directory and must
resolve inside it. Write `"verify": { "method": "digest" }` without a digest
so publication computes it. `canonfig source scan --file <path>` is tool
discovery only: it proposes `tool` resources and never file, config, or skill
resources. The
[tutorial](https://github.com/Microck/canonfig/blob/main/website/content/docs/tutorials/first-sync.mdx)
has a complete profile.

Check, then publish only after the operator reviews the profile:

```bash
canonfig source digest --profile-file ~/canonfig.profile.jsonc
canonfig source publish --profile-file ~/canonfig.profile.jsonc --reviewer operator
canonfig profile list
```

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

When the Source is another host, start the managed tunnel after the Source is
serving:

```bash
canonfig tunnel start --invitation ./canonfig-invite --ssh-host source.example --ssh-user operator --ssh-host-key-file ./source-host-key.pub
```

The tunnel records its configuration, so later restarts need only
`canonfig tunnel start`. Pipe the bounded envelope into enrollment; `--profile`
selects the profile:

```bash
cat ./canonfig-invite | canonfig follower enroll --stdin --name laptop --profile workstation
canonfig sync --plan
```

Enrollment pins the source TLS and signing fingerprints and issues an
independently revocable follower credential in the native store.
Refuse an expired, replayed, exposed, or fingerprint-mismatched invitation.
Request a new invitation from the Source Machine;
never reset trust or suppress verification.
Enrolling again under the same name with a new invitation rotates the
credential and keeps local settings. `--replace` enrolls a new identity,
revokes the old one, and resets agent policy, harness bindings, schedule
choice, and overlays; get explicit approval first.

Apply interactively only after the plan matches the intended targets:

```bash
canonfig sync --apply
canonfig status
```

`Converged` means the files are in place and verified, not that each client
accepted them. Tell the operator to restart Claude Code and review `/hooks` if
it reports hooks changed outside the app, to trust project folders in Claude
Code and Codex, and to trust Codex hooks from `~/.codex/hooks.json` in
`/hooks`. For Antigravity MCP configuration, start `agy` in the project and
invoke a managed MCP tool to confirm it loaded. `clientLoaded` stays
`not-verified` until a declared verification proves otherwise.

Configure and inspect the native schedule once the operator picks a time:

```bash
canonfig schedule set daily@09:00
canonfig schedule status
```

The schedule invokes `canonfig sync --apply --no-input --scheduled`. A profile
`scheduleDefault` is never installed automatically;
`canonfig schedule set --default` accepts it.

## Safety boundary

- Keep source signing material, follower credentials, invitation payloads, and
  the SQLite state database out of repositories, logs, screenshots, and chat.
- Store credentials through Secret Service, Keychain, or Credential Manager.
  If secure noninteractive storage is unavailable, preserve the Human Action
  Required outcome and present its exact instructions.
- Keep secrets out of command arguments, profile content, recipes, and
  environment examples.
- Preserve certificate pins, action journals, follower-modified skills, and
  existing state while troubleshooting.
- Use user-level installation and schedulers. Treat elevation, login, restart,
  reboot, and enabling linger as explicit human decisions.

## Troubleshooting

Run:

```bash
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig status --json
```

Interpret exit code `2` as usage, configuration, or version mismatch, `3` as
Human Action Required (including a locked or unavailable local credential
store), `4` as conflict or Follower Drift, `5` as authentication or revocation,
`6` as transport (including a down managed tunnel), and `7` as verification or
apply failure. Preserve evidence and resolve the reported cause instead of
deleting state. `canonfig follower unenroll` removes an enrollment on purpose;
it is not a repair step.
