# Scheduled runtime identity

The default native synchronization job invokes the absolute Node executable
running the installed Canonfig CLI, followed by the absolute compiled CLI
entrypoint and `sync --apply --no-input`. It does not invoke an npm shim, use
`/usr/bin/env`, search PATH, or copy interactive Node flags.

`--executable` keeps its existing meaning: an explicitly selected standalone
command receives `sync --apply --no-input` directly. The operator is responsible
for that command's runtime and entrypoint.

Re-rendering under a different Node installation or CLI location reports the old
definition as drifted; an approved `schedule set` updates it. Removing a runtime
or moving an installation can still invalidate an existing job. Install schedules
from the built, installed CLI, not a development TypeScript entrypoint.

The acceptance regression launches the compiled CLI with an empty PATH and an
unrelated working directory. It does not install a native job, access credentials,
or demonstrate a scheduled apply. A current job definition is not evidence of
Source availability, usable unattended credentials, or successful scheduled
Convergence. Those outcomes must be verified separately.
