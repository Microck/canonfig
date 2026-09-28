# Follower operations

## Select and inspect

Enrollment with `--profile` already selects a profile. Select another published
Machine Profile only when the operator asks to switch:

```bash
canonfig profile select workstation
canonfig status
```

Selection changes the profile requested by this follower. It does not edit or
publish a profile.

## Plan and apply

Plan without mutating targets:

```bash
canonfig sync --plan
```

Review the revision, downloaded and reused blobs, resource targets, dependency
order, no-ops, deterministic actions, retained config keys, Agent Tasks, human
actions, conflicts, verification methods, and any "schedule available" line.

Apply only after review:

```bash
canonfig sync --apply
canonfig status --json
```

Use `--no-input` only for a scheduler or another caller that cannot prompt.
Content transfer is not applied state; only independent verification establishes
`Converged`.

One run is one transaction for filesystem and config changes: if a
deterministic action fails, every file, directory, and config the run already
changed is restored, including resources that do not depend on the failed one,
and the run ends `Failed` (exit 7). Tool installs are not rolled back, and a
Human Action Required resource does not roll back the rest.

## Client trust after apply

`Converged` means the files are in place and verified, not that a client
accepted them. Canonfig never copies trust decisions between machines. After
apply, tell the operator to:

- restart Claude Code, open `/hooks` and review hooks when it reports hooks
  changed outside the app, and trust each project folder when asked;
- in Codex, trust each project directory, and open `/hooks` to trust hooks from
  `~/.codex/hooks.json`, which stay in a review state until trusted;
- in Gemini CLI, trust the folder first: it hides user-level MCP servers in
  untrusted folders.

`clientLoaded` stays `not-verified` unless the profile declares a verification
that proves the client loaded the resource. Report it as not verified.

## Diagnose outcomes

Run bounded probes:

```bash
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig schedule status
canonfig agent policy
canonfig agent harness
```

`status` reports only this follower. The Source has no fleet view, so each
follower's own `canonfig status` is its completion evidence.

### Human Action Required

Present the recorded reason, exact instructions, and affected resource. Typical
causes are login, a locked or unavailable local credential store (the message
names the store and the command to run), a follower config file that does not
parse (file, line, and column are named; only that resource blocks), denied
capability, ambiguous deterministic work, elevation, restart, or reboot.
Complete the human step, then re-plan:

```bash
canonfig doctor --no-input
canonfig sync --plan
```

Keep tokens off the command line and keep trust verification active.

### Follower Drift

Drift covers skills (`replace-if-unmodified`) and the Source section of
`append-local` files. A `replace` file is Source-owned: a local edit is replaced
by the next apply. For a drifted resource Canonfig compares desired, observed,
and last-applied digests, keeps the follower copy, and exits 4. When a
follower-modified skill or section drifts, preserve it and report the conflict
(resource, target, and the digests) instead of forcing convergence. The
operator chooses one of:

- keep the Source version: move the local copy aside, then `canonfig sync --apply`;
- keep the local change for everyone: copy it to the Source and publish a new
  revision there;
- keep a local `config` key on this follower only: claim it with a Local Overlay
  (`canonfig overlay set <resource-id> --target <path> --key <config.path>`).

Files and skills cannot move into a Local Overlay.
Unattended agents do not make this choice.

## Recover interruption

Inspect before recovery:

```bash
canonfig status
canonfig recover
```

For noninteractive recovery:

```bash
canonfig recover --no-input --json
```

Recovery resumes the recorded plan from the journal and rollback snapshots. It
does not accept a run ID, switch revisions, guarantee rollback of third-party
installers, or invent work when no recoverable run exists. It stops with exit 3
and changes nothing when a target was edited after the interruption. While
another Canonfig process holds the run lock, `sync --apply`, `recover`, and
`abandon` stop with exit 4 and name its PID.

If recovery fails, preserve SQLite state and the action journal, resolve the
reported cause, and retry while the original revision remains available. When
Canonfig reports the run cannot be recovered, close it without rollback, then
apply again:

```bash
canonfig abandon
canonfig sync --apply
```

## Rotate, replace, or unenroll

- Same name with a new invitation: rotates the credential and keeps agent
  policy, harness bindings, schedule choice, and overlays.
- `canonfig follower enroll --stdin --name <new> --profile <id> --replace`:
  enrolls a new identity, revokes the old one, and lists in `resets` what it
  reset (agent policy, harness and secret bindings, schedule choice, overlays).
  Requires explicit approval.
- `canonfig follower unenroll`: revokes this identity on the Source and deletes
  the local enrollment (pins, selected profile), credential, and received
  shared secrets. Applied files and the native schedule stay; run
  `canonfig schedule remove` separately if wanted. When the reply says the
  Source was unreachable, run `canonfig source revoke <id>` on the Source. A
  locked credential store exits 3 and keeps the record for a retry.
