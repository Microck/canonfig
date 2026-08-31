# Canonfig

Canonfig 2 is a deterministic, one-way configuration synchronizer for AI agent
setups. One **Source Machine** discovers and explicitly publishes immutable,
authenticated **Profile Revisions**. Linux, macOS, and Windows **Follower
Machines** fetch only revisions allowed for their identities and groups, then
plan, apply, and independently verify the selected profile.

Configuration Agents are optional and bounded. Canonfig always runs declared
deterministic actions first, and an agent statement never counts as proof of
convergence.

## What Canonfig manages

A Machine Profile can declare these resource kinds and apply policies:

| Resource | Default policy | Outcome |
| --- | --- | --- |
| File | `replace` | Exact owned file or symlink content |
| Directory | `mirror-owned` | Source-owned tree; only unchanged owned files are removed |
| Config | `merge` | Declared TOML, JSON, or YAML keys with local keys preserved |
| Skill | `replace-if-unmodified` | Canonical skill tree without overwriting follower edits |
| Tool | `ensure` | Platform-specific installation and verification |
| Credential | `require-local` | Usable local credential reference, never a copied secret |
| Schedule | `replace` | Native user-level synchronization schedule |

Transfers are content-addressed and incremental. Transfer and apply are separate:
a downloaded blob is not proof that a resource converged.

## Supported platforms

Canonfig requires Node.js 24 or newer and npm.

| Platform | Secure credential provider | Native user scheduler | Common recipes |
| --- | --- | --- | --- |
| Linux | Secret Service | systemd user timer | apt, npm, uv, cargo, source |
| macOS | Keychain | launchd user agent | Homebrew, npm, uv, cargo, source |
| Windows 10/11 | Credential Manager | per-user Task Scheduler | winget, npm, uv, cargo, source |

Paths, package identities, recipes, credential providers, and scheduler
artifacts remain platform-specific even when the desired capability is shared.

Package recipes default to fail-closed builds: npm uses `--ignore-scripts` and
uv uses `--only-binary=:all:`. Recipes that require lifecycle hooks or source
distributions must include a reviewed build policy with bounded toolchain
executables, paths, HTTPS origins, capabilities, and steps. The current
executor escalates those recipes to Human Action Required because it cannot
confine lifecycle descendants. Git and other source dependency specifications
are not accepted without a separately bounded execution plan. Reviewed source
recipes are preserved as immutable references but always require Human Action
Required; the current executor never fetches or builds source code.

## Install

Install the exact public package version on Linux, macOS, or Windows:

```bash
npm install --global @microck/canonfig@2.1.0
canonfig --version
```

The npm package is scoped as `@microck/canonfig`; the installed executable
remains `canonfig`.

## Quickstart

### 1. Initialize the Source Machine

```bash
canonfig source init
canonfig doctor --no-input --timeout-ms 5000
```

Discover explicit source evidence, review the resulting proposal, and publish it
intentionally:

```bash
canonfig source scan --file AGENTS.md --file package.json
canonfig source publish --proposal package.json --profile workstation --name Workstation --reviewer operator
canonfig source publish --profile-file ~/.canonfig/source/profile.jsonc --proposal package.json --reviewer operator
canonfig profile list
```

The JSONC `--profile-file` form is authoritative for the profile id, name,
groups, resources, policies, dependencies, and schedule default. Accepted
discovery proposals are merged for resource ids not authored in that file;
unreviewed discovery remains blocked, and duplicate or conflicting resource
targets fail closed. Credentials are references only and are never copied from
the Source Machine.

### 2. Serve and invite

The currently shipped source server accepts loopback hosts only:

```bash
canonfig source serve --host 127.0.0.1 --port 17342
```

While it is running, create a short-lived, single-use invitation:

```bash
canonfig source invite --endpoint https://127.0.0.1:17342 --expires 15m --group developers
```

Treat the returned invitation as temporary sensitive material. The enrolled
endpoint must be reachable as that exact HTTPS origin.

### 3. Enroll a follower

Keep the complete invitation in an ephemeral local variable:

```bash
canonfig follower enroll "$INVITE" --name laptop --profile workstation
canonfig profile select workstation
canonfig sync --plan
```

Enrollment pins the source TLS and signing fingerprints and issues an
independently revocable follower credential. Apply only after reviewing the
plan:

```bash
canonfig sync --apply
canonfig status
```

### 4. Configure synchronization

The default follower schedule is daily at 00:00 in its configured local
timezone:

```bash
canonfig schedule set daily@00:00
canonfig schedule status
```

Native jobs invoke `canonfig sync --apply --no-input`; Canonfig does not require
a resident follower daemon.

## Security model

- There is exactly one Source Machine. Followers never publish upstream state.
- Profile Revisions are immutable, content-addressed, signed, and verified after
  download.
- Enrollment pins independent TLS and source-signing fingerprints. Later
  synchronization rejects changed pins, invalid signatures, digest mismatches,
  replayed invitations, and revoked credentials.
- Every follower has its own revocable identity and group assignments.
- Credentials remain local references backed by the platform provider. Canonfig
  does not copy Source Machine credentials into profiles or followers.
- Agent Tasks use intersecting task and harness bounds for paths, executables,
  HTTPS origins, elevation, login, restart, reboot, time, input, and output.
- Canonfig captures and redacts evidence, then performs independent verification.
- Missing login, secure storage, approval, or another human-only capability
  produces **Human Action Required** with exact recovery instructions.
- A modified managed skill produces **Follower Drift** and remains untouched.

Keep invitations, tokens, passwords, private keys, source signing material,
follower credentials, and SQLite state out of repositories and command examples.

## Verified CLI examples

Plan, apply, inspect, and diagnose:

```bash
canonfig sync --plan
canonfig sync --apply --no-input --json
canonfig status --json
canonfig doctor --no-input --timeout-ms 5000 --json
```

Inspect profiles and select one on a follower:

```bash
canonfig profile list
canonfig profile show revision-one
canonfig profile select workstation
```

Inspect or set agent policy and harness bounds:

```bash
canonfig agent policy
canonfig agent policy agent-propose
canonfig agent harness
canonfig agent harness codex --executable /opt/codex --allow-path /home/operator/.canonfig --allow-leaf-executable npm --allow-origin https://registry.npmjs.org --allow-capability restart --maximum-input-bytes 4096
```

Manage schedules and recovery:

```bash
canonfig schedule set weekly:Mon,Wed,Fri@12:30 --timezone Europe/Paris
canonfig schedule remove
canonfig recover --no-input --json
```

Revoke one follower identity on the Source Machine:

```bash
canonfig source revoke follower-one
```

Human output is the default. `--json` emits the stable `canonfig.cli/v1`
envelope. Exit codes distinguish success (`0`), internal failure (`1`), usage or
configuration (`2`), Human Action Required (`3`), conflict or drift (`4`),
authentication or revocation (`5`), transport (`6`), and verification or apply
failure (`7`).

## Documentation

- [Architecture and authority](website/content/docs/concepts/architecture.mdx)
- [Source setup](website/content/docs/source/setup.mdx)
- [Discovery, review, and publication](website/content/docs/source/lifecycle.mdx)
- [Follower enrollment and trust](website/content/docs/followers/enrollment.mdx)
- [Profiles and apply policies](website/content/docs/profiles/resources.mdx)
- [Synchronization](website/content/docs/operations/synchronization.mdx)
- [Agent policies and harness bounds](website/content/docs/operations/agent-policies.mdx)
- [Schedules](website/content/docs/operations/schedules.mdx)
- [Drift and Human Action Required](website/content/docs/operations/drift-and-human-action.mdx)
- [Recovery](website/content/docs/operations/recovery.mdx)
- [CLI reference](website/content/docs/reference/cli.mdx)
- [Installation skill](skills/install-canonfig/SKILL.md)
- [Operations skill](skills/operate-canonfig/SKILL.md)

## Shipped constraints

- The source transport accepts only canonical loopback hosts, including
  `localhost`, and binds to `127.0.0.1` or `::1`. Remote exposure, public
  binding, and port-forwarding workflows are not part of the verified CLI
  contract.
- `schedule set` accepts daily and weekly calendars. The profile contract can
  represent custom calendars, but the CLI does not accept cron or native
  scheduler expressions.
- Source discovery scans files passed through `--file`; it is not an implicit
  whole-home scan.
- Supported agent harness kinds are `codex`, `claude`, and `gemini`.
- Third-party installers, login operations, and arbitrary agent commands do not
  promise full rollback. Recovery re-observes and re-verifies them.
- Canonfig is one-way. It does not provide bidirectional sync, automatic
  credential transfer, silent skill conflict resolution, whole-home backup, or
  a hosted fleet control plane.
- Cross-platform acceptance and release-readiness certification is C13 work and
  is not claimed by this documentation milestone.

## Development and validation

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run docs:validate
npm run skills:validate
npm pack --dry-run
```

The normal lint and test workflows include documentation command checks, skill
structure checks, and representative skill scenarios.

## License

[MIT](LICENSE)
