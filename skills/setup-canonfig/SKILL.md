---
name: setup-canonfig
description: Guide first-time Canonfig install and setup on this computer. Find installed harnesses, share skills, MCPs, and global instructions locally by default, or set up a Source Machine or Follower Machine for multi-machine sync.
---

# Set up Canonfig

Canonfig keeps one Canonical Folder (`~/.canonfig/`) and projects it into every
Target Harness you use. Start from what is already on this computer, explain
what will change in plain language, and wait for approval before writing.

## 1. Inspect

On the user's computer, run `canonfig --version`, `canonfig status --json`, and
`canonfig harnesses --json`.

- If `canonfig` is missing, confirm Node.js 24.15+ or 26+ and npm are present,
  then ask before running `npm install --global @microck/canonfig` and
  `canonfig doctor --no-input --timeout-ms 5000`. If you can only see a
  sandbox, say so and hand off the commands instead.
- If this machine is already a Source Machine or Follower Machine, show its
  current state and switch to [operate-canonfig](../operate-canonfig/SKILL.md).
- If `~/.canonfig/` already holds unenrolled local config, start from it.
- Read known global config files and skill directories for installed harnesses
  using detected roots and the installed version's adapters. Parse configs as
  data and keep credentials out of chat, tables, and command arguments.

Show one inventory table. Name excluded harnesses separately and mark any
unreadable category `Unchecked`.

| Harness | Skills | MCPs | Hooks | Other config found |
| --- | ---: | ---: | ---: | --- |
| Installed harness name | Count | Count | Count | Instructions, rules, subagents, commands, or settings |

## 2. Ask the setup questions

Use numbered options and one short **Recommended** line with a reason for each
question. Accept numbers, labels, or custom answers. Skip questions the user
already answered. "Use recommendations" accepts displayed configuration choices
and opens the preview; applying changes always requires its own approval.

**1. Are you syncing harnesses on this computer, or across multiple machines?**

Default recommendation: **Just this computer** (fastest way to start; no
server, enrollment, or schedule required, and you can turn it into a Source
Machine later).

1. Just this computer: share config across harnesses here via `~/.canonfig/`.
2. Source Machine: own `~/.canonfig/` here and publish signed revisions to other computers.
3. Follower Machine: receive config from an existing Source Machine.

If the user picks **2**, read [references/source.md](references/source.md) and
follow it from here. If they pick **3**, read
[references/follower.md](references/follower.md) and follow it from here.
Otherwise continue below for local setup.

**2. Which harness do you use most?**

List installed harnesses plus **Other**. Recommend the harness the user named
or the installed harness they invoked this from. If you have neither, ask
without guessing from history or auth stores.

**3. What should Canonfig manage?**

Default recommendation: **Skills, MCP servers, and global instructions from
[primary harness]** (starts from what you already use and leaves hooks local).

1. Share skills, MCPs, and global instructions.
2. Share skills and global instructions. Keep each harness's own MCP list.
3. Also include rules, subagents, commands, and supported hooks.
4. Pick specific items or bring items in from other harnesses.

When MCPs are in scope, show a cross-harness matrix with one column per
installed harness, marking each server `Present`, `Missing`, `Differs`, or
`Unchecked` (noting aliases and disabled entries). Compare actual launchers,
URLs, and options privately. Default to enabled servers, recommend the primary
harness's definition for same-name conflicts, and ask when intent is unclear.
Group long skill inventories by shared, unique, and conflicting names.

**4. Where should the shared config apply?**

Default recommendation: **All installed supported harnesses** (retaining any
existing exclusions).

1. Apply to all listed harnesses.
2. Choose harnesses.
3. Preview only.

Mention shared paths such as `~/.agents/skills/` when a harness outside the
selection also reads them.

## 3. Preview the changes

Check `canonfig --help` and the
[harness reference](https://canonfig.micr.dev/docs/reference/harnesses/) for
the installed schema. Start a new local folder with
`{"version":1,"harnesses":[...]}` in `canonfig.jsonc`, shared instructions in
`AGENTS.md`, and complete skill trees in `skills/<name>/`. Translate only
reviewed items. Map MCP servers into `mcp.<name>` using `{ "fromEnv": "NAME" }`
for credentials, and list any missing env vars or unsupported options in the
review. Review each hook command and trigger before migrating it.

- To keep all native MCP lists untouched, set `preserveMcp: true` in
  `~/.canonfig/local/local.jsonc`. To preserve individual harnesses when the
  preview shows unwanted removals, offer
  `canonfig local mcp preserve --harness <id>`.
- To keep destination-only instructions or skills alongside shared ones, use
  `local.appendLocal` (it does not merge MCP lists or resolve skill name
  conflicts).

Draft privately. For a first-time setup, preview in a disposable `HOME` with
copies of affected configs (isolating state and every harness root override).
When existing Canonfig ownership is present, preview against the live Canonical
Folder; if that needs draft files in `~/.canonfig/`, ask to stage only those
files with backups first, then run `canonfig sync --plan --json`.

Always show the full category summary (including unchanged categories):

| Category | Now | After setup |
| --- | --- | --- |
| Skills, instructions (`AGENTS.md`), MCPs, hooks, rules, subagents, commands, settings | Observed count or status | Already shared, share, keep local, none configured, or needs attention |

Follow with a per-harness table of concrete changes:

| Harness or shared path | Adds or updates | Removes or replaces | Exceptions |
| --- | --- | --- | --- |
| Affected target | Meaningful changes | Exact names or paths | Unsupported or blocked items |

Compare original and proposed MCP lists by name (including aliases and disabled
entries) because one config write can replace a whole list. Mark any removal
summary with a single `⚠️`. Show where `~/.canonfig/` and Takeover Snapshots
live. If a removal cannot be explained, hold that category or narrow targets.

**5. Apply the changes shown above?**

Recommend applying when the preview matches the user's choices. If it exposes
unintended loss, recommend one concrete fix (such as adding a needed MCP or
preserving that harness's MCP list) and preview again. Offer **Apply the
changes shown** (or **Apply and remove the listed entries**), **Change my
selections**, and **Stop after preview**. Wait for approval of the displayed
changes.

## 4. Apply, verify, and orient the user

Write the approved `~/.canonfig/` folder (and any `local/local.jsonc` settings)
on the real machine if it was drafted in a disposable `HOME`, then run
`canonfig sync --plan --json` on the real machine. If additions, removals, or
targets differ from the approved preview, show the updated diff and ask again.
Keep Takeover Snapshots enabled, then run
`canonfig sync --apply --no-input --json`. Leave recovery evidence intact if
the run stops or reports drift.

Re-run `canonfig sync --plan --json` to confirm zero pending changes, and
inspect the projected output for each harness. If the user asks whether MCPs
work, check initialization and tool listing on approved servers and report
configuration and connectivity separately (without invoking MCP tools or hooks
as a test).

End with:

1. Which harnesses synced, any exceptions, and the Takeover Snapshot path.
2. Three lines so the user leaves with the mental model:
   - Edit shared skills, instructions, and MCPs in `~/.canonfig/`, then review
     with `canonfig sync --plan` and apply with `canonfig sync --apply` to
     project changes to every harness.
   - Put machine-only exceptions in `~/.canonfig/local/` (never overwritten or
     published).
   - First writes save a Takeover Snapshot in `~/.canonfig/.backups/`; run
     `canonfig restore` to hand a harness back.
