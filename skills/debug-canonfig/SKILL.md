---
name: debug-canonfig
description: Debug Canonfig sync, projection, tool, secret, tunnel, and scheduler issues across a Source Machine and Follower Machines. Inspect live state, check known failure classes, and classify every finding as Category A (operator or config error) or Category B (Canonfig product bug to file on GitHub).
---

# Debug Canonfig

Diagnose sync, projection, MCP, tool, secret, tunnel, and scheduler failures
across the Source Machine and every Follower Machine. Classify every finding
strictly as **Category A** (operator, profile, or local machine error) or
**Category B** (Canonfig product bug or missing capability).

## Safety rules

- Never print, echo, log, or paste secret values, tokens, API keys, invitation
  envelopes, `~/.canonfig/secrets.json`, or files under
  `~/.canonfig/credentials/` into chat, command arguments, or GitHub issues.
- Back up `~/.canonfig/local/local.jsonc` (for example to
  `~/.canonfig/local/local.jsonc.bak.<timestamp>`) before editing it.
- Never delete `~/.canonfig/state.sqlite`, run journals, lock files of active
  PIDs, or Takeover Snapshots to silence an error. Use `canonfig recover` for
  interrupted runs.
- On Windows over SSH, when OpenSSH network logon cannot access DPAPI or
  Credential Manager, trigger unattended sync through Task Scheduler
  (`\Canonfig\canonfig-sync`) via `canonfig schedule run --timeout-ms 600000 --json`
  (or `schtasks /Run /TN "\Canonfig\canonfig-sync"`). Do not downgrade storage
  or bypass credentials.
- Never patch around a Category B Canonfig bug with brittle local shims,
  wrapper scripts, or unsafe flag workarounds. Capture evidence and file an
  issue on `Microck/canonfig`.

## 1. Collect evidence (Source and every Follower)

Run the read-only snapshot on the Source Machine and on every affected Follower
Machine before changing anything:

```bash
canonfig --version
canonfig status --json
canonfig sync --plan --json
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig harnesses --json
canonfig local mcp status
canonfig overlay list
canonfig schedule status
canonfig tunnel status
canonfig secrets list
```

Also inspect, redacting any secret values:

1. `~/.canonfig/canonfig.jsonc` on the Source (and the mirror on each Follower
   to verify applied revision parity and `major.minor` CLI version parity).
2. `~/.canonfig/local/local.jsonc` on each machine.
3. Managed harness configs for the affected harnesses (for example
   `~/.claude.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`).
4. Native service, scheduler, and tunnel logs:
   - **Linux:** `systemctl --user list-units 'canonfig*'`,
     `journalctl --user -u canonfig-sync.service`, and
     `journalctl --user -u canonfig-source.service`.
   - **macOS:** `~/Library/LaunchAgents/dev.canonfig.*` and
     `~/.canonfig/source-service.log`.
   - **Windows:** Task Scheduler tasks `\Canonfig\canonfig-sync` and
     `\Canonfig\canonfig-source`, plus Event Viewer
     `Microsoft-Windows-TaskScheduler/Operational`.

## 2. Check the eight failure classes

Audit the collected evidence against each class below:

| # | Failure class | What to inspect | Typical category |
| --- | --- | --- | --- |
| 1 | **Forgotten `preserveMcp` locks** | Follower `local/local.jsonc` has `preserveMcp: true` or a harness array, leaving native MCP lists frozen while other categories sync. Confirm with `canonfig local mcp status`. | **A** (clear with `canonfig local mcp project [--harness <id>]` once approved) |
| 2 | **Stale `"enabled": false` overlays or wrong-OS absolute paths** | `local/local.jsonc` or `canonfig.jsonc` hides a published MCP with `"enabled": false`, or carries Linux `/home/...` paths onto Windows or macOS. Confirm with `canonfig overlay list`. | **A** (fix or remove stale overlay, or make Source paths portable) |
| 3 | **Overlays dropping `fromSecret` or embedding plaintext credentials** | A local MCP overlay omits `{ "fromSecret": "<name>" }` / `{ "fromEnv": "<NAME>" }` or embeds a literal token or API key instead of referencing Canonfig secrets. | **A** (restore `fromSecret` / `fromEnv`, store secret via stdin with `canonfig secrets set`, rotate exposed token). **B** if `source publish` accepted a literal credential it should reject. |
| 4 | **Broken stdio MCPs or non-portable `tools` recipes** | Stdio `command` points to a nonexistent binary, omits `requires: ["tools/<id>"]`, uses a Windows `.cmd`/`.bat` shim without `node.exe` + JS entrypoint, or uses a Linux-only npm package causing `EBADPLATFORM` on macOS or Windows. | **A** (add per-platform `tools` recipes, set `requires`, or scope `mcp.<name>.harnesses` / group). **B** if Canonfig fails to run a valid declared platform recipe. |
| 5 | **Forced CLI downgrades from stale `tools` pins** | Local installed CLI version is newer than the exact `version` pinned in `canonfig.jsonc#tools.<id>.recipes`, causing sync to downgrade the tool (for example via `apt --allow-downgrades` or pinned npm/brew/winget versions). | **A** (bump the pinned version on Source and publish) or **B** (missing minimum-version or no-downgrade policy in Canonfig). |
| 6 | **Skill directory drift from runtime artifacts or unmanaged skills** | Projected or mirrored `skills/<name>/` triggers `drift-conflict` (exit 4) or collision (exit 3) due to `__pycache__`, `*.pyc`, `.DS_Store`, or pre-existing unmanaged skill folders. | **A** for pre-existing unmanaged skills (move into `~/.canonfig/local/skills/` or adopt on Source, or remove stray files). **B** if Canonfig fails to ignore OS/runtime caches like `.DS_Store` or bytecode it should ignore. |
| 7 | **Unconfigured authenticated CLIs** | `tools.<id>` installs and passes `executable-present` verification, but the CLI still fails because its own config has no credentials or login state (missing `login: { "required": true, "howTo": "..." }`). | **A** (complete interactive login on the machine and add `login` metadata to `canonfig.jsonc`). **B** if Canonfig ignores declared `login.required` or misreports verification. |
| 8 | **Duplicate/stale reverse-tunnel units or Windows ACL rollback timeout** | Stray manual systemd/launchd/SSH tunnel units fight Canonfig's managed tunnel on loopback, or `canonfig schedule run` on Windows times out (exit 7) during slow NTFS ACL rollbacks without stopping the task. | **A** for duplicate manual tunnel units (remove stale unit, use `canonfig tunnel status` / `start`). **B** if Canonfig's NTFS ACL rollback or tunnel supervision wedges or times out under normal load. |

## 3. Classify every finding: Category A vs Category B

Present every finding in a single triage table before making changes. Never mix
remediation for A and B:

| Finding | Machine(s) | Category | Root cause and evidence | Next action |
| --- | --- | --- | --- | --- |
| Short name | Source / Follower | **A** or **B** | Exact file, key, exit code, or log line (no secrets) | Fix locally / update Source + publish, or file GitHub issue |

### Category A: Operator, profile, or local machine error

1. Explain the exact root cause and which files will change.
2. Back up `~/.canonfig/local/local.jsonc` before any local edit. Wait for user
   approval before writing files, publishing revisions, or running `sync --apply`.
3. Apply the fix in the right place:
   - Machine-local fix: edit `local/local.jsonc` or run the native Canonfig
     subcommand (`canonfig local mcp project`, `canonfig overlay remove`,
     `canonfig recover`), then plan and apply.
   - Shared profile fix: edit `~/.canonfig/` on the Source Machine, plan and
     apply there, then publish (`canonfig source publish --reviewer operator`).
4. Verify convergence on the Source and every affected Follower:

```bash
canonfig sync --plan --json
canonfig sync --apply
canonfig status --json
```

On Windows over SSH where DPAPI or Credential Manager is inaccessible, run the
scheduled task instead of direct `sync --apply`:

```bash
canonfig schedule run --timeout-ms 600000 --json
canonfig status --json
```

If `schedule run` times out (exit 7), do not kill the task or delete state.
Wait and check `canonfig status --json` and `canonfig schedule status` because
the Task Scheduler job continues running.

### Category B: Canonfig product bug or missing capability

Do not paper over Category B issues with local wrapper scripts, manual patches
to mirrored files, or insecure overrides.

1. Capture minimal, redacted evidence: `canonfig --version`, OS and
   architecture, `node --version`, machine role (Source or Follower), exact
   command and exit code, relevant file/line or `canonfig doctor --no-input --json`
   excerpt, and expected vs actual behavior.
2. Search [github.com/Microck/canonfig/issues](https://github.com/Microck/canonfig/issues)
   for duplicates first. Use the private GitHub security advisory form for
   security defects.
3. File a focused GitHub issue on `Microck/canonfig` using `canonfig report-issue`
   (after checking `canonfig report-issue automatic status --json` and getting
   explicit user approval when automatic reporting is off):

```bash
canonfig report-issue automatic status --json
canonfig report-issue --stdin --json
canonfig report-issue --stdin --submit --json
```

4. Return the created issue URL and leave the affected machine in a safe,
   reversible state until the fix ships.
