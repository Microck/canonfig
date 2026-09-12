# MCP qualification receipts

An MCP tool is ready only when Canonfig has evidence for seven independent states:

1. `installed`: the exact absolute recipe entrypoint exists and is executable.
2. `launches`: a bounded startup probe exits successfully.
3. `protocol-compatible`: a harmless protocol negotiation probe succeeds for the declared compatibility constraint.
4. `authenticated`: a harmless identity/read operation succeeds, or authentication is explicitly not required.
5. `functional`: a harmless operation such as listing tools succeeds.
6. `client-loaded`: the named target client confirms that it loaded the integration.
7. `canonfig-managed`: the selected recipe fingerprint matches Canonfig's saved binding.

A startup or tools-list result does not imply authentication, functional usability, or target-client loading. Missing stages are recorded as `unresolved` or `not-run`; exclusions are recorded as `excluded`. None of those states is ready.

## Recipe identity and reuse

Qualified recipes record the upstream, exact version, follower platform and architecture, artifact digest, absolute entrypoint, dependency policy, execution context, MCP compatibility constraint, and target client. Canonfig hashes those fields into the saved recipe fingerprint. A follower reuses a recipe only when the exact fingerprint remains applied and the exact entrypoint is still present. A PATH hit without that binding is not selected. Changing an input, architecture, client target, or compatibility constraint plans the pinned install again.

npm and uv recipes remain package-manager installs resolved through follower-owned installer bindings. Binary and source-artifact provenance uses the same qualification receipt and fingerprint; artifact acquisition remains the byte-resource transport's responsibility rather than a PATH lookup.

Receipts retain only stage, method, harmless operation name, exit status, recipe provenance, and local prerequisite disposition. Raw command output, cookies, tokens, environment variables, and license data are never persisted or copied from another machine.

## Local prerequisites and exclusions

Browser sessions and licensed-tool entitlements are local prerequisites. A profile records instructions and links each prerequisite to `authenticated`, `functional`, or `client-loaded`; the corresponding harmless probe is the only way to satisfy it.

The current audit keeps these integrations unresolved until their local prerequisite succeeds:

- Iris: local browser login.
- Oracle: local browser login.
- IDA: local license entitlement.
- Parkour: required local runtime.
- Ghidra-headless: required local headless runtime.

An explicitly excluded integration records every stage as `excluded` and is never ready.