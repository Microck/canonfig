# Canonfig v7.1.10

This release cuts clutter from the Follower pages and shows the Source the way
you customized it on every machine's map.

## Follower pages

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

## Everywhere

- Terms that used to be underlined show a small (?) button instead, and their
  explanations are easier to read.
- The Source card's name, icon and colour, customized on the Source, now show
  on every Follower's map. Close the Customize panel to share a change. An
  uploaded icon stays in the browser where you added it, and anything you
  customize on a Follower still applies only there.

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

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
