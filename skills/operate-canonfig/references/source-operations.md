# Source operations

## Edit the folder

The Source authors `~/.canonfig/`. Publication reads only `canonfig.jsonc`,
`AGENTS.md`, `rules/`, `skills/`, `agents/`, `commands/`, and `hooks/`; state,
backups, logs, and `local/` stay on this machine. Every file must resolve
inside the folder, and symlinks are refused. Unknown keys and frontmatter
fields fail with the file and the reason. The
[folder reference](https://canonfig.micr.dev/docs/reference/canonfig-folder/)
lists every key; check it before adding one.

After an edit, project it on the Source and review the plan:

```bash
canonfig sync --plan
canonfig sync --apply
```

The plan names every harness surface a first apply takes over and whether it
keeps a backup. MCP secrets stay `{ "fromEnv": "NAME" }` references; hooks and
stdio MCP commands run code on followers, so review each one before
publishing.

## Discover tools

`source scan` is tool discovery over the folder. It reads instructions, skills,
hook scripts, and MCP commands and proposes `tools` entries, such as the pinned
npm or uv package behind an MCP server command, and runs no processes:

```bash
canonfig source scan
canonfig source scan --write
```

Review accepted tools, upstream URLs, invocation evidence, independent
verification, platform recipes, login requirements, and needs-review entries.
Prose alone remains review evidence. `--write` adds the accepted entries to
`canonfig.jsonc` and keeps its comments.

Reject publication when evidence is unresolved, a recipe embeds credentials,
platform package identity is guessed, or verification cannot observe the
declared capability. Automatic installer recipes need an exact `version`;
publication refuses one without it.

## Publish explicitly

Publish only a reviewed folder:

```bash
canonfig source publish --reviewer operator
canonfig profile list
canonfig profile show workstation:3f9a2c41
```

Publication compiles the folder into one signed, immutable, content-addressed
revision. It needs `profile` (`id`, `name`) in `canonfig.jsonc` and refuses a
`profile.id` other than the one this Source already publishes: one Source
publishes one Machine Profile. Credential-looking literals are refused before
signing. `profile show` takes a Profile Revision ID.

The same content as the latest revision returns that revision unchanged; new
content, or content matching an older revision, becomes the next sequence.
Followers take the highest sequence, so restoring earlier folder content and
publishing it is the supported rollback. Credentials are secure-store
references only; never put credential values in the folder or a command
argument.

`groups.<name>` in `canonfig.jsonc` lists items (`instructions` or
`<category>/<name>`, for example `mcp/docs`) only followers in that group
receive. `local.allow` names the categories followers may add through their
own `local/`.

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
