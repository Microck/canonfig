---
name: setup-canonfig
description: Guide a low-friction Canonfig setup across Linux, macOS, and Windows by inspecting first, asking only unresolved questions with explanations and recommended answers, then installing, configuring, planning, applying, and verifying a Source Machine, Follower Machine, or project harness.
---

# Set Up Canonfig

Turn the requested outcome into verified Canonfig state without turning setup
into a long interview. Inspect first, recommend safe defaults, ask only for
decisions that cannot be inferred, and keep destructive or authority-changing
actions behind explicit approval.

## Interaction contract

1. Inspect before asking. Detect the platform, architecture, user, home
   directory, shell, Node.js and npm versions, Canonfig version, existing
   `~/.canonfig` state, secure credential capability, native user scheduler,
   current diagnostics, and repository harness state when relevant.
2. Do not ask for facts already established by inspection or by an earlier
   answer.
3. Ask no more than four related unresolved questions in one round. Prefer one
   round for normal installations. Ask a later question only when an earlier
   answer or newly observed state makes it necessary.
4. Every question must include a short `Why it matters` explanation and either
   a `Recommended` answer with a reason or `No automatic recommendation`.
5. Allow compact replies:
   - `Use recommendations` accepts the recommendations shown in the current
     question batch.
   - The operator may override answers by question number or field name.
   - `Skip optional` leaves optional features disabled.
   - `Show advanced options` reveals choices that are normally omitted.
6. Do not ask about optional shared secrets, Configuration Agents, custom
   schedules, hooks, or target extensions unless the request or discovered
   configuration makes them relevant. Mention their safe default once.
7. Never request passwords, tokens, private keys, credential values, or full
   invitation payloads in chat. Use an ephemeral local variable, protected file,
   stdin, or the native credential store as required by the command.
8. A recommendation is not approval. Require explicit approval for identity
   replacement, immutable publication, follower apply, shared-secret authority,
   `--force`, `agent-apply`, elevation, restart, or reboot.

Read [references/questions.md](references/questions.md) before interviewing the
operator.

## Route the request

Choose exactly the branches needed for the requested outcome:

- Source Machine bootstrap, profile authoring, publication, or invitations:
  [references/source-setup.md](references/source-setup.md)
- Follower enrollment, first synchronization, scheduling, or recovery:
  [references/follower-setup.md](references/follower-setup.md)
- Project-local harness configuration:
  [references/harness-setup.md](references/harness-setup.md)
- Final verification and reporting:
  [references/completion.md](references/completion.md)

The project harness branch is separate from Source/Follower Machine Profile
synchronization. Do not make the user answer fleet questions for a harness-only
request.

## Workflow

### 1. Establish the outcome

Classify the request as one or more of:

- install the CLI only;
- initialize the single Source Machine;
- author and publish a Machine Profile;
- enroll or converge a Follower Machine;
- resume or diagnose existing state;
- configure a repository's AI harnesses.

State the detected scope in one sentence. Ask a scope question only when two
materially different outcomes remain possible.

### 2. Observe read-only state

Use non-mutating probes before proposing changes. Run only commands appropriate
to the detected platform and existing installation:

```text
node --version
npm --version
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig status --json
canonfig schedule status
canonfig agent policy
canonfig agent harness
canonfig harness status --json
canonfig harness doctor --json
```

A command being unavailable is an observation, not permission to install or
repair it. Preserve certificate pins, state databases, action journals, caches,
follower edits, and harness ownership records.

Present observations compactly:

```text
Detected
- macOS arm64
- Node.js 24.8.0 and npm available
- Canonfig not installed
- Keychain and user launchd available
- no existing Canonfig role
```

### 3. Apply quiet defaults

Use documented, low-risk defaults without asking when they do not change
authority or overwrite data:

- user-level operation;
- exact package `@microck/canonfig@3.0.0`;
- executable name `canonfig`;
- `deterministic-only` agent policy;
- no shared-secret transfer;
- no `--force`;
- no elevation, login, restart, or reboot;
- YAML for a new harness source unless the repository already standardizes on
  JSON;
- interactive review before the first follower apply.

List applied defaults once. Do not ask the operator to confirm each one.

### 4. Ask only unresolved decisions

Use the required question format from `references/questions.md`. Batch related
questions, prefill detected values, and make the recommended path answerable
with `Use recommendations`.

If every remaining value has a safe, reversible default, state the defaults and
continue to the plan without asking a question.

### 5. Validate the complete decision record

Before mutation, verify that:

- one state directory has only one machine role;
- the intended Source Machine is the only publishing authority;
- selected profiles and group references exist;
- resource IDs, dependencies, targets, policies, and verification are valid;
- recipes are platform-specific, version-aware, and evidence-backed;
- scheduled operation has a native user scheduler and noninteractive credential
  access;
- no secret value appears in a profile, command example, or report;
- no follower-owned edit or harness collision will be overwritten silently.

Unknown or unsupported work becomes Human Action Required. Do not guess.

### 6. Show one plan

Show the intended role, installation, profile or harness targets, resources,
credential references, schedule, agent policy, mutations, verification, and
unresolved blockers. Keep routine no-op details collapsed unless requested.

Ask for one approval covering the displayed bounded stage. Publication and first
apply remain separate approvals because they establish different authority and
mutation boundaries.

### 7. Execute idempotently

Install, initialize, enroll, publish, apply, or schedule only after the relevant
approval. Re-observe after each stage. A resumed run must not reinstall,
reinitialize, reenroll, republish, reset trust, or force ownership merely
because state already exists.

Canonfig requires Node.js 24 or newer and npm:

```bash
npm install --global @microck/canonfig@3.0.0
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

Use the current user's platform facilities:

| Platform | Secure credentials | User scheduler |
| --- | --- | --- |
| Linux | Secret Service | systemd user timer |
| macOS | Keychain | launchd user agent |
| Windows | Credential Manager | per-user Task Scheduler |

Unavailable secure storage or scheduling is reported exactly; do not replace it
with plaintext credentials or a system-level daemon.

### 8. Verify and report

Read [references/completion.md](references/completion.md). Report `complete`
only when the requested outcome has independent evidence. Preserve and explain
Human Action Required, Follower Drift, authentication, transport, interrupted,
or verification failures without deleting state or pretending partial success
is Convergence.

## Stop conditions

Stop before mutation when:

- the requested role conflicts with existing state;
- identity or trust would need to be replaced without explicit approval;
- a Source endpoint is not the loopback HTTPS origin supported by Canonfig;
- a required recipe, version, target, or verification is guessed;
- secure noninteractive credential storage is required but unavailable;
- a plan contains an unapproved conflict, deletion, follower edit, or agent
  capability;
- publication inputs changed after review;
- the requested action would suppress verification or erase diagnostic evidence.
