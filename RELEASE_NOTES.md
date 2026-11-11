# Canonfig v7.1.7

The browser UI has shorter copy and more direct ways to fix setup problems.

## Health checks and recovery

- Health check hides skipped checks and shows passing checks by name. Problems
  explain what to do, with buttons to edit the tool list, open installers, or
  open agent policy where the browser can help.
- A missing Linux Secret Service client now includes a distribution-specific
  install command. Image-based Fedora and RHEL systems get an rpm-ostree
  command that accepts packages already installed, plus reboot guidance.

## Less clutter

- Source and Follower pages remove repeated explanations while keeping scope,
  consequences, and recovery instructions. Groups and Follower secrets have
  clearer empty states.
- Fingerprints fold into technical details. Source pages no longer show
  Follower lifecycle and tunnel sections.
- Harness bounds remain visible but disabled on a Source, labeled
  "Set on each Follower". They remain editable on Followers when agent policy
  allows it.

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

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
