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
- [`debug-canonfig`](debug-canonfig/SKILL.md): cross-machine diagnosis and
  A-vs-B triage. Inspect Source and Follower state, catch common profile and
  local-machine misconfigurations (such as stale `preserveMcp` locks, broken
  overlays, non-portable paths or tool recipes, and skill drift), fix operator
  errors safely, and file focused GitHub issues for Canonfig product bugs.

Start with `Use $setup-canonfig to set up Canonfig on this computer`.
Once set up, use `Use $operate-canonfig` for ongoing changes and recovery, or
`Use $debug-canonfig` to diagnose sync failures and separate config errors from
Canonfig bugs.
