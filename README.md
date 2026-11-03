<div align="center">

  <img src="https://raw.githubusercontent.com/Microck/canonfig/main/.github/assets/canonfig-animation.gif" width="320" alt="canonfig chest filled with AI agent logos">

  <h1>canonfig</h1>
  <p>one-way sync for ai agent configuration.</p>

  <p>
    <a href="https://www.npmjs.com/package/@microck/canonfig"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/@microck/canonfig.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=dark"><img src="https://shieldcn.dev/npm/@microck/canonfig.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=light" alt="npm version"></picture></a>
    <a href="https://www.npmjs.com/package/@microck/canonfig"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/dt/@microck/canonfig.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=dark"><img src="https://shieldcn.dev/npm/dt/@microck/canonfig.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=light" alt="npm total downloads"></picture></a>
    <a href="https://github.com/Microck/canonfig/actions/workflows/acceptance.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/ci/Microck/canonfig.svg?workflow=acceptance.yml&amp;branch=main&amp;variant=secondary&amp;size=xs&amp;logo=false&amp;mode=dark"><img src="https://shieldcn.dev/github/ci/Microck/canonfig.svg?workflow=acceptance.yml&amp;branch=main&amp;variant=secondary&amp;size=xs&amp;logo=false&amp;mode=light" alt="ci status"></picture></a>
    <a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/license/Microck/canonfig.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=dark"><img src="https://shieldcn.dev/github/license/Microck/canonfig.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=light" alt="license"></picture></a>
  </p>
</div>


---

`canonfig` keeps a declared agent setup consistent across linux, macos, and
windows. one Source Machine publishes immutable, signed Profile Revisions.
Follower Machines plan, apply, and independently verify what they are authorized
to receive. followers never publish changes back.

deterministic actions run first. optional Configuration Agents handle bounded
fallback tasks; an agent's claim never counts as proof of convergence.

[documentation](https://canonfig.micr.dev/docs) | [interactive demo](https://canonfig.micr.dev) | [first sync](https://canonfig.micr.dev/docs/tutorials/first-sync/) | [CLI reference](https://canonfig.micr.dev/docs/reference/cli/)

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
npm install --global @microck/canonfig@5.0.1
canonfig --version
canonfig doctor --no-input
```

check the `credentials` result before continuing. canonfig uses Secret Service
on linux, Keychain on macos, and Credential Manager on windows.

## browser interface

<img src="https://raw.githubusercontent.com/Microck/canonfig/main/.github/assets/readme/walkthrough.gif" width="880" alt="the canonfig browser interface: the Source overview, the machine map, the profile, then a follower's sync page checking for updates">

the browser interface covers the whole loop: see what changed on the Source,
publish it, watch every machine pick it up, and decide what happens to local
edits on a follower. [try the interactive demo](https://canonfig.micr.dev); it
runs in your browser on made-up machines.

the interface is a preview and isn't in the npm package yet. to sync real
machines, use the commands below.

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/Microck/canonfig/main/.github/assets/readme/overview.png" alt="Source overview: unpublished changes and which machines are not up to date, and why"><br><b>overview</b>: what you haven't published yet, and which machines are behind and why</td>
    <td width="50%"><img src="https://raw.githubusercontent.com/Microck/canonfig/main/.github/assets/readme/machines.png" alt="machine map: the Source atlas connected to laptop, studio, gaming-pc and build-box, each with its sync state"><br><b>machines</b>: every follower, its revision and its sync state</td>
  </tr>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/Microck/canonfig/main/.github/assets/readme/sync.png" alt="follower sync page: the planned changes and a paused skill with the choice to keep the local edit or use the new revision"><br><b>sync</b>: the planned changes on a follower, with a choice for each local edit</td>
    <td width="50%"><img src="https://raw.githubusercontent.com/Microck/canonfig/main/.github/assets/readme/setup.png" alt="setup: what should this machine do, make this the Source or copy the setup from another machine"><br><b>setup</b>: a new machine becomes the Source or copies its setup from one</td>
  </tr>
</table>

## sync machines

start with the [first sync tutorial](https://canonfig.micr.dev/docs/tutorials/first-sync/).
it covers the profile, source service, pinned connection, and follower enrollment.

after enrollment, run on the follower:

```sh
canonfig sync --plan
canonfig sync --apply
canonfig status
```

to publish changes from a reviewed profile on the source:

```sh
canonfig source digest --profile-file ~/canonfig.profile.jsonc
canonfig source publish --profile-file ~/canonfig.profile.jsonc --reviewer "$USER"
```

`source digest` validates content without signing it; publication creates an
immutable revision. `Converged` means declared resources match, not that an
agent client has loaded them.

### schedule updates

```sh
canonfig schedule set daily@09:00
canonfig schedule status
```

schedules follow the user's login session by default. see
[schedules](https://canonfig.micr.dev/docs/how-to/manage-schedules/) and
[unattended operation](https://canonfig.micr.dev/docs/how-to/run-unattended/)
for boot or logged-out operation.

## configure harnesses

project-local harness configuration projects one canonical definition into
selected agent harnesses:

```sh
canonfig harness init
canonfig harness plan
canonfig harness apply
# or keep local projections updated while this foreground process runs:
canonfig harness watch
```

`canonfig harness export` packages a setup to share; it is **not a secret
scanner**, so review declared content first. see the
[harness guide](docs/harness-configuration.md) and
[archive contents and limits](docs/harness-archives.md).

## update upstream skills

register an existing skill's Git source with `canonfig skills track`, then
preview updates before applying them:

```sh
canonfig skills check
canonfig skills update --apply
```

local edits block an update rather than being discarded. see
[tracking, local edits and recovery](docs/skill-updates.md).

## self-updates

opt-in `canonfig self-update` installs stable patch releases for user-owned
global npm installs; major and minor upgrades stay manual. read
[setup, automation and recovery](docs/self-update.md) before enabling it.

## what gets applied

| resource | default behavior |
| --- | --- |
| `file` | replace owned content and mode |
| `directory` | mirror desired entries; remove only unchanged entries previously written by Canonfig |
| `config` | merge declared TOML, JSON or YAML keys; preserve follower-owned keys and comments |
| `skill` | replace only if the installed copy is unmodified |
| `tool` | run a platform recipe and independently verify it |
| `credential` | require a local credential reference; never copy it as profile content |

explicit policies can be more destructive. read the
[profile reference](https://canonfig.micr.dev/docs/reference/profile-schema/)
before changing ownership or apply policy.

## trust and boundaries

- enrollment pins source TLS and signing identities; changed pins, invalid
  signatures and replayed invitations fail closed
- each follower has an independently revocable identity and group assignment
- profile credentials stay local; named secrets are shared only with followers
  enrolled in `canonfig:secrets`
- Configuration Agents are bounded by allowlists; elevation, login, restart and
  reboot are denied

see [security and credentials](https://canonfig.micr.dev/docs/reference/security/).

## agent skills

let an AI agent install, set up or operate canonfig for you with the
[install](skills/install-canonfig/SKILL.md), [setup](skills/setup-canonfig/SKILL.md)
and [operate](skills/operate-canonfig/SKILL.md) skills.

## development

```sh
npm ci
npm run build:cli
npm run docs:validate
npm test
```

the browser interface lives in [`ui/`](ui/README.md) and runs on demo data
(`npm --prefix ui ci`, then `npm run ui:dev`). see the
[release runbook](docs/release-runbook.md) for every release gate.

## license

[MIT](LICENSE)
