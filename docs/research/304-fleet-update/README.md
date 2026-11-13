# Source-driven Canonfig updates (#304)

## Scope and evidence

Research against Canonfig `7070b8487191ec813e6405ab53d5591e9459a1df` and a fresh temporary checkout of upstream T3 Code at `9a455f02e2ddf35cc78c21757a96d3ffc3491622`. Existing T3 checkouts and live Canonfig installations were not changed. Sources and their limits are in [sources.md](sources.md). Recorded implementation evidence follows below.

## What T3 actually does

1. The web client compares its bundled version with `serverConfig.environment.serverVersion`. It flags a server behind the client, rather than every difference. Nightly comparisons include the prerelease build. See `apps/web/src/versionSkew.ts:47-89`.
2. An update request supplies an exact target version. The server distinguishes desktop-managed updates from launcher-managed boot services. Unsupported launch modes receive a manual update path. It checks managed policy, cross-track database compatibility and an in-flight guard before staging. See `apps/server/src/cloud/selfUpdate.ts:53-58,121-138,177-218`.
3. The remote server downloads its own platform archive and release checksums, verifies SHA-256, extracts into staging and validates the runtime. It publishes a completed version directory with a sentinel. This path is not an arbitrary `npm install latest` and does not transfer the desktop's installed directory. See `apps/server/src/cloud/pinnedRuntime.ts:197-283,299-407`.
4. The candidate runs `__service-preflight --database-path ... --launcher-protocol ...`. The response must identify the requested version and report ready before the launcher accepts an update. See `apps/server/src/cloud/selfUpdate.ts:222-301,326-346`.
5. The resident launcher owns the active/trial process and update record. It starts a trial, waits for preparation, commits the selected runtime, or returns to the previous runtime on trial failure or timeout. See `apps/server/src/serviceLauncher.ts:1020-1248,1294-1335,1389-1441`.
6. The client reconnects and requires the matching update ID, committed outcome and exact server version. An accepted request or open socket is not success. See `packages/client-runtime/src/state/server.ts:144-192`.

The inspected archive path authenticates its checksum through the release download origin. It is not evidence that T3 verifies npm publisher provenance. Canonfig's requested publisher check needs an additional trust boundary.

```mermaid
sequenceDiagram
    participant C as T3 client
    participant S as Remote server
    participant R as Release origin
    participant L as Resident launcher
    C->>S: Read environment version and update capability
    C->>S: Update exact target version
    S->>R: Download platform archive and checksum
    S->>S: Verify, extract, run database preflight
    S->>L: Request update(target, database)
    L-->>S: Update ID accepted
    S-->>C: Restart handoff accepted
    L->>L: Start trial and await prepared response
    alt Trial healthy
        L->>L: Commit active runtime
        C->>S: Reconnect
        S-->>C: Ready(update ID, committed, exact version)
    else Trial fails or times out
        L->>L: Return to previous runtime
        S-->>C: Ready(update ID, rolled back or failed)
    end
```

## Prior art

| System | Version authority and activation | Useful here | Constraint |
| --- | --- | --- | --- |
| T3 Code | Client requests exact release; remote stages; resident launcher trials and commits it | Exact target, separate acceptance and completion, preflight, retained prior runtime | A follower launcher would introduce a resident daemon |
| VS Code Remote | Client installs and updates its server on connection; server lifecycle belongs to the client | Pair the remote runtime with the controlling client | Remote extensions are closed source; public FAQ proves automatic management, not an independently reviewed exact-commit installation algorithm |
| Tailscale | Per-device update opt-in; eligible online devices can receive admin-console Start update; release auto-updates are delayed for stability | Local authorization, inventory, staged availability | Depends on an online resident client; latest eligible release is not an exact Source release directive |
| Syncthing | Background synchronization process and monitor; upgrade command and automatic-upgrade opt-out | Keep update and restart outcomes distinct | Its process model differs from scheduled Canonfig followers; peer synchronization is not source-owned fleet release authority |
| Ansible pull | Scheduled local pull and execution; optional commit-signature verification; external locking required | Pull on the native schedule, authenticate instructions, exclude concurrent work | A general playbook executor is a much broader remote execution contract |
| Salt masterless | `salt-call --local state.apply` needs no minion daemon; local state tree | Bounded local execution can replace a resident worker | State distribution and release trust still need a separate contract |

## Chosen Canonfig design

- A **Fleet Update** selects the Source Machine's exact stable Canonfig version, not `latest`, a caller-supplied URL, a package name or a shell command.
- The Source explicitly starts it from the CLI or Version page, selecting a canary. All currently active enrolled followers participate, canary first, then one at a time. Enrollment after start is not silently added to that immutable target set.
- Enrollment authorizes Source-directed updates automatically. No local setting or enablement step gates Fleet Updates. Ordinary manual/automatic self-update policy remains separate; its off switch does not block fleet activation. No new resident follower process, inbound listener or native schedule is installed.
- `sync --apply`, including its existing native scheduled invocation, checks for an update before opening a Synchronization Run. The update control endpoint is authenticated and TLS-pinned, but deliberately independent of the profile transport's major.minor gate. Otherwise a minor update could never repair the mismatch it caused.
- The Source signs a bounded directive using the existing Ed25519 signing identity. It binds protocol, rollout ID, sequence, follower identity, exact version, digest, state format and expiry. Followers pin that key to enrollment, reject stale/foreign/expired directives and do not accept an update from an untrusted signing key.
- Each follower obtains release evidence directly from the official npm registry. Require exact package/version, registry signature, SHA-512 tarball integrity and Sigstore provenance from `https://github.com/Microck/canonfig/.github/workflows/release.yml@refs/heads/main` with GitHub Actions' OIDC issuer. The registry's `maintainers` or `_npmUser` fields alone are not publisher proof. The current public 7.1.9 release has that provenance identity.
- Reuse the updater's gate, command leases, staged nested npm install, disabled lifecycle scripts, candidate smoke checks, journal and retained backup. Supported installed commands hold leases even without standalone self-update settings. Fleet activation discovers npm beside the running Node. The installed old process must not resume ordinary work after its code is replaced.
- Busy commands defer. An open or interrupted Synchronization Run prevents activation. A mismatched state format is a refusal, not an implicit migration. The candidate must be checked before activation and execute a real Synchronization Run afterward.
- Completion requires the new executable's exact version and a fresh Converged deployment receipt for this follower. The Source advances only on the matching authenticated report. Failed health halts the entire rollout. Missing health remains pending and never authorizes the next follower.
- Status distinguishes queued, deferred, updating, healthy and failed followers; Source stop prevents new admissions. An admission already activating cannot be remotely undone.
- Rollback is explicit: stop the rollout, recover any unfinished run with its creating build, stop the affected installation's processes, inspect and restore its retained package using the existing updater recovery procedure, verify version and status, then start a reviewed rollout. Automatic package reversal after Projection is unsafe because code rollback is not configuration rollback.

```mermaid
sequenceDiagram
    participant O as Operator
    participant S as Source Machine
    participant F as Canary Follower
    participant N as Official npm and Sigstore
    participant G as Next Follower
    O->>S: Start Fleet Update to Source version
    S->>S: Persist immutable signed target set
    F->>S: Scheduled sync checks authenticated update endpoint
    S-->>F: Signed exact-release admission
    F->>F: Verify enrollment signature and freshness
    alt Active command or Synchronization Run
        F-->>S: Deferred, installation unchanged
    else Idle
        F->>N: Independently verify release and publisher
        F->>F: Stage, preflight, journal and activate
        F->>F: New executable runs sync and records Convergence
        F-->>S: Matching version and health report
        alt Health passed
            S->>S: Admit next follower
            G->>S: Next native schedule checks admission
        else Health failed
            S->>S: Halt; keep remaining followers queued
        end
    end
```

## Threat model

| Threat | Boundary and mitigation | Remaining risk |
| --- | --- | --- |
| Spoofed Source | Enrollment-pinned TLS and Ed25519 signing identity; authenticated per-follower control endpoints | Source keys and follower credentials remain local secrets |
| Compromised Source requests malicious code | No remote executable, URL, registry or package-name input; follower independently checks official package provenance and digest | Accepted: a compromised Source can start a rollout of an official Canonfig release that passes npm signature and provenance checks. Compromise of the trusted release workflow, npm or Sigstore trust roots is outside Source-key protection |
| Tampered directive or tarball | Canonical signed payload, exact version and SHA-512 binding; registry signature and provenance subject must agree | A correctly signed official release can contain a defect |
| Replayed directive/report | Monotonic rollout sequence, bounded expiry, follower binding and current rollout/attempt identity | A compromised follower can lie about its own health; reports are not hardware attestation |
| Repudiation | Persist signed directive, phase transitions, local update journal and authenticated health outcome | Local administrators can alter local storage |
| Credential disclosure | Reuse credential references and pinned transport; do not publish tokens or npm authentication config | Reports must not contain raw subprocess logs or credential values |
| Denial of service | Bounded metadata/downloads/timeouts, one admission at a time; offline/busy/failing followers never count as healthy | A canary that remains offline stalls the rollout; operator must stop and start a reviewed rollout |
| Elevation of privilege | User-private npm prefix only; no sudo, scripts or arbitrary commands from Source | Canonfig and its declared dependencies run with the enrolled user's authority |
| Concurrent activation and sync | Existing command leases plus run exclusion; check unfinished state again before activation | External package managers do not participate; maintenance must exclude them |
| Unsafe rollback | Retained prior package, explicit recovery, no automatic state conversion | A failed health run may already have changed managed files; restoring code does not reverse those changes |

## Rejected alternatives

- SSH from Source to every follower: new credentials, bidirectional reachability and broader remote command authority.
- Resident follower updater: would allow immediate push, but violates the specified no-daemon model. Schedule latency is accepted instead.
- A second per-follower consent setting: the maintainer chose enrollment as the authority boundary. It leaves followers on older releases until someone performs local work and is not retained as a fallback.
- Merely installing the newest npm release: does not pin the Source's version or establish publisher trust.
- Signing an arbitrary URL with the Source key: Source compromise would authorize arbitrary code everywhere.
- Health equals process exit or `--version`: says nothing about continued Convergence.
- Updating inside an active run: risks replacing executable modules midway through recorded work.
- Automatic package rollback after failed Convergence: cannot safely reverse applied configuration or an unfinished run.
- Accepting missing provenance for local fixtures in production: would turn the proof seam into a security bypass. Isolated proof must supply its own verifier at the module boundary, never a production flag or environment override.

## Open risks and proof requirements

The first release containing this protocol must be installed on each follower before it can consume directives. Unsupported install methods and state-format changes remain explicit operator work. No immediate push or atomic filesystem rollback is claimed. Package dependencies remain a separate supply-chain trust surface.

Required proof: separate disposable Source/Follower HOMEs and N/N+1 packages; show `--version`, `status` and Source rollout status. Also exercise unsigned/tampered directives, active-run deferral and failed-health rollout halt. A local artifact proof cannot establish public Sigstore publisher verification; run that verifier separately against a real published release. Keep raw commands/output here and remove this entire research directory before merging.

## Initial implementation evidence

These historical outputs predate the maintainer's automatic-enrollment decision and retain the original status wording. The proof ran in task-owned Raft workspace `paris:rf-d458f921d2ac4f42` with separate disposable Source and Follower HOMEs, private credentials and npm prefixes. No operator enrollment, native schedule, service or harness directory was used.

```sh
npm run build:cli
node docs/research/304-fleet-update/prove-fleet.mjs
node --import tsx docs/research/304-fleet-update/verify-publisher.mjs
```

- [Installed CLI proof](proof-output.txt): Source upgraded from fixture 7.1.9 to 7.1.10; the canary reached 7.1.10 and recorded a fresh Converged receipt. The output includes `--version`, `status --json` and Source rollout status.
- The same proof refused unsigned and tampered directives, deferred while a real sync held the run lock, halted after a follower's post-update drift failure, and left the next follower on 7.1.9.
- [Publisher proof](publisher-output.txt): the production verifier accepted the public 7.1.9 npm signature and Sigstore release-workflow provenance. The downloader accepted its SHA-512 digest and rejected a wrong digest.
- The local packages use signed fixture publisher metadata through a replacement verifier module inside temporary packages only. The installed CLI, TLS enrollment, downloader, staging, activation and convergence path remain real. This is not a claim that a local fixture has public Sigstore provenance; no bypass flag or environment variable ships.
- [Browser evidence](gui-output.txt), [running rollout](gui-rollout.png) and [stopped rollout](gui-stopped.png): selected `canary-ui`, confirmed Start rollout, saw both queued followers, then confirmed Stop rollout and observed `stopped`. This used `prove-gui.ts`, a loopback GUI and a task-private Raft relay. No follower package was installed by this separate GUI check.
- [Focused checks](checks-output.txt): 52 tests passed across fleet integration and existing updater/GUI acceptance cases. Project, website and UI typechecks passed. Root and website lint had no warnings or errors; UI lint had 73 warnings and no errors. Command validation covered 449 examples and skill validation covered 3 structures.
- [Full UI run](ui-checks-output.txt): 148 of 149 tests passed. The remaining Version test had an incomplete fixture without the new `fleet` field. Its corrected fixture passed all [3 tests in that file](ui-regression-output.txt). The resource-navigation and self-update transport file also passed 3/3 after adding fleet responses and the reduced-motion preference used by adjacent fixtures. No assertions were removed.
- The interrupted full Vitest run had no retained completion output. Only the recorded focused results are claimed; native macOS and Windows checks remain for CI.

The browser, private tunnel and disposable GUI stopped after verification. Raft confirmed destruction of `paris:rf-d458f921d2ac4f42`; downloaded private bootstrap material was removed.

Earlier proof attempts are retained as [version refusal](proof-version-refusal.txt) and [health refusal](proof-health-refusal.txt). The former exposed inconsistent fixture version metadata. The latter exposed a real lineage bug: a projection receipt names a follower-specific revision, not the Source publication. The fix reads the stored `sourceRevision`; the TLS/projection regression failed before the fix and passed afterward.

Simplification reviewed reuse, quality and efficiency inline because this child task forbids further delegation. No behavior-preserving cleanup was warranted; activation continues to use the existing updater and locks. No independent reviewer or human testing is claimed.

## Automatic enrollment verification

After removing per-follower consent, a fresh run used task-owned Raft workspace `paris:rf-92ec80e88114469f`, Node `24.21.0` and npm `11.19.0`.

```sh
npm run build:cli
node docs/research/304-fleet-update/prove-fleet.mjs
node --import tsx docs/research/304-fleet-update/prove-gui.ts
```

- [Installed CLI proof without opt-in](proof-automatic-output.txt): every follower began with `self-update status` reporting `enabled: false` and `settings: null`. No follower enable command ran. After the Source moved from fixture `7.1.9` to `7.1.10`, the canary activated `7.1.10`, recorded Convergence and still reported standalone updates disabled, with no settings file created.
- The same run refused unsigned and tampered directives, deferred while a real sync held the run lock, halted on failed post-update health, and left the unadmitted follower on `7.1.9`. Local fixture publisher metadata remains separate from the unchanged production publisher verifier and its recorded [public-registry proof](publisher-output.txt).
- [Focused checks](checks-automatic-output.txt): CLI build, all 54 tests in the four affected backend files, all six tests in the two affected UI files, and project/website/UI typechecks passed. Root and website lint reported no warnings or errors; UI lint reported 73 warnings and no errors. Documentation validation covered 449 command examples and three skill structures. No fresh full-suite or native macOS/Windows pass is claimed.
- [Browser transcript](gui-automatic-output.txt), [enrolled follower Version page](gui-automatic-follower.png) and [enable dialog](gui-automatic-enable.png): the real follower showed standalone Self-updates Off. Its enable dialog retained only the npm path and idle confirmation; no Source-following checkbox or local fleet setting remained. The dialog was cancelled without enabling standalone updates.

The browser and private tunnel closed, the GUI exited successfully and removed both disposable HOMEs and its bootstrap URL, and Raft confirmed destruction of the workspace. No live enrollment, schedule, service or harness directory was used. All verification was agent-run; human testing remains for the maintainer before merge.

All research files and screenshots must be removed before merge. They are committed separately from the implementation.
