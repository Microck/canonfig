# Canonfig v7.1.11

This release makes the Source Overview tell the truth about what is published,
and tidies how terms and explanations show up.

## Source Overview

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

## Everywhere

- A term inside a sentence, such as "as a follower", is underlined again and
  explains itself on hover or focus. Titles and labels keep the small (?)
  button.
- On a Follower's Sync page, the explanations under "Your own changes" and
  "Preview instructions files" moved into (?) tooltips next to their titles.

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

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
