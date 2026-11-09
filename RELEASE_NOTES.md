# Canonfig v7.1.3

Source setup includes `~/.codex/skills` and other supported tool folders when
scanning for skills.

## Import existing skills

- Import follows supported skill-folder links without changing the originals.
- Expand "Shared skills" to see its folder path and the selected tools that
  read it.
- Tree branches open and close with a short animation. Reduced-motion settings
  disable it.

## Import safeguards

- Skills containing hard-linked files or aliases of protected configuration
  files are skipped.
- The 1 MiB file limit also applies to generated `SKILL.md` files. Batch limits
  count the converted content, not its original text.
- Selected content above 64 MiB stops the import before any writes. Select fewer
  items or reduce file sizes, then scan, review and approve again.

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

Install with `npm install --global @microck/canonfig@7.1.3` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.
