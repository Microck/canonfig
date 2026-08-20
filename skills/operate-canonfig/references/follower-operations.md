# Follower operations

## Select and inspect

Select a published Machine Profile:

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
order, no-ops, deterministic actions, Agent Tasks, human actions, conflicts,
and verification methods.

Apply only after review:

```bash
canonfig sync --apply
canonfig status --json
```

Use `--no-input` only for a scheduler or another caller that cannot prompt.
Content transfer is not applied state; only independent verification establishes
`Converged`.

## Diagnose outcomes

Run bounded probes:

```bash
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig schedule status
canonfig agent policy
canonfig agent harness
```

### Human Action Required

Present the recorded reason, exact instructions, and affected resource. Typical
causes are login, unavailable secure storage, denied capability, ambiguous
deterministic work, elevation, restart, or reboot. Complete the human step, then
re-plan:

```bash
canonfig doctor --no-input
canonfig sync --plan
```

Keep tokens off the command line and keep trust verification active.

### Follower Drift

For a managed skill, Canonfig compares desired, observed, and last-applied
digests. When the follower copy changed, preserve it and report the conflict.
The operator must choose whether to keep it, restore source content, or move
follower-owned work into a Local Overlay. Unattended agents do not make this
choice.

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

Recovery resumes the recorded plan and re-observes incomplete actions. It does
not accept a run ID, switch revisions, guarantee rollback of third-party
installers, or invent work when no recoverable run exists.

If recovery fails, preserve SQLite state and the action journal, resolve the
reported cause, and retry while the original revision remains available. Build
a new plan only when Canonfig reports that recovery cannot continue.
