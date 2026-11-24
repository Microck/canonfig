# Canonfig skills

- [`setup-canonfig`](setup-canonfig/SKILL.md): install and set up Canonfig.
  Defaults to sharing skills, MCP servers, and global instructions across
  installed harnesses on this computer, with a clear preview before writing.
  Routes to Source Machine or Follower Machine setup when syncing multiple
  computers.
- [`operate-canonfig`](operate-canonfig/SKILL.md): day-2 operations and
  recovery. Edit `~/.canonfig/`, plan and apply syncs, manage harness
  exclusions and MCP preservation, restore Takeover Snapshots, resolve
  Follower Drift or Human Action Required, recover interrupted runs, and
  manage Source or Follower machines.

Start with `Use $setup-canonfig to set up Canonfig on this computer`.
Once set up, use `Use $operate-canonfig` for ongoing changes, diagnostics, or
recovery.
