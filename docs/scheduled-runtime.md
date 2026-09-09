# Scheduled runtime and explicit cadence

The packaged CLI renders native schedules with its absolute Node executable and
absolute compiled CLI entrypoint. The job does not find `canonfig` or Node through
an interactive shell, PATH, npm shim, or shebang. A Node installation upgrade that
removes either path still requires an approved schedule update; a rendering is not
proof that a scheduled run completed.

An explicit `schedule set --executable` remains an operator-supplied executable
receiving `sync --apply --no-input`; it is not interpreted as a Node script. The
ScheduleManager embedding API offers a local default command independently of
published resource recipes. Existing embedded users can keep executable lookup.

Publication preserves an omitted `scheduleDefault`. It no longer fabricates a
midnight schedule for a profile that did not request one. An explicitly declared
calendar remains signed profile data. Existing immutable revisions are not changed.
No schedule is enabled, removed, or migrated merely by upgrading the package.

The native acceptance regression runs the manager's exact rendered command with
an empty PATH and a spaced entrypoint on each platform, without registering jobs.
Real unattended completion additionally needs the requested native scheduler,
usable credentials in that execution context, Source reachability and pinned
transport, installer bindings when needed, and independently verified application.
