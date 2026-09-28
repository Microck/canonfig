<div align="center">

  <img src="https://raw.githubusercontent.com/Microck/canonfig/main/.github/assets/canonfig-logo.png" width="160" alt="canonfig logo">

  <h1>canonfig</h1>

  <p>
    <a href="https://www.npmjs.com/package/@microck/canonfig"><img src="https://img.shields.io/npm/v/@microck/canonfig?style=flat-square&color=000000" alt="npm version badge"></a>
    <a href="https://www.npmjs.com/package/@microck/canonfig"><img src="https://img.shields.io/npm/dt/@microck/canonfig?style=flat-square&color=000000" alt="npm total downloads badge"></a>
    <a href="https://github.com/Microck/canonfig/actions/workflows/acceptance.yml"><img src="https://img.shields.io/github/actions/workflow/status/Microck/canonfig/acceptance.yml?branch=main&style=flat-square&label=ci&color=000000" alt="ci badge"></a>
    <a href="https://github.com/Microck/canonfig/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-000000?style=flat-square" alt="license badge"></a>
  </p>
</div>

---

`canonfig` is a deterministic, one-way configuration synchronizer for ai agent setups. one source machine explicitly publishes immutable, signed profile revisions. linux, macos, and windows follower machines fetch only the revisions allowed for their identities and groups, then plan, apply, and independently verify the selected profile.

configuration agents are optional and bounded. canonfig always runs declared deterministic actions first, and an agent statement never counts as proof of convergence.

[documentation](https://github.com/Microck/canonfig/blob/main/website/content/docs/index.mdx) | [tutorial](https://github.com/Microck/canonfig/blob/main/website/content/docs/tutorials/first-sync.mdx) | [architecture](https://github.com/Microck/canonfig/blob/main/website/content/docs/explanation/architecture.mdx) | [install skill](https://github.com/Microck/canonfig/blob/main/skills/install-canonfig/SKILL.md) | [operate skill](https://github.com/Microck/canonfig/blob/main/skills/operate-canonfig/SKILL.md) | [license](https://github.com/Microck/canonfig/blob/main/LICENSE)

## why

managing agent setups across multiple machines usually breaks because machines drift, sync tools try to be bidirectional authorities, or agents execute unbounded setup scripts that cannot be verified. canonfig keeps configuration deterministic and one-way:

- one authority: exactly one source machine publishes upstream. followers consume signed revisions and never publish back.
- deterministic first: declared files, configs, skills, and platform package recipes apply first. configuration agents only handle bounded fallback tasks.
- immutable and signed: profile revisions are content-addressed, cryptographically signed, and verified after download.
- explicit secret authority: profile credentials remain local by default. operators may separately share named secrets with followers enrolled in the `canonfig:secrets` group; transferred values use pinned HTTPS and native OS credential stores.
- native schedulers, no follower daemons: followers sync from systemd user timers, launchd user agents, or Windows Task Scheduler, with no resident follower process.
- clear divergence states: stops at human action required when an operator step is needed, and flags follower drift when local skill edits would otherwise be overwritten.

## install

4.0.0 is for new installations. if you have a 3.2.x installation, do not replace
its package or state in place; follow the [fresh-install guide](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/upgrade.mdx).

requires Node.js 24+ and npm. install the same release on the source machine and on every follower:

```bash
npm install --global @microck/canonfig@4.0.0
canonfig --version
canonfig doctor --no-input
```

the npm package is `@microck/canonfig`; the installed binary is `canonfig`. read the `credentials` line of `doctor`: canonfig keeps its keys in Secret Service (linux), Keychain (macos), or Credential Manager (windows). if it reports storage as unavailable, follow the recovery text it prints before you continue.

## quickstart

this is the short form of the [tutorial](https://github.com/Microck/canonfig/blob/main/website/content/docs/tutorials/first-sync.mdx): machine A (the source) has Claude Code and Codex set up; machine B (a follower) receives that setup and keeps it current on its own. the commands use a POSIX shell.

### 1. make machine A the source

```bash
canonfig source init
```

this creates the source signing key and TLS certificate and publishes nothing. it refuses to replace an existing source identity.

### 2. write the profile

you declare what to sync in a JSONC profile file. create `~/canonfig.profile.jsonc` on machine A. each `source` path is relative to the profile file's directory, has no `..`, and must resolve inside that directory:

```jsonc
{
  "version": 2,
  "id": "workstation",
  "name": "Workstation",
  "groups": [],
  "resources": [
    {
      "id": "claude-instructions",
      "kind": "file",
      "target": "~/.claude/CLAUDE.md",
      "spec": { "kind": "file", "source": ".claude/CLAUDE.md" },
      "verify": { "method": "digest" }
    },
    {
      "id": "codex-config",
      "kind": "config",
      "target": "~/.codex/config.toml",
      "spec": {
        "kind": "config",
        "format": "toml",
        "keys": [{ "path": "model_reasoning_effort", "value": "high" }]
      },
      "verify": { "method": "digest" }
    },
    {
      "id": "claude-review-skill",
      "kind": "skill",
      "target": "~/.claude/skills/code-review",
      "spec": {
        "kind": "skill",
        "name": "code-review",
        "files": [{ "path": "SKILL.md", "source": ".claude/skills/code-review/SKILL.md" }]
      },
      "verify": { "method": "digest" }
    }
  ]
}
```

`"verify": { "method": "digest" }` without a `digest` value makes publication compute the digest from the exact content it publishes; a digest you write yourself must match. a `config` resource owns only the keys it lists; everything else in that file stays the follower's. the [profile reference](https://github.com/Microck/canonfig/blob/main/website/content/docs/reference/profile-schema.mdx) lists every field.

`canonfig source scan --file <path>` is tool discovery only: it proposes `tool` resources (such as the npm package behind an MCP server command) and never proposes file, config, or skill resources.

### 3. check and publish

```bash
canonfig source digest --profile-file ~/canonfig.profile.jsonc
canonfig source publish --profile-file ~/canonfig.profile.jsonc --reviewer "$USER"
```

`source digest` reads the profile like publication does and prints each resource's digest; it signs nothing. a missing source file, a path outside the profile directory, or an invalid value fails there with the resource id and the reason. publishing the same content again returns the same revision; changed content becomes the next sequence.

### 4. keep the source serving and invite machine B

```bash
canonfig source service install
canonfig source service status
canonfig source invite --endpoint https://127.0.0.1:17342 --output ~/canonfig-invite --expires 1h
```

`source service install` runs `source serve` as a native user service (systemd user unit, launchd agent, or Task Scheduler logon task) and waits until the endpoint answers with this source's pinned identity. to try things in the foreground instead, run `canonfig source serve --host 127.0.0.1 --port 17342` and leave the terminal open.

the invitation is a single-use, mode-`0600` file that expires. copy it to B over an authenticated channel. if A and B are different hosts, also copy A's SSH host public key, read on A itself:

```bash
scp ~/canonfig-invite b.example:canonfig-invite
scp /etc/ssh/ssh_host_ed25519_key.pub b.example:source-host-key.pub
```

### 5. enroll machine B

on B, when A is another host, start the managed tunnel after the source is serving. it pins the SSH host key, the TLS certificate, and the source signing key separately. later restarts need no invitation: `canonfig tunnel start` alone restarts the recorded tunnel.

```bash
canonfig tunnel start --invitation ./canonfig-invite --ssh-host a.example --ssh-user you --ssh-host-key-file ./source-host-key.pub
```

enroll by piping the invitation; it is never passed as an argument. `--profile` selects the profile:

```bash
cat ./canonfig-invite | canonfig follower enroll --stdin --name laptop --profile workstation
rm ./canonfig-invite
```

### 6. plan and apply

```bash
canonfig sync --plan
canonfig sync --apply
canonfig status
```

apply journals every action and verifies each resource independently. the result is `Converged` when every resource matches; if a filesystem action fails, the run is rolled back and names the resource and the reason.

`Converged` does not mean each client has accepted what it received. Restart Claude Code and review hooks in `/hooks` if it reports hooks changed outside the app; Claude Code and Codex ask you to trust each project folder; Codex does not run hooks from `~/.codex/hooks.json` until you open `/hooks` and trust each one. For a projected Antigravity MCP server, start `agy` in that project and invoke one of its managed tools to verify loading. `canonfig status` keeps `clientLoaded` at `not-verified`: canonfig cannot see inside a client.

### 7. sync automatically

```bash
canonfig schedule set daily@09:00
canonfig schedule status
```

the native job runs `canonfig sync --apply --no-input --scheduled` at that local time. `schedule set` prints the resolved time zone, the next run, and a warning when the time falls into a daylight-saving gap. when the profile carries a `scheduleDefault`, sync only reports it; `canonfig schedule set --default` installs it.

### unattended operation

the source service and follower schedules run while the user is logged in on linux, macos, and windows. on linux they also run at boot and after logout once lingering is on (`loginctl enable-linger "$USER"`); canonfig does not turn it on for you. macos needs the logged-in desktop session with the login Keychain unlocked. a scheduled follower run restarts a managed tunnel that went down once before fetching. see [run canonfig unattended](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/run-unattended.mdx) and [manage schedules](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/manage-schedules.mdx).

### changes and upgrades

edit the source files or the profile on A, then run the same `source digest` and `source publish` commands; followers apply the new sequence at their next run. see [publish profile changes](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/publish-profile-changes.mdx).

the source and every follower in a new 4.0.0 installation must run the same major.minor release; otherwise requests fail with "source/follower version mismatch". 4.0.0 refuses 3.2.x peers. An in-place upgrade from 3.2.x is unsupported and unverified: keep the old state intact and follow the [fresh-install procedure](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/upgrade.mdx) to back it up and set up a separate Source and followers.

### shared secrets (optional)

to share a named secret, invite the follower with `--group canonfig:secrets` and pipe each value into the source credential store. piped input is stored byte for byte, so use `printf '%s'` rather than `echo`:

```bash
printf '%s' "$GITHUB_TOKEN" | canonfig secrets set github-token
canonfig source invite --endpoint https://127.0.0.1:17342 --output ./canonfig-secrets-invite --expires 15m --group canonfig:secrets
```

a successful follower apply then writes authorized secrets into the follower's native credential store.

### journaled setup (optional)

`canonfig setup` bootstraps a machine role through a reviewed, digest-approved plan that `setup apply` resumes from a journal:

```bash
canonfig setup plan --role source --file ~/.codex/config.toml --intent "prepare source"
canonfig setup approve --approver operator
canonfig setup apply
canonfig setup status
```

`setup plan --file` bounds tool discovery only; it does not select what is synced. synced files, configs, and skills come from the profile file you publish.

## harness configuration files

harness configuration projects one canonical project definition into selected harnesses. it is scaffolded as YAML by default or strict JSON on request:

```bash
canonfig harness init
canonfig harness init --format json
canonfig harness validate
canonfig harness plan
canonfig harness apply
```

canonfig rejects projects containing more than one of `.canonfig/harness.yaml`, `.canonfig/harness.yml`, and `.canonfig/harness.json` instead of silently choosing one. ordinary follower sync does not run harness projection.

## resource kinds and apply policies

| resource | default policy | outcome |
| --- | --- | --- |
| `file` | `replace` | exact owned file content and mode, or raw symlink target |
| `directory` | `mirror-owned` | source-owned tree with exact modes; only unchanged owned entries are removed. `replace` is a true mirror and removes foreign entries too |
| `config` | `merge` | declared TOML, JSON, or YAML keys merged in place, keeping local keys and comments; keys dropped from the profile are removed unless the follower claimed them |
| `skill` | `replace-if-unmodified` | canonical skill tree without overwriting follower edits |
| `tool` | `ensure` | platform-specific recipe installation and independent verification; declares `agentInstall` bounds to permit bounded agent installation |
| `credential` | `require-local` | validated local credential reference, never a copied secret |

transfers are content-addressed and incremental. transfer and apply remain separate steps: a downloaded blob is not proof of convergence.

## authority and security model

- one source machine: only the source machine publishes profile revisions. followers are read-only consumers and cannot push upstream state.
- immutable revisions: every revision is content-addressed, signed with the source private key, and verified locally before apply.
- pinned trust: enrollment pins source TLS and signing certificates. synchronization rejects changed pins, invalid signatures, digest mismatches, and replayed invitations.
- revocable follower identities: every follower receives an independent revocable credential and group assignment. `canonfig source revoke <follower-id>` revokes one from the source; `canonfig follower unenroll` revokes it from the follower itself and removes its local enrollment, credential, and received shared secrets. files it applied and its native schedule stay in place.
- explicit secret sharing: profile credential resources stay local. only followers granted `canonfig:secrets` receive separately named source secrets over authenticated pinned HTTPS; values go directly into native secret storage and are never written to profiles, ordinary state tables, or JSON manifests.
- non-transitive secrets: followers never re-share values received from a source, and source deletions retire source-owned follower credentials on the next apply.
- bounded agent harness: when agent resolution is enabled, tasks run within strict allowlists for executables, paths, HTTPS origins, and input size. elevation, login, restart, and reboot remain denied by default.
- fail-closed boundaries: missing logins, locked or unavailable credential stores, and manual approvals raise Human Action Required (exit code 3); modified follower skills produce Follower Drift (exit code 4).

## command surface

run `canonfig --help` for every command, and `canonfig <group> --help` (for example `canonfig source --help`) for one group.

| command | purpose |
| --- | --- |
| `canonfig setup` | plan, approve, apply, or inspect a journaled machine bootstrap |
| `canonfig source init` | initialize local source authority |
| `canonfig source scan` | discover tool resources from named files (tool discovery only) |
| `canonfig source digest` | validate a profile file and print each resource's content digest without signing |
| `canonfig source publish` | publish a profile file as an immutable signed revision |
| `canonfig source serve` | run the loopback source server in the foreground |
| `canonfig source service` | install, inspect, or remove the source server as a native user service |
| `canonfig source invite` | generate a short-lived, single-use follower invitation |
| `canonfig source revoke` | revoke an enrolled follower identity |
| `canonfig tunnel` | start, restart, inspect, or stop the pinned SSH tunnel to the source |
| `canonfig follower enroll` | enroll a follower from a piped invitation and select its profile |
| `canonfig follower unenroll` | revoke this follower on the source and remove its local enrollment, credential, and received secrets |
| `canonfig sync` | plan (`--plan`) or apply (`--apply`) profile synchronization |
| `canonfig recover` | resume an interrupted synchronization run from its journal |
| `canonfig abandon` | close a run that cannot be recovered, without rollback |
| `canonfig status` | inspect local follower convergence and drift status |
| `canonfig doctor` | run non-mutating platform and environment diagnostics |
| `canonfig overlay` | manage local configuration overlays (`list`, `set`, `remove`) |
| `canonfig profile` | list profiles, inspect revisions, or select the active profile |
| `canonfig schedule` | configure (`set`), inspect (`status`), or remove native schedules |
| `canonfig secrets` | set, list, remove, or synchronize opt-in shared secrets, or bootstrap credential storage |
| `canonfig agent` | inspect or set agent policy and harness allowlist bounds |
| `canonfig harness` | initialize, validate, plan, apply, and inspect project harness configuration |
| `canonfig installer` | bind, check, list, or remove the installer executables canonfig uses |

## exit codes

`--json` outputs the stable `canonfig.cli/v1` envelope. exit codes are explicit:

| code | category | meaning |
| --- | --- | --- |
| `0` | `success` | command completed or follower converged |
| `1` | `internal` | internal error |
| `2` | `usage-or-configuration` | invalid arguments, profile, or configuration, or a source/follower version mismatch |
| `3` | `human-action-required` | manual human action needed, including a locked or unavailable local credential store |
| `4` | `conflict-or-drift` | local conflict, another canonfig process holding the run, or follower skill drift |
| `5` | `authentication-or-revocation` | invalid certificate pin, revoked identity, or bad token |
| `6` | `transport` | connection or TLS transport failure, including a down managed tunnel |
| `7` | `verification-or-apply-failure` | recipe verification or apply failure |

## documentation

- [tutorial: sync Claude Code and Codex from machine A to machine B](https://github.com/Microck/canonfig/blob/main/website/content/docs/tutorials/first-sync.mdx)
- [how-to: publish profile changes](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/publish-profile-changes.mdx)
- [how-to: run canonfig unattended](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/run-unattended.mdx)
- [how-to: manage schedules](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/manage-schedules.mdx)
- [how-to: recover](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/recover.mdx)
- [how-to: upgrade canonfig](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/upgrade.mdx)
- [how-to: configure agent policies](https://github.com/Microck/canonfig/blob/main/website/content/docs/how-to/configure-agent-policies.mdx)
- [reference: CLI](https://github.com/Microck/canonfig/blob/main/website/content/docs/reference/cli.mdx)
- [reference: profiles and schema](https://github.com/Microck/canonfig/blob/main/website/content/docs/reference/profile-schema.mdx)
- [reference: cross-platform behavior](https://github.com/Microck/canonfig/blob/main/website/content/docs/reference/cross-platform.mdx)
- [reference: diagnostics](https://github.com/Microck/canonfig/blob/main/website/content/docs/reference/diagnostics.mdx)
- [reference: security](https://github.com/Microck/canonfig/blob/main/website/content/docs/reference/security.mdx)
- [explanation: architecture](https://github.com/Microck/canonfig/blob/main/website/content/docs/explanation/architecture.mdx)
- [explanation: tools and recipes](https://github.com/Microck/canonfig/blob/main/website/content/docs/explanation/tools-and-recipes.mdx)
- [install skill](https://github.com/Microck/canonfig/blob/main/skills/install-canonfig/SKILL.md)
- [setup skill](https://github.com/Microck/canonfig/blob/main/skills/setup-canonfig/SKILL.md)
- [operate skill](https://github.com/Microck/canonfig/blob/main/skills/operate-canonfig/SKILL.md)
- [release runbook](https://github.com/Microck/canonfig/blob/main/docs/release-runbook.md)

## license

[MIT](https://github.com/Microck/canonfig/blob/main/LICENSE)
