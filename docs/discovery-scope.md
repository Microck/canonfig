# Discovery respects enabled scope

`source scan` excludes structured MCP, hook, and explicit `canonfig.tools`
records with `enabled: false` or `disabled: true` before collecting command
arguments, nested entries, or tool evidence. A disabled ancestor excludes its
whole subtree; a descendant cannot reenable itself. Either disabled declaration
wins when both flags are present. A record with neither flag is discovered.
Invalid enablement values on an active record that declares its own command or
executable fail parsing without including the value or command in the
diagnostic. Elsewhere `enabled` and `disabled` are legal entry names, so a
nonboolean value there is a nested entry and scanning continues.

MCP `command` fields are executable identities, not shell programs. Spaces and
Windows path separators are preserved. Arguments belong in `args`. Hooks keep
shell-command discovery semantics. Discovery executes no
commands and does not prove a referenced executable works on another platform.

This prevents disabled integrations from becoming publication candidates. It
does not remove previously published resources, rotate an exposed credential,
or authorize an external agent to read arbitrary configuration files.
`source scan` reads the Canonical Folder's instructions, skills, hook scripts
and MCP commands. `setup plan --file` bounds tool discovery only; it never
chooses which files are synced, which the folder decides.

Synthetic regressions in `tests/acceptance/discovery-scope.test.ts` run in the
existing acceptance/full-suite jobs on Linux, macOS, and Windows. They do not
contact upstream services or read native credential stores.
