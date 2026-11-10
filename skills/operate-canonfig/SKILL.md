---
name: operate-canonfig
description: Operate Canonfig 7.1.5 Source and Follower Machines safely. Use for editing the ~/.canonfig/ folder and its publication, tool discovery, the Source service and tunnel, follower invitations, groups or revocation, unenrollment, harness selection and exclusions, takeover snapshots and restore, local/ items, synchronization planning or apply, no-input automation, agent policy and harness bounds, schedules, status or doctor diagnostics, client trust after apply, Follower Drift, Human Action Required, and interrupted-run recovery.
---

# Operate Canonfig

Use one-way, evidence-first operations. The Source publishes its
`~/.canonfig/` folder; followers mirror it and never publish upstream.

## Route the request

- For editing the folder, tool discovery, publication, the Source service,
  invitations, groups, and revocation, read
  [references/source-operations.md](references/source-operations.md).
- For plan/apply, harnesses, takeover snapshots and restore, `local/` items,
  client trust, status, diagnostics, drift, Human Action Required, recovery,
  and unenrollment, read
  [references/follower-operations.md](references/follower-operations.md).
- Before changing schedules, the tunnel, credential handling, recipes, or
  harness roots, read
  [references/platform-boundaries.md](references/platform-boundaries.md).

## Operating loop

1. Observe with `canonfig status`, `canonfig harnesses`, and bounded
   `canonfig doctor`.
2. Identify the role: on a follower, the applied immutable Profile Revision; on
   the Source or an unenrolled machine, the local folder.
3. Plan with `canonfig sync --plan`; review every harness surface it takes over
   and whether it keeps a backup, every mirror item, tool, agent task,
   conflict, human action, and verification.
4. Apply only an approved plan with `canonfig sync --apply`.
5. Verify the final outcome and evidence. `Converged` requires every required
   verification to pass. It does not prove a client loaded the result:
   `clientLoaded` stays `not-verified`, and client trust and hook review are
   the operator's steps.
6. Preserve and report `HumanActionRequired`, `FollowerDrift`, `Failed`, or
   `Interrupted` exactly. Never reinterpret partial success as convergence.
7. Report each follower from its own `canonfig status`. The Source has no fleet
   view: on the Source, `canonfig status --follower <id>` reports only that
   follower's enrollment, not its convergence.

## Harnesses and backups

A machine projects the harnesses `canonfig.jsonc` lists that are installed and
not excluded on that machine:

```bash
canonfig harnesses
canonfig harnesses exclude cursor
canonfig harnesses include cursor
```

`exclude` and `include` edit only this machine's `excludeHarnesses` in
`~/.canonfig/local/local.jsonc`. Before its first write to a harness, Canonfig
keeps a takeover snapshot in `~/.canonfig/.backups/`; `canonfig restore` writes
it back:

```bash
canonfig restore
canonfig restore <snapshot>
```

Restore runs as a journaled run, releases those surfaces, and excludes their
harnesses here. It refuses a surface that changed since Canonfig last applied
it, and changes nothing then. Removing a harness from `harnesses` retires its
unmodified outputs; it does not restore the snapshot.

## Automation

Native schedules run:

```bash
canonfig sync --apply --no-input --scheduled
```

For machine-readable output from a manual noninteractive run:

```bash
canonfig sync --apply --no-input --json
```

Scheduled runs never wait for approval. Human Action Required exits with code
`3`; Follower Drift exits with code `4`. Keep failure output visible. `status`
and `doctor` report the last unattended run's outcome and reason. A scheduled
run restarts a managed tunnel that is down once before fetching; a stopped
tunnel is left stopped.

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
canonfig agent harness codex --executable /opt/codex --allow-path /home/operator/.canonfig --allow-leaf-executable npm --allow-origin https://registry.npmjs.org --allow-capability restart --maximum-input-bytes 4096
```

Use exact HTTPS origins and platform-local paths. Elevation, login, restart,
and reboot remain denied unless both task and harness authorize them. A policy
change is not a repair for Human Action Required.

## Safety boundary

- Publication is explicit. Discovery and agent output remain proposals.
- Invitations are short-lived and single-use; credentials are local references,
  never copied from the Source Machine.
- Preserve modified follower skills and other edited mirror files. Canonfig
  does not merge or overwrite them automatically.
- Preserve certificate pins, SQLite state, action journals, blobs, takeover
  snapshots, `~/.canonfig/local/`, and verification evidence during diagnosis.
- Run declared deterministic recipes before agent work. Keep recipes
  platform-specific, version-aware, upstream-backed, and independently verified.
- Refuse requests to hide drift, erase evidence, bypass trust, take over
  without a backup unprompted, broaden allowlists without task need, or mark
  actions complete manually.
