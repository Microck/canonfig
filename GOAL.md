# Canonfig v2 goal

**Status:** Ready for implementation

## Objective

Replace the legacy v1 product with Canonfig v2: a deterministic, one-way configuration synchronizer that publishes configuration from one Source Machine and converges Linux, macOS, and Windows Follower Machines with bounded AI assistance.

The [architecture contract](./docs/architecture.md) defines required behavior. The [implementation map](./docs/implementation-map.md) defines work order, file ownership, and verification.

## Success criteria

Canonfig v2 is complete only when all of the following are true:

- The package, CLI, state path, protocol, environment variables, generated files, and documentation use Canonfig naming.
- A Source Machine can scan local agent instructions and tool configuration into evidence-backed Profile Change Proposals.
- A user or Configuration Agent can review a proposal and publish an immutable, authenticated Profile Revision.
- Each discovered tool records its invocation evidence, upstream URL, platform-specific Installation Recipes, verification, and login requirements.
- Each Follower Machine has an independently revocable identity and fetches only revisions allowed for its groups.
- Profile Revision transfer is content-addressed and incremental.
- Apply Policies independently control replacement, merging, mirroring, installation, credentials, and skill preservation.
- A modified follower skill is never overwritten automatically.
- Deterministic actions run before Canonfig creates an Agent Task.
- Agent Tasks enforce declared filesystem, executable, network, elevation, time, output, and verification limits.
- Missing logins or other human-only actions produce Human Action Required with exact recovery instructions.
- Every Synchronization Run records its plan, action progress, verification evidence, drift, and final outcome in SQLite.
- An interrupted run can recover without claiming false convergence.
- Daily, weekly, and custom schedules use native Linux, macOS, and Windows schedulers.
- The default follower schedule runs at 00:00 in the configured local timezone.
- Typecheck, anti-slop lint, unit tests, integration tests, and cross-platform acceptance tests pass.
- The Fumadocs site and Canonfig skills match the shipped CLI and profile contract.
- A clean npm package installs and runs on supported platforms.

## Accepted constraints

- Canonfig has exactly one Source Machine per installation.
- Synchronization is one-way. Followers never publish upstream state.
- V2 is a hard cut with no legacy compatibility, migration, alias, or fallback path.
- Linux, macOS, and Windows are first-class platforms.
- The implementation uses TypeScript, Node.js 24 or newer, npm, and exactly pinned matching Effect v4 packages.
- Effect services use deep, domain-shaped interfaces with separate service tags, layers, errors, and types.
- Boundary data uses Effect Schema and expected failures use tagged errors.
- Runtime configuration uses Effect Config. Credentials remain redacted until an adapter consumes them.
- Operational state uses SQLite through the matching Effect v4 adapter.
- Tests use real seams, temporary filesystems, temporary SQLite databases, loopback HTTPS, and test layers.
- Tests do not use module mocks, method spies, or arbitrary sleeps.
- Anti-slop remains enabled at error severity for all new code.
- Scheduled followers invoke the normal CLI path and do not require a resident follower daemon.
- Credentials are configured locally or referenced through secure platform storage. They are not copied from the Source Machine.
- Profile publication is explicit. Discovery and AI output create proposals, not silent publications.

## Work sequence

- [x] [C1. Foundation and hard-cut rename](./docs/implementation-map.md#c1-foundation-and-hard-cut-rename)
- [x] [C2. Domain and profile contract](./docs/implementation-map.md#c2-domain-and-profile-contract)
- [x] [C3. State repository](./docs/implementation-map.md#c3-state-repository)
- [x] [C4. Machine and platform adapters](./docs/implementation-map.md#c4-machine-and-platform-adapters)
- [x] [C5. Synchronization planner](./docs/implementation-map.md#c5-synchronization-planner)
- [x] [C6. Apply and recovery](./docs/implementation-map.md#c6-apply-and-recovery)
- [x] [C7. Discovery and installation recipes](./docs/implementation-map.md#c7-discovery-and-installation-recipes)
- [x] [C8. Enrollment and transport](./docs/implementation-map.md#c8-enrollment-and-transport)
- [x] [C9. Agent resolution](./docs/implementation-map.md#c9-agent-resolution)
- [x] [C10. Native scheduling](./docs/implementation-map.md#c10-native-scheduling)
- [x] [C11. CLI and diagnostics](./docs/implementation-map.md#c11-cli-and-diagnostics)
- [x] [C12. Documentation and skills](./docs/implementation-map.md#c12-documentation-and-skills)
- [x] [C13. Cross-platform acceptance and release readiness](./docs/implementation-map.md#c13-cross-platform-acceptance-and-release-readiness)

Follow the dependency map in the implementation plan. Do not start a dependent item before its required contracts and tests pass.

## Readiness completed

- [x] Canonfig name selected.
- [x] Domain language recorded in [CONTEXT.md](./CONTEXT.md).
- [x] V2 architecture contract accepted.
- [x] Implementation work and dependencies mapped.
- [x] Anti-slop vendored and configured.
- [x] Current v1 behavior covered by 28 passing tests before replacement begins.
- [x] Current single-file architecture and high-risk hubs identified.

No unresolved product decision blocks C1.

## Execution rules

1. Update the relevant contract artifact before changing observable behavior.
2. Write the failing test or conformance case before non-trivial implementation.
3. Keep one canonical code path. Do not preserve v1 through adapters or temporary aliases.
4. Run typecheck, relevant tests, and anti-slop after each work item.
5. Record implementation discoveries in the nearest code comment, architecture document, or domain glossary.
6. Update this checklist only after the work item's verification passes.
7. Do not publish, rename the GitHub repository, release npm packages, or create commits without explicit authority.

## Out of scope

- Bidirectional or follower-to-source synchronization
- A hosted fleet control plane
- Automatic transfer of source credentials
- Silent merging of modified canonical skills
- Whole-home-directory backup
- Unattended GUI automation without a documented adapter
- Guaranteed rollback of third-party installers
- Automatic publication of AI-generated Profile Change Proposals
- Automatic deletion of historical Profile Revisions or blobs
- Compatibility with any legacy v1 state

## Known risks

- Effect v4 is currently on a release-candidate line. C1 must pin every Effect package to one verified matching version and must not mix v3 `latest` packages with v4 packages.
- The legacy source has 164 anti-slop violations. New code must be clean; v1 should be removed at its defined replacement point instead of mechanically patched.
- Secure noninteractive credential storage differs across operating systems and desktop or headless environments. Unsupported storage must become Human Action Required.
- External installers cannot offer uniform rollback. Recovery must report and re-verify their real state.
- GitHub and npm renaming are externally visible actions and remain deferred until explicitly authorized.

## Finish and blocker rule

The goal finishes successfully only when every success criterion passes and every work item is checked.

If the same external blocking condition prevents progress in two separate execution passes and no safe in-scope alternative remains, stop the goal as blocked. Record the blocker, evidence from both passes, completed work, and the exact user or external action required to resume.
