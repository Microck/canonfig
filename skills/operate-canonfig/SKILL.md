---
name: operate-canonfig
description: Operate an existing Canonfig setup. Edit ~/.canonfig/, plan and apply syncs, exclude harnesses or preserve MCPs, restore Takeover Snapshots, resolve Follower Drift or Human Action Required, recover interrupted runs, or manage Source and Follower machines.
---

# Operate Canonfig

Inspect current state first, plan before mutating, verify after applying, and
preserve local edits, pins, journals, and backups.

For Source publishing, services, invitations, revocation, Follower schedules,
tunnels, unenrollment, or Linux/macOS/Windows credential and scheduler
boundaries, read [references/multi-machine.md](references/multi-machine.md).

## 1. Inspect

```bash
canonfig status --json
canonfig harnesses --json
canonfig doctor --no-input --timeout-ms 5000 --json
```

Identify whether this machine is unenrolled local, a Source Machine, or a
Follower Machine. Check `canonfig --help` when confirming flags on the
installed version.

## 2. Edit and sync

Make shared changes in `~/.canonfig/` (on a Follower, shared changes belong on
the Source Machine; put machine-only items in `~/.canonfig/local/`). Always
plan before applying:

```bash
canonfig sync --plan
```

Show the user every affected harness surface, Takeover Snapshot, MCP list
change, tool install, and blocker. Apply only after approval:

```bash
canonfig sync --apply
canonfig status --json
```

Use `--no-input --json` only for noninteractive callers. Keep Takeover
Snapshots enabled unless `--no-backup` is explicitly approved. `Converged`
proves files are verified on disk; `clientLoaded` stays `not-verified`, so
remind the user to approve hooks or project trust in each harness when those
changed.

## 3. Harnesses, local exceptions, and restore

- Exclude or re-include a harness on this machine only:
  `canonfig harnesses exclude <id>` / `canonfig harnesses include <id>`.
- Keep native MCP lists untouched (globally or per harness):
  `canonfig local mcp status`, `canonfig local mcp preserve [--harness <id>]`,
  `canonfig local mcp project [--harness <id>]`. Report preserved MCP maps
  separately from synced config; preservation does not make them match
  `~/.canonfig/`.
- Keep specific skills local (requires `local.appendLocal` to include
  `skills`): `canonfig local skills list|add <name>|remove <name>`.
- Hand a harness back to its pre-Canonfig state: `canonfig restore [snapshot]`.
  Restore writes the Takeover Snapshot back and excludes those harnesses here.
  It refuses before writing if a surface was edited after Canonfig last applied
  it.

## 4. Handle stops without losing work

| Outcome | Exit | What to do |
| --- | ---: | --- |
| **Human Action Required** | 3 | Show the recorded resource, reason, and exact non-secret step (login, locked credential store, parse error, changed pinned root, `local/` name collision). Re-plan after the user completes it. |
| **Follower Drift** | 4 | Keep the local file and show the conflict. Let the user choose: keep the Source version (move local copy aside, then sync), promote the change on the Source, or keep it machine-local under `~/.canonfig/local/` with another name (when `local.allow` admits that category) and restore the mirror copy. Never force-overwrite drift. |
| **Interrupted run** | - | Run `canonfig status`, then after approval resume from the journal with `canonfig recover` (or `--no-input --json`). Only if Canonfig reports it cannot be recovered, get approval to run `canonfig abandon` and then `canonfig sync --apply`. |
| **Run lock held** | 4 | Wait for the named PID to finish rather than deleting lock or state files. |

## 5. Report a Canonfig bug

When you hit a reproducible Canonfig defect, search
[github.com/Microck/canonfig/issues](https://github.com/Microck/canonfig/issues)
for duplicates first. Use the private security advisory form for security bugs.

1. Run `canonfig report-issue automatic status --json`.
2. If `data.status` is `ask`, run `canonfig report-issue automatic account --json`
   and ask the user (naming `@<login>`) whether to **Enable automatic
   reporting**, **Review this report only**, or **Don't report**. Apply their
   choice via `canonfig report-issue automatic enable --account <id> --revision <revision> --json`
   or `disable --json`.
3. Pipe JSON (`{"title":"...","body":"..."}` with repro steps and zero secrets,
   credentials, or private paths) into:
   - `canonfig report-issue --stdin --automatic --json` when automatic is
     enabled, or
   - `canonfig report-issue --stdin --json` to preview, then `--stdin --submit --json`
     after explicit approval.
4. Return `data.url`.
