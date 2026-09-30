# Completion and reporting

A command completing is not proof that the requested setup is complete. Use
observed state and Canonfig's independent verification.

## Completion states

Report exactly one:

- `complete`: every requested outcome is verified;
- `incomplete — approval required`: the next bounded mutation needs explicit
  operator approval;
- `incomplete — Human Action Required`: a human-only step is recorded;
- `incomplete — conflict or Follower Drift`: local ownership blocks apply;
- `incomplete — unsupported`: the requested outcome is outside the shipped
  contract;
- `failed`: authentication, transport, apply, or independent verification
  failed;
- `interrupted`: persisted work exists and may be recoverable.

Do not call a degraded, partially applied, or merely downloaded follower
`Converged`.

## Evidence checklist

### CLI installation

- Node.js 24 or newer and npm observed;
- exact installed Canonfig version observed;
- intended user can resolve the `canonfig` executable;
- bounded diagnostics reported.

### Machine bootstrap

- setup role matches the intended machine;
- setup plan digest and approval are reported;
- setup status is `complete`;
- required item evidence and qualified recipe provenance are recorded;
- optional exclusions or failures are reported without hiding independent work.

### Source Machine

- intended user owns one Source identity;
- the authored profile file is identified, `canonfig source digest` passed on
  it, and tool-discovery inputs (`--file`) are listed separately;
- requested publication has revision ID, profile ID, sequence, digest, and
  publication time;
- `profile show` matches the reviewed candidate;
- `canonfig source service status` reports `running` when followers must sync
  unattended, with the platform's unattended mode stated (Linux lingering on or
  off, macOS desktop session, Windows logon);
- unresolved evidence or recipes are reported rather than silently accepted.

### Follower Machine

- follower identity and human-readable name reported;
- source TLS and signing fingerprints reported as pinned, without exposing key
  material;
- selected profile, revision, and groups reported;
- this follower's own `canonfig status` independently reports `Converged`;
- credential references resolve through Secret Service, Keychain, or Credential
  Manager as appropriate;
- client trust and hook review steps given (see below), with `clientLoaded`
  reported as `not-verified`;
- requested schedule matches the systemd user timer, launchd user agent, or
  per-user Task Scheduler task; `scheduled` in the completion receipt becomes
  `verified` only after a real scheduled run completed.

The Source has no fleet view. On the Source, `canonfig status --follower <id>`
shows only that follower's enrollment. Each follower's own `canonfig status` is
its completion evidence; report followers without that evidence as pending.

### Setup-agent execution permissions

Run Canonfig as the intended machine user. A project sandbox is not proof of
access to that user's state, credential provider, or native scheduler.

State commands can open SQLite for writing even when they only report status.
Authorize access to the user's Canonfig state directory, normally
`~/.canonfig`, including SQLite sidecars. Once that directory exists, Codex can
use its supported scoped directory grant, for example:

```bash
codex --sandbox workspace-write --ask-for-approval on-request --add-dir "$HOME/.canonfig"
```

If the state directory does not exist yet, run the approved initial Canonfig
setup command through the agent's per-command native execution approval, then
grant the created state directory. Keep the selected project context; do not
grant the entire home directory or change state-file permissions.

The directory grant does not authorize native Secret Service, Keychain,
Credential Manager, or scheduler IPC. Request the agent's supported
per-command approval for the exact required Canonfig diagnostic or setup
command in the intended user's native session. Preserve the original blocked
probe. Without that access, report credential or scheduler inspection as
blocked or indeterminate, not broken, ready, or verified. Do not weaken the
credential policy or bypass the agent sandbox globally.

### Client trust after apply

`Converged` means files are in place and verified, not that a client accepted
them. Canonfig never copies trust decisions between machines. Tell the operator:

- Claude Code: restart it; if it reports hooks changed outside the app, review
  them in `/hooks`; trust each project folder when asked.
- Codex: trust each project directory when asked; hooks from
  `~/.codex/hooks.json` load in a review state and do not run until trusted in
  `/hooks`.
- Antigravity CLI: start `agy` in the project and invoke a managed MCP tool
  to confirm that the changed server loaded.

`clientLoaded` stays `not-verified` unless the profile declares a verification
that proves a client loaded the resource. Never report it as verified from file
evidence.

### Project harness

- one canonical source format;
- validation passes;
- targets and support levels reported;
- no unapproved collision, force ownership, or external edit;
- status has no pending owned changes;
- requested target probes reported.

## Failure interpretation

Canonfig CLI exit categories are:

| Code | Meaning |
| ---: | --- |
| 0 | success |
| 1 | internal defect |
| 2 | usage or configuration |
| 3 | Human Action Required |
| 4 | conflict or Follower Drift |
| 5 | authentication or revocation |
| 6 | transport |
| 7 | verification or apply failure |

Preserve the reported details, state database, pins, cache, and action journal.
Do not repair an expected failure by deleting evidence.

## Final report

Keep the report compact and omit secret values and invitation payloads:

```text
Setup result: complete

Machine
- role: Follower Machine
- name: laptop
- Canonfig: 4.0.0

Trust
- Source endpoint: https://127.0.0.1:17342
- TLS fingerprint: pinned
- signing fingerprint: pinned
- credential: stored in native secure storage

Profile
- ID: workstation
- revision: <id>
- groups: developers
- result: Converged

Schedule
- daily@09:00 Europe/Madrid
- mechanism: native user scheduler
- state: current

Clients
- clientLoaded: not-verified
- trust and hook review: steps given for Claude Code and Codex

Unresolved
- none
```

For incomplete work, state what succeeded, the exact blocker, what was not
changed, and the next non-secret action. Do not repeat the entire setup history.
