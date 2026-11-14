# Unreleased

- Detect Tailscale during health checks, setup planning and Source service setup.
- Serve the Source and browser interface directly on your tailnet with `--tailnet`.
  MagicDNS invitations enroll and sync without an SSH tunnel. Headscale custom
  domains work through the native Tailscale client.
- Keep TLS certificate pins and signed revisions. Tailnet startup refuses
  unavailable, expired or userspace-only clients and never changes Serve settings.

# Canonfig v7.1.9

This release clears a health check warning that never went away on Linux and
Windows, and fixes two small things on the Machines page.

## Fixes

- Health check now tests the keyring on Linux (Secret Service) and Windows
  (Credential Manager) by saving, reading back and deleting a throwaway value,
  as macOS already did. A working keyring now passes instead of showing
  "write and unattended access are not verified" forever. If the test fails,
  the check says to start and unlock the keyring, with the provider's error in
  its details.
- Add machine fills in the Source's address in "Address it connects to"
  instead of opening with an empty box. An address you typed is kept the next
  time you open it.
- A renamed machine's card shows only the name you chose. The hostname moves
  to the name's tooltip.

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

Before upgrading, finish or recover any unfinished run with the CLI build that
created it.

Install with `npm install --global @microck/canonfig@7.1.9` on every machine,
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
