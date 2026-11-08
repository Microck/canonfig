# Canonfig v7.1.2

Source setup's Import step is now a tree of your AI coding tools, and the AI
tools step asks one plain question.

## Import step

- Each tool, plus the shared `~/.agents` folder, is a collapsed row that opens
  into categories and then items. Tool and category rows have a checkbox that
  selects everything under them, and a search opens every branch with a match.
- Checking an item under a tool imports that tool's copy. A copy that is
  identical in another tool is checked there too. When the content differs,
  the other tools show which version is used, and checking it there switches
  to that version.
- Checking a whole tool or category takes only items nobody has decided yet:
  it never replaces a version you picked from another tool, and never selects
  an MCP server that needs a password or token.
- An MCP server that needs a password or token names the environment variable
  on its row ("Needs `$TOKEN`"), and checking it is your consent to replace the
  value with that variable. The separate "Replace saved passwords..." switch is
  gone.
- A choice made under a tool you then remove on the AI tools step is kept and
  comes back when you add the tool again.
- Each tool lists what it can't import under one line, grouped by reason.
- The explanatory paragraphs above and below the list are gone.

## AI tools step

The step asks "Which tools sync with `~/.canonfig/`?" and says that syncing
replaces their instructions, skills and MCP servers, and that unchecked tools
are left alone except for skills in the shared `~/.agents/skills/` folder.

## Upgrading

Install with `npm install --global @microck/canonfig@7.1.2` on every machine,
or run `canonfig self-update apply`. Stop `canonfig ui` first, and on a Source
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

If you started Source setup on 7.1.0 and did not finish it, 7.1.1 and later
refuse that setup's journal, `~/.canonfig/setup.json`, and tell you to move it
aside. Finish setup on 7.1.0 before upgrading, or check whether setup already
changed anything, move the file aside and start setup again. Do not remove
`state.sqlite`.
