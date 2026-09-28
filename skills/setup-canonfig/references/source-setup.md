# Source Machine setup

Use for the sole publishing authority, Machine Profile authoring, publication,
and invitations. Follow the selected Simple/Advanced mode and numbered question
contract from [questions.md](questions.md), not a separate free-text interview.

## Inspect and select

Confirm user, Node.js 24+, npm, installed Canonfig version, secure credential
capability, existing role, revisions, and diagnostics. Never initialize over a
Follower identity or unknown state. These are conditional observations:

```bash
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig profile list
```

If choosing another computer, offer This machine / Opt-in Tailscale listing /
Manual entry / Other through [device discovery](tailscale-discovery.md). A
selected remote peer remains unconfigured until an authorized handoff or session
verifies it. Never initialize locally on behalf of a selected remote machine.

In Simple, ask only unresolved profile identity and configuration scope after
ownership is established; show groups, schedule default, and policies as editable
summary rows. In Advanced, offer environment, devices, profile, each resource,
credentials, and invitation sections from [the catalogue](configuration-choices.md).
For each field: observed candidates, supported alternatives, numbered Other, a
short explanation, and a justified recommendation. No invented profile inventory.

Recommend preserving valid state, only explicit approved discovery files, no
additional groups without a need, deterministic-only, and no new shared secrets.
Profile names such as workstation are proposals, not discovered facts. Calendar
proposals must show their timezone and remain editable.

## Install and initialize

Install only when necessary, then create the Source bootstrap plan. `--file`
names approved tool-discovery inputs only; it never selects synced content.

For an existing 3.2.x installation, do not replace its package or state.
Set up 4.0.0 separately using the [fresh-install guide](../../../website/content/docs/how-to/upgrade.mdx).

```bash
npm install --global @microck/canonfig@4.0.0
canonfig --version
canonfig setup plan --role source --file AGENTS.md --intent "prepare source"
canonfig setup approve --approver operator
canonfig setup apply
canonfig setup status --json
canonfig doctor --no-input --timeout-ms 5000
```

Show the exact setup digest before approval; use actual approved file paths and
operator identity, or omit `--file` when none was selected. Source preflight
must prove signing and TLS key storage before initialization. The journaled
apply is resumable, and `source init` refuses to replace an existing Source
identity. Report the Source owner and location without displaying key material.

## Discover tools and author the profile

`source scan` is tool discovery only. Scan only approved explicit files:

```bash
canonfig source scan --file ~/.codex/config.toml --file ~/.claude.json
```

It proposes `tool` resources (for example the pinned package behind an MCP
server command) and runs no processes. It never proposes file, config, or skill
resources. Summarize accepted and needs-review evidence, login requirements,
tool recipes, and unresolved Agent Tasks. Do not execute discovered prose or
infer package equivalence across platforms.

Synced files, configs, and skills come from an authored JSONC Machine Profile,
for example `~/canonfig.profile.jsonc`, the same route as the
[tutorial](https://github.com/Microck/canonfig/blob/main/website/content/docs/tutorials/first-sync.mdx).
Placing it in the home directory lets each `source` path point at the real
file. Rules to apply while authoring:

- `source` is relative to the profile file's directory, has no `..`, and must
  resolve inside that directory after symlinks.
- For file, directory, config, and skill resources write
  `"verify": { "method": "digest" }` and omit `digest`; publication computes
  it. A hand-written digest must match.
- A `config` key owns the whole value at its path; other keys in the file stay
  the follower's. `~/.claude.json` also holds account state, so manage only
  entries such as `mcpServers.<name>`, never the whole file.
- A skill lists every file it contains. Claude Code reads `~/.claude/skills`;
  Codex reads `~/.agents/skills`.
- Automatic installer recipes need an exact `version`. Leave secrets out.

Show compact editable resource rows: ID/kind, target, groups, dependencies,
ownership/policy, recipe/version, and independent verification. Simple drills
into ambiguous or requested rows; Advanced offers each relevant field. Use the
catalogue's recursive numbered menus for content, permissions, symlinks, config
keys, build bounds, and checks rather than asking users to write raw schema.

| Kind | Documented default Apply Policy |
| --- | --- |
| file | replace |
| directory | mirror-owned |
| config | merge |
| skill | replace-if-unmodified |
| tool | ensure |
| credential | require-local |
| schedule | replace |

A default replacement policy is not proof an existing target is safe to overwrite.
Offer only schema-compatible alternatives and show destructive consequences.
Credential resources hold references, never values. Local Overlays are for
supported merge-config keys, not arbitrary skill-tree or target-path overrides.

## Publication gate

Validate unique IDs, dependencies, cycles, group references, nonoverlapping safe
targets, policy compatibility, platform recipes, and independent verification,
then check the profile. This reads every `source` like publication and signs
nothing:

```bash
canonfig source digest --profile-file ~/canonfig.profile.jsonc
```

Show the exact profile, groups, calendar, resources, digests, discovery inputs,
and any blockers. `source digest` is the dry run; do not invent another
validation flag. Publication with `--proposal` rescans that input; if it
changed, review the changed candidate.

```text
Question: PUBLISH — Publish this exact Machine Profile as a new immutable revision?
Why it matters: Authorized followers can consume the signed revision; publication is permanent.
Recommended: No automatic recommendation; review all resources and unresolved items first.
Options:
1. Publish this candidate — sign only the reviewed content, with no unresolved blockers.
2. Revise a setting — reopen its choices and revalidate the candidate.
3. Stop before publication — preserve authoring files without signing.
4. Other (type your own) — request a narrower candidate or explanation.
```

After explicit publication approval, use actual reviewed paths, reviewer, and
returned revision IDs, not the illustrative IDs below:

```bash
canonfig source publish --profile-file ~/canonfig.profile.jsonc --reviewer operator
canonfig profile list
canonfig profile show revision-one
```

Add `--proposal <approved-input>` only for reviewed discovery input to merge.
Publishing unchanged content returns the latest revision unchanged, so a resume
does not need to publish again. A profile with no resources is refused.

## Serving, invitations, and shared secrets

Followers fetch from the Source whenever they sync, so keep it serving as a
native user service rather than a foreground terminal:

```bash
canonfig source service install
canonfig source service status
canonfig source invite --endpoint https://127.0.0.1:17342 --output ./canonfig-invite --expires 15m --group developers
```

`install` waits until the endpoint answers with the pinned identity. The service
runs while the user is logged in; on Linux also at boot and after logout once
lingering is on (a human decision: `loginctl enable-linger <user>`). On macOS
run `install` from the desktop session, not over SSH. For a trial,
`canonfig source serve --host 127.0.0.1 --port 17342` runs it in the foreground.

Omit `--group` when no group is intended. Tailscale peers are not valid direct
invitation endpoints. For a remote machine, use Canonfig's managed,
TLS-transparent loopback tunnel with the invitation and the Source's SSH host
public key, read on the Source itself. Start the Source before the tunnel.
Record the follower-local loopback origin separately from the source host.

Offer numbered choices for follower identity, selected profile, declared groups,
lifetime, secure delivery, and any shared-secret grant. Recommend minimum scope,
15m proposed expiry, and fresh material for exposed, expired, or replayed invites.
Never ask for or display a real invitation in chat or reports. The required
mode-`0600` output file is temporary delivery material; remove it after the
follower has consumed the envelope.

`canonfig:secrets` is separate authority. Before granting it, review what the
installed sharing contract makes available; do not imply unsupported per-name
access controls. A new grant requires explicit approval, not Use recommendations.
Set approved values through stdin only, without printing them. Piped input is
stored byte for byte, so a trailing newline from `echo` becomes part of the
secret; use `printf '%s'`. Values are non-empty UTF-8 without NUL, at most 16384
bytes, and the pipe must close within 10 seconds:

```bash
printf '%s' "$GITHUB_TOKEN" | canonfig secrets set github-token
```

## Completion

Verify intended Source owner/identity and relevant diagnostics. When publication
was requested, report actual profile/revision ID, sequence, digest, and time;
inspect that revision against the reviewed candidate. Keep unresolved recipes,
Human Action Required, and unconfigured remote machines explicit. Source-only
initialization need not publish an unrequested profile to count as complete.
