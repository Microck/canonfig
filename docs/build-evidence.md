# Build identity and validation evidence

A package version is not enough to identify an unreleased build. Two checkouts
can both report the same version while containing different compiled modules.

`npm run build:cli` builds the production browser application, copies it into
`dist/ui`, and writes `build-receipt.json` after CLI minification. The receipt
stays outside the package; CI preserves it as a workflow artifact.
The `canonfig.build/v1` receipt records the package version, SHA-256
of each CLI and browser build input, each compiled JavaScript module and
browser asset, aggregate digests, and Git commit/dirty state when available.
It records no timestamps, host names, absolute checkout paths, environment, or credentials.
A source archive without Git metadata remains buildable and records `git: null`.

Compare `compiledDigest` when identifying installed builds. Hash the installed
`dist` files and compare them with the individual `compiledFiles` hashes to
check which build an installation came from and that its bytes have not
changed. `sourceDigest` includes the lockfile and build
implementation. These receipts are diagnostic evidence, not signatures or a
substitute for package provenance, Source signing, or TLS pinning. A receipt
alone does not establish that an installation converged.

Acceptance CI preserves the exact packed CLI and receipt for each platform.
Repository validation also preserves a `git archive` of its tracked inputs,
the actual tested commit, and the archive hash. This permits reproducing a
failed validation without reconstructing a private worktree from chat history.
Only tracked repository files enter the source archive; local credentials,
configuration, dependency directories, and runtime state are not collected.
Artifacts expire after seven days. Their existence is not evidence of a passing
job: inspect the corresponding workflow result before reporting validation.
