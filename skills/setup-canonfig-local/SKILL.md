---
name: setup-canonfig-local
description: Guide the user through Canonfig setup on this computer. Find installed harnesses, start from their primary harness, and show what the first local apply would share, keep, or replace.
---

# Set up Canonfig on this computer

Use this flow for global harness config on one computer. Local sync works from `~/.canonfig/` without enrollment, publication, or a schedule. Use [setup-canonfig](../setup-canonfig/SKILL.md) for Source or Follower setup.

## 1. Inspect

On the user's computer, run `canonfig --version`, `canonfig status --json`, and `canonfig harnesses --json`.

- If Canonfig is missing, offer the user-level install from [install-canonfig](../install-canonfig/SKILL.md). If you can only see a sandbox, say so.
- For an existing Source, Follower, or unfinished setup, show the state and use the existing setup or operating workflow. For an existing unenrolled folder, start from its current Canonfig config.
- Read only known global config files and skill directories for installed harnesses. Use detected roots and the installed version's adapters. Parse config as data. Keep credentials out of chat, review tables, and command arguments.

Show one inventory table. Name any excluded harnesses separately. Use `Unchecked` if you could not inspect a category.

| Harness | Skills | MCPs | Hooks | Other config found |
| --- | ---: | ---: | ---: | --- |
| Installed harness name | Count | Count | Count | Instructions, rules, subagents, commands, or settings |

## 2. Ask the setup questions

Use numbered options and one short **Recommended** line with a reason for each question. Accept numbers, labels, or custom choices. Skip answered questions. “Use recommendations” accepts the displayed setup choices and opens the preview. Apply requires its own answer.

**1. Which harness do you use most?**

List installed choices and **Other**. Recommend the harness the user named, or the installed harness they opened this setup from. If you have neither, ask without guessing. Do not inspect history or auth stores to infer usage.

**2. What do you want Canonfig to manage?**

Default recommendation: **Skills, tool connections (MCPs), and global instructions from [primary harness].** Start from the config the user already uses and keep hooks local.

1. Share skills, MCPs, and instructions.
2. Share skills and instructions. Keep each harness's MCP list.
3. Also include rules, subagents, commands, and supported hooks.
4. Choose items or bring in items from other harnesses.

When MCPs are in scope, show the servers being considered in a matrix. Use one column per installed harness. Mark each entry `Present`, `Missing`, `Differs`, or `Unchecked`. Note aliases and disabled entries. Compare the actual launcher or endpoint and its options privately. Default to enabled entries and recommend the primary harness's definition for same-name conflicts. Ask when the intended definition is unclear. Group long skill inventories by shared, unique, and conflicting names.

**3. Where should the shared config apply?**

Default recommendation: **All supported installed harnesses.** Show their names and retain existing exclusions.

1. Apply to all listed harnesses.
2. Choose harnesses.
3. Preview only.

Mention shared paths such as `~/.agents/skills/` if a harness outside the selection can also read them.

## 3. Preview the changes

Use the installed schema and [harness reference](https://canonfig.micr.dev/docs/reference/harnesses/). Start a new local folder with `{"version":1,"harnesses":[...]}` in `canonfig.jsonc`. Put shared instructions in `AGENTS.md` and copy complete skill trees into `skills/<name>/`, including their support files. Translate only reviewed items. For MCPs, map the native transport, launcher or URL, and supported options into `mcp.<name>`. Use verified environment references or supported secret storage for credentials. Mark missing credentials and unsupported options in the review. Review each hook command and when it runs before migrating it.

Use `preserveMcp: true` in `local/local.jsonc` to keep all native MCP lists. If the installed CLI supports `canonfig local mcp preserve --harness <id>`, offer to keep individual harnesses’ lists when the preview shows removals. Prefer `local.appendLocal` for instructions and skills when preserving destination-only content. It does not merge MCP lists or prevent skill name conflicts.

Draft privately. For first setup, preview in a disposable home with copies of affected configs. Isolate state and every harness path override. Existing ownership can change the result, so preview it against the live Canonical Folder. If that needs draft files in the live folder, ask to stage only those files, back up the originals, then run `canonfig sync --plan --json`. If declined, undo only unchanged staging.

Always show the full setup summary, including items that stay as they are.

| Category | Now | After setup |
| --- | --- | --- |
| Skills, instructions (`AGENTS.md`), MCPs, hooks, rules, subagents, commands, and settings (one row each) | Observed count or status | Already shared, share, keep local, none configured, or needs attention |

Show custom files if present. Follow with a short per-harness table of real changes:

| Harness or shared path | Adds or updates | Removes or replaces | Exceptions |
| --- | --- | --- | --- |
| Affected target | Meaningful changes | Exact names or paths | Unsupported or blocked items |

Compare original and proposed MCP lists by name, including aliases and disabled entries. A single planned config write can replace a whole list. Use one ⚠️ before the removal summary. Show the shared config and takeover backup locations. If you cannot explain a removal, hold that category or narrow the targets.

**4. Apply the changes shown above?**

Recommend applying if the preview matches the user's choices. If it exposes unchosen loss, recommend one fix, such as adding an MCP the user still needs, and preview again. Offer **Apply the changes shown** (or **Apply and remove the listed entries**), **Change my selections**, and **Stop after preview**. Wait for approval of the displayed changes.

## 4. Apply and check

Run `canonfig sync --plan --json` on the actual machine. If the additions, removals, or targets changed, show the new preview and ask again. Keep takeover backups enabled, then run `canonfig sync --apply --no-input --json`. Leave recovery evidence in place if the run stops or reports drift.

Replan and inspect the managed output for each target. If the user asks whether MCPs work, check initialization and tool listing on approved servers. Report configuration and connectivity separately. Do not invoke MCP tools or hooks as a test.

Report which harnesses synced, any exceptions or pending changes, where to edit shared config, and the backup path if created. On repeat runs, use the current Canonical Folder and ask before importing over it.
