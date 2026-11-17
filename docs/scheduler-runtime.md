# Scheduled runtime identity

The default native synchronization job invokes the absolute Node executable
running the installed Canonfig CLI, followed by the absolute compiled CLI
entrypoint and `sync --apply --no-input --scheduled`. It does not invoke an npm
shim, use `/usr/bin/env`, search PATH, or copy interactive Node flags. Only the
native job passes `--scheduled`, which keys the unattended-run evidence, so a
manual `--no-input` run cannot be mistaken for a scheduler fire.

The scheduled invocation starts before CLI Fleet Update checks and includes
their outcome. An unavailable Source or refused update still leaves a failed
invocation for `status` and `doctor`; it is not reported as a job that never ran.

`canonfig schedule run [--timeout-ms <ms>]` starts that same installed native job
and waits for its next invocation to finish. Use it from SSH when Windows
Credential Manager is unavailable to an OpenSSH key network logon, or when the
macOS login Keychain is unavailable to the remote shell. The job keeps its
installed identity and logon rather than inheriting the SSH session.

The command refuses absent, disabled, stopped, or drifted jobs and names
`canonfig schedule set` as the repair. It polls the state database once per
second, follows the first invocation starting at or after the request, and
returns its synchronization outcome and run id. The default wait is two hours.
A timeout does not stop the job: check `canonfig schedule status` and
`canonfig status` before retrying. An already-running invocation is not reused;
if the native scheduler coalesces the start request, the wait can time out.

Windows still requires the user to be logged on for its Interactive task.
macOS still requires the user's GUI session and an unlocked login Keychain.
Linux uses the existing systemd user service and needs a working user manager;
triggering it does not unlock a credential store.

When the running Node is a Homebrew Cellar path such as
`<prefix>/Cellar/node@24/24.16.0/bin/node`, the job names the stable
`<prefix>/opt/<formula>/bin/node` link instead, provided that link resolves to
the same binary. `brew upgrade` deletes the versioned Cellar directory, so a
job naming it would stop starting. Otherwise the job names `process.execPath`.

`--executable` keeps its existing meaning: an explicitly selected standalone
command receives `sync --apply --no-input --scheduled` directly. The operator
is responsible for that command's runtime and entrypoint.

Re-rendering under a different Node installation or CLI location reports the old
definition as drifted (binding drift). The next `sync --apply` or an explicit
`schedule set` re-renders it. Removing a runtime or moving an installation can
still invalidate an existing job. Install schedules from the built, installed
CLI, not a development TypeScript entrypoint.

`schedule set` never starts a run for a time that has already passed today; it
prints the resolved time zone and the next run. A time that does not exist on a
daylight-saving day produces a warning that names the native behavior. The
user-facing rules for time zones, daylight saving, and missed runs are in
`website/content/docs/how-to/manage-schedules.mdx`.

The Windows task runs `%SystemRoot%\System32\wscript.exe` with a small JScript
launcher, which runs the runtime and CLI hidden and exits with their exit code.
In the user's session `node.exe` would otherwise get a visible console window for
the whole run, renamed by every `cmd` child such as `npm ls`. `conhost
--headless` hides the window too but always exits 0, so Task Scheduler's last
result would report every failed sync as a success. The install writes the
launcher to `%LOCALAPPDATA%\canonfig\native\CanonfigScheduleLaunch-<digest>.js`;
a missing launcher is drift. `schedule status` reports the runtime and CLI the
launcher runs as the binding, not `wscript.exe`. This needs Windows Script Host,
which is on by default; a policy that turns it off makes every run fail with a
nonzero last result. A task registered by an earlier release no longer matches,
so the post-apply reconciler re-registers it when it is enabled.

The Windows task uses an InteractiveToken logon, so Task Scheduler starts it
only while the user is logged on and never catches up a run it skipped while the
user was logged off or the machine was off. `schedule status` and `doctor`
always warn about this on Windows, as they warn about `Linger=no` on Linux. They
also compare the most recent due start (from the selected calendar, five minutes
of grace) with the task's `LastRunTime` and the registration `Date` Canonfig
writes into the task XML. When that start came after both, the job stays
`current` (it is still armed for the next run) and a second warning names the
missed time: "the scheduled run at `<time>` did not start (last start
`<time>`): the cause is not established from task history". A task XML without a
registration date cannot tell a missed run from a time that passed before
registration until it has run once, so no missed run is reported for it.

The packed-CLI regression installs the packaged tarball, then launches the
installed CLI through the rendered command with an empty PATH and an unrelated
working directory. It does not install a native job, access credentials,
or demonstrate a scheduled apply. A current job definition is not evidence of
Source availability, usable unattended credentials, or successful scheduled
Convergence. Those outcomes must be verified separately; `status` and `doctor`
report the last unattended run's outcome and failure reason.

Windows sync tasks explicitly allow starting on battery and do not stop an active sync when AC power is disconnected. Existing tasks with either battery restriction, or missing settings that imply restrictive defaults, are definition drift and need repair from a manual `canonfig sync --apply` or a valid `canonfig schedule set` command. This does not override Windows sleep, shutdown, or user-logon requirements. Missed-run diagnostics name possible causes rather than infer a specific one from a missing start.
