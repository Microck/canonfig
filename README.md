<div align="center">

  <img src="https://raw.githubusercontent.com/Microck/canonfig/main/.github/assets/canonfig-animation.gif" width="320" alt="canonfig chest filled with AI agent logos">

  <h1>canonfig</h1>
  <p>one-way sync for ai agent configuration.</p>

  <p>
    <a href="https://www.npmjs.com/package/@microck/canonfig"><img src="https://img.shields.io/npm/v/@microck/canonfig?style=flat-square&color=000000" alt="npm version badge"></a>
    <a href="https://www.npmjs.com/package/@microck/canonfig"><img src="https://img.shields.io/npm/dt/@microck/canonfig?style=flat-square&color=000000" alt="npm total downloads badge"></a>
    <a href="https://github.com/Microck/canonfig/actions/workflows/acceptance.yml"><img src="https://img.shields.io/github/actions/workflow/status/Microck/canonfig/acceptance.yml?branch=main&style=flat-square&label=ci&color=000000" alt="ci badge"></a>
    <a href="https://github.com/Microck/canonfig/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-000000?style=flat-square" alt="license badge"></a>
  </p>
</div>


---

`canonfig` keeps a declared agent setup consistent across linux, macos, and
windows. one Source Machine publishes immutable, signed Profile Revisions.
Follower Machines plan, apply, and independently verify what they are authorized
to receive. followers never publish changes back.

deterministic actions run first. optional Configuration Agents handle bounded
fallback tasks; an agent's claim never counts as proof of convergence.

[documentation](website/content/docs/index.mdx) | [first sync](website/content/docs/tutorials/first-sync.mdx) | [command reference](website/content/docs/reference/cli.mdx)

## why

keeping agent setups in sync across machines usually means copying files by hand
or dealing with bidirectional sync conflicts. canonfig gives you one source for
configuration, instructions, skills, and platform-specific tool recipes while
preserving follower-owned configuration values and detecting local skill edits
before replacing them. native schedules keep followers up to date without a
resident follower daemon.

## install

requires Node.js 24+ and npm. install the same release on the source and every follower:

```sh
npm install --global @microck/canonfig@4.2.0
canonfig --version
canonfig doctor --no-input
```

check the `credentials` result before continuing. canonfig uses Secret Service
on linux, Keychain on macos, and Credential Manager on windows. follow the
reported recovery steps if the store is locked or unavailable.

4.2.0 adds automatic skill updates, source skill deletion reconciliation, and live
local harness projection. upgrade the source and all followers together: mixed
4.0/4.1/4.2 fleets are rejected. **do not replace a
3.2.x installation or its state in place**; use the
[fresh-install upgrade guide](website/content/docs/how-to/upgrade.mdx).

## sync machines

start with the [Source Machine → Follower Machine tutorial](website/content/docs/tutorials/first-sync.mdx).
it covers the profile, source service, pinned connection, and follower enrollment.
profile source paths are relative to the profile's directory and cannot escape it.

after enrollment, run on the follower:

```sh
canonfig sync --plan
canonfig sync --apply
canonfig status
```

to publish changes from an existing, reviewed profile on the source:

```sh
canonfig source digest --profile-file ~/canonfig.profile.jsonc
canonfig source publish --profile-file ~/canonfig.profile.jsonc --reviewer "$USER"
```

these examples use a POSIX shell. `source digest` validates content without
signing it; publication creates an immutable revision.
see [publishing changes](website/content/docs/how-to/publish-profile-changes.mdx).

apply journals filesystem changes and verifies resources independently.
`Converged` means declared resources match, not that an agent client has loaded
or trusted them. `clientLoaded` remains `not-verified`; complete any client-side
restart, project-trust or hook approval separately.

### schedule updates

```sh
canonfig schedule set daily@09:00
canonfig schedule status
```

the native job runs `sync --apply --no-input --scheduled` at the resolved local
time. a profile's `scheduleDefault` is only reported until you install it with
`canonfig schedule set --default`.

by default, services and schedules follow the user's login-session lifecycle.
boot or logged-out operation needs platform-specific setup and an available
credential store. an installed unit is not proof it can serve or sync.
see [unattended operation](website/content/docs/how-to/run-unattended.mdx) and
[schedules](website/content/docs/how-to/manage-schedules.mdx).

## configure harnesses

project-local harness configuration projects one canonical definition into
selected agent harnesses:

```sh
canonfig harness init
canonfig harness validate
canonfig harness plan
canonfig harness apply
# Or keep local projections updated while this foreground process runs:
canonfig harness watch
```

YAML is the default; use `harness init --format json` for strict JSON. keep only
one of `.canonfig/harness.yaml`, `.canonfig/harness.yml`, or `.canonfig/harness.json`.
ordinary follower sync does not run harness projection.
see the [harness guide](docs/harness-configuration.md) and
[sync-harnesses skill](skills/sync-harnesses/SKILL.md).

### package a setup

export canonfig configuration itself, one harness, or several harnesses:

```sh
canonfig harness export --source-only --output canonfig-source.zip
canonfig harness export --target codex --output codex.tar.gz
canonfig harness export --target codex --target claude-code --include-source --output setup.zip
```

add `--dry-run` to inspect the inventory first. exports compile declared project
sources, not your whole home directory or local account state. existing archives
are never overwritten. this is **not a secret scanner**: review declared content
before sharing it. see [archive contents and limits](docs/harness-archives.md).

## update upstream skills

register an existing skill's Git source and revision with `canonfig skills track`,
then preview updates before applying them:

```sh
canonfig skills list
canonfig skills check
canonfig skills update
canonfig skills update --apply
```

the last command updates all tracked skills; repeat `--name` to select specific
skills. local edits block the selected update rather than being discarded.
roots, source configuration, refs and subdirectories are configurable.

for unattended upstream updates, `canonfig skills auto --apply` runs a foreground
worker every 24 hours. add `--once` for your own OS scheduler. preview with
`canonfig skills auto` first. local edits or source changes stop the worker;
it never publishes profiles or applies harness configuration automatically.

only public HTTPS Git sources and local repositories are supported. this is not
follower synchronization or a skill marketplace. update canonical skills on the
Source Machine, review, then publish.
see [tracking, local edits and recovery](docs/skill-updates.md).

## what gets applied

| resource | default behavior |
| --- | --- |
| `file` | replace owned content and mode |
| `directory` | mirror desired entries; remove only unchanged entries previously written by Canonfig; preserve unrelated or locally modified entries |
| `config` | merge declared TOML, JSON or YAML keys; preserve follower-owned keys and comments; remove dropped Canonfig-owned keys unless claimed through Local Overlay |
| `skill` | replace only if the installed copy is unmodified |
| `tool` | run a platform recipe and independently verify it |
| `credential` | require a local credential reference; never copy it as profile content |

explicit policies can be more destructive: directory `replace` removes foreign
entries too. read the [profile schema](website/content/docs/reference/profile-schema.mdx)
before changing ownership or apply policy.

## trust and boundaries

- enrollment pins source TLS and signing identities; changed pins, invalid
  signatures and replayed invitations fail closed
- each follower has an independently revocable identity and group assignment
- profile credentials stay local; separately named secrets are shared only with
  explicitly enrolled `canonfig:secrets` followers and stored in native credential stores
- Configuration Agents are bounded by allowlists; elevation, login, restart and
  reboot are denied by default
- `source scan` and `setup plan --file` discover tools, not the files, configs or
  skills selected for synchronization

`--json` uses the stable `canonfig.cli/v1` envelope. exit `3` means Human Action
Required; exit `4` means conflict or Follower Drift.
see the [CLI reference](website/content/docs/reference/cli.mdx) and
[diagnostics](website/content/docs/reference/diagnostics.mdx) for all exit codes.

## development

```sh
npm ci
npm run build:cli
npm run docs:validate
npm test
```

the separate documentation browser suite uses `npm run website:build`,
`npx e2e-web install chromium`, and `npm run test:e2e`; its runner needs
Node.js 24.8+. browser checks do not verify native keyrings, synchronization or
scheduled jobs. see the [release runbook](docs/release-runbook.md) for all gates.

## documentation

- [first sync](website/content/docs/tutorials/first-sync.mdx) · [profiles](website/content/docs/reference/profile-schema.mdx)
- [harness configuration](docs/harness-configuration.md) · [archives](docs/harness-archives.md) · [skill updates](docs/skill-updates.md)
- [recovery](website/content/docs/how-to/recover.mdx) · [upgrades](website/content/docs/how-to/upgrade.mdx)
- [security](website/content/docs/reference/security.mdx) · [cross-platform behavior](website/content/docs/reference/cross-platform.mdx)
- [install skill](skills/install-canonfig/SKILL.md) · [setup skill](skills/setup-canonfig/SKILL.md) · [operate skill](skills/operate-canonfig/SKILL.md)

## license

[MIT](LICENSE)
