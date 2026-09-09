# Follower-owned installer bindings

A Machine Profile declares the package, exact version, index, and build policy.
An installer binding declares how this local machine starts the package manager.
It is not transferred from the Source Machine and cannot add environment values,
package options, shell expressions, evaluation flags, or a different build policy.

Use the existing verified paths on the current machine:

```text
canonfig installer set npm --executable <absolute-node-path> --arg <absolute-npm-cli.js-path>
canonfig installer set uv --executable <absolute-uv-path>
canonfig installer list --json
canonfig installer check npm --json
canonfig installer remove npm
```

`set` resolves selected symlinks, verifies regular files and the bounded exact
`--version` invocation, then writes user-local `.canonfig/installers/<method>.json`
atomically. The invocation is shell-free, has a five-second timeout, and discards
version output from reports. Repeating the same set does not rewrite the file.
Explicit set/remove can repair or delete malformed regular binding files. A
symlinked/special binding file or an escaping ancestor is not silently replaced.

All deterministic resource installers resolve through this data before launching.
Arguments from the signed recipe follow the binding's fixed prefix unchanged.
Without a binding the existing PATH lookup remains available, but Windows
`.cmd`/`.bat` shims produce Human Action Required rather than enabling a shell.
Node plus `npm-cli.js` or `pnpm.cjs` works without an interactive PATH. Native
installers may still have their own runtime prerequisites; `check` reports only
current-process execution, not unattended scheduler readiness or package success.

Bindings support apt, brew/homebrew, bun, cargo, npm, pnpm, uv, and winget only.
This does not make unsupported Cargo/source-build policies executable. Existing
exact-version, provenance, approved-index, environment-isolation, and
scripts-disabled enforcement remains in the resource executor. The separately
reviewed uv flag correction is PR #92.

These are operator-approved local executable paths, not a sandbox or executable
signature attestation. Replacing the contents of a bound program changes what it
runs; binding paths must be protected by the machine's existing access controls.
A changed or missing entrypoint requires local repair, not an agent-generated
PATH workaround. Audit coverage: E03/E04/E05 and the executable-resolution
portion of S09/S10. This does not claim the historical fleet is configured.
