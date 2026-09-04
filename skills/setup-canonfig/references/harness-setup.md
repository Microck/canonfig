# Project harness setup

Use this branch to project one repository-local `.canonfig` source into native
configuration for AI development harnesses. This does not initialize a Source
Machine, enroll a Follower Machine, or publish a Machine Profile.

## Inspect first

Find the repository root and inspect:

- existing `.canonfig/harness.yaml`, `.canonfig/harness.yml`, or
  `.canonfig/harness.json`;
- `.canonfig/.harness-state.json`;
- root instruction files and rules;
- existing skill directories;
- MCP, hook, agent, command, and permission configuration;
- installed target executables;
- native files that may collide with generated artifacts.

Run read-only commands when Canonfig is available:

```bash
canonfig harness targets
canonfig harness doctor --json
canonfig harness status --json
```

Canonfig rejects a repository containing more than one supported harness source
format. Preserve external edits and existing native keys.

## Minimal question flow

Ask only what the repository does not already answer:

1. Which target harnesses are required?
2. Which canonical instruction file and skill roots should be used?
3. Are lossy, shim, or unsupported mappings acceptable?
4. Which detected collisions, if any, may Canonfig own?

Recommended answers:

- targets: only those named by the request or whose executable and existing
  configuration show clear intent; otherwise no automatic recommendation;
- new format: YAML, Canonfig's default, unless the repository already
  standardizes on strict JSON;
- instructions: reuse the existing root `AGENTS.md` when present;
- skills: reuse existing repository skill roots;
- translation: begin with `--strict` so compromises are explicit;
- collisions: preserve existing ownership; never recommend `--force`.

Do not ask the user to define empty optional sections. Keep MCP servers, hooks,
agents, commands, permissions, and target extensions empty unless requested or
discovered.

Every question includes `Why it matters`, `Detected`, and `Recommended`.
A user should normally be able to answer with `Use recommendations`.

## Scaffold

For a new source:

```bash
canonfig harness init
```

Use strict JSON only when selected:

```bash
canonfig harness init --format json
```

Scaffolding must not overwrite an existing source without explicit approval.
The canonical layout may include:

```text
.canonfig/
  harness.yaml or harness.json
  instructions/
  rules/
  skills/
  hooks/
  agents/
  commands/
```

MCP credentials remain symbolic environment references. Never copy token values
into YAML, JSON, generated native files, plan output, or chat.

## Validate and plan

Populate only the requested or detected features, then run:

```bash
canonfig harness validate
canonfig harness plan --strict
canonfig harness diff
```

Show:

- selected targets and their support level per feature;
- files and managed keys to create, update, or remove;
- shim, lossy, and unsupported diagnostics;
- collisions and externally edited generated artifacts;
- executable hook or plugin shims;
- symbolic MCP environment references.

Do not bury diagnostics in a large unchanged-file list.

When a collision exists, ask about that exact path or key:

```text
Question:
May Canonfig take ownership of <path or key>?

Why it matters:
`--force` may replace an existing native entry or externally edited generated
artifact. Cleanup will later remove only state Canonfig records as owned.

Detected:
<current owner and conflict>

Recommended:
No. Preserve the existing entry unless the operator has reviewed the before and
after content and intentionally transfers ownership.

Options:
preserve / transfer this entry / revise canonical source
```

Approval for one collision does not authorize blanket `--force`.

## Apply

After the displayed plan is approved:

```bash
canonfig harness apply --strict
canonfig harness status
canonfig harness doctor
```

Use `--force` only for specifically approved collisions and show the affected
paths again immediately before apply. `clean` removes only Canonfig-owned
artifacts and also requires a plan review.

## Harness completion evidence

Harness setup is complete only when:

- exactly one canonical source format exists;
- configuration validation passes;
- enabled targets and support levels are reported;
- the approved plan has no unresolved collision or external edit;
- apply succeeds without unapproved force ownership;
- status reports no pending owned changes;
- requested target executables are probed;
- every lossy, shim, or unsupported mapping remains explicit.
