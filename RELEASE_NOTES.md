# Canonfig v7.1.1

The Import step in Source setup is usable with a real collection of skills and
MCP servers, and every setup screen explains its terms for someone new to
Canonfig.

## Import step

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

## Setup wording

Setup now says what a Source, a follower, a profile and an AI coding tool are
before it asks you to choose. Error messages say what failed and what to do
next, and the fingerprint check explains how to compare fingerprints before
you confirm them. Joining or creating a Source still changes none of your AI
coding tools' files.

## Upgrading

Install with `npm install --global @microck/canonfig@7.1.1` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 refuses that
setup's journal, `~/.canonfig/setup.json`, and tells you to move it aside.
Check whether setup already changed anything, move the file aside, and start
setup again. Do not remove `state.sqlite`.
