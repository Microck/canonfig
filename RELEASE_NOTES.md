# Canonfig v4.0.2

This corrective patch addresses the remaining 22 findings in the #181 backlog.
Node.js 24 or newer is required. The Source/follower protocol and state schema
remain compatible on the 4.0.x line. Finish or recover an unfinished run with its
original build before upgrading, and retain a backup until verification passes.

## Source concurrency and ownership handovers

Pending enrollment survives unrelated Source commands. An exclusive serving
lease prevents competing servers from invalidating enrollment, and bounded
shutdown releases that lease even with stalled clients (#148).

Owned resource retirement precedes successor writes, with explicit dependency
sequencing and recovery-safe handovers. Local edits remain protected (#150).
Installed scheduler commands are inspected independently of desired bindings;
missing runtimes fail readiness, while verifier limitations remain unverified
rather than producing false passes (#155). Verified Homebrew opt paths survive
keg upgrades for both scheduler and installer bindings (#157).

## Native schedules and installation evidence

- Canonicalize named time zones and reject unsupported numeric offsets before persistence (#156).
- Choose the first occurrence of repeated local times during fall-back, including half-hour DST changes (#158).
- Allow Windows synchronization on battery power without stopping an active apply when unplugged; avoid asserting an unproven reason for a missed run (#159).
- Require finalized follower enrollment before selecting a schedule. Keep pending/unenrolled recovery guidance accurate, including leftover native jobs (#160).
- Scope unattended-fire evidence to the installed native job. Old, unbound and pre-install process records remain historical, not proof of the current installation (#162).

## Installer and observation consistency

- Support rustup cargo proxies and Corepack pnpm entrypoints while preserving verified Homebrew opt paths. Validation disables automatic downloads/pinning and will not initialize absent rustup settings (#161).
- Select the same qualified tool recipe during observation, planning and installation (#163).

## Harness configuration safety

- Adopt identical generated files and managed blocks in fresh clones; accept LF/CRLF-only text conversions without weakening exact-byte binary protection (#166, #179).
- Keep adopted and updated TOML blocks in place. Refuse cleanup that would change the scope of following operator keys.
- Emit supported Claude/Droid hook events; reject unsupported mappings under strict mode. Use Droid's documented standalone event layout and project-root script paths (#167).
- Permit read-only Codex proposals from non-Git working directories without changing Canonfig action authorization (#168).
- Preserve existing CLAUDE.md instruction symlinks and refuse silent replacement/deletion of other native-output symlinks (#171).
- Clean retired binary skill files using original bytes, with accurate text/binary removal previews (#172).
- Retire explicitly disabled targets on unfiltered apply while retaining shared output still needed by enabled targets (#175).
- Copy repository-contained linked skill sources and report escapes, dangling links and cycles rather than silently dropping them (#176).
- Preserve unrelated JSONC comments and formatting using targeted edits, including during re-render and cleanup (#177).

## Setup diagnostics

Invalid or unreadable discovery inputs are operator usage errors rather than
internal journal defects. Failed/skipped item evidence is shown in human output
and status JSON under normal redaction rules; stale evidence is not attached to
a changed verdict (#178, #180).

## Verification

Release requires clean integration tests, native Linux/macOS/Windows x64/ARM64
checks, Codex and CodeRabbit reviews, the unchanged package-size budgets, and a
fresh public-registry install after publication. Draft preparation is not a
release or a claim that these final gates have completed.
