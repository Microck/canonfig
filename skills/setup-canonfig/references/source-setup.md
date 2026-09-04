# Source Machine setup

Use this branch when creating the single publishing authority, authoring a
Machine Profile, publishing a Profile Revision, or creating follower
invitations.

## Inspect first

Confirm the current user, Node.js 24 or newer, npm, Canonfig version, secure
credential capability, existing role, existing revisions, and diagnostic state.
Never run `canonfig source init` over an existing Follower Machine or unknown
state.

```bash
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig profile list
```

## Minimal question flow

Do not ask for every possible profile field up front. Ask the first batch only
for unresolved essentials:

1. Source ownership: which user and state directory will permanently own the
   publishing identity?
2. Profile identity: stable profile ID and display name.
3. Scope: which explicit files should discovery inspect, and which follower
   platforms must the profile support?
4. Fleet policy: follower groups and the default synchronization calendar.

For each, include `Why it matters`, detected evidence, and a `Recommended`
answer. Good recommendations include:

- profile ID: a short lowercase machine class such as `workstation`, not a
  physical hostname;
- discovery inputs: existing explicit sources such as `AGENTS.md`,
  `package.json`, `pyproject.toml`, `Cargo.toml`, or known MCP/hook
  configuration;
- groups: none until a real access or configuration distinction exists;
- schedule: a visible local-time daily run, or the user's existing standard.

Do not ask about shared secrets or Configuration Agents unless they are
requested or discovered. Their defaults are disabled and `deterministic-only`.

## Install and initialize

After approval:

```bash
npm install --global @microck/canonfig@2.2.0
canonfig --version
canonfig source init
canonfig doctor --no-input --timeout-ms 5000
```

Initialization creates signing and TLS authority. It does not publish a Machine
Profile. Report where authority lives without displaying signing or TLS key
material.

## Discover and author

Scan only files the operator approved:

```bash
canonfig source scan --file AGENTS.md --file package.json
```

Summarize accepted evidence, `needs-review` evidence, tool recipes, login
requirements, skills, and unresolved Agent Tasks. Do not treat prose as an
installation command or infer equivalent package identities across apt,
Homebrew, winget, npm, uv, cargo, or source recipes.

Prefer an authored v2 JSONC profile when the desired setup includes files,
directories, configs, skills, credentials, schedules, dependencies, groups, or
platform-specific recipes. For each discovered resource, present a compact
table with:

- resource ID and kind;
- target and group;
- proposed Apply Policy;
- platform recipe and exact version when applicable;
- independent verification;
- source-owned versus follower-local behavior.

Ask only about rows that are ambiguous, destructive, unsupported on a required
platform, or missing verification. The documented safe defaults are:

| Kind | Default Apply Policy |
| --- | --- |
| file | replace |
| directory | mirror-owned |
| config | merge |
| skill | replace-if-unmodified |
| tool | ensure |
| credential | require-local |
| schedule | replace |

Credential resources contain symbolic references, never values. Shared-secret
transfer is separate and requires an explicit `canonfig:secrets` group grant.

## Publication gate

Validate the complete profile before asking for publication approval. Reject
duplicate IDs, missing dependencies, dependency cycles, undeclared groups,
unsafe or overlapping targets, incompatible policies, incomplete recipes, and
verification that cannot observe the desired result.

Show one publication candidate:

```text
Profile
- id and name
- groups and schedule default
- resource count by kind
- supported platforms
- reviewed discovery inputs
- unresolved items
- expected revision sequence
```

If any reviewed input changed, rescan and show the changed evidence. Do not
publish a candidate different from the one the operator reviewed.

Ask one explicit question:

```text
Question:
Publish this exact Machine Profile as a new immutable Profile Revision?

Why it matters:
Publication signs a permanent content-addressed revision that authorized
followers may select. It cannot edit an existing revision.

Recommended:
Publish only when every resource, recipe, group, target, and verification above
is approved and there are no unresolved items.

Options:
publish / revise / stop
```

Then publish and inspect:

```bash
canonfig source publish --profile-file ~/.canonfig/source/profile.jsonc --reviewer operator
canonfig profile list
canonfig profile show revision-one
```

Add `--proposal <approved-input>` only when merging reviewed discovery evidence
at publication.

## Serving and invitations

Canonfig's source server and invitation endpoint accept loopback HTTPS origins:

```bash
canonfig source serve --host 127.0.0.1 --port 17342
canonfig source invite --endpoint https://127.0.0.1:17342 --expires 15m --group developers
```

For another physical machine, an operator-managed tunnel may map the follower's
loopback address to this server. Canonfig does not configure or verify that
tunnel; the TLS certificate must pass through unchanged. Do not replace the
loopback endpoint with a public bind or disable pinning.

Ask only the invitation decisions not already known:

- intended follower and selected profile;
- declared groups;
- whether the follower explicitly needs `canonfig:secrets`;
- invitation lifetime and private delivery channel.

Recommend 15 minutes, the minimum required groups, no shared secrets, and a new
invitation if the payload was exposed, expired, or replayed. Never print a real
invitation in the setup report.

Set shared values through stdin only:

```bash
printf %s "$GITHUB_TOKEN" | canonfig secrets set github-token
```

## Source completion evidence

A Source setup is complete only when:

- the intended user owns one valid Source identity;
- diagnostics report the relevant probes;
- an approved profile has a reported revision ID, sequence, digest, and
  publication time when publication was requested;
- `profile show` matches the reviewed profile;
- no unresolved recipe, verification, or Human Action Required record was
  silently accepted;
- any invitation was delivered ephemerally and omitted from reports.
