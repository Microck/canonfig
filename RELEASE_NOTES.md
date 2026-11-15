# Unreleased

- Detect Tailscale during health checks, setup planning and Source service setup.
- Serve the Source and browser interface directly on your tailnet with `--tailnet`.
  MagicDNS invitations enroll and sync without an SSH tunnel. Headscale custom
  domains work through the native Tailscale client.
- Keep TLS certificate pins and signed revisions. Tailnet startup refuses
  unavailable, expired or userspace-only clients and never changes Serve settings.

# Canonfig v7.1.12

This release lets a machine keep selected skills and its own MCP servers while
the rest of the Source's setup syncs. It works on Followers and on the Source
when it syncs its own folder.

## Keep selected skills local

Add skill names to `excludeSkills` in the machine's
`~/.canonfig/local/local.jsonc`:

```json
{
  "excludeSkills": ["deploy", "review"]
}
```

Those skills stay as they are in every harness skill folder on that machine,
including `~/.agents/skills` and Hermes's skill folders. Canonfig does not
write, check or delete them, and other Source skills still sync. If Canonfig
managed one before, the next successful sync gives it back to the machine with
its current files. This needs `skills` in the Source's `local.appendLocal`.

## Keep native MCP servers

Set `"preserveMcp": true` in the same file to leave each harness's MCP server
list exactly as it is, including options the canonical format cannot express.
New Source servers are not written either. Instructions, skills, commands and
other settings still sync, and agent files still name the Source's servers.

Removing either setting does not quietly take over local copies. The next
sync stops and says what to resolve.

## Known limitation

Import assumes trusted local processes and source folders that stay unchanged.
A concurrent parent-folder swap can bypass path checks and cause private
configuration to be read. Keep other programs from changing the source folders
during import.

## Upgrading

Before upgrading, finish or recover any unfinished run with the CLI build that
created it.

Install with `npm install --global @microck/canonfig@7.1.12` on every machine,
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
