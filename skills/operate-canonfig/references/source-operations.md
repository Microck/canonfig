# Source operations

## Discover tools

`source scan` is tool discovery only. Scan only explicit files:

```bash
canonfig source scan --file ~/.codex/config.toml --file ~/.claude.json
```

It proposes `tool` resources, such as the pinned npm or uv package behind an
MCP server command, and runs no processes. It never proposes file, config, or
skill resources and never copies settings. Review accepted tools, upstream
URLs, invocation evidence, independent verification, platform recipes, login
requirements, and needs-review entries (`incomplete-declaration`,
`ambiguous-executable`). Prose alone remains review evidence.

Reject publication when evidence is unresolved, a recipe embeds credentials,
platform package identity is guessed, or verification cannot observe the
declared capability. Automatic installer recipes need an exact `version`;
publication refuses one without it.

## Author and check the profile

Synced content comes from an authored JSONC profile file such as
`~/canonfig.profile.jsonc`, with `file`, `directory`, `config`, `skill`, `tool`,
and `credential` resources. A `source` path is relative to the profile file's
directory, has no `..`, and must resolve inside that directory after symlinks.
For content resources write `"verify": { "method": "digest" }` and omit the
digest: publication computes it. A digest written by hand must match.

Check before publishing; this signs nothing:

```bash
canonfig source digest --profile-file ~/canonfig.profile.jsonc
canonfig source digest --profile-file ~/canonfig.profile.jsonc --resource claude-instructions
```

It prints each content resource's digest and, when a digest was declared,
whether it matches. Missing sources, escaping paths, unsafe numbers, and
unknown fields fail with the resource ID and the reason.

## Publish explicitly

Publish only a reviewed profile:

```bash
canonfig source publish --profile-file ~/canonfig.profile.jsonc --reviewer operator
canonfig profile list
canonfig profile show revision-one
```

Add `--proposal <path>` to merge accepted discovery resources that do not share
an authored ID. The profile file is authoritative for metadata, resources,
policies, dependencies, and the schedule default. Duplicate IDs, overlapping
targets, malformed fields, and unknown fields are rejected before signing.
`profile show` takes a Profile Revision ID.

Publication signs an immutable, content-addressed revision. The same content as
the latest revision returns that revision unchanged; new content, or content
matching an older revision, becomes the next sequence. Followers take the
highest sequence, so republishing earlier content is the supported rollback of
a profile. A profile with no resources is refused unless `--allow-empty` is
passed on purpose. Credentials are secure-store references only; never put
credential values in a profile file or command argument.

## Keep the Source serving

Followers fetch from the loopback HTTPS endpoint, so the Source must be serving
when they sync. Supervise it as a native user service:

```bash
canonfig source service install
canonfig source service status
```

`install` waits until the endpoint answers with this Source's pinned identity.
`status` reports `running`, `not-installed`, `not-running`, `not-serving`, or
`drifted` (rerun `install`). `canonfig source service remove` removes it. See
[platform boundaries](platform-boundaries.md) for when each platform's service
runs. `canonfig source serve --host 127.0.0.1 --port 17342` is the foreground
form; stop it before installing the service on the same port.

## Invitations and groups

With the Source serving:

```bash
canonfig source invite --endpoint https://127.0.0.1:17342 --output ./canonfig-invite --expires 15m --group developers
```

Repeat `--group` for additional declared groups. Group membership is source
owned and carried by enrollment; followers cannot add themselves. The output
is a bounded mode-`0600` envelope with explicit EOF. Deliver it through an
authenticated private channel and create a new one if it is expired or exposed.

## Shared secrets

Only followers enrolled with `--group canonfig:secrets` receive shared secrets.
Pipe each value; piped input is stored byte for byte, including a trailing
newline, so use `printf '%s'` rather than `echo`:

```bash
printf '%s' "$GITHUB_TOKEN" | canonfig secrets set github-token
```

Values are non-empty UTF-8 without NUL, at most 16384 bytes. The pipe must
close within 10 seconds. At a terminal, entry is hidden and only the final
Enter is dropped. Every store is read back and compared; a store that returns
different bytes fails with exit 3 and keeps nothing.

## Revoke

Revoke one independently issued identity:

```bash
canonfig source revoke follower-one
```

Revocation blocks future authenticated fetches for that follower only. Re-enroll
with a new invitation when access should return; do not reuse credentials or
reset pins. A follower that runs `canonfig follower unenroll` revokes itself;
revoke it here only when its reply says the Source was unreachable.

## Moving from 3.2.x to 4.0.0

An in-place upgrade is unsupported and unverified. The signed revision format
changed; a 4.0.0 Source and a 3.2.x follower refuse each other even if they
were previously enrolled. Do not replace the package or state in the existing
installation. Back up each machine's existing state separately, then establish
a new 4.0.0 Source and enroll new followers in separate installations with new
invitations. Review and republish the profile, and plan before applying. Do not
copy old enrollments, signing credentials, revisions, or schedules into new
state. Follow the [fresh-install guide](../../../website/content/docs/how-to/upgrade.mdx).
