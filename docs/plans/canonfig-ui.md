# Canonfig browser UI integration

## Integrated live GUI

`canonfig ui [--port n] [--no-open]` serves the packaged React application in the foreground on `127.0.0.1`. Omitting `--port` asks the operating system for a free port. The launch URL carries a single-use token that establishes a session cookie. The server checks Host and Origin, holds the normal command lease, and releases its resources on Ctrl-C or SIGTERM. Bare `canonfig` still prints help. This server is separate from `source serve` and never becomes a network administration service.

The four feature areas are integrated with the shared server and authoring API. Source and Follower workspaces call real services; an unconfigured machine opens the setup wizard. Production never reports a simulated mutation as successful or fills missing status fields with demo values.

The production entry is `ui/src/live-app.tsx`, selected through Vite's build-selected `@app` entrypoint; `ui/src/gui-client.ts` imports the shared contract directly. Development and demo builds select `App.tsx`. Production supports the actual role's registered screens and `/setup` when unconfigured. Unsupported paths show an unavailable page rather than mounting demo screens. `src/gui/server.ts` uses Node HTTP under a scoped Effect lifetime. Bootstrap exchanges `GET /?token=...` for an HttpOnly, SameSite=Strict, Path=/ cookie, redirects with 303, and requires the cookie for assets and API calls. Host and any supplied Origin must match the actual loopback address and port.

`src/gui/contract.ts` re-exports the area contracts under `src/gui/contract/`, imported directly by both packages. There are no generated copies. Session contracts live in `contract/session.ts`; operation tickets live in `contract/operations.ts`.

| Contract | Route | Source |
| --- | --- | --- |
| `GuiSession` | `GET /api/session` | `GuiQueries.session()` reads local role records through StateRepository, without network probes. Actual `role` (`source`, `follower`, `unconfigured`), `machineName`, CLI `version`, and `folderPath`. |
| `GuiStatus` | `GET /api/status` | Existing `FollowerCommands.status()` payload. Validate `machineRole`, lifecycle entries with `reached` and `detail`, and tunnel JSON while retaining additional status properties. |
| `GuiError` | Error responses | Existing CLI failure taxonomy, represented by `category`, `exitCode`, and `message`. Do not invent GUI failure categories. |

`src/runtime/layers.ts` implements status. A Source without follower configuration reports unreached follower lifecycle stages. That is not proof the Source service is unhealthy. A follower's response can include synchronization state, active recovery, a completion receipt, and convergence evidence. The GUI does not infer fleet health, pending folder changes or remote schedules from these fields.

## Phase 2 ownership

The shared foundation and all four feature areas are implemented and registered once. The ownership table records the integrated modules. Missing CLI/domain operations remain hidden, not implemented as GUI-only mutations.

| Owner | Contracts and routes | Live entry and existing screens | Tests |
| --- | --- | --- | --- |
| A: integration | Shared contracts, session routes, server, operations, queries, runtime/CLI wiring and authoring API | `live-app.tsx`, `gui-client.ts`, `live/session.tsx`, production guard and shared workspace providers/navigation | `tests/acceptance/gui.test.ts`, `tests/gui-plumbing.test.ts`, `tests/projection-authoring.test.ts` |
| B: profile, publication, skills, Source Secrets | `src/gui/contract/profile.ts`, `src/gui/routes/profile.ts` | `workspace/live/profile.ts`; shared Profile, Source and Skills screens | `tests/gui/profile.test.ts` |
| C: machines, invitations, enrollment, setup, map | `src/gui/contract/enrollment.ts`, `src/gui/routes/enrollment.ts` | `workspace/live/machines.ts`; shared Machines, onboarding and map | `tests/gui/enrollment.test.ts` |
| D: synchronization, recovery, schedule, local items, overlays, harness toggles, backups, secrets, tunnel, unenroll, export | `src/gui/contract/synchronization.ts`, `src/gui/routes/synchronization.ts` | `workspace/live/follower.ts`; shared Follower, Harnesses and Schedule screens | `tests/gui/synchronization.test.ts` |
| E: source service, agent policy/harness, installers, doctor, update status/check | `src/gui/contract/administration.ts`, `src/gui/routes/administration.ts` | `workspace/live/administration.ts`; shared Settings screens | `tests/gui/administration.test.ts` |

Area implementation modules use the shared contracts and visual controls. B consumes D's secret/export handlers; E consumes C's setup handlers. Machine and state layers are exposed once for all area routes.

Each area contract and server route factory is registered once. There is no live-only screen registry. `workspace/workspace.tsx` selects the same screens for both providers, and `tests/gui/**/*.test.ts` remains included in Vitest.

### Backend seam and worked Overview example

`WorkspaceBackend` in `ui/src/gui-client.ts` is the injected browser backend. It supplies `session(signal)`, `status(signal)`, `request(path, responseSchema, signal, mutation?)`, and `operation(id, signal)`. The HTTP implementation decodes responses with the shared Effect schemas. Mutations send JSON, the session cookie and `x-canonfig-request: browser`. `GuiRequestError` preserves the CLI message, category and exit code; `ErrorNotice` in `ui/src/live/session.tsx` displays all three.

`LiveApp({ backend })` defaults to `httpBackend`, authenticates the session and supplies `LiveWorkspaceProvider`. Canonical shared routes determine navigation and role access. Unknown paths never mount a demo screen.

The live hooks import the area's shared schemas and never import simulated records. `shared/metadata.ts` holds reusable labels and types without fixtures. Shared controls use `ScreenContext`; forms and the machine-map renderer are shared by the production and demo providers.

### Typed operations and real journals

An area route export is an Effect that captures its command services once and returns `GuiRoute[]`. Use `queryRoute` for reads and `mutationRoute(method, path, inputSchema, operation, status?, options?)` for explicit operations. The helper rejects invalid JSON, unknown request keys and bodies over the route's bounded byte limit before invoking the service. The default is 1 MiB. Profile item/config and local-item authoring routes derive their allowance from the shared 128 MiB authoring aggregate budget, base64 expansion and a 1 MiB JSON envelope allowance. The authoring writer enforces that same aggregate budget on the complete candidate before writing. Other routes retain the default. Empty mutations share the strict `EmptyBody` schema. The server requires the session cookie, exact Host/Origin checks, the custom request header and `application/json` for every mutation. Errors use the CLI taxonomy. There is no shell or arbitrary command endpoint.

Long operations use `GuiOperations`, provided to every area route factory. Capture it with `yield* GuiOperations`; return `operations.start(commandEffect, readJournal)` from a mutation with status 202 and the `GuiOperationTicket` response schema. Poll `GET /api/operations/<id>` through `backend.operation`. The command runs in the server scope, not the request scope, so disconnecting the request does not cancel an apply. Closing the GUI interrupts its scope; existing command journals remain the recovery authority.

`readJournal` must read that operation's real journal or return JSON null until it exists. Capture the operation's actual run/setup/revision identity, not a later unrelated "latest run". Tickets expose running/succeeded/failed execution state, the actual result or CLI failure, and this journal. They contain no percentage, synthetic stage or timestamp. Up to 64 tickets remain available until the server stops; the next start is refused rather than evicting a ticket someone is polling. Tickets are session-local, while journals persist through their domain services.

### Shared authoring API

`src/projection/authoring.ts` is independent of the GUI and requires `MachineState`. Callers provide `{ folder, scope: "canonical" | "local", statePath }`, using the same state path as sync/restore. Route owners enforce machine-role authorization before calling it; a follower's canonical mirror is not a writable GUI target.

- `readAuthoringItems(target)` lists file items and whole skill trees. Each item has a digest, and each contained file has its own digest, bytes and executable flag.
- `readAuthoringItem(target, path)` also reads absent items, whose digest is null.
- `writeAuthoringItems(target, changes)` accepts `{ path, expectedDigest, files }` for each item. An empty file list deletes it. A skill change contains its entire desired tree. Instructions, rules, agents, commands, hook scripts and `files/` content use the same writer.
- `editAuthoringConfig(target, expectedDigest, edits, changes?)` applies JSONC key-path edits through `jsonc-parser` `modify`/`applyEdits`. `undefined` removes a key. Optional item changes let a resource declaration and its file content validate together. Canonical keys include harnesses, surfaces, MCP, hooks, settings, tools, credentials, groups, scheduleDefault, local policy, resources and profile. The local target edits `local/local.jsonc`.

The writer holds the existing cross-process run lock, checks each item's digest, validates the complete candidate with the existing folder loader in memory, and re-reads the authoring snapshot before publication. Invalid candidates and stale preconditions write no authoring files. Local additions outside `local.allow` are refused. Every changed file publishes through anchored `MachineState.atomicWrite`; create uses no-replace publication. Files are protected at 0600, executable scripts at 0700. Symlinks, special files and traversal are refused.

Atomicity is per file, not a whole-directory transaction. A filesystem failure midway through a multi-file skill/resource edit must be reported and reloaded; do not report the whole edit as saved. The run lock serializes Canonfig writers. Digests detect hand edits visible at the final check, not an external editor racing the subsequent filesystem rename.

### Fonts and release size

`ui/scripts/subset-fonts.py` reproduces subsets from the phase-1 Git revision `2039144`, using `fonttools[woff]` 4.62.1. It keeps Latin plus the punctuation/symbols found in UI source, OpenType layout features and license metadata. The unused italic face and its CSS declaration are removed; the four referenced upright weights and both OFL texts remain. Keep the release size measurement and budget in `tools/release/validate-release.ts` aligned with the packaged production UI.

The shipped font bytes fell from 518,156 to 156,000. Manrope is 22,876 bytes; Ioskeley Mono Regular/Medium/SemiBold/Bold are 33,076/33,496/33,356/33,196 bytes. The removed italic was 107,428 bytes. The complete shared-screen production package measured 1,237,671 bytes packed and 4,277,427 unpacked. Release ceilings are 1,290,000 and 4,410,000 bytes, retaining about 4% packed and 3% unpacked headroom.

## Screen and action inventory

The rows below record the integrated state: live, browser-local, demo-only, hidden or terminal-only. `GET` reads, while `POST`, `PUT` and `DELETE` name explicit operations. Search, filter, tab selection, expanding details, draft edits, Save/Discard confirmation, copy buttons and navigation stay in the browser unless a row says otherwise.

### Overview, navigation, and presentation

| Screen/action and evidence | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Source/Follower Overview and Reload | **Live:** `FollowerCommands.status` supplies actual machine evidence. | `GET /api/session`, `GET /api/status` | A |
| Overview unpublished queue, follower lag, item-by-machine matrix and fleet summaries | **Hidden in live:** no fleet telemetry or folder-diff contract exists. The demo keeps its simulated summaries. | No synthetic Overview endpoints | A |
| Sidebar, command palette, role-invalid/not-found routes | **Live:** shared navigation is restricted to the actual role and supported operations. | Browser navigation | A |
| Tours, chapter picker, first-visit tips, Get started dismissal and GitHub star prompt | **Browser-local:** guidance never certifies a real machine operation. Live tours use supported chapters only. | Browser preferences only | A |

### Profile and publication

| Screen/action | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| **Live:** Profile Items list/filter/detail, add/edit/remove/save/discard, As written and group selection | Digest-checked `readAuthoringItems`, `writeAuthoringItems` and `editAuthoringConfig`. File items include whole skill trees and `files/`; config items include MCP, hooks, settings, tools, credentials and authored resources. Resource declarations and associated file changes save together. | `GET`/`PUT /api/profile/items`; `PUT /api/profile/config` | B |
| **Live:** Profile Harnesses selection and per-harness Gets/Everything | Comment-preserving edits to `harnesses` and `surfaces`, not local include/exclude. Installed-harness evidence remains D's table. | `GET /api/profile/items`; `PUT /api/profile/config` | B |
| **Live:** Groups create/remove and resource membership. **Hidden:** rewriting existing machine memberships | Authored `groups` through digest-checked config edits. Existing enrollment groups require a new invitation and re-enrollment with `--replace`. | `PUT /api/profile/config`; invitations owned by C | B/C |
| **Live:** Defaults save/discard profile name, default schedule, local allowlist and append-local policy | Digest-checked edits to `profile`, `scheduleDefault` and `local`, preserving unspecified keys. A missing profile requires an explicit ID; existing IDs are read-only in this form. | `PUT /api/profile/config` | B |
| **Live:** Discover tools and inspect findings. **Hidden:** Add selected | `SourceCommands.scan({write:false})`. Selective writes have no exact CLI counterpart. | `POST /api/profile/scan` | B |
| **Live:** Publication reviewer, real folder/resource validation, confirmation and operation polling; revision list/detail/copy fingerprint. **Hidden:** synthetic progress, unpublished sequence prediction and machines-on-revision counts | `folderProfile`, `validateMachineProfile`, publication credential checks, then `SourceCommands.publish`. Publication revalidates before signing. Operation evidence is null until this operation's exact revision commits. | `POST /api/profile/validate`, `/api/publications`; `GET /api/revisions`; `POST /api/revisions/inspect` | B |
| **Live:** Profile Export, including the shared backend and verified browser download | Real verified archive transported as base64 JSON and downloaded as a Blob, with archive digest, manifest digest and signer shown. No browser persistence. | `POST /api/exports` | D; B owns Profile button |
| **Live:** Skill upstream list, track source/ref/subdir, check changes and update | `listSkills`, `trackSkill`, `checkSkills`, `updateSkills` in `src/skills/manager.ts`. Local edits refuse with the CLI conflict category and exit code. Updates recheck before writing and never publish. | `GET /api/skills`; `POST /api/skills/track`, `/check`, `/update` | B |

Area B uses the same profile, publication, revision, skill and Source Secret screens for both providers. Live field editors preserve supported frontmatter and JSONC values. Tool recipes, unknown fields, hook scripts, `files/` content and full skill trees use exact-text/tree controls inside the same detail panel. Saves check the captured config and item digests; conflicts retain the CLI error and offer Reload. Live publication shows real validation and committed revisions, without predicted sequence numbers or synthetic progress. The demo retains its simulated flows.

Source Secrets is live through D's shared contract: list metadata, set/replace a write-only value, and confirmed removal. Values never enter browser persistence. Sharing membership changes remain replacement invitations, not an invented membership mutation. B adds no duplicate secrets or export handlers.

Canonical authoring also runs projection's `projectResources` boundary check before any candidate writes. Authored targets inside any adapter-owned or never-touch path are refused with the projection diagnostic, without writing the config or its associated files.

### Machines, invitations, and onboarding

| Screen/action | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Source machine map/list and follower detail | **Live:** safe enrollment inventory includes identity, name, groups, enrollment date, revocation, pending and credential-presence flags. Remote health, revision, platform, schedule and recovery claims are **hidden**, because the Source has no telemetry for them. | `GET /api/machines`; detail selection is browser-local | C |
| Follower map/list, Source detail, this-machine detail | **Live:** local enrollment only, including public Source fingerprints. Sibling followers are never returned. | `GET /api/enrollment` | C |
| Add machine: endpoint, expiry, groups, invitation download, transfer/tunnel/enroll instructions | **Live:** `SourceCommands.invite` delivers the real envelope through a private temporary file, which is removed after reading. Download returns that envelope, not a simulated certificate. Optional label is **hidden**, because invitations do not reserve names. | `POST /api/invitations` | C |
| Pending invitations and Cancel | Stored invitation metadata is **live** through StateRepository. Cancellation is **hidden**, because no CLI cancel operation exists. Neither listing nor errors expose bearer codes, nonce digests or credential references. | `GET /api/machines` includes `invitations` | C |
| Disconnect/revoke follower confirmation | **Live:** explicit confirmation calls `SourceCommands.revoke`. | `POST /api/machines/revoke` | C |
| Change groups and replacement invitation | **Live:** creates a new invitation; the follower explicitly chooses replacement enrollment. Existing remote membership is never silently rewritten. | `POST /api/invitations`; `POST /api/enrollment` with `replace: true` | C |
| Map select/open/add, pan/zoom/fit, drag nodes, reset layout; customize name/purpose/icon, upload icon, preset/custom colour, reset appearance | **Browser-local:** the shared map view uses localStorage. Names and appearance never change hostnames or enrollment identities. Enrollment-only links show no fabricated transfer animation. | None | C |
| Standalone map demo controls | **Hidden in live:** the demo adapter supplies simulated records to the shared renderer. | None | C |
| Setup role, harness picks, import offers/collisions/skips/secret opt-in, review, approve, apply and status | **Live:** calls SetupCommands in-process, preserves the exact import offers and plan digest, and requires explicit approval. Draft changes require re-planning. Unconfigured sessions route to `/setup`. Arbitrary profile-name, service-port and scan controls are **hidden** here because they are not setup inputs; profile naming follows the CLI hostname rule, while service/scan remain separate operations. | `POST /api/setup/plan`, `/approve`, `/apply`; `GET /api/setup` | C |
| Follower invitation file/paste/inspect, SSH host/user/host-key trust, name, exclusions, default schedule, Join/Open | **Live:** validates the actual invitation envelope, starts the real tunnel with a verified host-key file, and calls follower enroll. Post-enrollment exclusions and schedule call D's handlers; schedule errors preserve the CLI requirement to apply a profile first. | `POST /api/enrollment/inspect`, `/api/enrollment/tunnel`, `/api/enrollment`; `PUT /api/harnesses`, `/api/schedule` | C, D preference handlers |

#### Area C setup contract for settings

`GuiSetupStatus` is the response to `GET /api/setup`. It preserves the CLI's stage,
approval state, current plan digest, item verdicts, evidence, provenance and recorded
choices. `POST /api/setup/plan` accepts `GuiSetupPlanInput` and returns
`GuiSetupJournal`, the existing domain SetupJournal schema. `POST /api/setup/approve`
accepts `{ approver, planDigest }` and returns that same journal. `POST /api/setup/apply`
accepts `{ planDigest }` and returns `GuiOperationTicket` with HTTP 202. Area E uses
these same endpoints and schemas, not a second setup controller.

Approve/apply reject stale digests with `conflict-or-drift` and exit code 4.
GUI setup mutations are serialized. Apply polling reads real setup status only
while it matches the captured plan digest; a later unrelated plan is not presented
as the operation's journal. Enrollment and tunnel tickets have no setup journal.
No browser completion checkbox certifies readiness.

Enrollment now uses the shared machine screens and onboarding wizard in both builds.
The live controller preserves setup digests and human approval, inspects real
invitation files or pasted envelopes, and runs enrollment or tunnel operations.
Only the simulated onboarding adapter imports demo fixtures. Configured Setup
reads the same backend journal. Map appearance stays browser-local; demo purposes
and remote telemetry never become live machine facts.

### Synchronization and local state

| Screen/action | CLI/service mapping | Endpoint | State |
| --- | --- | --- | --- |
| Sync check, plan details, apply, held/drift explanation, collision link | `FollowerCommands.synchronize`; plan and apply are polled operations. Final journal evidence is bound to the command's exact run ID, never the latest run. Drift requires manual resolution, not force overwrite. | `POST /api/sync/plan`, `/api/sync/apply` | Live |
| Recover, Abandon, Check again | `FollowerCommands.recover/abandon`; confirmations preserve the CLI's no-rollback semantics. Check again runs a fresh plan. | `POST /api/recovery`, `/api/recovery/abandon`, `/api/sync/plan` | Live |
| Adoption review creation | `sync --plan --review-local`; returns only the CLI's review metadata. | `POST /api/sync/reviews` | Live |
| Adoption review exact text, whole-file previews, delete | No protected read/delete CLI operation exists. Private review contents remain on disk. | None | Hidden |
| Schedule cadence, Source default, days/time, native status, Save | `FollowerCommands.scheduleStatus/setSchedule`; next-run and platform facts appear only when supplied by native status. No invented preview or wake guarantee. | `GET`/`PUT /api/schedule` | Live |
| Local instructions, rules, skills, agents, commands: list, add, edit, rename, delete, save, discard | Shared authoring API with `scope: "local"`, Source `local.allow`, digest preconditions, binary-safe skill assets, executable flags and reload on conflicts. Rename is one checked transaction. | `GET`/`PUT /api/local/items`; an empty file list deletes the item | Live |
| Local MCP/settings keys and backups preference | `editAuthoringConfig` updates `local/local.jsonc` with digest checks and preserves comments. Backup disable requires confirmation. | `PUT /api/local/preferences` | Live |
| Collision replacement, overlays and exact key claims | `FollowerCommands.overlays`; item and key-claim names stay in JSON bodies. Removing a claim permits the next sync to manage the key again. | `GET`/`PUT`/`DELETE /api/local/overlays` | Live |
| Managed harness include/exclude | `FollowerCommands.harnesses`; `GuiHarnessReport` exposes actual installed/listed/excluded state for this screen and enrollment preferences. | `GET`/`PUT /api/harnesses` | Live |
| Retained append-local content details | No protected content-read API exists. | None | Hidden |
| Backups list, restore confirmation and outcome | `listSnapshots` lists real takeover snapshots; `FollowerCommands.restore` supplies actual restore/exclusion evidence as a polled operation. | `GET /api/backups`; `POST /api/backups/restore` | Live |
| Follower Secrets list and update | `listSecrets` and `synchronizeSharedSecrets`; only names and origins are returned. | `GET /api/secrets`; `POST /api/secrets/sync` | Live |
| Tunnel status, start and stop | `FollowerCommands.tunnelStatus/restartTunnel/stopTunnel`; start uses recorded configuration, stop keeps it. First-time configuration belongs to enrollment. | `GET /api/tunnel`; `POST /api/tunnel/start`, `/api/tunnel/stop` | Live |
| Enrollment details, copy fingerprints and unenroll | C supplies the safe `GuiEnrollment` read contract and handler. D calls `FollowerCommands.unenroll` exactly: applied files, native schedule and tunnel configuration remain. | `GET`/`DELETE /api/enrollment` | Live; integrated with C |
| Local settings Export | `FollowerCommands.exportArchive`; the server checks the returned archive hash, downloads actual bytes and removes its unique temporary file. No arbitrary output path is accepted. | `POST /api/exports` | Live |

D also owns the Source secrets handlers used by B: `GET /api/secrets` returns
`GuiSecrets`, `PUT /api/secrets` accepts write-only `{ name, value }` and returns
`GuiSecretSummary`, and `DELETE /api/secrets` accepts `{ name }` and returns
`GuiSecretRemoval`. Follower sync returns `GuiSecretSync`. These shapes and
`GuiArchiveDownload` are defined in `src/gui/contract/synchronization.ts`.
Secret values never enter responses, URLs, logs or browser storage; even malformed
secret-request diagnostics omit the submitted input.

The polished Follower screens now use `workspace/live/follower.ts` through the
typed workspace interface. Plan, apply, recovery, abandonment and restore render
real operation evidence with human labels. Local editing preserves complete file
trees, binary assets, executable bits and digest preconditions; configuration
edits preserve unrelated keys and comments. The demo keeps its simulated flow.
The old live-only synchronization screen and registry have been removed.

Follower verification: UI typechecking, production and demo builds, packaged CLI
compilation, root TypeScript checking and root lint passed in a disposable Paris
Raft workspace. The GUI acceptance/synchronization tests passed 5 cases, and
navigation tests passed 37. UI lint reported 73 warnings and no errors.
Packaged-browser checks covered plan, apply, private review, local file/config
editing, rename/removal, binary skill assets and executable bits, a refused save
with its draft retained, overlays/key claims, harness toggles, backups preference,
verified export and real daily/weekday native schedules. The scheduler refusal
was resolved by starting the disposable guest's user manager, then saving again.
An enrolled Follower sidebar did not offer Join a Source.

Sixteen demo-left/live-right comparisons cover eight pages at 1920×1080 and
390×844: `/tmp/canonfig-ui/unify/sync-compare-<page>-<width>.png`.
Both browser sessions reported no errors during the final capture pass.
The integration acceptance below completes recovery, abandonment, restore, secret refresh, tunnel start/stop and unenrollment. Shared setting values now wrap long revisions, fingerprints and paths at 390px instead of forcing their row wider.

### Settings and shared secrets

| Screen/action | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Source service status, Install, Remove | **Live.** `source service status/install/remove` through SourceCommands, with Source-role enforcement and native status evidence. Restart is **hidden** because no CLI counterpart exists. | `GET`/`POST`/`DELETE /api/source-service` | E |
| Agent policy mode, built-in/custom harness, model, executable/args, writable paths, evidence limit, Save | **Live.** FollowerCommands get/setAgentPolicy and get/setAgentHarness. Save reports policy success separately if harness save fails. The Source shows the CLI's harness refusal, not a fabricated harness configuration. | `GET`/`PUT /api/agent/policy`, `/api/agent/harness` | E |
| Installers list and Check | **Live.** The same installer binding list, Windows suggestions and bounded check as `installer list/check`. Bind/remove remain terminal operations, not extra GUI buttons. | `GET /api/installers`; `POST /api/installers/:method/check` | E |
| Machine setup journal, Approve plan, Apply | **Live:** E uses C's integrated handlers. Explicit human approval and the displayed plan digest precede approve/apply. Apply polls its real operation journal. Mark linger done is **hidden** because a checkbox cannot verify readiness. | `GET /api/setup`; `POST /api/setup/approve`, `/apply` | E frontend, C backend |
| Health check Run checks, result detail, fix command copy | **Live.** `doctor --no-input` through FollowerCommands. Failed checks retain the report and CLI category/exit code; copying evidence or a recovery command does not execute it. | `POST /api/doctor` | E |
| Canonfig version status and Check; enable/disable/apply instructions | Status and Check are **live**. Enable, disable and apply are **terminal-only**, with copyable commands and instructions to stop the GUI first. No write endpoint or command-lease exemption. | `GET /api/self-update`; `POST /api/self-update/check` | E |
| Source Secrets list, Set, Replace value, Remove, sharing membership | **Live:** `listSecrets/storeSecret/removeSecret` use the CLI failure mapping. Membership changes require replacement enrollment. Values remain write-only and absent from logs, URLs, status and browser persistence. | `GET`/`PUT`/`DELETE /api/secrets` | B frontend, D backend |

Area E now uses the shared workspace settings screens through the administration slice described in Phase 2d. Its separate live administration components have been removed. Setup remains owned by area C.

## Decisions for phase 2

1. **Decided:** build one shared authoring API for Profile and follower `local/`, with comment-preserving JSONC edits, existing folder validation, atomic file writes and digest preconditions.
2. **Decided:** read contracts expose only real folder data, enrollment records, stored invitations, run journals and takeover snapshots. No invented telemetry, progress, timestamps or remote schedules.
3. **Decided:** invitation cancellation, selective scan writes, service restart and private-review deletion stay hidden in production until CLI counterparts exist. The demo keeps them. Map appearance customization stays browser-local in localStorage.
4. **Decided:** unenrollment matches the CLI's actual cleanup boundaries. Setup uses plan, explicit human approval and apply through its existing journal. A checkbox cannot certify credentials, host keys, linger or convergence.
5. **Decided:** self-update status/check may become live now. Enable, disable and apply from the GUI remain phase 3, tracked by issue #260, with no command-lease exemption.

## Remaining follow-ups

- Setup mutations serialize within the GUI, and journal writes use their IO lock. The plan-digest check and subsequent domain command are not one cross-process transaction. Another CLI process can replace the journal between those steps; a future domain-level operation must own that complete boundary.
- Native schedule installation requires a running systemd user manager on Linux. Acceptance uses task-owned users and managers inside the disposable Raft guest, never the operator's manager.
- Vite reports a vendor chunk above its 500 kB advisory threshold. Production and demo builds succeed; this is a bundle-splitting follow-up, not a missing route.


## Delivery evidence

The earlier area evidence below records focused authoring and administration exercises. The final integrated acceptance record follows the Phase 2d section and supersedes earlier incomplete-check notes.

## Phase 2d: one screen tree, two data sources

`ui/src/workspace/workspace-types.ts` defines the screen-facing `Workspace` interface. It combines `OverviewSlice`, `ProfileSlice`, `MachinesSlice`, `FollowerSlice` and the typed `AdministrationSlice` from `administration-types.ts`. Field names stay unchanged where their meaning holds. Revision, sync progress, machine platform/state, snapshot counts and other evidence that the backend does not report are optional. Live screens omit the corresponding demo telemetry or explain that it is not reported.

`store.tsx` owns only the React context and browser-local UI state. `SimulatedWorkspaceProvider` in `simulated-store.tsx` retains the demo's fixtures and actions. `LiveWorkspaceProvider` in `live-provider.tsx` composes the hooks in `workspace/live/{overview,profile,machines,follower,administration}.ts`. The providers use the same navigation state, `workspace.tsx` screen tree, `frame.tsx`, sidebar groups, icons, route tabs and mobile navigation. The production bundle guard rejects simulated providers, the demo application and `shared/data.ts`.

Each live resource exposes loading and its decoded CLI error. `LiveWorkspaceProvider` selects the active page's resource state, so the existing skeletons and `ErrorNotice` show pending or failed reads without replacing them with fixture data. `live/resource.ts` owns abortable reads and real operation-ticket polling. Backend state is never persisted in browser storage. Map appearance, dismissed guidance and unfinished UI drafts remain browser-local.

`capabilities` separates unavailable CLI operations from the demo: invitation cancellation, selective scan writes, service restart, private-review deletion and self-update mutations are false in production. `simulatedTelemetry` is false too. Profile, enrollment and follower write capabilities are true; their completed hooks supply the shared forms.

Production session/token bootstrap remains in `live-app.tsx`. Its session determines the allowed role and routes; unconfigured machines redirect to `/setup`. The old screen registry is gone. Both builds now render the shared onboarding flow, with a real enrollment controller in production and fixture injection in the demo. Live tours include the navigation introduction and Agent policy, without claiming remote health or the demo's Source name.

### Worked example

Overview reads the actual session and CLI status without treating unreachable follower lifecycle stages as Source failures. Source service, Agent policy, Installers, Health check and Canonfig version all use the shared settings screens. Source service exposes real status/install/remove, not restart. Policy save preserves the separate Source harness refusal. Doctor retains failed reports and their CLI diagnostics. Version exposes status/check and terminal instructions for mutations. `ui/src/live/administration.tsx` and the old live Overview have been removed.

### Completed area ownership

All three area cutovers are complete. No live-only replacement screen or screen registry remains. The following table records the implemented scope, not outstanding tasks.

| Owner | Owned files | Remaining checklist |
| --- | --- | --- |
| Profile agent | `workspace/live/profile.ts`, `workspace/profile.tsx`, `workspace/profile-authoring.ts`, `workspace/profile-authoring-controls.tsx`, `workspace/skills.tsx`, Source harness controls in `workspace/harnesses.tsx`, profile/publication/source-secret portions of `workspace/source.tsx`; old `live/profile.tsx` and its authoring modules deleted | **0:** all 11 members implemented: `setResources`, `setSecrets`, `markProfileEdit`, `removeProfileEdit`, `publish`, `setListed`, `setSurfaces`, `scannedTools`, `skillSources`, `upstreamSkills`, `profileSchedule` |
| Machines agent | `workspace/live/machines.ts`, `workspace/machines.tsx`, `onboarding/*`, `shared/machine-map/*`, configured Setup view in `workspace/settings.tsx`; removed `live/enrollment.tsx` | **0:** revoke, invitation creation/download, replacement enrollment, setup plan/approve/apply and enrollment tunnel use the real API. Unsupported invitation cancellation stays hidden. |
| Follower agent | `workspace/live/follower.ts`, `workspace/follower.tsx`, `workspace/schedule.tsx`, follower secrets/tunnel/local/backup controls; old `live/synchronization.tsx` and `workspace/synchronization/screens.tsx` | **0:** live operation plans/outcomes and run IDs, human-action recheck, harness exclusions, backups preference/restore, complete local editing, overlays/key claims, native schedule, tunnel controls, secret refresh, private-review creation, enrollment/unenroll and verified archive download are wired to the real API. Unreported progress and fleet telemetry stay absent. |
| Integration owner | `workspace-types.ts`, `store.tsx`, providers, navigation/frame/routes, `live-app.tsx`, build guard, Overview and administration hooks | **0** in the Overview and administration example |

The profile hook uses real authoring, validation, publication, revision inspection, skill tracking/check/update, Source Secret and archive APIs. Its shared forms retain digest preconditions, write-only secret values and failure/reload controls. The machines hook reads enrollment records and invitation metadata without inventing health. The follower hook supplies full local authoring records and actual operation tickets to the shared forms; its capability is enabled.

The integration preserves all slices, digest preconditions, explicit setup approval, write-only secrets and the CLI failure taxonomy. The demo retains its simulated flows.

Area C keeps Source import collisions and secret-reference opt-in explicit.
Live setup omits simulated progress and service/scan choices that are not setup
inputs. Follower onboarding shows actual Source fingerprints, requires replacement
consent, and loads local harness preferences after enrollment. Schedule selection
preserves the CLI's applied-profile prerequisite. Neither enrollment nor saving
local preferences is presented as a completed synchronization.

Profile area evidence: GUI acceptance/profile tests passed 8 cases; navigation and authoring tests passed 56 cases, including 19 lossless-authoring cases. Packaged-browser checks exercised field and exact-tree writes, item creation/removal, discard, group membership and creation, defaults, stale-digest Reload/retry, and skill tracking/check/update/local-edit refusal. Sixteen comparisons cover eight pages at both viewports under `/tmp/canonfig-ui/unify/profile-compare-<page>-<width>.png`. Final integration acceptance below completes its remaining action checks.

### Phase 2d verification

In the disposable Paris Raft workspace, UI typechecking, production/demo builds, packaged CLI compilation, root TypeScript checking and root lint passed. The production module-graph guard passed. The targeted GUI acceptance/routes suite passed all 18 tests across five files, and shared navigation tests passed all 37 cases. UI lint reported 73 warnings and no errors; root and website lint reported no warnings or errors.

Packaged-browser checks used a disposable Source home and named `agent-browser` sessions. They exercised Overview, role-invalid navigation, the mobile navigation sheet, Source service reload, initial Agent policy creation and reload, a real npm installer binding and successful Check, doctor with retained failed-probe evidence, and the real self-update installation refusal. The missing-policy case starts with no radio selected; choosing and saving a policy writes through the API rather than inventing a saved default. Native service install/remove and self-update mutations were not run on the controller.

All six worked-example pages were captured at 1920×1080 and 390×844 for both providers. The 24 originals are `/tmp/canonfig-ui/unify/admin-{demo,live}-{overview,service,agent,installers,health,version}-{1920,390}.png`. Twelve `admin-compare-<page>-<width>.png` images place the demo on the left and live on the right. The shared spacing, navigation and controls match; only real evidence and supported operations differ. Demo Source, Follower Overview/Sync and New machine setup also loaded without browser errors, with four extra `demo-*.png` captures in that directory.

## Final integrated acceptance

The three area branches were merged in enrollment, profile, synchronization order with `--no-ff`. Shared type imports and write capabilities were combined, not chosen from one side. The last unused live-screen type module and empty profile handoff marker were removed. Production and demo now have one screen tree.

Integration fixes:

- Setting rows and property grids wrap long revisions, fingerprints and paths within their available width.
- The follower stores Source keys and an endpoint, not a Source machine name. Its Source card uses "Source" with the endpoint on a separate line.
- Source harness inventory is requested for configured Sources as well as Followers, so Gets and surface edits render real rows.
- Invitation groups always offer the built-in `canonfig:secrets` permission, independently of authored groups.
- Publication labels omit unknown sequence numbers. Overview, service, doctor and version show named evidence, not raw response JSON; exact authored configuration remains an editor, not a status dump.
- Vite build commands set the production environment before entrypoint selection. The packaged-executable test exposed inherited `NODE_ENV=test` selecting the demo; a real packed-assets regression now prevents that.

Acceptance used packaged `node dist/runtime/main.js ui --no-open --port 5430` for Source and port 5431 for Follower, separate temporary homes, actual native keyrings, task-owned Linux users/systemd managers and `agent-browser` in a disposable Paris Raft workspace. Source HTTPS served only loopback port 17343. The SSH fixture used a separate loopback sshd on 2222, a disposable key pair and a forwarding allowlist restricted to that Source; the tunnel listened on 17344.

Screenshots are retained in `/tmp/canonfig-ui/final/`. The action evidence below supplements the area-specific authoring, local-item and administration evidence above.

| Browser action | Result | Screenshot basename |
| --- | --- | --- |
| Source onboarding, actual import offer, review/approve/apply | Pass with native credential storage | `source-native-setup-complete-1920.png` |
| Publish and inspect revision, public fingerprint/signature | Pass, two real revisions | `source-revision-detail-{1920,390}.png` |
| Source Secret set, replace, remove | Pass, metadata only; removed then recreated for sharing | `source-secret-{replaced,removed}-1920.png` |
| Export download | Pass; signed archive imported with `--dry-run` into a separate HOME, exit 0 | `source-export-1920.png` |
| Harness Gets and surface changes | Pass, saved Codex surface selection | `source-harness-surfaces-1920.png` |
| Group create and remove | Pass | `source-group-{created,removed}-1920.png` |
| Discover tools read | Pass; no findings for the instructions-only fixture, no selective-write control | `source-discover-tools-1920.png` |
| Invitation and download | Pass, actual envelope consumed over loopback | `source-invitation-{1920,390}.png` |
| Source machines list/detail/map | Pass with stored names and enrollment evidence | `source-machine-{list,detail}-1920.png`, `source-machine-detail-390.png`, `source-machines-{1920,390}.png` |
| Follower enrollment and Source identity display | Pass, Source title with endpoint secondary | `follower-enrolled-390.png`, `follower-source-name-1920.png`, `follower-source-detail-390.png` |
| Replacement invitation/enrollment | Pass, explicit consent and secret-sharing permission | `source-replacement-invitation-390.png`, `follower-replacement-enrollment-390.png` |
| Sync plan/apply | Pass, real revision and verified outcome | `follower-sync-plan-390.png`, `follower-sync-applied-{1920,390}.png` |
| Recover | Pass, interrupted journal seeded through StateRepository as in the CLI recovery tests, retaining checksum-verified artifacts | `follower-recovered-390.png` |
| Abandon | Pass; recorded run closed without rollback | `follower-abandoned-390.png` |
| Restore backup | Pass after applying under the replacement identity; restored instructions and excluded Codex | `follower-backup-restored-390.png` |
| Secrets refresh | Pass, one shared secret entered the follower's native store | `follower-secrets-refreshed-390.png` |
| Tunnel stop/start | Pass against the disposable real sshd with independent SSH/TLS/Source pins | `follower-tunnel-{stopped,started}-390.png` |
| Daily, weekdays, picked days, custom native expression, published Source default | Pass, native jobs installed and armed; reload retained selections | `follower-schedule-{daily,weekdays,picked-days,custom,source-default}-390.png` |
| Native Source service install/remove | Pass after stopping the task-owned foreground Source transport; systemd reported active/running, enabled, matching definition and serving revisions | `source-service-{installed,removed}-390.png` |
| Unenroll, performed last | Pass; returned to setup, role became unconfigured, shared secret inventory became empty; native schedule and tunnel retained per CLI contract | `follower-unenrolled-{1920,390}.png` |

Fixture corrections did not bypass product safeguards: replacement enrollment first required a fresh apply before restore; a retained recovery journal required the same packaged build and its projected artifacts. The initial local-file credential fixture correctly refused shared secrets, so acceptance used actual native keyrings. Invalid custom native calendar input returned the CLI failure; `Sun *-*-* 11:30:00` installed successfully.

Not exercised in this Linux acceptance: native macOS/Windows behavior and self-update mutations. The latter remain explicitly terminal-only and outside this phase. Native Source service install/remove was exercised only in the disposable guest after the Follower's final unenrollment.

The final page pass captured 28 supported pages at both 1920×1080 and 390×844, plus the deliberately unavailable Source Backups route. Every page reported document width equal to viewport width, no overflowing monospace evidence and no raw JSON status blocks. Files use `<role>-<page-path-with-hyphens>-<width>.png`; `browser-page-evidence.json` records all 58 observations. Earlier captures made while the old test-environment packaging bug replaced assets with the demo were discarded and replaced after the production fix.

### Final verification results

All checks ran in the disposable Paris Raft guest:

| Check | Observed result |
| --- | --- |
| UI typecheck, production build, demo build | Passed; production module-graph guard active |
| Root `npx tsc -p tsconfig.json --noEmit` | Passed |
| `npm run build` | Passed, including the packaged CLI and full website |
| `npm run lint` | Passed |
| `npm run docs:validate` | Passed, 438 command examples across 61 files |
| `npm run skills:validate` | Passed, 3 skill structures |
| `npm run release:validate` | Passed: 438 files, 1,237,667 packed bytes and 4,277,427 unpacked bytes; metadata, naming, secret patterns, clean install and binary checks |
| Packed executable regression suite | 17 passed, including production browser assets under inherited test environment |
| Full `npm test -- --maxWorkers=2` | 1,860 passed, 71 skipped, 1 failed across 79 files: 77 passed, 1 skipped, 1 failed |

The sole final-suite failure is the known root-user permission case in `tests/integration/synchronization-run.test.ts`: root writes the nominally unwritable target, so the outcome is `Converged` rather than `Failed`. No test was skipped or weakened for this result. The initial unrestricted-worker run also timed out the publication metadata-budget case at 60 seconds; it passed alone in 23.75 seconds and in the final complete two-worker run. The final full run took 963.51 seconds.

The old release ceilings rejected the measured package, so they were raised only after measurement, with those bytes recorded beside the new limits. All 100 final screenshots, the signed export, page-width evidence and verification logs are retained under `/tmp/canonfig-ui/final/`. Remaining product follow-ups are the setup cross-process transaction boundary, advisory bundle splitting and GUI self-update lease handoff, not unfinished area cutovers.
