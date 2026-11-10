# Canonfig v7.1.5

The browser interface reports Source service problems once, at the top of the
window, instead of as an error on each page.

## Source service bar

- A bar above the workspace names the problem and offers the fix. It is red
  when other machines cannot get new revisions and yellow when the service is
  only out of date and still serving. You can close a yellow bar.
- Reinstall keeps the address and port the service already uses.
- Overview turns red when other machines cannot reach the Source.
- Category and exit-code details no longer appear on every page. Settings,
  Source service still shows the full status.

## Fixes

- Empty Revisions, Secrets, Profile and Machines lists place their dithered
  background on the bottom edge of the page.

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

Install with `npm install --global @microck/canonfig@7.1.5` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.
