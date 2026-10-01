# Scheduled runtime identity

The default native synchronization job invokes the absolute Node executable
running the installed Canonfig CLI, followed by the absolute compiled CLI
entrypoint and `sync --apply --no-input --scheduled`. It does not invoke an npm
shim, use `/usr/bin/env`, search PATH, or copy interactive Node flags. Only the
native job passes `--scheduled`, which keys the unattended-run evidence, so a
manual `--no-input` run cannot be mistaken for a scheduler fire.

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

The packed-CLI regression installs the packaged tarball, then launches the
installed CLI through the rendered command with an empty PATH and an unrelated
working directory. It does not install a native job, access credentials,
or demonstrate a scheduled apply. A current job definition is not evidence of
Source availability, usable unattended credentials, or successful scheduled
Convergence. Those outcomes must be verified separately; `status` and `doctor`
report the last unattended run's outcome and failure reason.
