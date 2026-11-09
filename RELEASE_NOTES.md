# Canonfig v7.1.4

Source setup shows fewer technical details and separates reviewing changes from
creating the Source.

## Review and approve setup

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

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

Install with `npm install --global @microck/canonfig@7.1.4` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.
