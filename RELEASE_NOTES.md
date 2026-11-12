# Canonfig v7.1.8

This release finds agent CLIs installed with npm, removes the Source agent
policy page that broke the health check, and makes tool discovery and the
harness list faster and quieter.

## Breaking change: agent policy is set on Followers only

Agents run only on Follower Machines, so agent policy now lives there alone.

- `canonfig agent policy` on a Source or an unenrolled machine exits 2 with
  "agent policy is set on each Follower Machine; this machine is not an
  enrolled Follower Machine". The browser's agent routes refuse the same way.
- Source settings no longer have an agent policy page.
- `~/.canonfig/policy.json` is ignored. You can delete it.

## Fixes

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

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

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
