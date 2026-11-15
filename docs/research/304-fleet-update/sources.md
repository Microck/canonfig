# Primary sources

Inspected 2026-11-13. T3 paths are pinned to the temporary upstream checkout's commit, not the operator's existing checkouts.

## T3 Code

- [Version mismatch and capability](https://github.com/pingdotgg/t3code/blob/9a455f02e2ddf35cc78c21757a96d3ffc3491622/apps/web/src/versionSkew.ts#L47-L112): client/server comparison and installation-specific manual commands.
- [Remote self-update](https://github.com/pingdotgg/t3code/blob/9a455f02e2ddf35cc78c21757a96d3ffc3491622/apps/server/src/cloud/selfUpdate.ts#L121-L346): exact release, policy and database checks, candidate preflight, launcher handoff.
- [Pinned runtime](https://github.com/pingdotgg/t3code/blob/9a455f02e2ddf35cc78c21757a96d3ffc3491622/apps/server/src/cloud/pinnedRuntime.ts#L197-L407): platform archive, SHA-256 comparison, staging and completed-install sentinel.
- [Service launcher](https://github.com/pingdotgg/t3code/blob/9a455f02e2ddf35cc78c21757a96d3ffc3491622/apps/server/src/serviceLauncher.ts#L1020-L1441): trial activation, prepare acknowledgement, failure/timeout recovery and retained previous runtime.
- [Client completion validation](https://github.com/pingdotgg/t3code/blob/9a455f02e2ddf35cc78c21757a96d3ffc3491622/packages/client-runtime/src/state/server.ts#L144-L192): restart acceptance is distinct from committed exact-version confirmation.

## Prior art

- [VS Code Remote FAQ](https://code.visualstudio.com/docs/remote/faq): client-installed/updated server, lifecycle ownership, local-download transfer option and closed-source extension boundary. This source does not prove the exact-commit installer internals.
- [Tailscale updates](https://tailscale.com/docs/features/client/update): per-device opt-in, admin-console eligibility, installation-method reuse, staged auto-update release availability and scheduling limitations.
- [Syncthing CLI](https://docs.syncthing.net/users/syncthing.html): background process, automatic-upgrade opt-out, upgrade command and distinct restart/update exit statuses.
- [Syncthing FAQ](https://docs.syncthing.net/users/faq.html#why-do-i-see-syncthing-twice-in-task-manager): monitor/worker restart model. The initially requested `users/upgrading.html` returned 404; no claim relies on it.
- [Ansible pull](https://docs.ansible.com/projects/ansible/latest/cli/ansible-pull.html): scheduled pull architecture, explicit concurrency warning and `--verify-commit` signature check.
- [Salt Masterless Quickstart](https://docs.saltproject.io/en/latest/topics/tutorials/quickstart.html): `salt-call --local` runs without the minion daemon.

## Release trust

- [npm registry signatures](https://docs.npmjs.com/about-registry-signatures/): ECDSA signs `name@version:integrity`; registry key endpoint and key representation.
- [Canonfig 7.1.9 metadata](https://registry.npmjs.org/@microck/canonfig/7.1.9): exact version, official tarball, SHA-512 integrity, registry signatures and attestation URL. Metadata alone is not publisher authentication.
- [Canonfig 7.1.9 attestations](https://registry.npmjs.org/-/npm/v1/attestations/@microck%2fcanonfig@7.1.9): provenance subject digest, release workflow identity, main ref, GitHub issuer, repository ID and release commit.
- [Sigstore 4.0.0 package](https://registry.npmjs.org/sigstore/4.0.0): Node support compatible with Canonfig's Node 24 floor.
- [Sigstore source](https://github.com/sigstore/sigstore-js/tree/21dd66d041593ad5d9fc2fe461131d8db868ad6f): package's recorded source revision. The installed `sigstore@4.0.0` declarations, `dist/config.d.ts` and `dist/sigstore.d.ts`, are the implementation-driving API: certificate issuer/URI policy, TUF trust roots, certificate-transparency and transparency-log verification.

## Local contracts

- `docs/self-update.md`, `src/runtime/self-update/{core,coordination,settings}.ts`: explicit opt-in, private global npm prefix, leases, idle checks, staging, activation journal and manual recovery.
- `src/enrollment/{source-server,follower-client,version-handshake}.ts`: per-follower bearer credentials, pinned TLS and major.minor transport gate.
- `src/enrollment/enrollment.layer.ts:954-977`, `src/profile/profile-codec.ts:5-25`: enrollment-verified signing key and canonical JSON.
- `docs/scheduler-runtime.md`, `src/runtime/layers.ts:1161-1240`: native `sync --apply --no-input --scheduled` invocation and unattended evidence.
- `src/state/state-repository.types.ts:78-92`, `src/synchronization/run-lock.ts`: exact-build deployment receipt and cross-process Synchronization Run exclusion.

## Research limits

Semantic search became unavailable with provider HTTP 402. Direct local code reads and primary documents were used instead; no paid tier was enabled. Source inspection establishes mechanisms, not their runtime correctness. Isolated proof and public verifier output must be recorded separately.
