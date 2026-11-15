# Upgrade an existing installation

## Before replacing the build

1. Identify the intended user, machine role, executable and npm prefix, current
   version, and requested target. Read that target's official release notes and
   upgrade instructions. Coordinate Source and follower changes when major.minor
   changes; mixed major.minor releases cannot synchronize.
2. Inspect status for interrupted setup, sync, and update work. Finish or recover
   it with the build that created it before replacing that build. Preserve state,
   journals, identity, credential references, local policies, and snapshots;
   follow the release's recovery instructions instead of deleting blockers.
3. If the installation is a custom build, compare its required behavior with the
   official target first, including preservation and credential handling. Stop
   if the official target lacks a required policy; do not replace it and silently
   accept a narrower outcome.
4. Record the actual UI and Source service commands, bind addresses, ports, user
   context, executable paths, native definitions and overrides, credential-store
   environment and dependencies, tunnels, and follower schedules. Preserve a
   private copy before changes; keep credentials and launch tokens out of logs.
5. Name the affected services and maintenance interruption. Obtain authorization
   before stopping them or changing their definitions; leave unrelated services,
   agent sessions, and previews alone.

## Replace and restart

Use the approved exact npm release under the intended user's existing prefix,
following its release instructions. For a terminal-driven update, stop the UI
first. Where the release requires Source service removal and reinstallation,
record its settings before removal and reinstall with the recorded bind address
and port, not assumed defaults. Installation starts the service immediately;
there is no stopped staging phase for repairing its environment afterwards.

Establish credential/session requirements and approved native overrides before
invoking `install`. On Linux, retain or restore still-required systemd user
drop-ins under `~/.config/systemd/user/canonfig-source.service.d/` after removal
and before installation. The installer rewrites the base unit, not those
drop-ins, then reloads the manager and starts the service. If a requirement
exists only as an edit to the generated definition, installation overwrites it.
Block reinstallation until a supported pre-activation configuration supplies
that requirement; report an unsupported override rather than starting without it.

For a manual self-update, `canonfig self-update apply` previews;
`canonfig self-update apply --apply` installs. Read the installed help before
using it. Its locks do not coordinate external package writers, and a running
Source or watcher defers activation. Standalone self-update does not restart
services. Keep a deferred update distinct from a completed update.

For releases supporting Source-driven Fleet Updates, read `canonfig source update`
help before upgrading followers individually. That separate workflow rolls out
the Source's exact release through a canary and native follower apply commands;
both releases and their installation prefixes must support it. Disabling
standalone self-updates does not disable Fleet Updates.

For an update through Settings, Version, keep that UI running and follow its
coordination instructions instead of stopping it mid-update. A successful GUI
update exits the old UI; launch the new build explicitly afterwards.

## Verify and hand off

- Check `canonfig --version`, bounded diagnostics, and the actual native service
  command and status after restarting. A new CLI version alone does not prove
  that an existing UI or service process runs the new build.
- Check the running UI's Settings, Version page or authenticated session version
  separately. Reuse an authenticated session for verification when available.
  Verify the approved private URL through its existing tunnel or proxy without
  changing unrelated routes.
- A bootstrap sign-in URL is single-use. If verification consumed it, treat it
  as used. With restart authorization, launch the UI again to issue a fresh
  link; hand that link to the user without opening it. Keep the token out of
  public artifacts.
- Verify each requested follower on that machine. Report installed and running
  versions, service and UI reachability, preserved policies and overrides,
  diagnostics, and any follower still awaiting upgrade or convergence. An upgrade
  is not evidence of publication, synchronization, or client reload.
