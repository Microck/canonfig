# Platform boundaries

Use equivalent domain outcomes, not copied paths or native definitions.

| Platform | Credentials | Scheduler | Common deterministic recipes |
| --- | --- | --- | --- |
| Linux | Secret Service | systemd user timer | apt, npm, uv, cargo, source |
| macOS | Keychain | launchd user agent | Homebrew, npm, uv, cargo, source |
| Windows | Credential Manager | per-user Task Scheduler | winget, npm, uv, cargo, source |

## Recipes

Keep every Installation Recipe platform-specific and version-aware. Verify its
package identity against evidence and the tool's upstream URL. A shared npm, uv,
cargo, or source recipe is valid only when evidence supports each named
platform. Login instructions describe a non-secret human step and never contain
a credential.

When no recipe is unambiguous, retain a bounded Agent Task. Under
`deterministic-only`, report Human Action Required. Under `agent-propose`, review
the proposal without executing it. Under `agent-apply`, enforce task and harness
bounds and rerun independent verification.

## Harness paths

- On Linux, use POSIX paths and user-owned filesystem roots.
- On macOS, use POSIX paths and Keychain-backed credential references.
- On Windows, use Windows paths and Credential Manager references.

Never copy Source Machine absolute paths into a portable profile. Every network
allowlist entry must be an exact HTTPS origin.

## Schedules

Install the same calendar through the local adapter:

```bash
canonfig schedule set daily@00:00
canonfig schedule status
```

Linux renders a systemd user timer, macOS a launchd user agent, and Windows a
per-user Task Scheduler task. Do not copy native definitions between platforms.
If the scheduler is unavailable, preserve the typed failure or Human Action
Required outcome.
