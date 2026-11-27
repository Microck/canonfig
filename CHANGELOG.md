# Changelog

Every Canonfig release, newest first. Each section is the GitHub release notes for that version.

## Unreleased

### Tool recipes

- Binary tool recipes can install a named executable from a verified `.tar.gz`,
  `.tgz`, or `.zip` archive.

### Agent skills

- Added the `debug-canonfig` skill (`skills/debug-canonfig/SKILL.md`) with a
  Source-and-Follower inspection checklist and a Category A (operator/config) vs
  Category B (Canonfig product bug) triage workflow covering `preserveMcp`
  locks, stale overlays, credential references, non-portable tool recipes,
  forced tool downgrades, skill directory drift, unauthenticated CLIs,
  duplicate tunnels, and Windows Task Scheduler runs.
- Updated `setup-canonfig` and `operate-canonfig` with upfront guardrails to
  prevent those profile, overlay, tool-recipe, skill-drift, and Windows
  scheduler mistakes.

### Automatic local sync

- The Linux and macOS watcher now finds Codex and other harnesses in the
  directories on your shell's `PATH`. After upgrading, run `canonfig watch enable`
  again from the shell that finds those harnesses to refresh an existing watcher.

## v7.9.1 - 2026-11-26

### Synchronization

- Generated Python bytecode caches inside projected skills no longer block skill updates or automatic local sync.

## v7.9.0 - 2026-11-24

### Automatic local sync

- `canonfig watch` applies the Canonfig folder to this machine's harnesses
  about a second after each change to `canonfig.jsonc`, `AGENTS.md`,
  `rules/`, `skills/`, `agents/`, `commands/`, `hooks/`, `files/` or
  `local/`. It runs on a Source or unenrolled machine; a Follower refuses it.
- `canonfig watch enable` runs the watcher as a user service (systemd user
  unit, LaunchAgent or Task Scheduler logon task), `watch status` reports it
  and its latest run, and `watch disable` removes it.
- The Local sync page has an Apply changes automatically switch, and the
  Source Overview shows whether automatic apply is on. A Follower that kept a
  watcher from before it enrolled can remove it from its Sync page.

### MCP servers

- `mcp.<name>.harnesses` limits a server to the listed harnesses, and sync
  removes it from harnesses dropped from the list. The Source editor has a
  Target harnesses picker.
- With `proxy: true`, Streamable HTTP servers that take a `fromSecret`
  header share one local listener, `canonfig mcp proxy`, instead of starting
  a launcher for each harness session. Upstream credentials stay out of
  harness configuration.

### Diagnostics

- `doctor` verifies legacy HTTP+SSE MCP servers through initialization and
  tool listing, and does not follow redirects on that connection, so their
  configured headers stay on the configured origin.
- `doctor` reports MCP servers that reject or never acknowledge ping replies,
  and reports a failed session cleanup separately from the handshake result.
- `doctor` checks Codex MCP servers on Windows with the environment Codex
  gives them.
- Setup and installer checks find Rustup-managed Cargo without starting the
  Rustup proxy, and give recovery steps for a missing or ambiguous toolchain.

### Fleet Update

- A rollout halts when an admitted canary misses its one-hour health deadline,
  even if that follower stays offline.
- A scheduled sync repairs a managed tunnel before checking for a Fleet
  Update. If the check still fails, the sync continues and reports the check
  as deferred.
- The browser refreshes the canary list, and the Source checks it again
  before a rollout starts.

### Synchronization, archives and recovery

- An interrupted profile download resumes from its verified part instead of
  starting over.
- File operations for authored resources stay anchored under your home folder.
- Archive import and restore keep the original error when cleanup also fails,
  and recovery cleans up only the failed run's files.
- `recover` says so when no local run needs recovery.
- Linux checks that stored credentials survive a credential provider restart,
  and Windows keeps credential generations consistent during rotation.

### Browser interface

- Publishing sends exactly the profile content you reviewed.
- Unsaved drafts survive browser back and forward navigation.
- A lost archive preview can be retried.
- Expired invitations leave the waiting list.
- Dithered status bands, machine tiles and progress bars match the approved
  designs again, empty states no longer draw cut-off art, and the tour route
  meets each step at its centre.

### Agent skills

- The `setup-canonfig` and `operate-canonfig` skills now start from local
  setup and load detail only when a branch needs it.

## v7.8.2 - 2026-11-20

### Self-update

- An idle Source service, `canonfig ui` or `skills auto --apply` no longer
  holds off updates. Each holds its lease only while it handles a request,
  operation or pass. When its next request finds that an update replaced
  Canonfig, it exits with status 75 before running new code, and its service
  manager starts it again on the new release. A foreground `canonfig ui`
  prints why it stopped; run it again.
- Canonfig commands, MCP servers included, keep starting while an update
  downloads and stages its release. Only the final package swap makes a
  starting command wait, and a command still working at that point defers
  the update instead of failing it.

### Source

- Every Source state directory must use its own credential namespace. Legacy
  state is refused with recovery steps instead of being migrated, and setup
  and `source service status` no longer probe the keyring for it.

### Synchronization and recovery

- Observation records the final kind of every filesystem path, so an unknown
  path is never treated as a file, directory or symlink.
- `recover` and `abandon` name the build that created an unfinished run from
  another release before reading its journal, and clean up only the staging
  names the current build creates.
- Incomplete authored resource IDs fail before preparation or rollback.

### Browser interface

- Health checks start through one flow, keep their timeout across pages and
  cannot be started twice.
- Custom map icons are rejected when the browser cannot check transparency,
  with browser-specific guidance; the saved icon is kept.
- Focused machine cards and their toolbars are scrolled into view on the map.
- Tours preview and navigate to the page each step names.
- The setup approval control cannot be submitted while it fades out.
- Installer and agent model settings use the same validation as the CLI.

### CLI

- Node's SQLite warning is no longer filtered, and `self-update` help works
  on unsupported Node versions.

## v7.8.1 - 2026-11-19

### Synchronization

- A follower no longer stops on a tool that has no install recipe for its
  platform. When every recipe for a missing tool names other platforms (for
  example a Linux and macOS only tool on Windows), the follower plans nothing
  for it instead of asking for an action no one can take. Tools without
  recipes, or with `agentInstall` bounds, still ask, and installed tools are
  still verified everywhere.

### MCP launcher

- `canonfig mcp run` releases its self-update lease once the server starts, so
  long-running MCP servers no longer hold off Canonfig updates.

## v7.8.0 - 2026-11-18

### MCP health check

- `canonfig doctor` and the browser Health check now start every MCP server each
  installed harness declares, the way that harness starts it, and require it to
  answer `initialize` and list its tools. Entries Canonfig did not write, and
  harnesses whose MCP is preserved, are checked too. Each failing server is
  listed with its reason, such as a missing command, a timeout, or an HTTP
  error, with credentials redacted.
- Codex servers get only the environment Codex passes them, and each harness's
  servers start together, so failures that only happen at session start show
  up in the check.

### Machine health on the Source

- After `canonfig doctor` or the Health check, an enrolled Follower sends its
  report to the Source, and the Source records its own. Machines shows each
  machine's latest report under **Health**, with the checks and MCP servers
  that need attention. The report notes when sharing it failed.

### Fixes

- MCP servers started through `canonfig mcp run` no longer fail at random with
  "Self-update coordination is busy" when a harness starts many of them at
  once. Starting commands now wait briefly for the coordination gate; a running
  self-update still blocks them.

### Upgrading

Use Node.js 24.15+ or 26+. Source and Followers must all use the 7.8 release line
before resuming synchronization; 7.7.x and 7.8.x do not synchronize with each other.
A 7.8.0 Source can roll followers on 7.7.x forward with a Fleet Update.

## v7.7.0 - 2026-11-17

### Machine-local MCP

- Keep native MCP maps for chosen harnesses only, with `"preserveMcp": ["codex"]`
  in `local/local.jsonc` or `canonfig local mcp preserve --harness codex`, while
  the other harnesses keep receiving Source MCP. `true` and `false` work as
  before. Sources and Followers can choose the same policy in Local settings,
  and `canonfig local mcp status` lists the preserved harnesses.

### Security

The audit findings and the approved exception are unchanged from 7.6.0: five
moderate findings under `sigstore`, and the website-only `picomatch` advisory
GHSA-fc5q-39xc-vjpf, which still has no fixed release.

### Upgrading

Use Node.js 24.15+ or 26+. Source and Followers must all use the 7.7 release line
before resuming synchronization; 7.6.x and 7.7.x do not synchronize with each other.
A 7.7.0 Source can roll followers on 7.6.x forward with a Fleet Update.

## v7.6.0 - 2026-11-17

### Browser interface

- Manage a Source's own harness exclusions, item overlays and settings key claims
  from Local settings, the same screen Followers use. Nothing is published or
  applied until you run those steps.
- Choose **Skip reading existing tool configuration** on the first Source setup
  step, before Canonfig reads anything.
- Setup's technical details stay after a reload, with stage completion times,
  approval history and copyable digests.
- Replace a Follower's enrollment from Settings, with an explicit reset
  confirmation for the new identity.

### Shared MCP credentials

- MCP environment variables and headers accept `{ "fromSecret": "name" }`, naming
  a shared secret from `canonfig secrets`. Canonfig projects an installed stdio
  launcher for these servers and resolves the secret only when the server starts,
  so no value lands in harness configs, publications, exports or plans.
- `canonfig mcp run <name>` starts a server that way, passes stdio through
  untouched and exits with the server's code. Remote servers are bridged through
  a pinned `mcp-remote`, with headers passed in environment variables.
- Launchers keep the server's `fromEnv` names and the Linux credential-store
  session variables when a harness filters MCP environments, find npm across
  Node layouts including Homebrew, and replace environment names
  case-insensitively on Windows. Windows `.cmd` and `.bat` servers fail with
  instructions to configure the native executable, instead of running server
  arguments through a shell.

### Fixes

- Run the Windows scheduled sync without a console window. It used to show an
  empty window for the whole run, titled after the current command, such as
  `npm ls suno-api-cli`. The task keeps the sync's exit code. This needs Windows
  Script Host, which is on by default.

### Security

The five moderate findings from 7.5.0 remain in the TUF/minimatch chain under
`sigstore`. A new high-severity advisory in `picomatch` (GHSA-fc5q-39xc-vjpf,
ReDoS) reaches `fdir`, `tinyglobby` and `fumadocs-core`, `fumadocs-mdx` and
`fumadocs-ui`. These are used only by the documentation website and development
tools, not by the published package, and no fixed `picomatch` is released yet.
This release uses an approved exception to the clean-audit gate for both. The
website's `next` moves to 16.4.6, which fixes its moderate advisory.

### Upgrading

Use Node.js 24.15+ or 26+. Source and Followers must all use the 7.6 release line
before resuming synchronization; 7.5.x and 7.6.x do not synchronize with each other.
A 7.6.0 Source can roll followers on 7.5.x forward with a Fleet Update. Publish
`fromSecret` references only after every follower runs 7.6.0. On Windows, the
first sync that converges after updating re-registers the scheduled task with
the new launcher. If the follower's runs end in Human Action Required, run
`canonfig schedule set <calendar>` once instead.

## v7.5.0 - 2026-11-17

### Browser interface

- Plan and apply a Source's own files, or an unenrolled folder's, from Local sync,
  and recover or restore from Backups, without enrolling. Publishing stays a
  separate step.

### Fixes

- Find a tool on Windows right after its installer added it to the saved PATH.
  A tool such as ImageMagick, installed by winget earlier in the same run,
  failed its verification because the run kept the PATH it started with.
- Keep a self-updated package directory free of group and other write access.
  Under a 0002 umask the update left it group-writable, and the next update then
  refused to run.

### Security

The same five moderate audit findings as 7.4.0 remain in the upstream
TUF/minimatch dependency chain under `sigstore`. This release uses an explicitly
approved exception to the clean-audit gate; these denial-of-service advisories
are not fixed.

### Upgrading

Use Node.js 24.15+ or 26+. Source and Followers must all use the 7.5 release line
before resuming synchronization; 7.4.x and 7.5.x do not synchronize with each other.
A 7.5.0 Source can roll followers on 7.4.x forward with a Fleet Update.

On Linux or macOS under a 0002 umask, the 7.4.x updater that installs 7.5.0 still
leaves the package directory group-writable. Once 7.5.0 is installed, run
`chmod g-w,o-w <prefix>/lib/node_modules/@microck/canonfig` once; later
updates keep it closed.

## v7.4.0 - 2026-11-17

### Browser interface

- Browse all stored Source profile histories in Revisions, with recorded reviewers
  and resource-change counts. Look up an exact revision ID and inspect its complete
  stored record, approval metadata and canonical bytes.
- Edit agent harness bounds, HTTPS origins, leaf executables and secret bindings
  on a follower under any agent policy. Saving them never runs an agent.
- See stored receipt and recovery evidence on the overview after a fresh browser
  session, enrollment details for a selected follower, and a per-probe health
  check timeout.
- Change a schedule's time zone from a picker, and stop automation with a
  confirmed removal, as `canonfig schedule remove` does.
- Check and apply upstream skill updates for all tracked skills, or a selected
  set, in one reviewed batch. Publishing stays a separate step.
- Set, replace and remove follower-local secrets in the browser. Source secrets
  show where they came from.
- Accept the tools a Source scan discovers after reviewing them, as
  `canonfig source scan --write` does, without publishing.

### Remote shells

- Add `canonfig schedule run` to start this machine's installed synchronization
  job now and wait for its result. Use it over SSH, where Windows Credential
  Manager and the macOS login Keychain are unavailable and `canonfig sync`
  cannot read the follower credential: the job runs in your signed-in session.
  It reports the run's outcome and id, supports `--timeout-ms` and `--json`,
  and refuses a missing, disabled or changed job. A timeout leaves a job that
  is still running alone.

### Synchronization

- Keep applying a run past a resource that needs a person, such as a tool with
  no installation recipe for this platform. Resources that depend on it wait,
  the run still ends Human Action Required, and it lists every resource that
  needs attention. Before, one such tool stopped everything after it.
- Record the resources a Human Action Required run applied and verified, so the
  next run does not report Canonfig's own writes as Follower Drift.

### Fixes

- Accept Fleet Update directives on a follower whose clock is up to five minutes
  behind the Source. Any follower even slightly behind refused every directive
  as expired, so rollouts never reached it.
- Put back skills or other items that are missing entirely from a directory
  Canonfig manages, such as a harness skills folder, when nothing else there
  changed. Before, this was reported as Follower Drift and stopped every later
  run. A file missing from inside a skill is still Follower Drift.

### Security

The same five moderate audit findings as 7.3.0 remain in the upstream
TUF/minimatch dependency chain under `sigstore`, whose latest release still
depends on the affected range. This release uses an explicitly approved
exception to the clean-audit gate; these denial-of-service advisories are not
fixed.

### Upgrading

Use Node.js 24.15+ or 26+. Source and Followers must all use the 7.4 release line
before resuming synchronization; 7.3.x and 7.4.x do not synchronize with each other.
Finish or recover any unfinished run with the CLI build that created it before
installing 7.4.0.

A Fleet Update from a 7.4.0 Source reaches 7.3.x followers, but a 7.3.x follower
whose clock is behind the Source's still refuses its directive as expired; the
fix applies once the follower runs 7.4.0. Correct that machine's clock, or stop
its browser interface and run `npm install --global @microck/canonfig@7.4.0`
there. On a Source, stop the service and browser interface, update, then start
them again with their original address and port.

## v7.3.0 - 2026-11-16

### Machine-local controls

- Manage kept-local skill names and native MCP preservation from `canonfig local`
  and the machine-local settings page. Both preserve concurrent edits and keep
  these choices on this machine.

### Fixes

- Verify Windows npm packages whose command shims launch native executables
  directly, without invoking a shell or changing their arguments.
- Restore captured Windows permissions without reassigning an unchanged owner,
  while preserving inheritance flags and leaving child permissions unchanged.

- Reset the Publish dialog's reviewer to the workspace default after Cancel or
  Escape, without losing the draft when validation fails.
- Load Source revision details by their unique ID so profile histories with the
  same revision number cannot show each other's published resources.

### Security

Five moderate audit findings remain in the upstream TUF/minimatch dependency
chain. This release uses an explicitly approved exception to the clean-audit
gate; these denial-of-service advisories are not fixed.

### Upgrading

Use Node.js 24.15+ or 26+. Source and Followers must all use the 7.3 release line
before resuming synchronization; 7.2.x and 7.3.x do not synchronize with each other.
Before installing 7.3.0, finish or recover any unfinished run with the CLI build
that created it. If recovery fails, retain its journals and rollback snapshots,
follow the reported recovery instructions, and do not switch packages.

Stop the browser interface before installing
`npm install --global @microck/canonfig@7.3.0`. On a Source, record and remove
the service first, prepare credential access and required native overrides,
then reinstall the service with its original address and port.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing source folders
during import.

## v7.2.0 - 2026-11-16

### Security

- Update Sigstore and its bundle library to 5.0.1, including the fix for
  verification silently dropping `certificateOIDs` constraints and patched
  filesystem traversal dependencies.
- Five moderate audit findings remain in TUF's `minimatch` dependency chain.
  Publication uses an explicitly approved exception to the clean-audit gate;
  these denial-of-service advisories are not fixed.

### Fleet updates

- Roll out the Source's exact stable release to enrolled Followers with
  `canonfig source update --canary <follower-id> --apply` or Settings > Version.
- Followers check on their next CLI `sync --apply`, including scheduled runs.
  The canary must converge before the rollout continues; a failed health check
  halts it, and offline Followers stay queued.
- Verify the Source signature, official npm publisher provenance, and package
  integrity before activation. Active commands and unfinished runs defer updates.
  Downgrades and state-format changes require manual recovery.

### Tailnet

- Detect Tailscale during health checks, setup planning and Source service setup.
- Serve the Source and browser interface directly on your tailnet with `--tailnet`.
  MagicDNS invitations enroll and sync without an SSH tunnel. Headscale custom
  domains work through the native Tailscale client.
- Keep TLS certificate pins and signed revisions. Tailnet startup refuses
  unavailable, expired or userspace-only clients and never changes Serve settings.

### Installers

- Keep Homebrew formula names intact, check the available version before installing, and verify the installed keg against the pin.
- Add digest-verified single-executable binary recipes for explicit platforms and architectures. The destination directory must exist; archives, build steps, and automatic replacement of different existing bytes are not supported.

### Documentation

- Document machine-local skill and MCP preservation, first-adoption review, and upgrade/UI handoff in the bundled Canonfig skills.
- Clarify upgrade instructions: `canonfig self-update apply` previews an update; `canonfig self-update apply --apply` installs it. Source service installation starts immediately, so prepare credential access and required native overrides first.

### Upgrading

The updated dependencies require Node.js 24.15+ or 26+. Update Node.js before
installing this release; Node.js 25 is not supported by these dependencies.

Source and Followers must run the same major.minor version. Upgrade every
machine to 7.2.0 before resuming synchronization; 7.1.x cannot sync with 7.2.x.
Finish or recover unfinished runs with the CLI build that created them first.

Stop the browser interface before installing
`npm install --global @microck/canonfig@7.2.0`. On a Source, remove its service
before installation and reinstall it afterwards. Prepare unattended credential
access and required native service overrides before reinstalling: installation
starts the service immediately. Follow the documented upgrade procedure for
your platform. This release does not update existing machines by itself.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing source folders
during import.

## v7.1.12 - 2026-11-15

This release lets a machine keep selected skills and its own MCP servers while
the rest of the Source's setup syncs. It works on Followers and on the Source
when it syncs its own folder.

### Keep selected skills local

Add skill names to `excludeSkills` in the machine's
`~/.canonfig/local/local.jsonc`:

```json
{
  "excludeSkills": ["deploy", "review"]
}
```

Those skills stay as they are in every harness skill folder on that machine,
including `~/.agents/skills` and Hermes's skill folders. Canonfig does not
write, check or delete them, and other Source skills still sync. If Canonfig
managed one before, the next successful sync gives it back to the machine with
its current files. This needs `skills` in the Source's `local.appendLocal`.

### Keep native MCP servers

Set `"preserveMcp": true` in the same file to leave each harness's MCP server
list exactly as it is, including options the canonical format cannot express.
New Source servers are not written either. Instructions, skills, commands and
other settings still sync, and agent files still name the Source's servers.

Removing either setting does not quietly take over local copies. The next
sync stops and says what to resolve.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Before upgrading, finish or recover any unfinished run with the CLI build that
created it.

Install with `npm install --global @microck/canonfig@7.1.12` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

A `secrets.json` written before `retiredReferences` existed is refused. Back it
up, add `"retiredReferences": []` to it, and run the command again.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.11 - 2026-11-15

This release makes the Source Overview tell the truth about what is published,
and tidies how terms and explanations show up.

### Source Overview

- The Overview now shows the newest published revision, for example "Revision
  3 is published". Before, a Source with published revisions still showed a
  gray "Publish the profile to send it to your other machines".
- With nothing published it says "Nothing published yet", and if the
  revisions cannot be read it says so and shows the error.
- It never claims machines are up to date. Followers don't report which
  revision they applied, so the Overview says it can't tell which machines
  have it yet, and that edits saved since then need a new revision.
- "Other machines can't reach this Source" still comes first when the Source
  service is not serving.
- The Revisions list and the revision details show the newest revision first.

### Everywhere

- A term inside a sentence, such as "as a follower", is underlined again and
  explains itself on hover or focus. Titles and labels keep the small (?)
  button.
- On a Follower's Sync page, the explanations under "Your own changes" and
  "Preview instructions files" moved into (?) tooltips next to their titles.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Before upgrading, finish or recover any unfinished run with the CLI build that
created it.

Install with `npm install --global @microck/canonfig@7.1.11` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

A `secrets.json` written before `retiredReferences` existed is refused. Back it
up, add `"retiredReferences": []` to it, and run the command again.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.10 - 2026-11-14

This release cuts clutter from the Follower pages and shows the Source the way
you customized it on every machine's map.

### Follower pages

- Overview shows each sync step (Source address set, Joined, Profile chosen,
  Source reachable, Up to date) with a status mark instead of the word
  "Reached", and its header turns green once the machine is up to date.
- Sync lists only the changes it makes. Items that already match, or that were
  verified, collapse into one line you can open. Revision and run IDs move
  under "Technical details".
- Commands in Sync and Schedule messages show as code. The notice about a
  harness that cannot take an item now reads, for example, "Codex has no global
  slash-command directory. Profile commands were not added there."
- Enrollment keeps each fingerprint on one line, and Local settings lines up
  the Backups switch with the table above it.
- "Held items" and "Private adoption review" on Sync now say what they do.

### Everywhere

- Terms that used to be underlined show a small (?) button instead, and their
  explanations are easier to read.
- The Source card's name, icon and colour, customized on the Source, now show
  on every Follower's map. Close the Customize panel to share a change. An
  uploaded icon stays in the browser where you added it, and anything you
  customize on a Follower still applies only there.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Before upgrading, finish or recover any unfinished run with the CLI build that
created it.

Install with `npm install --global @microck/canonfig@7.1.10` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

A `secrets.json` written before `retiredReferences` existed is refused. Back it
up, add `"retiredReferences": []` to it, and run the command again.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.9 - 2026-11-13

This release clears a health check warning that never went away on Linux and
Windows, and fixes two small things on the Machines page.

### Fixes

- Health check now tests the keyring on Linux (Secret Service) and Windows
  (Credential Manager) by saving, reading back and deleting a throwaway value,
  as macOS already did. A working keyring now passes instead of showing
  "write and unattended access are not verified" forever. If the test fails,
  the check says to start and unlock the keyring, with the provider's error in
  its details.
- Add machine fills in the Source's address in "Address it connects to"
  instead of opening with an empty box. An address you typed is kept the next
  time you open it.
- A renamed machine's card shows only the name you chose. The hostname moves
  to the name's tooltip.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Before upgrading, finish or recover any unfinished run with the CLI build that
created it.

Install with `npm install --global @microck/canonfig@7.1.9` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

A `secrets.json` written before `retiredReferences` existed is refused. Back it
up, add `"retiredReferences": []` to it, and run the command again.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.8 - 2026-11-13

This release finds agent CLIs installed with npm, removes the Source agent
policy page that broke the health check, and makes tool discovery and the
harness list faster and quieter.

### Breaking change: agent policy is set on Followers only

Agents run only on Follower Machines, so agent policy now lives there alone.

- `canonfig agent policy` on a Source or an unenrolled machine exits 2 with
  "agent policy is set on each Follower Machine; this machine is not an
  enrolled Follower Machine". The browser's agent routes refuse the same way.
- Source settings no longer have an agent policy page.
- `~/.canonfig/policy.json` is ignored. You can delete it.

### Fixes

- Harness detection finds CLIs installed with npm under nvm, such as codex,
  pi, droid and opencode, when Canonfig runs from a service without your
  shell PATH.
- Health check no longer fails with "configured agent policy requires an
  adapter" on a Source. A failed check shows in the list instead of an
  "Operation failed" box above it, and a missing secret-tool warning is one
  line with the install command.
- Discover tools lists programs, not words. Inline code in prose and commands
  after a pipe count only when they name an installed program, and shell is
  read the way the shell reads it, so keywords, flags, heredocs, here-strings
  and function names no longer appear as tools. On an 80-item profile the list
  went from 3,262 entries to 98. The results list scrolls inside the dialog.
- Changing what a harness gets saves once when the Gets menu closes, instead
  of on every tick. The Root column says "Not synced here yet" instead of
  "Not taken over yet".

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Before upgrading, finish or recover any unfinished run with the CLI build that
created it.

Install with `npm install --global @microck/canonfig@7.1.8` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

A `secrets.json` written before `retiredReferences` existed is refused. Back it
up, add `"retiredReferences": []` to it, and run the command again.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.7 - 2026-11-11

The browser UI has shorter copy and more direct ways to fix setup problems.

### Health checks and recovery

- Health check hides skipped checks and shows passing checks by name. Problems
  explain what to do, with buttons to edit the tool list, open installers, or
  open agent policy where the browser can help.
- A missing Linux Secret Service client now includes a distribution-specific
  install command. Image-based Fedora and RHEL systems get an rpm-ostree
  command that accepts packages already installed, plus reboot guidance.

### Less clutter

- Source and Follower pages remove repeated explanations while keeping scope,
  consequences, and recovery instructions. Groups and Follower secrets have
  clearer empty states.
- Fingerprints fold into technical details. Source pages no longer show
  Follower lifecycle and tunnel sections.
- Harness bounds remain visible but disabled on a Source, labeled
  "Set on each Follower". They remain editable on Followers when agent policy
  allows it.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Before upgrading, finish or recover any unfinished run with the CLI build that
created it.

Install with `npm install --global @microck/canonfig@7.1.7` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

A `secrets.json` written before `retiredReferences` existed is refused. Back it
up, add `"retiredReferences": []` to it, and run the command again.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.6 - 2026-11-10

Settings pages show less text, and installers can be set up from the browser.

### Installers in the browser

- Settings, Installers lists the package managers it finds on this machine,
  each with an Add button. Add installer opens a form for any other path.
- Canonfig checks an installer runs before it saves it, the same check as
  `canonfig installer set`. Each installer can be removed from its row.

### Cleaner settings

- Explanatory paragraphs are gone from Version, Health check, Source service,
  Agent policy, Setup and the Follower tunnel and schedule pages.
- Health check runs when the page opens.
- Setup shows one list of steps, named after the tool they check, with the
  reason under any step that failed.
- Error boxes keep the message and fold category and exit code into
  Technical details. Source service folds its manager details the same way.
- Commands inside messages are shown as code.

### Fixes

- An invalid `~/.canonfig/secrets.json` now names the file and the fields it
  needs, without showing any of its content.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Install with `npm install --global @microck/canonfig@7.1.6` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

A `secrets.json` written before `retiredReferences` existed is refused. Back it
up, add `"retiredReferences": []` to it, and run the command again.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.5 - 2026-11-10

The browser interface reports Source service problems once, at the top of the
window, instead of as an error on each page.

### Source service bar

- A bar above the workspace names the problem and offers the fix. It is red
  when other machines cannot get new revisions and yellow when the service is
  only out of date and still serving. You can close a yellow bar.
- Reinstall keeps the address and port the service already uses.
- Overview turns red when other machines cannot reach the Source.
- Category and exit-code details no longer appear on every page. Settings,
  Source service still shows the full status.

### Fixes

- Empty Revisions, Secrets, Profile and Machines lists place their dithered
  background on the bottom edge of the page.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Install with `npm install --global @microck/canonfig@7.1.5` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.4 - 2026-11-09

Source setup shows fewer technical details and separates reviewing changes from
creating the Source.

### Review and approve setup

- Review planned changes in a compact list. Full diagnostics remain in Settings,
  Setup.
- "Approve setup" expands into a name field on the same line without changing
  the card's height. Continue records your approval; creating the Source remains
  a separate action.
- Returning from Import clears the previous approval name, so a changed plan
  requires you to enter it again.
- The Create step shows who approved the plan instead of repeating the list.
- Different local import versions have a warning button that shows their source
  paths. Opening it does not change your selection.
- The dithered background shows activity while Canonfig checks the machine.
  Reduced-motion settings keep it still.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Install with `npm install --global @microck/canonfig@7.1.4` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.3 - 2026-11-09

Source setup includes `~/.codex/skills` and other supported tool folders when
scanning for skills.

### Import existing skills

- Import follows supported skill-folder links without changing the originals.
- Expand "Shared skills" to see its folder path and the selected tools that
  read it.
- Tree branches open and close with a short animation. Reduced-motion settings
  disable it.

### Import safeguards

- Skills containing hard-linked files or aliases of protected configuration
  files are skipped.
- The 1 MiB file limit also applies to generated `SKILL.md` files. Batch limits
  count the converted content, not its original text.
- Selected content above 64 MiB stops the import before any writes. Select fewer
  items or reduce file sizes, then scan, review and approve again.

### Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

### Upgrading

Install with `npm install --global @microck/canonfig@7.1.3` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.2 - 2026-11-08

Source setup's Import step is now a tree of your AI coding tools, and the AI
tools step asks one plain question.

### Import step

- Each tool, plus the shared `~/.agents` folder, is a collapsed row that opens
  into categories and then items. Tool and category rows have a checkbox that
  selects everything under them, and a search opens every branch with a match.
- Checking an item under a tool imports that tool's copy. A copy that is
  identical in another tool is checked there too. When the content differs,
  the other tools show which version is used, and checking it there switches
  to that version.
- Checking a whole tool or category takes only items nobody has decided yet:
  it never replaces a version you picked from another tool, and never selects
  an MCP server that needs a password or token.
- An MCP server that needs a password or token names the environment variable
  on its row ("Needs `$TOKEN`"), and checking it is your consent to replace the
  value with that variable. The separate "Replace saved passwords..." switch is
  gone.
- A choice made under a tool you then remove on the AI tools step is kept and
  comes back when you add the tool again.
- Each tool lists what it can't import under one line, grouped by reason.
- The explanatory paragraphs above and below the list are gone.

### AI tools step

The step asks "Which tools sync with `~/.canonfig/`?" and says that syncing
replaces their instructions, skills and MCP servers, and that unchecked tools
are left alone except for skills in the shared `~/.agents/skills/` folder.

### Upgrading

Install with `npm install --global @microck/canonfig@7.1.2` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.

## v7.1.1 - 2026-11-08

The Import step in Source setup is usable with a real collection of skills and
MCP servers, and every setup screen explains its terms for someone new to
Canonfig.

### Import step

- The step lists every item your AI coding tools offer, grouped by category,
  with search, a category filter and a count of what you selected. It no
  longer shows a wall of raw "import skipped" and "import collision" lines.
- An item with identical content in several tools is one row that lists each
  tool. Only items whose content differs ask you to choose, and the
  "Needs a choice" filter shows just those. Each one has a version picker
  with a "Skip import" option.
- Items that can't be imported sit in one collapsed section, grouped by
  reason, and the common reasons say how to fix the original file.
- Setup no longer stops offering imports after 256 items. A machine with a
  few thousand skills and servers can import all of them.
- Opening a `canonfig ui` page without signing in shows a short page that
  points to the sign-in link, instead of a raw JSON error.

### Setup wording

Setup now says what a Source, a follower, a profile and an AI coding tool are
before it asks you to choose. Error messages say what failed and what to do
next, and the fingerprint check explains how to compare fingerprints before
you confirm them. Joining or creating a Source still changes none of your AI
coding tools' files.

### Upgrading

Install with `npm install --global @microck/canonfig@7.1.1` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 refuses that
setup's journal, `~/.canonfig/setup.json`, and tells you to move it aside.
Check whether setup already changed anything, move the file aside, and start
setup again. Do not remove `state.sqlite`.

## v7.1.0 - 2026-11-08

`canonfig ui` can now be used from other devices on your tailnet, and
`canonfig self-update` can move to new minor and major versions.

### Reach the browser interface over Tailscale

- `canonfig ui --host <address>` listens on this machine's Tailscale address
  instead of `127.0.0.1`. It accepts loopback and Tailscale ranges only
  (`::1`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`) and refuses any other
  address, because the interface is served over plain HTTP. `100.64.0.0/10`
  is also used for carrier-grade NAT, so pass the address `tailscale ip`
  prints; on any other network the sign-in link and session cookie would
  travel unencrypted.
- `canonfig ui --port <n> --origin <https-url>` works behind an HTTPS proxy
  such as `tailscale serve`. The printed sign-in link uses that address, and
  the browser session cookie is marked `Secure`.

```bash
tailscale serve --bg 5317
canonfig ui --port 5317 --no-open --origin https://atlas.tailnet.ts.net
```

The sign-in link still works only once, and requests from any other host or
origin are still refused. Without these options `canonfig ui` listens on
`127.0.0.1` only, as before.

### Self-update beyond patches

- Automatic updates (`canonfig self-update auto`) install the newest patch in
  your current `major.minor` line, or the newest release of a newer major
  version when one exists. They never move to a new minor on their own.
- Manual updates (`canonfig self-update apply` and the Version page in
  `canonfig ui`) install the newest release in your current major version,
  including new minors. A newer major is reported with the command that
  installs it.
- An update to a new minor or major warns that a Source and its Followers
  only pair on the same `major.minor`, so every machine needs it. A major
  update also warns that it may refuse older state.

### Fixes

- The Machines page no longer shows the List view's loading skeleton on the
  Map, or the Map under the List's skeleton, when switching views.
- The Map's loading skeleton no longer shows a stray dot for an unreachable
  machine's connection.

### Upgrading

Stop running Canonfig commands, including `canonfig ui`, before installing. A
Source's background service keeps running the old code until it restarts, so
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

Install with `npm install --global @microck/canonfig@7.1.0` on every machine.
Machines on 7.0.x run the earlier updater, which installs patches only, so
`canonfig self-update` cannot reach 7.1.0 from there; from 7.1.0 on it can
move between minor versions. A 7.1 Source and its Followers must all run
7.1.x, because Canonfig only pairs machines on the same minor version.

## v7.0.0 - 2026-11-07

This release makes Canonfig's long-running operations recover correctly after
a crash, a lost connection, or a late reply. Each one now records exactly which
step it reached, so an interrupted operation resumes or reports what to do
instead of guessing.

### Breaking change: set machines up again

Canonfig 7.0.0 uses a new state format and does not read state written by 6.x.
On a machine that ran 6.x, the first 7.0.0 command that opens Canonfig state
(such as `canonfig status` or `canonfig sync`) refuses the old state and tells
you to move `state.sqlite` aside and set the machine up again. Nothing is
changed before that refusal.

Install with `npm install --global @microck/canonfig@7.0.0` on every machine,
then set up the Source and enroll each Follower again. A 7.0 Source and 6.x
Followers refuse each other, so update them all.

### Synchronization

- A sync is no longer marked complete before its last cleanup step finishes.
  An interrupted sync resumes that step on the next run.
- Rollback keeps the files it needs to restore your harness until the restore
  has finished, and reports a rollback that could not finish.
- A blocked action is reported as blocked, not as skipped.

### Machines and enrollment

- Setting up a Source can no longer leave it half initialized.
- Replacing or removing a Follower's enrollment keeps the old credential until
  the change is confirmed. If the Source cannot be reached to confirm a
  rollback, `canonfig status` and `canonfig doctor` show the pending rollback
  and the command that finishes it.
- If the Source restarts while a Follower is joining for the first time, the
  Follower drops the discarded enrollment and you can enroll again with a new
  invitation.
- Unattended run receipts now live in the state database.
- Shared secrets, tunnels, setup steps, skill updates, and the Source service
  install now each record their progress, so an interruption leaves a clear
  state.
- `canonfig self-update` reports an installed update as installed, with a
  warning, when only its follow-up bookkeeping failed.

### Browser interface

- Late replies can no longer overwrite newer edits in the profile editor,
  local items, secrets, policy, or onboarding.
- A follower command whose status check failed recovers instead of looking
  finished.
- A failed tool scan offers a retry, and a running revocation cannot be
  dismissed.

## v6.1.1 - 2026-11-06

The settings page for Canonfig itself in `canonfig ui` is now called Version in
the sidebar, page header, and machine menu. There are no other changes.

Machines running 6.1.0 can update with `canonfig self-update` or
`npm install --global @microck/canonfig@6.1.1`.

Canonfig 6.1.0 and 6.1.1 work together.

## v6.1.0 - 2026-11-06

### Use Canonfig in your browser

`canonfig ui` opens a browser interface for this machine's actual Canonfig state.
It runs in the foreground on `127.0.0.1` and opens a one-time login link.
Keep that link private and keep the terminal open while using the interface.
Node.js 24 or newer is required.

```sh
canonfig ui
canonfig ui --port 5317 --no-open
```

Without `--port`, the operating system chooses a free port. `--no-open` prints
the login link instead of opening the browser. Stop the server with Ctrl-C.
The public demo still uses made-up machines, not your configuration.

On a Source, you can set up the machine, edit the profile and its harnesses and
groups, validate and publish revisions, manage upstream skills and shared
secrets, export the profile, and invite or revoke followers. On a Follower,
you can join a Source, inspect and apply sync plans, recover or abandon
interrupted runs, edit allowed local items and overlays, manage harness
exclusions and key claims, restore backups, refresh secrets, configure schedules
and tunnels, and unenroll. Both roles expose status, doctor checks, agent policy,
installer checks and the applicable service settings.

Profile and local configuration edits preserve comments. If a file changed
since the browser read it, saving refuses the conflict instead of overwriting
the other edit. Reload to compare the disk version with your draft, then discard
or re-apply your edits. Machine-map names, icons, colours and layout stay in the
browser; they do not rename machines or change enrollment identities.

You can check, enable, disable and install self-updates from the Canonfig version
page. Stop other Canonfig processes before updating. After a successful update,
the GUI server exits and asks you to start `canonfig ui` again.

Archive import, installer binding and removal, and agent-assisted apply remain
CLI-only. Invitation cancellation, selective scan writes, service restart and
private-review deletion are not available in the live GUI; these are not
supported CLI operations either.

### Fixes and behavior changes

- Windows Ctrl-Break and console-close signals now shut Canonfig down cleanly.
- Leases left by dead processes no longer block self-update. Running Canonfig
  processes still block activation.
- Applying sync from the GUI refreshes shared secrets. CLI sync behavior is
  unchanged.
- The npm package is larger, about 1.24 MB packed, because it includes the GUI.

### Upgrade all machines together

Install the release on every Source and Follower:

```sh
npm install --global @microck/canonfig@6.1.0
canonfig --version
```

6.0 and 6.1 are different major.minor lines. Every Source and Follower must move
to 6.1 together; mixed lines fail the source/follower version handshake.
Self-update stays within a major.minor line and will not move 6.0.x to 6.1.
Once on 6.1, it can install stable 6.1.x patch releases.

## v6.0.0 - 2026-11-05

This major release replaces repo-level harness projects and the hand-written
profile with one global folder, `~/.canonfig/`. Node.js 24 or newer is required.

### Breaking: the global `~/.canonfig/` folder

`~/.canonfig/` holds `canonfig.jsonc`, `AGENTS.md`, `rules/`, `skills/`,
`agents/`, `commands/`, `hooks/` and `files/`. `canonfig sync` writes each
harness listed in `canonfig.jsonc` in that harness's own format. Canonfig
supports 16 harnesses, including Claude Code, Codex, Antigravity, Oh My Pi,
Pi, Amp, OpenCode and Cursor; see the harness reference for the full list. It
manages configuration only and never touches logins, tokens, sessions or
history.

On the Source Machine, `canonfig source publish --reviewer <name>` signs the
folder as a Profile Revision. Followers mirror it and write their harnesses in
one journaled run. Items for one machine only go in `~/.canonfig/local/`.

Before Canonfig first writes a harness file, it copies what was there to
`~/.canonfig/.backups/`. It keeps the first snapshot and the 4 most recent.
`canonfig restore` puts a snapshot back. `canonfig sync --no-backup`, or
`"backups": false` in `~/.canonfig/local/local.jsonc`, turns snapshots off on
that machine.

`canonfig setup` detects installed harnesses and selects them, and offers a
reviewed import of existing instructions, skills and MCP servers. Imported
literal secrets become `fromEnv` references.

New commands: `canonfig harnesses`, `canonfig harnesses include|exclude`,
`canonfig restore`, and a `harnesses` probe in `canonfig doctor`.

Removed: repo-level `canonfig harness` projects, the hand-written profile file
with `--profile-file`, `canonfig profile select`, `follower enroll --profile`,
`source digest`, `source reconcile-skills` and `setup --scope project-only`.

### Pick what each harness gets

`surfaces.<harness>` in `canonfig.jsonc` limits a harness to some categories:
`instructions`, `rules`, `skills`, `agents`, `commands`, `hooks`, `mcp` and
`settings`. A harness that `surfaces` does not name gets every category.
Outputs a harness stops getting are removed like those of an unlisted harness.
Canonfig refuses a `surfaces` entry for a harness that `harnesses` does not
list, and a category the harness cannot take. The shared `~/.agents/skills/`
directory is written when any harness that reads it gets `skills`.

### One role per machine

A machine is a Source or a Follower, never both. On an enrolled follower,
`source init`, `scan`, `publish`, `serve`, `service install`, `invite`,
`revoke` and `setup plan --role source` exit 2 before changing anything and
name the Source the machine follows; run `canonfig follower unenroll` first.
On a Source, `follower enroll` and `setup plan --role follower` exit 2 before
the invitation is used.

### Export and import

`canonfig export` writes the folder and `local/` to a private `.tar.gz`
(mode 0600) with a `manifest.json` listing the size, SHA-256 and mode of every
file. `state.sqlite`, backups, logs and credentials are never included, and a
literal credential in the folder stops the export. On a Source, the export is
signed with the Source signing key. `--include-harnesses` adds the harness
files Canonfig manages, but only while they still hold what Canonfig wrote.

`canonfig import <file>` checks every checksum and the signature, and refuses
links, devices, `..` paths and files outside the allowlist before it writes
anything. `--expect-key <fingerprint>` also refuses unsigned archives and
archives signed by another key. Import writes the folder as one journaled run,
so a failure rolls back and `canonfig recover` works. A folder that already
has content needs `--replace`, which first saves the replaced entries to
`~/.canonfig/.backups/`; `canonfig restore <id>` puts them back. Import is
refused on an enrolled follower and never writes harness files; run
`canonfig sync` afterwards.

### Keep a machine's own content

- append-local: with `local.appendLocal` in `canonfig.jsonc`, Canonfig owns
  only a marked section of each instructions file and only the skill
  directories it writes. The machine's own text and skills stay, and the first
  adoption keeps everything already there. `canonfig sync --plan
  --review-local` writes private reviews of the exact texts before you apply.
- `instructions` in `local.allow` lets `local/AGENTS.md` be appended to the
  published `AGENTS.md` in every harness.
- Local overlays: `canonfig overlay list|set|remove` lets an item in
  `local/` replace the published item of the same name. A key claim,
  `settings/<harness>#<key>`, keeps one settings key on this machine while the
  other keys still follow the Source.
- Authored resources: `resources.<id>` in `canonfig.jsonc` with content under
  `files/` manages a `file`, a `directory` or keys in a `config` file outside
  the harnesses. Resources publish, honor follower groups, get takeover
  snapshots, drift checks and restore, and may not target harness folders,
  `~/.agents`, `~/.canonfig` or protected files such as `~/.codex/auth.json`.

### Interface demo

The demo at https://canonfig.micr.dev adds a per-harness "Gets" menu, skill
upstream tracking and update checks, a Canonfig version page for self-update,
an import step in setup that lists what each item loses on import, and export
buttons. The demo runs on simulated data. This release does not ship a
`canonfig ui` command.

### Upgrade boundaries

There is no in-place upgrade from 5.x. Canonfig 6.0.0 refuses state from an
earlier release before writing anything ("Canonfig state at `<path>` was
created by an earlier Canonfig version", exit 3). On each machine, move
`~/.canonfig/state.sqlite` aside and set the machine up again: run
`canonfig setup plan` on the Source, then enroll each follower with a new
invitation. Every Source and Follower must run the same major.minor release;
a mismatch fails with "source/follower version mismatch" (exit 2), so move
every machine to 6.0.0.

### Verification

Publication is gated on repository validation, packed CLI checks and native
Linux/macOS/Windows x64 and Windows ARM64 acceptance. Verify the published npm
artifact, provenance and matching GitHub tag after publication. Release
preparation alone does not assert that publication succeeded.

## v5.0.1 - 2026-11-03

This patch fixes how Follower Machines check Configuration Agent install paths.
Node.js 24 or newer is required. The Source/follower protocol and state schema
are unchanged on the 5.0.x line, so 5.0.0 and 5.0.1 machines sync with each
other and can be updated one at a time.

### Agent install paths

A profile's `agentInstall.paths` entries that start with `~`, such as
`~/.local/bin`, are now expanded on the follower before the harness bounds
check. Before 5.0.1 these entries never matched the shell-expanded
`--allow-path` values, so the follower refused the agent (#242).

`canonfig agent harness` now stores each `--allow-path` value as an absolute
path, so a quoted `~` or a relative path works. The bounds check compares whole
path segments and ignores case on Windows, so `/opt/bin` no longer covers
`/opt/binaries`.

Harness settings saved with a literal `~` before 5.0.1 are not converted. Rerun
`canonfig agent harness codex`, `claude` or `custom` with the same options to
store absolute paths.

### Upgrade boundaries

Update from 5.0.0 machine by machine; finish any interrupted run with
`canonfig recover` first and restart the Source after replacing its package.
From 4.x, follow the 5.0.0 boundaries: pause synchronization, upgrade the Source
and all followers to 5.0.1 together, replace any stored `gemini` harness, and
verify before resuming. In-place migration from 3.2.x remains unsupported.

### Verification

Publication is gated on repository validation, packed CLI checks and native
Linux/macOS/Windows x64 and Windows ARM64 acceptance. Verify the published npm
artifact, provenance and matching GitHub tag after publication. Release
preparation alone does not assert that publication succeeded.

## v5.0.0 - 2026-11-02

This major release changes the Configuration Agent harness options and adds
opt-in patch self-updates. The documentation now lives at
https://canonfig.micr.dev/docs. Node.js 24 or newer is required.

### Breaking: agent harness changes

The `gemini` harness is removed. Gemini CLI has been replaced by Google's
Antigravity CLI, so the adapter targeted a tool that no longer ships.
`canonfig agent harness` now accepts `codex`, `claude` and `custom`.

`codex` and `claude` take an optional `--model <name>`, which Canonfig passes as
the CLI's own `--model` flag; leave it out to use the agent's default. Their
read-only flags stay fixed, so they do not accept free-form arguments.

`custom` runs any agent executable with exactly the arguments given by repeated
`--argument` options, without a shell. Canonfig writes the Agent Task as a
`canonfig.agent-task/v1` JSON document to its standard input and reads a
proposal JSON object (`summary` and `actions`) from its standard output.
Canonfig cannot force a custom agent into a read-only mode; start it in its own
plan or read-only mode through its arguments. Every proposed action is still
checked against the configured allowlists, and output that is not a proposal is
refused. `--model` is rejected for `custom`.

A follower that stored a `gemini` harness is not converted. After the upgrade,
commands that read it, such as `canonfig status`, stop with "the gemini agent
harness was removed in 5.0.0" (exit 2). Run `canonfig agent harness codex`,
`claude` or `custom` with the executable and allowlist options it needs to
replace the stored harness, then continue the upgrade checks.

### Opt-in patch self-updates

`canonfig self-update enable|disable|status|check|apply|auto` installs stable
patch releases in the current major.minor line for user-owned global npm
installations. Commands that change anything preview unless given `--apply`.
Candidates are staged with lifecycle scripts disabled and checked before
activation, and the previous package is kept as a backup. Active Canonfig
commands defer activation; unfinished synchronization runs stop it.
Self-update never crosses a major or minor version, installs no OS service and
does not restart services. Read `docs/self-update.md` before enabling it: stop
existing Canonfig processes and schedules first.

### Documentation site and interface demo

The documentation moved to https://canonfig.micr.dev/docs. Links to the
previous documentation pages redirect to the same page under `/docs`.
https://canonfig.micr.dev now serves an interactive demo of the upcoming
browser interface. It runs on simulated data and is not connected to a
machine; this release does not ship a `canonfig ui` command.

### Upgrade boundaries

State and signed-revision formats are unchanged, so 4.x installations update
in place. The major.minor handshake rejects mixed 4.x/5.0 fleets. Pause
synchronization, upgrade the Source and all followers to 5.0.0, restart the
Source with its prior settings, replace any stored `gemini` harness, and verify
before resuming. Finish unfinished runs with their original build and retain
backups. In-place migration from 3.2.x remains unsupported.

### Verification

Publication is gated on repository validation, packed CLI checks and native
Linux/macOS/Windows x64 and Windows ARM64 acceptance. Verify the published npm
artifact, provenance and matching GitHub tag after publication. Release
preparation alone does not assert that publication succeeded.

## v4.2.0 - 2026-10-28

This feature release adds opt-in automation for tracked skills, authored source
profiles and local harness projection. Node.js 24 or newer is required.

### Automatic tracked skill updates

`canonfig skills auto` previews by default. `--apply` runs a foreground update
loop (24 hours by default); `--once` supports an explicit external scheduler.
Selected sources are frozen and revalidated under the update lock. Local drift
and failures stop the updater. It does not install an OS service, publish a
profile, force an overwrite or apply harness configuration.

### Source skill deletion reconciliation

`canonfig source reconcile-skills --profile-file FILE` previews removal of
previously observed source-backed skills that have disappeared. `--apply`
records observations and makes validated, backed-up JSONC edits; `--watch`
repeats the process. Changed resource identities, inaccessible parents and
unsafe dependencies fail closed. Other profile writers must be stopped.
Profile publication and follower synchronization remain explicit separate steps.

### Live local harness projection

`canonfig harness watch` projects supported canonical configuration into enabled
harnesses while running in the foreground. Two matching plans are required
before each serialized apply. It recreates deleted generated outputs, cleans up
retired ownership and avoids idle writes. Drift, invalid saves and apply errors
stop the watcher rather than overwriting local edits. SIGINT/SIGTERM waits for
in-flight cleanup. Continuous dry-run and strict mode are supported.

The watcher does not coordinate other apply/clean processes or external editors;
stop those writers first. It does not install a background service, refresh a
running harness process, transfer credentials or change machine sync transport.

### Dependency maintenance

Pin transitive Zod to 4.6.7 to resolve GHSA-mrhx-c7xc-m3w5 in documentation
and test tooling. The release candidate is rebuilt and revalidated with this
lockfile.

### Upgrade boundaries

State and signed-revision formats are unchanged. The existing major.minor
handshake rejects mixed 4.0/4.1/4.2 fleets. Pause synchronization, upgrade the
Source and all followers to 4.2.0, restart the Source with its prior settings,
and verify before resuming. Finish unfinished runs with their original build
and retain backups. In-place migration from 3.2.x remains unsupported.

### Verification

Publication is gated on repository validation, packed CLI checks and native
Linux/macOS/Windows x64 and Windows ARM64 acceptance. Verify the published npm
artifact, provenance and matching GitHub tag after publication. Release
preparation alone does not assert that publication succeeded.

## v4.1.0 - 2026-10-22

This feature release adds portable harness archives and configurable upstream
skill tracking. Node.js 24 or newer is required.

### Harness archives

`canonfig harness export` packages canonical configuration alone, one or multiple
selected harnesses, or selected harnesses plus canonical configuration. ZIP and
TAR.GZ archives preserve binary files, executable bits and Unicode names, and
include an inventory with content hashes. Dry runs, strict validation, bounded
input sizes and no-clobber output make export explicit and inspectable.

Exports do not read environment credentials, upload files or mutate source/native
configuration. Authored literal secrets are not automatically scrubbed. External
dependencies remain external; this is not a complete machine backup.

### Tracked skill updates

`canonfig skills track`, `list`, `check` and `update` track an existing installed
skill against an explicit Git source, ref and subdirectory. Roots, configuration
paths and named selections are configurable. Tracking requires a matching tree;
updates preview by default and require `--apply` to write.

Local additions, edits or deletions block the selected update rather than being
overwritten. Staging, revalidation, locking, rollback and an interruption journal
protect updates. Public HTTPS and local Git sources are supported; private/SSH
sources, automatic merges and automatic crash recovery are not claimed. The
commands do not execute skills or change follower/profile publication policy.

### Dependency maintenance

Update the documentation site to Next.js 16.4.2 and test tooling to Vitest 4.1.12
to resolve the advisories found during release preparation. Production and full
dependency audits are clean on the updated lockfile.

### Upgrade boundaries

The state schema and signed-revision format are unchanged. The existing
major.minor handshake still rejects mixed 4.0/4.1 fleets: pause synchronization,
upgrade the Source and every follower to 4.1.0, restart the Source with its prior
settings, and verify before resuming. Finish or recover unfinished runs using
their original build and retain backups. In-place migration from 3.2.x remains
unsupported; follow the separate fresh-install guide.

### Verification

Release is gated on repository checks, native Linux/macOS/Windows x64 and ARM64
acceptance, packed CLI validation, unchanged package-size budgets and review.
Publication must be followed by a fresh public npm install and provenance/tag
verification. Preparing these notes does not assert that publication succeeded.

## v4.0.2 - 2026-10-21

This corrective patch addresses the remaining 22 findings in the #181 backlog.
Node.js 24 or newer is required. The Source/follower protocol and state schema
remain compatible on the 4.0.x line. Finish or recover an unfinished run with its
original build before upgrading, and retain a backup until verification passes.

### Source concurrency and ownership handovers

Pending enrollment survives unrelated Source commands. An exclusive serving
lease prevents competing servers from invalidating enrollment, and bounded
shutdown releases that lease even with stalled clients (#148).

Owned resource retirement precedes successor writes, with explicit dependency
sequencing and recovery-safe handovers. Local edits remain protected (#150).
Installed scheduler commands are inspected independently of desired bindings;
missing runtimes fail readiness, while verifier limitations remain unverified
rather than producing false passes (#155). Verified Homebrew opt paths survive
keg upgrades for both scheduler and installer bindings (#157).

### Native schedules and installation evidence

- Canonicalize named time zones and reject unsupported numeric offsets before persistence (#156).
- Choose the first occurrence of repeated local times during fall-back, including half-hour DST changes (#158).
- Allow Windows synchronization on battery power without stopping an active apply when unplugged; avoid asserting an unproven reason for a missed run (#159).
- Require finalized follower enrollment before selecting a schedule. Keep pending/unenrolled recovery guidance accurate, including leftover native jobs (#160).
- Scope unattended-fire evidence to the installed native job. Old, unbound and pre-install process records remain historical, not proof of the current installation (#162).

### Installer and observation consistency

- Support rustup cargo proxies and Corepack pnpm entrypoints while preserving verified Homebrew opt paths. Validation disables automatic downloads/pinning and will not initialize absent rustup settings (#161).
- Select the same qualified tool recipe during observation, planning and installation (#163).

### Harness configuration safety

- Adopt identical generated files and managed blocks in fresh clones; accept LF/CRLF-only text conversions without weakening exact-byte binary protection (#166, #179).
- Keep adopted and updated TOML blocks in place. Refuse cleanup that would change the scope of following operator keys.
- Emit supported Claude/Droid hook events; reject unsupported mappings under strict mode. Use Droid's documented standalone event layout and project-root script paths (#167).
- Permit read-only Codex proposals from non-Git working directories without changing Canonfig action authorization (#168).
- Preserve existing CLAUDE.md instruction symlinks and refuse silent replacement/deletion of other native-output symlinks (#171).
- Clean retired binary skill files using original bytes, with accurate text/binary removal previews (#172).
- Retire explicitly disabled targets on unfiltered apply while retaining shared output still needed by enabled targets (#175).
- Copy repository-contained linked skill sources and report escapes, dangling links and cycles rather than silently dropping them (#176).
- Preserve unrelated JSONC comments and formatting using targeted edits, including during re-render and cleanup (#177).

### Setup diagnostics

Invalid or unreadable discovery inputs are operator usage errors rather than
internal journal defects. Failed/skipped item evidence is shown in human output
and status JSON under normal redaction rules; stale evidence is not attached to
a changed verdict (#178, #180).

### Verification

Release requires clean integration tests, native Linux/macOS/Windows x64/ARM64
checks, Codex and CodeRabbit reviews, the unchanged package-size budgets, and a
fresh public-registry install after publication. Draft preparation is not a
release or a claim that these final gates have completed.

## v4.0.1 - 2026-10-20

4.0.1 fixes safety, enrollment, CLI output and diagnostic issues reported after
4.0.0. Node.js 24 or newer is required. The state schema and signed-revision
format are unchanged; Sources and followers remain on the 4.0.x compatibility
line. Finish or recover unfinished runs with their original build before
updating, and keep a backup of the installation and state. Migration from 3.2.x
still requires a separate setup, not an in-place upgrade.

### Filesystem safety and native configuration

- Preserve directory permissions and file modes through synchronization,
  rollback and native configuration updates. Failed writes no longer leave
  parent directories or obsolete rollback data behind.
- Treat symlinked managed-directory ancestors and non-regular merge targets as
  actionable conflicts instead of traversing or replacing them. Unrelated
  safe resources can still proceed.
- Limit native harness cleanup to owned files. Deleted Codex/Grok TOML can be
  recreated or cleaned safely; dangling links and locally edited files retain
  their protections.

### Enrollment, publication and shared secrets

- Reject duplicate enrollment identities without consuming the reusable
  invitation or taking over an active follower.
- Reject revision metadata that cannot fit the transport budget before storing
  it. Source servers refuse a configured metadata ceiling below that admission
  budget. File blob bytes remain separate from metadata.
- Refuse local writes over Source-owned secret names. Manifest ownership checks,
  writes and retired-credential cleanup now share a cross-process lock, avoiding
  stale concurrent overwrites. Existing name collisions include recovery steps.
- Use the same credential-policy selection for regular and secret commands.
  Local-file bootstrap is described accurately without permitting shared-secret
  storage through an insecure backend.

### CLI and diagnostics

- Report inaccessible, corrupt or busy state as actionable errors, without
  deleting the existing state. Optional debug diagnostics remain redacted and
  inside a single result envelope.
- Emit one final apply result after automatic secret synchronization, with a
  matching exit status. Secrets commands use the canonical JSON schema.
- Handle JSON, version and help flags consistently across command groups and
  command logs. Usage errors identify missing arguments and unknown options;
  installer errors retain their specific explanation.
- Redact recognized credentials throughout human output, including repeated
  values, symbolic-prefix literals, URL userinfo and escaped JSON. Redacted
  scalar JSON stays parseable. Public harness binding names remain readable
  without masking unrelated executable paths.
- Handle child stdin closing early without crashing or losing exit diagnostics.
- Keep Windows command logging private when Node inherits PowerShell 7 module
  paths before launching Windows PowerShell.
- Make doctor honor actual installer bindings, removals and supported methods,
  including uv; yarn is no longer treated as a supported installer.
- Emit native MCP environment-reference syntax and reject unsupported mappings
  in strict mode, including unsupported Kilo project references.

### Verification

The integration candidate passed 1,147 selected tests, with 22 platform-specific
skips, plus real CLI checks. Linux, macOS, Windows x64 and Windows ARM64 CI passed
on the exact merged integration tree. The release candidate is validated again
by the release workflow before publication. These results do not claim live
model/provider authentication or completion of the remaining issue backlog.

## v4.0.0 - 2026-10-14

Canonfig 4.0.0 requires Node.js 24 or newer. This release is a fresh-install
baseline, not a supported in-place upgrade from 3.2.x. The signed revision
wire format changed. A 4.0.0 Source refuses 3.2.x followers, and a 4.0.0
follower refuses a 3.2.x Source. Preserve the old installation and its state;
back it up separately before establishing a new Source and enrolling new
followers. Existing signed revisions, credentials, schedules, and enrollment
pins are not migrated by this procedure.

### Changes

- On Windows with long paths disabled, `sync --plan` and the apply preflight
  refuse a target whose path, with Canonfig's staging names, exceeds MAX_PATH,
  naming the limit and the `LongPathsEnabled` remedy. Such a target used to
  pass planning and fail partway through the apply. Rollback and `recover` now
  also remove the parent directories a failed write created (deepest first,
  only while empty); previously they persisted after rollback. A Windows
  symlink refused with EPERM names its prerequisite: Developer Mode or
  `SeCreateSymbolicLinkPrivilege`.
- A uv tool whose executable was deleted while uv still listed it is repaired.
  Canonfig planned a reinstall on every apply, but `uv tool install` reported
  the tool as already installed and exited 0, so verification failed each
  time. Canonfig now passes `--reinstall` (not `--force`, which would also
  overwrite an executable uv does not own). npm, pnpm, and Cargo already
  reinstall a missing executable.
- A full Source `setup plan` no longer reports success when the native
  credential provider is merely present. With Secret Service (or Credential
  Manager) installed but not running or unlocked, the plan passed and
  `source-init` failed at apply. The preflight now stores, reads back, and
  deletes a disposable non-secret item and stops with the prerequisite if
  that fails; the inventory records `session-probe` when it succeeds.
- A changed version pin on an already-installed tool is now enforced. Planning
  asks the recipe's installer which version is installed (`uv tool list`,
  `npm`/`pnpm`/`bun` global listings, `winget list`, `dpkg-query`, Cargo's
  install metadata) and plans `install-tool` with `replaces` when it differs
  from the pin; previously a present executable planned `no-op` and the old
  version stayed. winget reinstalls with `--force` and apt with
  `--allow-downgrades`. After a pinned install the installer must report the
  pin, or the action fails.
- `source digest` and `source publish` hash and store file sources in
  streams, so peak memory no longer grows with file size (a 200 MiB file
  peaked at about 1.47 GB during publish; it now stays near 170 MB). State
  migration `0021_resource_blob_chunks` stores new blobs as 1 MiB chunks;
  blobs stored by earlier versions stay readable. Digests and signatures are
  unchanged. An older binary cannot serve blobs stored as chunks.
- Windows `schedule status` and `doctor` warn that the Task Scheduler task
  runs only while the user is logged on, and name a scheduled run that was
  skipped while nobody was logged on.
- The website dependency graph uses source-map-js 1.2.2, addressing the
  indexed-source-map denial-of-service advisory
  [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
- Native file sources publish raw bytes as immutable per-file SHA-256 blobs
  rather than embedding a whole resource's file content in signed JSON.
  Signed metadata carries each byte digest and length. File, directory, and
  skill resources share the byte pipeline; authorized followers fetch bounded
  byte ranges for larger files and verify the assembled bytes before use.
- Follower requests and Source responses carry a Canonfig version handshake. The
  Source refuses enrollment and revision transport from a different
  major.minor release before spending an invitation or shaping a revision;
  followers report a version mismatch instead of a misleading digest error.
- A per-user Source service can supervise `source serve` through systemd,
  launchd, or Windows Task Scheduler. Scheduled follower sync can restart a
  managed SSH tunnel once when it is down; native credential-store access is
  still required in that unattended session.
- Setup accepts CLI-only and project-only request scopes; enrollment reads
  invitation data from stdin, not from process arguments.
- Publication reports resource validation failures without printing raw
  parser input. Enrollment classifies Source credential failures as Human
  Action Required, and synchronization identifies removed installer bindings
  with a recovery message.
- CLI output redacts known secret values inside URLs and free text, including
  values under unrelated field names.
- Windows ACL reads use the PowerShell Core access-control API when needed.
  Permission operations have a longer timeout; rollback restores captured
  security descriptors through a native helper rather than recalculating
  inheritance from a temporary parent.
- Publication rejects recognizable literal credentials in configuration before
  signing or persistence. Symbolic environment references and named
  shared-secret bindings remain supported; reviewed bytes are not silently
  redacted into a different configuration.
- Setup binds approval to bounded authoring-file fingerprints. Changed,
  missing, unreadable, or oversized inputs require a new plan and approval
  before executing an installation or identity step.
- Recipe validation identifies the failing index, version, package, source,
  or build field without exposing rejected values. Reviewed uv indices
  reject credential-bearing query parameters.
- macOS credential decoding preserves a leading UTF-8 BOM as secret data.
  SSH public-key files accept normal LF and CRLF line endings without
  relaxing single-key validation or identity pinning.
- CLI startup rejects unsupported Node.js runtimes before loading database
  layers or reading enrollment input, with the required version and exit code 3.
- Setup verifies npm recipes in the reviewed installer's actual global prefix,
  including configured prefixes outside PATH and paths containing spaces.
- Discovery retains distinct package versions when their executable entry files
  have identical bytes, so stale copies remain visible for review.
- Windows Desktop and Core PowerShell use the same chunked native Credential
  Manager backend, so accepted 16 KiB secrets also fit when wrapped in their
  credential payload. The CLI size limit and native storage policy are unchanged.
- Linux Source status distinguishes the user manager's boot and logout lifecycle
  from access to signing and TLS credentials. Linger does not unlock an encrypted
  login keyring, and an installed service is not proof of login-free serving.
- The Linux Source service continues spaced failure retries after delayed native
  credential unlock instead of exhausting a boot-time start quota. Failed starts
  remain visible in status and the native journal; identity and storage policy
  are unchanged.
- Managed tunnels accept literal dash-prefixed OpenSSH arguments through
  repeated `--ssh-argument` options and validate IPv6 SSH destinations.
  IPv6 loopback forwarding is bracketed correctly; SSH, TLS and signing pins
  and host-key bypass rejection are unchanged.
- IPv6 Source HTTPS verifies the actual peer certificate's IP SAN directly,
  avoiding Node's IPv6-to-IDNA hostname conversion failure without weakening
  CA validation or the pinned Source identities.

These changes do not establish an in-place migration path or prove fleet
convergence on a live installation.

[Fresh-install guide](website/content/docs/how-to/upgrade.mdx)

---

## v3.2.1 - 2026-09-13

Canonfig 3.2.1 requires Node.js 24 or newer.

### Bug Fixes

- Pin Canonfig's shared Effect runtime package to the same release candidate as
  the CLI's direct Effect dependencies. Clean npm installs can no longer resolve
  incompatible Effect copies that make `canonfig doctor` fail during runtime
  layer initialization.

Canonfig 3.2.0 is deprecated. Upgrade to 3.2.1 before running synchronization or
diagnostics.

Full changelog: https://github.com/Microck/canonfig/compare/v3.2.0...v3.2.1

## v3.2.0 - 2026-09-13

Canonfig 3.2.0 requires Node.js 24 or newer.

### Features

- Add a stable public profile compiler with recursive configuration values,
  deterministic canonical output, validation diagnostics, and platform views.
- Publish files, directories, skills, archives, native binaries, empty files,
  and symlinks as byte-exact content-addressed resources. Large blobs transfer
  in bounded verified ranges with revision-scoped authorization.
- Make setup resumable and deterministic, with native credential bootstrap,
  explicit installer bindings, operational tunnel lifecycle management, and
  verifiable native scheduler readiness.
- Complete transactional fleet synchronization with durable build identity,
  upgrade gates, deployment receipts, hooks, skills, and convergence reports.
- Add staged MCP qualification for installation, launch, protocol,
  authentication, functional checks, target-client loading, and Canonfig
  ownership. Qualified recipes retain exact provenance and unresolved local
  prerequisites remain explicit.

### Reliability and Security

- Reject truncated transport responses before caching or applying content.
- Redact credential-bearing arguments and messages, preserve UTF-8 secrets on
  Windows, and verify macOS Keychain session access rather than binary presence.
- Keep installer and scheduler execution shell-free, bounded, and tied to the
  tested native runtime.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.5...v3.2.0

## v3.1.5 - 2026-09-08

Canonfig 3.1.5 requires Node.js 24 or newer.

### Bug Fixes

- Recreate missing skill directories during synchronization, including nested
  files. Previously, restoring a deleted skill could fail with a missing-artifact
  error instead of restoring its directory tree.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.4...v3.1.5

## v3.1.4 - 2026-09-08

Canonfig 3.1.4 requires Node.js 24 or newer.

### Bug Fixes

- Fix macOS Keychain round trips for text credentials, including Unicode and
  values up to the supported 16 KiB limit. Re-sync shared secrets after upgrading
  if an earlier version stored invalid values.
- Keep parent directories needed by desired files when replacing directory and
  skill trees, preventing directory-not-empty failures during synchronization.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.3...v3.1.4

## v3.1.3 - 2026-09-08

Canonfig 3.1.3 requires Node.js 24 or newer.

### Bug Fixes

- Fix npm installs failing before startup because user and global configuration
  pointed to the same file. Installs now use distinct empty configuration files
  while keeping inherited npm settings disabled.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.2...v3.1.3

## v3.1.2 - 2026-09-08

Canonfig 3.1.2 requires Node.js 24 or newer.

### Bug Fixes

- Detect tools by their declared entry file or command, not by the shared
  runtime used to verify them. Missing Node- or Python-based tools no longer
  appear installed just because their runtime is available.
- Restore captured Windows file and directory owners, groups, and access
  rules during rollback, including inheritance flags. Keep restored children
  unchanged when restoring directory permissions.

### Before upgrading

Finish or recover unfinished runs with the CLI that created them. This
release's rollback journal requires native permission snapshots and rejects
older mode-only journals. Windows audit rules are not captured.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.1...v3.1.2

## v3.1.1 - 2026-09-08

Canonfig 3.1.1 requires Node.js 24 or newer.

### Bug Fixes

- Preserve existing parent and sibling permissions when writing files on
  Windows. Protect new directories, staged content, and local credential
  storage without changing unrelated files' access rules.
- Support large files in rollback snapshots so synchronization can replace
  them and restore their original contents if an apply fails.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.0...v3.1.1

## v3.1.0 - 2026-09-07

Canonfig 3.1.0 requires Node.js 24 or newer.

### Features

- Add the opt-in `append-local` file policy for shared instructions such as
  `AGENTS.md`. Canonfig updates a marked Source section and preserves the
  follower's local text below it. Removing the resource removes only the Source
  section. Existing file policies keep their behavior.
- Add Simple and Advanced setup guidance, numbered configuration choices, and
  opt-in Tailscale device discovery.
- Add a harness-to-harness skill for importing supported agent configuration
  into one canonical harness and projecting it to other supported targets.

`append-local` supports regular, non-executable UTF-8 text files. Edits to the
managed Source section are reported as drift. Recovery preserves local edits
made after a failed apply and retains the snapshots needed for manual recovery.

Full changelog: https://github.com/Microck/canonfig/compare/v3.0.1...v3.1.0

## v3.0.1 - 2026-09-05

Canonfig 3.0.1 requires Node.js 24 or newer.

This release changes no behavior. The package contents are identical to v3.0.0
apart from the version string.

### Supply chain

- The package is published through npm trusted publishing, so it carries a
  provenance attestation linking the tarball to the workflow run and commit that
  built it. Verify it with `npm audit signatures` after installing, or read the
  provenance on the npm package page.
- v3.0.0 was published from a local machine after the trusted publisher
  configuration failed, so it has no attestation. Prefer 3.0.1 when you want a
  verifiable build. v3.0.0 remains installable and is functionally identical.

Full changelog: https://github.com/Microck/canonfig/compare/v3.0.0...v3.0.1

## v3.0.0 - 2026-09-05

Canonfig 3.0.0 requires Node.js 24 or newer.

This release resolves a full hand audit of the 2.x CLI. It changes several
published behaviors, so read the breaking changes before upgrading a fleet.

### Breaking changes

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

### Convergence and reliability

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

### Agents

- `agent-propose` invokes the harness during apply, records the proposal and
  stops, which is what the documentation always described.
- A harness that is denied, times out, overruns its output limit or returns
  unusable output is Human Action Required rather than a failed run, so one
  declining task no longer rolls back the rest of the profile.
- `sync --plan` reports a harness refusal against the task it would have
  attempted instead of dropping it silently.

### Enrollment and credentials

- The credential store is checked before an invitation is spent, so a machine
  that cannot keep a credential no longer burns a single-use invitation, and
  reports a human action rather than a transport failure.
- The credential policy recorded at enrollment is what later runs read, so a
  scheduled job no longer depends on an environment variable it does not carry.
- Enrolling a different name over a completed enrollment requires `--replace`.
  Re-enrolling the same name still rotates the credential.
- `canonfig doctor` probes the agent policy and harness the follower actually
  runs under instead of a file enrollment stops using.

### Diagnostics

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

### Platforms

- Updating a macOS schedule from inside a scheduled run no longer boots out the
  agent that owns the running process.
- Publication rejects calendars and timezones that macOS or Windows followers
  cannot apply. Such a profile used to leave those followers unable to converge
  at all, and after the scheduler moved out of the resource transaction it left
  them converged with no scheduled synchronization and no signal saying so.

Full changelog: https://github.com/Microck/canonfig/compare/v2.2.0...v3.0.0

## v2.2.0 - 2026-09-02

Canonfig 2.2.0 requires Node.js 24 or newer.

### Features

- Added privacy-safe JSON Lines command lifecycle logging with user-only file permissions, explicit opt-out, normalized command names, and catchable-signal completion records.
- Added first-class strict JSON harness configuration through `canonfig harness init --format json`, using the same schema and compiler as YAML.
- Added secure secret synchronization between authorized enrolled devices over pinned TLS, backed by native credential stores and automatic synchronization after successful apply operations.

### Security and reliability

- Secret values are accepted through standard input only and are never written to manifests, command arguments, normal output, or command logs.
- Revocation, source deletion, collisions, interrupted transfers, aggregate payload limits, and failed credential cleanup are handled fail-closed with retryable durable state.
- Ambiguous YAML and JSON harness configurations are rejected instead of silently selecting one.
- Command logs never record unrecognized tokens and apply protected current-user-only access controls on Windows.

### Documentation

- Updated the README, complete CLI reference, security reference, installation skills, and platform-specific installation instructions.
- Added a reproducible release runbook and validated command examples across repository and website documentation.

Full changelog: https://github.com/Microck/canonfig/compare/v2.1.1...v2.2.0

## v2.1.1 - 2026-09-01

### Bug Fixes

- Synchronization now preserves exact authored modes, symlink targets, empty directories, ordered skill roots, and native schedule definitions across Linux, macOS, and Windows.
- Recovery now rolls back interrupted filesystem and native scheduler changes safely, including resource removals.
- Restrictive directory modes and object-kind changes now converge without leaving partial state.
- Release artifacts are minified without identifier renaming and remain within the original size budget.

**Full Changelog**: https://github.com/Microck/canonfig/compare/v2.1.0...v2.1.1

## v2.1.0 - 2026-08-31

### What's Changed
* fix: disable standalone output on Vercel by @Microck in https://github.com/Microck/canonfig/pull/5
* feat(harness-config): project .canonfig into native agent harness configuration by @Microck in https://github.com/Microck/canonfig/pull/6
* feat(harness-config): add Kimi, Kilo, Hermes, and Qwen adapters by @Microck in https://github.com/Microck/canonfig/pull/7


**Full Changelog**: https://github.com/Microck/canonfig/compare/v2.0.0...v2.1.0

## v2.0.0 - 2026-08-20

Canonfig v2 is a one-way configuration synchronizer that publishes a canonical AI agent setup from one Source Machine and converges Linux, macOS, and Windows Follower Machines.

### Install

```bash
npm install --global @microck/canonfig@2.0.0
```

The npm package is scoped as `@microck/canonfig`; the installed executable remains `canonfig`.

### Highlights

- Source and Follower lifecycle with signed immutable profile revisions
- Cross-platform machine state, credentials, schedules, and package recipes
- Transactional synchronization, drift handling, rollback journals, and recovery
- Bounded agent command authorization and controlled subprocess execution
- Packed CLI validation and Linux, macOS, and Windows acceptance coverage
