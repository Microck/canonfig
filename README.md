<div align="center">

  <img src=".github/assets/canonfig-logo.png" width="160" alt="canonfig logo">

  <h1>canonfig</h1>

  <p>
    <a href="https://www.npmjs.com/package/@microck/canonfig"><img src="https://img.shields.io/npm/v/@microck/canonfig?style=flat-square&color=000000" alt="npm version badge"></a>
    <a href="https://www.npmjs.com/package/@microck/canonfig"><img src="https://img.shields.io/npm/dt/@microck/canonfig?style=flat-square&color=000000" alt="npm total downloads badge"></a>
    <a href="https://github.com/Microck/canonfig/actions/workflows/acceptance.yml"><img src="https://img.shields.io/github/actions/workflow/status/Microck/canonfig/acceptance.yml?branch=main&style=flat-square&label=ci&color=000000" alt="ci badge"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-000000?style=flat-square" alt="license badge"></a>
  </p>
</div>

---

`canonfig` is a deterministic, one-way configuration synchronizer for ai agent setups. one source machine discovers and explicitly publishes immutable, signed profile revisions. linux, macos, and windows follower machines fetch only the revisions allowed for their identities and groups, then plan, apply, and independently verify the selected profile.

configuration agents are optional and bounded. canonfig always runs declared deterministic actions first, and an agent statement never counts as proof of convergence.

[documentation](website/content/docs/index.mdx) | [architecture](website/content/docs/explanation/architecture.mdx) | [install skill](skills/install-canonfig/SKILL.md) | [operate skill](skills/operate-canonfig/SKILL.md) | [license](LICENSE)

## why

managing agent setups across multiple machines usually breaks because machines drift, sync tools try to be bidirectional authorities, or agents execute unbounded setup scripts that cannot be verified. canonfig keeps configuration deterministic and one-way:

- one authority: exactly one source machine publishes upstream. followers consume signed revisions and never publish back.
- deterministic first: declared files, configs, and platform package recipes apply first. configuration agents only handle bounded fallback tasks.
- immutable and signed: profile revisions are content-addressed, cryptographically signed, and verified after download.
- local credentials stay local: secrets are referenced through native OS credential stores (Secret Service, Keychain, Credential Manager) and are never copied into profiles or sent across the wire.
- native schedulers, no daemons: runs on systemd user timers, launchd user agents, and Windows Task Scheduler with zero resident follower background daemons.
- clear divergence states: stops at human action required when an operator step is needed, and flags follower drift when local skill edits would otherwise be overwritten.

## install

requires Node.js 24+ and npm.

```bash
npm install --global @microck/canonfig@2.1.1
canonfig --version
```

the npm package is `@microck/canonfig`; the installed binary is `canonfig`.

## quickstart

### 1. source machine setup

initialize the source machine and scan for explicit configuration to publish:

```bash
canonfig source init
canonfig doctor --no-input --timeout-ms 5000
canonfig source scan --file AGENTS.md --file package.json
canonfig source publish --proposal package.json --profile workstation --name Workstation --reviewer operator
canonfig profile list
```

start the local source server and create a single-use invitation:

```bash
canonfig source serve --host 127.0.0.1 --port 17342
canonfig source invite --endpoint https://127.0.0.1:17342 --expires 15m --group developers
```

Treat the returned invitation as temporary sensitive material.
This example binds to loopback (`127.0.0.1`) for same-machine follower enrollment.
If the follower is on a different machine, bind `--host` to a reachable address for both machines and pass the same address in `--endpoint`.

### 2. follower machine enrollment

on the follower machine, enroll with the invitation token, select the profile, plan the sync, and apply:

```bash
canonfig follower enroll "$INVITE" --name laptop --profile workstation
canonfig profile select workstation
canonfig sync --plan
canonfig sync --apply
canonfig status
```

enrollment pins the source TLS and signing fingerprints. subsequent sync runs verify signatures and digests against these pinned credentials.

### 3. native schedule

set up automatic background synchronization using the native user scheduler:

```bash
canonfig schedule set daily@00:00
canonfig schedule status
```

scheduled jobs invoke `canonfig sync --apply --no-input` without requiring a resident daemon.

## resource kinds and apply policies

| resource | default policy | outcome |
| --- | --- | --- |
| `file` | `replace` | exact owned file content and mode, or raw symlink target |
| `directory` | `mirror-owned` | source-owned tree with exact modes; only unchanged owned entries are removed |
| `config` | `merge` | declared TOML, JSON, or YAML keys merged while preserving local keys |
| `skill` | `replace-if-unmodified` | canonical skill tree without overwriting follower edits |
| `tool` | `ensure` | platform-specific recipe installation and independent verification |
| `credential` | `require-local` | validated local credential reference, never a copied secret |
| `schedule` | `replace` | native user-level synchronization schedule |

transfers are content-addressed and incremental. transfer and apply remain separate steps: a downloaded blob is not proof of convergence.

## authority and security model

- one source machine: only the source machine publishes profile revisions. followers are read-only consumers and cannot push upstream state.
- immutable revisions: every revision is content-addressed, signed with the source private key, and verified locally before apply.
- pinned trust: enrollment pins source TLS and signing certificates. synchronization rejects changed pins, invalid signatures, digest mismatches, and replayed invitations.
- revocable follower identities: every follower receives an independent revocable credential and group assignment.
- local credential isolation: credentials are confirmed through platform secret storage (Linux Secret Service, macOS Keychain, Windows Credential Manager) and never leave the machine.
- bounded agent harness: when agent resolution is enabled, tasks run within strict allowlists for executables, paths, HTTPS origins, and input size. elevation, login, restart, and reboot remain denied by default.
- fail-closed boundaries: missing logins or manual approvals raise Human Action Required (exit code 3); modified follower skills produce Follower Drift (exit code 4).

## command surface

| command | purpose |
| --- | --- |
| `canonfig source init` | initialize local source authority |
| `canonfig source scan` | scan declared files for discovery proposals |
| `canonfig source publish` | review and publish an immutable profile revision |
| `canonfig source serve` | start loopback source enrollment and profile server |
| `canonfig source invite` | generate short-lived, single-use follower invitation |
| `canonfig source revoke` | revoke an enrolled follower identity |
| `canonfig follower enroll` | enroll follower with pinned source invitation |
| `canonfig sync` | plan (`--plan`) or apply (`--apply`) profile synchronization |
| `canonfig recover` | reconcile state after interrupted synchronization run |
| `canonfig status` | inspect local follower convergence and drift status |
| `canonfig doctor` | run non-mutating platform and environment diagnostics |
| `canonfig overlay` | manage local configuration overlays (`list`, `set`, `remove`) |
| `canonfig profile` | list profiles, inspect revisions, or select active profile |
| `canonfig agent` | inspect or set agent policy and harness allowlist bounds |
| `canonfig schedule` | configure (`set`), inspect (`status`), or remove native schedules |

## exit codes

`--json` outputs the stable `canonfig.cli/v1` envelope. exit codes are explicit:

| code | category | meaning |
| --- | --- | --- |
| `0` | `success` | command completed or follower converged |
| `1` | `internal` | internal error |
| `2` | `usage-or-configuration` | invalid arguments or configuration syntax |
| `3` | `human-action-required` | manual human action needed to proceed |
| `4` | `conflict-or-drift` | local conflict or follower skill drift detected |
| `5` | `authentication-or-revocation` | invalid certificate pin, revoked identity, or bad token |
| `6` | `transport` | connection or TLS transport failure |
| `7` | `verification-or-apply-failure` | recipe verification or apply failure |

## documentation

- [explanation: architecture](website/content/docs/explanation/architecture.mdx)
- [explanation: tools and recipes](website/content/docs/explanation/tools-and-recipes.mdx)
- [reference: CLI](website/content/docs/reference/cli.mdx)
- [reference: profiles and schema](website/content/docs/reference/profile-schema.mdx)
- [reference: cross-platform behavior](website/content/docs/reference/cross-platform.mdx)
- [reference: diagnostics](website/content/docs/reference/diagnostics.mdx)
- [reference: security](website/content/docs/reference/security.mdx)
- [how-to: configure agent policies](website/content/docs/how-to/configure-agent-policies.mdx)
- [how-to: manage schedules](website/content/docs/how-to/manage-schedules.mdx)
- [how-to: recover](website/content/docs/how-to/recover.mdx)
- [tutorial: first end-to-end sync](website/content/docs/tutorials/first-sync.mdx)
- [cli reference](website/content/docs/reference/cli.mdx)
- [install skill](skills/install-canonfig/SKILL.md)
- [operate skill](skills/operate-canonfig/SKILL.md)

## license

[MIT](LICENSE)
