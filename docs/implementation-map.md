# Canonfig v2 implementation map

This map replaces the legacy v1 implementation. Each work item ends with an observable contract and verification. A later item may depend only on contracts completed by earlier items, not on removed legacy helpers.

The [v2 architecture contract](./architecture.md) defines the invariants and module interfaces that these work items must preserve.

## Completion criteria

Canonfig v2 is complete when:

- a Source Machine can scan, review, publish, and serve an authenticated Profile Revision
- Linux, macOS, and Windows followers can enroll and run scheduled one-way synchronization
- transfers are incremental while Apply Policies remain resource-specific
- deterministic Installation Recipes can install and verify tools per operating system
- ambiguous work can become a bounded Agent Task
- credentials and logins produce explicit local or human actions
- modified follower skills remain untouched and are reported as Follower Drift
- interrupted runs can recover without claiming false convergence
- contract, integration, and cross-platform acceptance tests pass
- the Fumadocs site and Canonfig skills describe the shipped behavior

## Dependency map

```text
C1 -> C2
C2 -> C3 -> C5 -> C6
C2 -> C4 -> C5
C2 + C4 -> C7
C2 + C3 + C4 -> C8
C6 + C7 -> C9
C4 + C6 -> C10
C6 + C8 + C9 + C10 -> C11
C11 -> C12 -> C13
```

## C1. Foundation and hard-cut rename

**Outcome:** The repository builds and tests as Canonfig on Node 24 with one Effect v4 runtime line. No new code imports the legacy entrypoint.

**Files:**

- `package.json`, `package-lock.json`, `tsconfig.json`
- `src/runtime/main.ts`
- `src/cli/cli.ts`
- `tests/foundation.test.ts`
- existing README and package metadata

**Work:**

- Rename package, binary, environment prefix, protocol, and default state path to Canonfig.
- Pin matching versions of `effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, and `@effect/vitest` from one v4 release line.
- Pin the supported Node runtime to version 24 or newer.
- Keep npm as the package manager.
- Add build, typecheck, lint, and test commands that cover configuration files and source.
- Establish a thin executable that runs an Effect program and maps typed CLI outcomes to exit codes.
- Update Vitest to a release without the current critical advisory.

**Verification:**

- `npm run build`
- `npm run typecheck`
- `npm run lint` has no findings in new foundation files
- `npm test`
- `canonfig --version` and `canonfig --help` work from the packed tarball

## C2. Domain and profile contract

**Outcome:** A versioned JSONC Machine Profile can decode, normalize, encode canonically, hash, and reject invalid resource graphs.

**Files:**

- `src/domain/profile.ts`
- `src/domain/resource.ts`
- `src/domain/synchronization.ts`
- `src/domain/identity.ts`
- `src/profile/profile-codec.ts`
- `tests/profile-contract.test.ts`

**Work:**

- Define branded IDs and schema-backed records for profiles, revisions, resources, followers, groups, plans, actions, and outcomes.
- Define Profile Resource kinds and Apply Policies from the architecture contract.
- Define Agent Task and Human Action Required schemas.
- Parse JSONC only at the authoring boundary.
- Produce deterministic canonical JSON for hashing and signatures.
- Validate unique resource IDs, dependency existence, acyclic dependencies, valid targets, and policy-kind compatibility.
- Add fixture-based forward conformance tests for the v2 profile schema.

**Verification:**

- Equivalent JSONC layouts produce the same canonical digest.
- Invalid dependencies and policy combinations return precise tagged errors.
- Every tagged union is exhaustively matched in tests.

## C3. State repository

**Outcome:** Canonfig persists identities, revisions, plans, action journals, Applied Resource Records, and outcomes transactionally in SQLite.

**Files:**

- `src/state/state-repository.service.ts`
- `src/state/state-repository.layer.ts`
- `src/state/state-repository.errors.ts`
- `src/state/state-repository.types.ts`
- `src/state/state-schema.ts`
- `tests/state-repository.test.ts`

**Work:**

- Use the Effect v4 SQLite adapter with explicit migrations.
- Keep the public interface domain-shaped rather than mirroring tables.
- Provide operations for publishing a revision, starting a run, journaling an action, completing a run, recording drift, and loading recovery state.
- Enforce immutable Profile Revisions and one active applying run per follower.
- Store credential references, never credential values, in ordinary tables.

**Verification:**

- Test against a temporary real SQLite database.
- Assert transaction rollback, uniqueness, malformed persisted JSON handling, interruption recovery data, and immutable revisions.
- No repository module mocks.

## C4. Machine and platform adapters

**Outcome:** One MachineState interface provides equivalent filesystem, process, credential, executable, and scheduler primitives on Linux, macOS, and Windows.

**Files:**

- `src/machine/machine-state.service.ts`
- `src/machine/machine-state.errors.ts`
- `src/machine/machine-state.types.ts`
- `src/machine/linux.layer.ts`
- `src/machine/macos.layer.ts`
- `src/machine/windows.layer.ts`
- `tests/contract/machine-state.contract.ts`

**Work:**

- Normalize paths into domain values without pretending platform paths are interchangeable strings.
- Implement atomic writes, symlinks where supported, executable lookup, bounded process execution, file digests, permissions, and user directories.
- Implement credential adapters for Secret Service, Keychain, and Credential Manager.
- Return Human Action Required when secure noninteractive credential storage is unavailable unless the user explicitly selected a local file credential policy.
- Define scheduler primitives but leave job rendering to C10.

**Verification:**

- Run one reusable contract suite against all three adapters.
- Use real temporary files and subprocesses.
- Verify path, permission, symlink, timeout, cancellation, output-limit, and credential-unavailable behavior.

## C5. Synchronization planner

**Outcome:** A pure planner turns a Profile Revision, Observed State, Local Overlay, and Applied Resource Records into a deterministic Synchronization Plan.

**Files:**

- `src/synchronization/synchronization.service.ts`
- `src/synchronization/synchronization.errors.ts`
- `src/synchronization/synchronization.types.ts`
- `src/synchronization/planner.ts`
- `src/synchronization/resource-plans.ts`
- `tests/synchronization-planner.test.ts`

**Work:**

- Keep the planner pure and independent of filesystem or database access.
- Distinguish incremental blob transfer from replace, merge, mirror, ensure, and drift behavior.
- Topologically order actions and reject dependency cycles at the contract boundary.
- Detect skill drift with desired, observed, and last-applied digests.
- Produce explicit no-op, deterministic, agent, human, and conflict actions.
- Make plan encoding stable for audit and recovery.

**Verification:**

- Table-driven tests cover every resource kind and Apply Policy.
- Reordering profile input does not change the semantic plan.
- Modified follower skills always produce Follower Drift and no write action.
- The same inputs always produce the same encoded plan.

## C6. Apply and recovery

**Outcome:** Synchronization can execute, verify, interrupt, and resume a recorded plan without reporting false convergence.

**Files:**

- `src/synchronization/synchronization.layer.ts`
- `src/synchronization/executor.ts`
- `src/synchronization/recovery.ts`
- `src/synchronization/resource-executors.ts`
- `tests/integration/synchronization-run.test.ts`
- `tests/integration/recovery.test.ts`

**Work:**

- Persist the full plan before the first mutation.
- Journal each action before and after execution.
- Apply file changes atomically and retain rollback material for owned files.
- Serialize mutations per target while allowing bounded independent observation.
- Verify each resource after application.
- Resume incomplete idempotent actions from the journal.
- Return Converged only when every required verification passes.

**Verification:**

- Inject deterministic interruption points through a test layer, not method spies.
- Kill runs before, during, and after writes, then verify recovery end state.
- Verify that external installer actions are never claimed as rolled back.
- Verify cancellation preserves an Interrupted record.

## C7. Discovery and installation recipes

**Outcome:** Source scanning produces evidence-backed tool and skill proposals with platform-specific recipes and upstream references.

**Files:**

- `src/profile/profile-catalog.service.ts`
- `src/profile/profile-catalog.layer.ts`
- `src/profile/profile-catalog.errors.ts`
- `src/profile/discovery.ts`
- `src/profile/tool-catalog.ts`
- `src/profile/publication.ts`
- `tests/discovery.test.ts`
- `tests/publication.test.ts`

**Work:**

- Scan configured AGENTS files, tool configs, hooks, MCP definitions, executable references, and package-manager metadata.
- Record source file, line, invocation, resolved executable, package metadata, and upstream URL.
- Treat prose as evidence for review, not as an executable installation command.
- Resolve deterministic npm, Homebrew, winget, uv, cargo, and source recipes when evidence is sufficient.
- Produce Agent Tasks for ambiguous recipes.
- Publish only validated, reviewed proposals.

**Verification:**

- Fixture scans cover mixed Markdown, shell blocks, configuration files, and false-positive prose.
- Every accepted tool has an upstream reference and at least one verification method.
- OS-specific package names remain independent.
- Publication is immutable and canonical.

## C8. Enrollment and transport

**Outcome:** Followers enroll once, authenticate independently, fetch signed revisions, and download only missing blobs over pinned HTTPS.

**Files:**

- `src/enrollment/enrollment.service.ts`
- `src/enrollment/enrollment.layer.ts`
- `src/enrollment/enrollment.errors.ts`
- `src/enrollment/enrollment.types.ts`
- `src/enrollment/source-server.ts`
- `src/enrollment/follower-client.ts`
- `tests/integration/enrollment.test.ts`
- `tests/integration/transport.test.ts`

**Work:**

- Generate Source Machine identity and HTTPS certificate material.
- Create short-lived, single-use invitations.
- Issue one revocable credential per Follower Identity and assign groups.
- Pin the source fingerprint during enrollment.
- Sign canonical Profile Revision payloads and verify signatures on followers.
- Implement revision metadata and content-addressed blob endpoints.
- Reject replayed invitations, revoked followers, invalid signatures, and digest mismatches.

**Verification:**

- Use a real loopback HTTPS server and temporary credential stores.
- Test enrollment, replay rejection, revocation, group filtering, cache reuse, interrupted downloads, and tampered content.
- A follower with every blob cached performs no blob downloads.

## C9. Agent resolution

**Outcome:** Ambiguous tool or configuration work can be proposed or executed by an AI agent without giving it undeclared authority.

**Files:**

- `src/agent/agent-resolution.service.ts`
- `src/agent/agent-resolution.layer.ts`
- `src/agent/agent-resolution.errors.ts`
- `src/agent/agent-resolution.types.ts`
- `src/agent/controlled-executor.ts`
- `src/agent/harness-adapters.ts`
- `tests/agent-resolution.test.ts`

**Work:**

- Encode Agent Tasks as structured files suitable for different AI CLIs.
- Implement deterministic-only, agent-propose, and agent-apply policy.
- Enforce path, executable, network-origin, elevation, timeout, and output limits in the executor.
- Require independent verification after execution.
- Redact configured secrets from recorded output.
- Convert source discoveries into Profile Change Proposals rather than direct publication.

**Verification:**

- Use a recording harness layer and real controlled subprocess fixtures.
- Test denied paths, denied origins, timeouts, oversized output, failed verification, redaction, and scheduled noninteractive behavior.
- No module mocking or method spying.

## C10. Native scheduling

**Outcome:** Followers can install, inspect, update, and remove a native sync schedule without a resident daemon.

**Files:**

- `src/schedule/schedule-manager.service.ts`
- `src/schedule/schedule-manager.layer.ts`
- `src/schedule/schedule-manager.errors.ts`
- `src/schedule/schedule-manager.types.ts`
- `src/schedule/linux-schedule.ts`
- `src/schedule/macos-schedule.ts`
- `src/schedule/windows-schedule.ts`
- `tests/contract/schedule.contract.ts`

**Work:**

- Support daily, weekly, and explicit calendar schedules with a named timezone.
- Default to daily at 00:00 follower-local time.
- Render systemd user timers, launchd agents, and Task Scheduler definitions.
- Invoke the canonical `canonfig sync --apply --no-input` command.
- Make installation idempotent and observable through `status`.

**Verification:**

- Golden contract fixtures cover equivalent schedules on all platforms.
- Platform acceptance tests install, trigger, inspect, and remove a real job.
- A scheduled run never waits for input.

## C11. CLI and diagnostics

**Outcome:** Every architecture operation is available through a stable human and JSON CLI with actionable errors.

**Files:**

- `src/cli/cli.ts`
- `src/cli/source-commands.ts`
- `src/cli/follower-commands.ts`
- `src/cli/render.ts`
- `src/cli/exit-codes.ts`
- `src/runtime/layers.ts`
- `src/runtime/main.ts`
- `tests/cli.test.ts`

**Work:**

- Implement the command contract from `docs/architecture.md`.
- Implement Local Overlay list, create/update, and remove operations with
  authorized normalized resource targets and durable follower state.
- Decode every argument and config value at the CLI boundary.
- Render plans, drift, human actions, recovery state, and verification evidence clearly.
- Keep stable JSON schemas and distinct exit codes for invalid input, drift, human action, operational failure, and interruption.
- Add `doctor` probes for runtime, state, credentials, source reachability, scheduler, package managers, and agent adapter.

**Verification:**

- Run the packed CLI as a subprocess against temporary source and follower homes.
- Snapshot stable help and JSON output where useful.
- Verify quiet and no-input behavior under a scheduler-like environment.

## C12. Documentation and skills

**Outcome:** A small Fumadocs site and two agent skills teach installation, operation, recovery, and recipe authoring from shipped contracts.

**Files:**

- `website/` Fumadocs workspace
- `skills/install-canonfig/`
- `skills/operate-canonfig/`
- `README.md`

**Work:**

- Build progressive documentation for concepts, Source Machine setup, follower enrollment, profiles, tools, agent policies, schedules, drift, and recovery.
- Generate CLI examples from verified commands rather than copying stale prose.
- Create an install skill that checks platform, installs Canonfig, enrolls a follower, configures a schedule, and reports login actions.
- Create an operations skill that scans, reviews proposals, publishes, diagnoses runs, and authors Installation Recipes.
- Keep skills concise and link to the Fumadocs reference for details.

**Verification:**

- Build the website.
- Validate every documented command against `canonfig --help` or an executable docs test.
- Run skill structural validation and scenario tests with representative Linux, macOS, and Windows inputs.

## C13. Cross-platform acceptance and release readiness

**Outcome:** One published Profile Revision converges representative Linux, macOS, and Windows followers with deterministic evidence.

**Files:**

- `tests/acceptance/`
- CI configuration
- release metadata and package files

**Work:**

- Exercise source publication, enrollment, incremental fetch, file/config/skill/tool resources, login-required outcomes, agent proposals, scheduling, drift, interruption, and recovery.
- Test at least one differing installation method for the same tool across the three operating systems.
- Pack and install the npm artifact in clean environments.
- Verify no legacy v1 names remain in runtime contracts, generated files, or documentation.
- Run anti-slop, typecheck, tests, package audit, and package-content inspection.

**Verification:**

- Linux, macOS, and Windows acceptance matrices pass.
- A second unchanged sync transfers no blobs and applies no actions.
- A modified follower skill is preserved on every platform.
- Every scheduled or agent-driven non-convergence ends in a visible typed outcome.
- The package contains only intended runtime and documentation files.

## Removal point for v1

The legacy entrypoint, its tests, protocol strings, and v1 documentation can be removed after C2 through C6 reproduce the required replacement contracts and C11 owns the executable entrypoint. They must not remain as a compatibility path or fallback implementation.
