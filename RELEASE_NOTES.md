# Canonfig v3.0.0

Canonfig 3.0.0 requires Node.js 24 or newer.

This release resolves a full hand audit of the 2.x CLI. It changes several
published behaviors, so read the breaking changes before upgrading a fleet.

## Breaking changes

- The `schedule` Profile Resource kind is removed. A Follower Machine now owns
  its native synchronization job outright: it inherits the profile's optional
  `scheduleDefault` or chooses its own with `canonfig schedule set`, and that
  choice survives an apply. Move a declared schedule to `scheduleDefault`, or
  set it per follower. A profile that omits `scheduleDefault` now schedules
  nothing rather than inheriting a daily midnight job.
- A Machine Profile may declare only a daily or weekly `scheduleDefault` in the
  follower's own timezone, written as `"timezone": "local"`. A `custom`
  expression and a named timezone are rejected at publication, because launchd
  and Windows Task Scheduler refuse both at apply and such a follower would end
  up with no scheduled synchronization at all. Set anything backend-specific
  per follower with `canonfig schedule set --timezone`.
- `replace` on a directory is a true mirror and removes entries Canonfig never
  wrote, so the managed subtree ends up exactly the desired subtree. Use
  `mirror-owned` to keep local files.
- A `tool` with no usable installation recipe no longer produces an Agent Task
  unless it declares an `agentInstall` block naming the paths and origins a
  bounded agent may use. Without it the resource is reported as Human Action
  Required.
- Exit codes follow the semantic failure class rather than words matched in an
  internal error type name. Refusals that exited 1 now exit 2, 3, 4 or 5, and
  exit 1 is reserved for defects. Replaying a consumed invitation exits 5
  rather than 6.
- Usage errors honor `--json` and emit a `canonfig.cli/v1` envelope on standard
  error instead of two plain lines.
- `canonfig follower enroll` requires `--profile`, which the help text always
  showed as required and the runtime always refused without.
- A `merge` config removes keys Canonfig owned that the profile no longer
  declares. A key claimed through the follower's Local Overlay is preserved.

## Convergence and reliability

- A follower whose native scheduler does not work converges. Reconciling the
  native job happens after a converged run and tolerates failure, so a
  container, headless server or CI host is no longer blocked by it.
- A removed symlink resource no longer fails every plan. Removal verification
  follows the applied record's own shape instead of assuming a digest.
- Two resources with identical content no longer collide. A blob is addressed
  by its content, so identical specifications share one blob, transfer once and
  are written to both targets.
- A deleted managed target is reinstalled under `replace-if-unmodified`, since
  absence is not a local edit. A target that exists but cannot be verified is
  still reported rather than overwritten.
- Recovering an interrupted directory action no longer fails when the captured
  tree was absent, which used to leave the follower unable to converge or
  recover without creating the directory by hand.
- `canonfig abandon` terminally closes an interrupted run whose revision is no
  longer authorized. It is not a rollback: what the run applied stays applied.
- Installers and `command` verifications run under their own limit, defaulting
  to ten minutes, rather than the ten second transport timeout.
- An `executable-present` verification naming an absolute path is checked by
  inspecting that path.
- A `bun` recipe with a registry tarball is decided at planning and reported as
  Human Action Required rather than failing the run at execution.
- Drift conflicts report the differing filesystem modes, so mode-only drift is
  no longer two identical digests with no explanation.

## Agents

- `agent-propose` invokes the harness during apply, records the proposal and
  stops, which is what the documentation always described.
- A harness that is denied, times out, overruns its output limit or returns
  unusable output is Human Action Required rather than a failed run, so one
  declining task no longer rolls back the rest of the profile.
- `sync --plan` reports a harness refusal against the task it would have
  attempted instead of dropping it silently.

## Enrollment and credentials

- The credential store is checked before an invitation is spent, so a machine
  that cannot keep a credential no longer burns a single-use invitation, and
  reports a human action rather than a transport failure.
- The credential policy recorded at enrollment is what later runs read, so a
  scheduled job no longer depends on an environment variable it does not carry.
- Enrolling a different name over a completed enrollment requires `--replace`.
  Re-enrolling the same name still rotates the credential.
- `canonfig doctor` probes the agent policy and harness the follower actually
  runs under instead of a file enrollment stops using.

## Diagnostics

- Failures name what went wrong instead of printing an internal error type.
  Every tagged error in the tree is classified explicitly, and a test fails when
  a new one is unclassified.
- Stray arguments and unknown options are reported as themselves rather than
  making the command that received them look unknown.
- `canonfig harness --help` prints help.
- A `harness.yaml` naming a missing source reports the `SOURCE_MISSING`
  diagnostic instead of a raw `ENOENT`.
- Text an operator writes around a marker-managed block stays where they put
  it; the block is replaced in place rather than moved to the end of the file.
- A failed `canonfig source serve` exits instead of blocking forever.
- Revoking an unknown follower says the follower is unknown rather than
  claiming the credential is invalid.

## Platforms

- Updating a macOS schedule from inside a scheduled run no longer boots out the
  agent that owns the running process.
- Publication rejects calendars and timezones that macOS or Windows followers
  cannot apply. Such a profile used to leave those followers unable to converge
  at all, and after the scheduler moved out of the resource transaction it left
  them converged with no scheduled synchronization and no signal saying so.

Full changelog: https://github.com/Microck/canonfig/compare/v2.2.0...v3.0.0
