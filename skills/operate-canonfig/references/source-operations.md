# Source operations

## Discover and review

Scan only explicit files:

```bash
canonfig source scan --file AGENTS.md --file package.json
```

Review accepted tools, skills, upstream URLs, invocation evidence, independent
verification, platform recipes, login requirements, and unresolved Agent Tasks.
Executable structured evidence can support a deterministic recipe; prose alone
remains review evidence.

Reject publication when evidence is unresolved, a recipe embeds credentials,
platform package identity is guessed, or verification cannot observe the
declared capability.

## Publish explicitly

Publish only the reviewed proposal:

```bash
canonfig source publish --proposal package.json --profile workstation --name Workstation --reviewer operator
canonfig source publish --profile-file ~/.canonfig/source/profile.jsonc --proposal package.json --reviewer operator
canonfig profile list
canonfig profile show revision-one
```

The `--profile-file` form decodes the production JSONC profile schema and is
authoritative for profile metadata, resources, policies, dependencies, and the
schedule default. Accepted discovery resources are merged only when they do
not share an authored id; discovery review decisions remain enforced.
Duplicate ids, overlapping targets, malformed fields, and unknown fields are
rejected before signing. `profile show` takes a Profile Revision ID.
Publication signs an immutable, content-addressed revision; it does not mutate
an existing revision. Credentials are secure-store references only; never put
credential values in a profile file or command argument.

## Invitations and groups

With the loopback source endpoint running:

```bash
canonfig source invite --endpoint https://127.0.0.1:17342 --expires 15m --group developers
```

Repeat `--group` for additional declared groups. Group membership is source
owned and carried by enrollment; followers cannot add themselves. Deliver the
invitation through an ephemeral private channel and create a new one if it is
expired or exposed.

## Revoke

Revoke one independently issued identity:

```bash
canonfig source revoke follower-one
```

Revocation blocks future authenticated fetches for that follower only. Re-enroll
with a new invitation when access should return; do not reuse credentials or
reset pins.
