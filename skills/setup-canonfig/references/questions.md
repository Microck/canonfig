# Guided questions

The interview exists to resolve decisions, not to restate diagnostics. Keep it
short enough that a normal user can answer in one message.

## Decide whether to ask

Ask a question only when all of these are true:

1. The answer is required for the requested outcome now.
2. It cannot be detected reliably from the machine, repository, Canonfig state,
   or an earlier answer.
3. A wrong assumption could change authority, ownership, security, or the
   resulting configuration.
4. There is no safe reversible default that can be applied and disclosed.

Do not ask optional-feature questions merely to prove completeness. Record their
defaults instead:

```text
Defaults
- shared-secret transfer: disabled
- Configuration Agent execution: disabled
- force ownership: disabled
```

## Required format

Use this shape, omitting `Detected` only when there is no relevant observation:

```text
1. Question:
Which role should this state directory have?

Why it matters:
A Canonfig state directory may contain a Source Machine or Follower Machine
identity, not both.

Detected:
No existing Canonfig identity was found.

Recommended:
Follower Machine, when another machine already owns the canonical profiles.
Otherwise there is no automatic recommendation because this chooses authority.

Options:
1. Source Machine
2. Follower Machine
3. CLI only

Answer:
```

Keep each explanation to one or two sentences. Keep the recommendation specific
and include its reason. Never disguise an inference as a detected fact.

## Answer classes

Use one of these answer sources in the decision record:

- `Detected`: directly observed and not contradicted.
- `Operator`: explicitly supplied by the user.
- `Recommended default`: selected because it is safe, reversible, and
  documented.
- `Needs review`: evidence exists but does not support one safe answer.
- `Blocked`: no supported answer can reach the requested outcome.

When intent alone determines the answer, say:

```text
Recommended:
No automatic recommendation. This choice establishes configuration authority
and must be made by the operator.
```

## Batching

Ask at most four related questions per round. Order them so earlier answers can
remove later questions.

A normal first response should look like:

```text
Detected
- Linux x64
- Node.js 24 and npm available
- Canonfig is not installed
- Secret Service and the systemd user session are available

Defaults
- install @microck/canonfig@3.0.1 for the current user
- deterministic-only
- no shared secrets
- review the first apply

I need two decisions:
[questions]
```

The operator may override answers by question number or field name. For example:

```text
Use recommendations, except:
- profile ID: personal-workstation
- schedule: weekly:Mon@10:00 Europe/Madrid
```

`Use recommendations` accepts only recommendations already shown. It never approves future publication,
apply, `--force`, identity replacement, secret sharing, or elevated
capabilities.

## Recommendation policy

Recommend in this order:

1. Preserve existing valid state.
2. Use the documented Canonfig default.
3. Minimize authority and mutation.
4. Prefer deterministic behavior over agent execution.
5. Prefer user-level native facilities over system services.
6. Prefer explicit versions and independent verification.
7. Leave optional features disabled until a stated need exists.

Never recommend deleting state, replacing identity, resetting certificate pins,
bypassing verification, using `--force`, enabling `agent-apply`, or broadening an
allowlist merely to make setup pass.

## Common questions

### Role

```text
Question:
What should this machine do?

Why it matters:
The Source Machine publishes canonical Profile Revisions. A Follower Machine
can consume them but never publishes upstream.

Detected:
<existing role or no role>

Recommended:
<detected existing role>; otherwise no automatic recommendation.

Options:
Source Machine / Follower Machine / CLI only
```

### State owner

Ask only when the current account differs from the requested long-term account.

```text
Question:
Which user account should own Canonfig state and scheduled runs?

Why it matters:
Credentials, `~/.canonfig`, and the native scheduler are scoped to that user.

Recommended:
The current non-root user, unless another account is already the established
owner.
```

### Agent policy

Ask only when the request requires ambiguous agent work.

```text
Question:
May a Configuration Agent participate when no deterministic action exists?

Why it matters:
`agent-propose` records a bounded proposal. `agent-apply` may execute only
within explicit local allowlists and still requires independent verification.

Recommended:
deterministic-only. It has the smallest execution surface and converts
ambiguity into Human Action Required.

Options:
deterministic-only / agent-propose / agent-apply
```

### Schedule

Ask only for a Follower Machine or when the user explicitly requests one.

```text
Question:
When should this follower synchronize?

Why it matters:
The native user scheduler runs the canonical noninteractive apply command, so
failures must be observable and the Source endpoint and credential store must
be available then.

Detected:
Timezone: <IANA timezone>
Scheduler: <available or unavailable>

Recommended:
Daily at a visible working-hour time in the detected timezone. Use the profile
default when one exists and is suitable.

Answer:
<daily@HH:mm or weekly:Day@HH:mm> [timezone]
```

### First apply

```text
Question:
Should the first synchronization be applied after you review its plan?

Why it matters:
The plan may install tools, replace files, remove unchanged source-owned
entries, or stop on conflicts.

Recommended:
Yes, review first. This is the safest default and subsequent native schedules
can remain noninteractive.

Options:
review then apply / plan only
```

## Handling corrections

Accept terse corrections without replaying the whole questionnaire. Update only
the affected decisions, state any new consequence, and continue. Ask another
question only when the correction creates a new material ambiguity.
