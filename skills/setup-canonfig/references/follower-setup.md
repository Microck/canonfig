# Follower Machine setup

Use this branch for enrollment, first synchronization, schedule installation,
diagnosis, or recovery.

## Inspect first

Detect the current user, platform, Node.js and npm versions, Canonfig version,
secure credential provider, native user scheduler, existing role, selected
profile, pinned source identity, last run, drift, and recoverable work.

```bash
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig status --json
canonfig schedule status
```

Do not reenroll an existing healthy follower or replace pins because a source is
temporarily unreachable. Preserve `~/.canonfig/state.sqlite`, credentials,
cache, action journal, Applied Resource Records, and follower-modified skills.

## Minimal question flow

A normal new follower needs at most one batch:

1. Follower name.
2. Profile ID.
3. How the invitation will be supplied locally.
4. Desired schedule, unless the profile default is accepted.

Explain each question and recommend:

- a stable descriptive machine name;
- the profile named in the user's request or invitation context;
- an ephemeral environment variable or protected temporary file that is
  deleted immediately after enrollment;
- review the first plan before apply;
- the profile schedule default when available, otherwise a visible local-time
  daily schedule.

Do not ask for the invitation payload in chat. Do not ask about shared secrets;
group authority is carried by the invitation and can be reported after
enrollment without displaying values.

## Install

After approval:

```bash
npm install --global @microck/canonfig@3.0.0
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

Use Secret Service on Linux, Keychain on macOS, or Credential Manager on
Windows. Missing secure noninteractive storage remains Human Action Required;
do not create a plaintext fallback unless the operator explicitly selected a
documented local-file credential policy.

## Enroll

Require the exact selected profile during enrollment:

```bash
canonfig follower enroll "$INVITE" --name laptop --profile workstation
```

On PowerShell, keep the invitation only in the current process. On every
platform, clear the variable or remove the protected temporary file immediately
after the command.

Enrollment must:

- pin the source TLS and signing fingerprints;
- issue one independently revocable follower credential;
- confirm that the selected profile has an authorized revision;
- preserve an interrupted enrollment for safe resumption.

Refuse expired, replayed, exposed, malformed, or fingerprint-mismatched
material. Request a fresh invitation; never reset trust or suppress
verification.

## First plan

Run a non-mutating plan:

```bash
canonfig profile select workstation
canonfig sync --plan
```

Present only material entries by default:

- selected Profile Revision;
- creates, updates, and owned removals;
- package recipes and login requirements;
- dependency order;
- Configuration Agent tasks and capabilities;
- Human Action Required records;
- conflicts and Follower Drift;
- verification methods.

Collapse unchanged resources and cache details unless the operator requests the
full plan.

Ask one approval question:

```text
Question:
Apply this exact synchronization plan?

Why it matters:
Apply may install tools or change managed targets. Canonfig will verify every
required resource afterward, but third-party installers may not be reversible.

Recommended:
Apply only when the displayed revision, mutations, ownership, recipes, and
verification match the intended machine.

Options:
apply / keep plan only / revise profile
```

## Apply and verify

After approval:

```bash
canonfig sync --apply
canonfig status --json
```

A successful download is not Convergence. Report complete only when independent
verification establishes `Converged`.

A successful apply may synchronize source-owned shared secrets only when the
follower was enrolled in `canonfig:secrets`. Report names and opaque references,
never values.

## Schedule last

Install a schedule only after an interactive apply has converged:

```bash
canonfig schedule set daily@09:00 --timezone Europe/Madrid
canonfig schedule status
```

Schedules invoke:

```text
canonfig sync --apply --no-input
```

Linux uses a systemd user timer, macOS a launchd user agent, and Windows a
per-user Task Scheduler task. Confirm that the same user, executable path,
secure credential provider, source tunnel when needed, and failure output are
available during scheduled execution.

Do not claim schedule completion when the native scheduler is disabled,
drifted, unavailable, or installed for another account.

## Resume and recover

When prior state exists, re-inspect rather than restarting setup:

```bash
canonfig status
canonfig recover --no-input --json
```

Recovery resumes the persisted plan and re-observes incomplete actions. It does
not accept a new revision, erase drift, or guarantee rollback of third-party
installers.

For Human Action Required, present the affected resource, reason, and exact
non-secret instruction. After the person completes it, rerun diagnostics and
plan. For Follower Drift, preserve the local edit and require the operator to
choose whether to keep it, restore source content, or move local ownership into
a Local Overlay.

## Follower completion evidence

A Follower setup is complete only when:

- the intended follower identity, name, profile, groups, and pinned trust are
  reported;
- the selected authorized revision is explicit;
- the approved plan was applied;
- final status independently reports `Converged`;
- shared-secret synchronization, when authorized, reports names only;
- the requested schedule matches the native user scheduler;
- no Human Action Required, Follower Drift, interrupted, authentication,
  transport, or verification failure remains unresolved.
