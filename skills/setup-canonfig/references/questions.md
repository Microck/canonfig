# Guided choices

Offer decisions, not blank forms. Apply this contract to every question in every
branch, including nested settings, corrections, confirmations, and advanced fields.

## When to ask

Always select MODE once unless already supplied. In Simple, ask only unresolved
intent, essentials, and conflicts; expose other defaults in an editable summary.
In Advanced, offer every relevant configuration section from the
[configuration catalogue](configuration-choices.md), with keep/disabled choices
before nested questions. Existing answers are prefilled in both modes.

Do not ask for facts already established. An optional section is not a required
questionnaire. A skipped required value remains deferred or blocked, not passed.

## Required format

Use a stable field ID instead of numbering both questions and answers. Keep each
question to a few lines; one sentence explains why and one justifies the default.
Never disguise an inference as a detected fact.

```text
Question: [ROLE] What should this machine do?
Why it matters: One Source publishes its ~/.canonfig/ folder; followers consume it.
Detected: <verified existing role, or omit this line>
Recommended: Keep the verified role; otherwise No automatic recommendation.
Options:
1. Source Machine: author ~/.canonfig/ and publish it.
2. Follower Machine: receive the folder from an existing Source.
3. CLI only: install without creating a machine identity.
4. Other (type your own): describe a different goal.
```

Each Options block must use consecutive numbers starting at 1 and end with an
`Other (type your own)` choice. Every option gets a short consequence, not just
an unexplained identifier. Show 1 to 4 useful alternatives before Other. A boolean
gets Yes / No / Other, not a bare yes/no prompt. A string gets detected value /
reasonable proposal / Other, not invented machine or profile names presented as
facts. Finite enums accept Other for clarification but never unsupported values.
Use More results or a filter for long lists; Other is always visible.

Mark single-select versus multi-select. For multi-select, Keep, None, and Skip
are exclusive with other choices. Do not infer that all discovered devices
should be selected.

## Answer handling

Accept an option number, option label, or plain custom text. Multi-select fields accept
comma-separated numbers. The operator can
override answers by question number or field name; stable field IDs are preferred.
Examples of replies (not commands):

```text
MODE=1; ROLE=2
NAME=3: studio-laptop
HARNESSES=1,3
IMPORT=2: claude-code, codex/skills/review
Use recommendations, except schedule: weekly:Mon@10:00 Europe/Madrid
Other: keep this machine local for now
```

A bare `2` is valid only for one active question. If a batch makes it ambiguous,
ask which field it refers to; do not guess. Validate unknown labels, out-of-range
numbers, conflicting multi-selects, paths, IDs, URLs, and enums before execution.
Ask only to repair the invalid field. Other never bypasses schema or permissions.

`Use recommendations` accepts only configuration recommendations already shown;
it never approves future publication, apply, takeover without a backup, trust
changes, shared-secret grants, agent execution, or elevated capabilities. Exclude
consent/approval questions from bulk recommendation acceptance, even when
displayed in the same round.

`Skip optional` preserves existing settings and leaves new optional features off.
`Show advanced options` switches to Advanced. `simple` switches back. Accept
in-depth, indepth, complex, and detailed as Advanced aliases. Keep answers and
approvals for unchanged stages; show only newly relevant questions.

## Recommendation and evidence policy

Prefer existing valid state, then documented conservative defaults. Recommend
minimal mutation, user-level native facilities, deterministic execution,
takeover snapshots, and independent verification. Never recommend force,
deletion, `--no-backup`, pin reset, permission expansion, or identity
replacement just to pass setup.

Use provenance Detected, Operator, Recommended default, Needs review, or Blocked.
A generated name or example time is a proposal, not a machine observation. Required
operator decisions may have No automatic recommendation. Never collect secret
values through Other; ask for a local input method instead.

## Common menus

These are templates. Replace placeholders with verified candidates or remove an
unavailable choice. Do not ask a field already answered by the request.

### Name or profile ID

```text
Question: [NAME] What should this follower be called? (choose one)
Why it matters: A descriptive name helps identify the machine in reports.
Detected: <local hostname, only when observed>
Recommended: 1. keep the established name to avoid unnecessary changes.
Options:
1. Keep <existing name>: preserve the current label.
2. Use <observed hostname>: match the machine's local name.
3. Other (type your own): supply a descriptive name.
```

On a Source, the profile ID is `profile.id` in `~/.canonfig/canonfig.jsonc`.
Keep an existing one: publication refuses a different ID once the Source has
published. For a new Source, offer a proposed class name such as workstation
only when it matches the request; label it proposed. A follower has no profile
choice.

### Harnesses (Source)

```text
Question: [HARNESSES] Which harnesses should ~/.canonfig/ be projected into? (multi-select)
Why it matters: Canonfig takes over each listed harness's global instructions, skills, MCP and settings surfaces.
Detected: <installed harnesses from the plan's `detected`>
Recommended: 1. the installed harnesses; each takeover keeps a snapshot.
Options:
1. Keep the planned list: <harnesses from the canonfig-folder item>.
2. Choose from installed harnesses: list each detected id.
3. Add a harness not installed here: followers that have it receive it.
4. Other (type your own): name harness ids to validate.
```

The answer becomes repeated `--harness <id>` flags, which replace the detected
list. A follower does not choose this list; it excludes harnesses for itself
with `canonfig harnesses exclude <harness>`.

### Import (Source)

```text
Question: [IMPORT] What should be copied from the harnesses into ~/.canonfig/ before takeover?
Why it matters: Items not imported stay only in the takeover snapshot after the first apply.
Detected: <count of imports.offered items, with collisions and skipped lines>
Recommended: No automatic recommendation; review the offered items first.
Options:
1. Import nothing: plan with --no-import; harness files are not read.
2. Import chosen harnesses or items: repeat --import <harness|item-id>.
3. Import everything offered: --import-all; collisions still need a choice.
4. Other (type your own): ask about an item or a collision.
```

List each offered item with its id, target and `secrets` lines. For an
`import collision`, ask which id to import; never pick one silently.

### Takeover

```text
Question: [TAKEOVER] Keep a snapshot of what Canonfig replaces in each harness?
Why it matters: The first apply replaces owned files and directories; the snapshot is what restore writes back.
Recommended: 1. keep the takeover snapshot.
Options:
1. Keep the snapshot: default; first snapshot plus the 4 most recent are kept.
2. Take over without a backup: `sync --apply --no-backup`; prior content is lost.
3. Stop before apply: leave every harness as it is.
4. Other (type your own): ask what a surface holds before deciding.
```

Option 2 is an approval, never accepted through `Use recommendations`.

### Secure invitation input

```text
Question: [INVITE_INPUT] How will you supply the invitation locally?
Why it matters: Invitations grant enrollment and must stay out of chat and history.
Recommended: 1. keep the value only in the local terminal session.
Options:
1. Local terminal input: read into an ephemeral variable without echo/history.
2. Existing protected temporary file: load locally, then remove it.
3. Not available yet: pause enrollment and request a fresh invitation.
4. Other (type your own): describe a secure method, never paste the invitation.
```

### Schedule

```text
Question: [SCHEDULE] When should this follower synchronize? (choose one)
Why it matters: Scheduled runs apply changes and require the Source and credentials.
Detected: <verified existing/profile schedule and local timezone, when known>
Recommended: 1. preserve a working schedule, or remain manual until first convergence.
Options:
1. Keep existing / remain manual: make no scheduler change.
2. Use <verified profile default>: install the Source's suggested calendar with `schedule set --default`.
3. Daily at <proposed time and timezone>: use an explicitly labelled proposal.
4. Other (type your own): give a supported daily/weekly calendar and timezone.
```

Do not hardcode a user's timezone or working hours. Offer timezone separately in
Advanced. New automatic scheduling needs consent even when the profile declares
a default. Manual mode must not silently remove an existing schedule.

### Agent policy

```text
Question: [AGENT_POLICY] How should ambiguous setup work be handled?
Why it matters: Agent proposals and execution have different permission boundaries.
Recommended: 1. deterministic-only has the smallest execution surface.
Options:
1. deterministic-only: stop for a human when no deterministic recipe exists.
2. agent-propose: review bounded suggestions without executing them.
3. agent-apply: configure explicit bounds and obtain separate execution approval.
4. Other (type your own): describe a policy requirement to validate.
```

### Stage approval

```text
Question: [APPROVE_STAGE] Execute the displayed installation stage?
Why it matters: This installs the displayed package for the specified local user.
Recommended: Review the exact changes; No automatic recommendation to execute.
Options:
1. Approve this stage: execute only its displayed changes.
2. Edit a setting: open its numbered choices without restarting.
3. Stop here: preserve the plan without executing it.
4. Other (type your own): request a narrower scope or explanation.
```

Use separate scoped approval menus for publication, first apply, takeover
without a backup, restore, secret authority, force, and privileged actions. Do
not turn every command into a confirmation if an unchanged bounded stage is
already approved.

## Correction and completion

Accept terse corrections without replaying the questionnaire. Revalidate affected
dependencies and invalidate only approvals whose scope changed. Never reuse a
number-to-device mapping after refreshing it without showing the new list.

Before the plan, show numbered editable summary rows: role, name, profile ID,
harnesses, imports, selected devices, credentials, agents, schedule.
Mark defaults and deferred fields. Selecting a row opens the same menu in either
mode. Completeness comes from the decision record and verification, not from
making the operator answer every possible question.
