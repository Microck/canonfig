---
name: operate-canonfig
description: Operate Canonfig 2 Source and Follower Machines safely. Use for discovery and proposal review, explicit profile publication, follower invitations, groups or revocation, profile selection, synchronization planning or apply, no-input automation, agent policy and harness bounds, schedules, status or doctor diagnostics, Follower Drift, Human Action Required, and interrupted-run recovery.
---

# Operate Canonfig

Use one-way, evidence-first operations. Followers consume Source Machine
authority; they never publish upstream.

## Route the request

- For discovery, proposal review, publication, invitations, groups, and
  revocation, read [references/source-operations.md](references/source-operations.md).
- For profile selection, plan/apply, status, diagnostics, drift, Human Action
  Required, and recovery, read
  [references/follower-operations.md](references/follower-operations.md).
- Before changing schedules, credential handling, recipes, or harness paths,
  read [references/platform-boundaries.md](references/platform-boundaries.md).

## Operating loop

1. Observe with `canonfig status` and bounded `canonfig doctor`.
2. Identify the role and selected immutable Profile Revision.
3. Plan with `canonfig sync --plan`; review every target, dependency, agent
   task, conflict, human action, and verification.
4. Apply only an approved plan with `canonfig sync --apply`.
5. Verify the final outcome and evidence. `Converged` requires every required
   verification to pass.
6. Preserve and report `HumanActionRequired`, `FollowerDrift`, `Failed`, or
   `Interrupted` exactly. Never reinterpret partial success as convergence.

## Automation

Native schedules run:

```bash
canonfig sync --apply --no-input
```

For machine-readable output:

```bash
canonfig sync --apply --no-input --json
```

Scheduled runs never wait for approval. Human Action Required exits with code
`3`; Follower Drift exits with code `4`. Keep failure output visible.

## Agent policy

Inspect policy and harness separately:

```bash
canonfig agent policy
canonfig agent harness
```

`deterministic-only` invokes no agent. `agent-propose` records a bounded
proposal but does not execute it. `agent-apply` executes only the intersection
of the Agent Task bounds and local harness allowlists, followed by independent
verification.

Configure the smallest local allowlist:

```bash
canonfig agent harness codex --executable /opt/codex --allow-path /home/operator/.canonfig --allow-executable npm --allow-origin https://registry.npmjs.org --allow-capability restart --maximum-input-bytes 4096
```

Use exact HTTPS origins and platform-local paths. Elevation, login, restart,
and reboot remain denied unless both task and harness authorize them. A policy
change is not a repair for Human Action Required.

## Safety boundary

- Publication is explicit. Discovery and agent output remain proposals.
- Invitations are short-lived and single-use; credentials are local references,
  never copied from the Source Machine.
- Preserve modified follower skills. Canonfig does not merge or overwrite them
  automatically.
- Preserve certificate pins, SQLite state, action journals, blobs, and
  verification evidence during diagnosis.
- Run declared deterministic recipes before agent work. Keep recipes
  platform-specific, version-aware, upstream-backed, and independently verified.
- Refuse requests to hide drift, erase evidence, bypass trust, broaden
  allowlists without task need, or mark actions complete manually.
