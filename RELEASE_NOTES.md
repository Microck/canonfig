# Canonfig v7.1.6

Settings pages show less text, and installers can be set up from the browser.

## Installers in the browser

- Settings, Installers lists the package managers it finds on this machine,
  each with an Add button. Add installer opens a form for any other path.
- Canonfig checks an installer runs before it saves it, the same check as
  `canonfig installer set`. Each installer can be removed from its row.

## Cleaner settings

- Explanatory paragraphs are gone from Version, Health check, Source service,
  Agent policy, Setup and the Follower tunnel and schedule pages.
- Health check runs when the page opens.
- Setup shows one list of steps, named after the tool they check, with the
  reason under any step that failed.
- Error boxes keep the message and fold category and exit code into
  Technical details. Source service folds its manager details the same way.
- Commands inside messages are shown as code.

## Fixes

- An invalid `~/.canonfig/secrets.json` now names the file and the fields it
  needs, without showing any of its content.

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

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
