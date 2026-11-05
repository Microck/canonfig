# Canonfig browser UI integration

## Scope and phase 1

`canonfig ui [--port n] [--no-open]` serves the packaged React application in the foreground on `127.0.0.1`. Omitting `--port` asks the operating system for a free port. The launch URL carries a single-use token that establishes a session cookie. The server checks Host and Origin, holds the normal command lease, and releases its resources on Ctrl-C or SIGTERM. Bare `canonfig` still prints help. This server is separate from `source serve` and never becomes a network administration service.

Phase 1 connects only the session and read-only Overview. Other workspace screens, onboarding mutations, and machine-map operations remain demo-only. Production must not report a simulated mutation as successful or populate missing status fields with demo values. An unconfigured machine gets its real role and setup guidance, not a completed setup wizard.

The production entry is `ui/src/live-app.tsx`, selected through Vite's build-selected `@app` entrypoint; `ui/src/gui-client.ts` imports the shared contract directly. Development and demo builds select `App.tsx`. Production supports the current role's Overview path, or `/overview` when unconfigured. Other paths show an unavailable page rather than mounting demo screens. `src/gui/server.ts` uses Node HTTP under a scoped Effect lifetime. Bootstrap exchanges `GET /?token=...` for an HttpOnly, SameSite=Strict, Path=/ cookie, redirects with 303, and requires the cookie for assets and API calls. Host and any supplied Origin must match the actual loopback address and port.

`src/gui/contract.ts` re-exports the area contracts under `src/gui/contract/`, imported directly by both packages. There are no generated copies. Session contracts live in `contract/session.ts`; operation tickets live in `contract/operations.ts`.

| Contract | Route | Source |
| --- | --- | --- |
| `GuiSession` | `GET /api/session` | `GuiQueries.session()` reads local role records through StateRepository, without network probes. Actual `role` (`source`, `follower`, `unconfigured`), `machineName`, CLI `version`, and `folderPath`. |
| `GuiStatus` | `GET /api/status` | Existing `FollowerCommands.status()` payload. Validate `machineRole`, lifecycle entries with `reached` and `detail`, and tunnel JSON while retaining additional status properties. |
| `GuiError` | Error responses | Existing CLI failure taxonomy, represented by `category`, `exitCode`, and `message`. Do not invent GUI failure categories. |

`src/runtime/layers.ts` implements status. A Source without follower configuration reports unreached follower lifecycle stages. That is not proof the Source service is unhealthy. A follower's response can include synchronization state, active recovery, a completion receipt, and convergence evidence. Phase 1 must not infer a fleet inventory, pending folder changes, or remote machine health from these fields.

## Phase 2 ownership

The shared foundation is implemented. The four feature areas below are registered but intentionally empty until their owners connect real operations. Each owner can complete its area without changing shared registration files. Changes to CLI/domain behavior outside the authoring API still require an assigned shared patch before dependent GUI work.

| Owner | Contracts and routes | Live entry and existing screens | Tests |
| --- | --- | --- | --- |
| A: integration | `src/gui/contract.ts`, `src/gui/contract/session.ts`, `src/gui/contract/operations.ts`, `src/gui/routes/session.ts`, `src/gui/server.ts`, `src/gui/routing.ts`, `src/gui/operations.ts`, `src/gui/queries.ts`, runtime/CLI wiring, `src/projection/authoring.ts`, `src/projection/folder.ts` | `ui/src/live-app.tsx`, `ui/src/gui-client.ts`, `ui/src/live/routes.tsx`, `ui/src/live/session.tsx`, `ui/src/main.tsx`, `ui/vite.config.ts`, `ui/src/shared/metadata.ts`, `ui/src/shared/shared.tsx`, `ui/src/workspace/screen-context.tsx`, `workspace.tsx`, `store.tsx`, `frame.tsx`, `routes.ts`, `nav.ts`, `guide.tsx`, `tour-steps.tsx`, `page-tips.ts`, `kit.tsx` under `ui/src/workspace/` | `tests/acceptance/gui.test.ts`, `tests/gui-plumbing.test.ts`, `tests/projection-authoring.test.ts` |
| B: profile, publication, skills, Source Secrets | `src/gui/contract/profile.ts`, `src/gui/routes/profile.ts` | `ui/src/live/profile.tsx`; `ui/src/workspace/profile.tsx`, `ui/src/workspace/source.tsx`, `ui/src/workspace/skills.tsx` | `tests/gui/profile.test.ts` |
| C: machines, invitations, enrollment, setup, map | `src/gui/contract/enrollment.ts`, `src/gui/routes/enrollment.ts` | `ui/src/live/enrollment.tsx`; `ui/src/workspace/machines.tsx`, `ui/src/onboarding/*`, `ui/src/shared/machine-map/*` | `tests/gui/enrollment.test.ts` |
| D: synchronization, recovery, schedule, local items, overlays, harness toggles, backups, secrets, tunnel, unenroll, export | `src/gui/contract/synchronization.ts`, `src/gui/routes/synchronization.ts` | `ui/src/live/synchronization.tsx`; `ui/src/workspace/follower.tsx`, `ui/src/workspace/harnesses.tsx`, `ui/src/workspace/schedule.tsx` | `tests/gui/synchronization.test.ts` |
| E: source service, agent policy/harness, installers, doctor, update status/check | `src/gui/contract/administration.ts`, `src/gui/routes/administration.ts` | `ui/src/live/administration.tsx`; `ui/src/workspace/settings.tsx`, `ui/src/workspace/update-gate.ts` | `tests/gui/administration.test.ts` |

Each area may add sibling implementation modules within a directory named for that area. Existing screen tests follow their screen owner. Shared visual primitives are not copied into area modules. B consumes D's secret/export contracts; E consumes C's setup contracts. Cross-area controls wait for their owning API, rather than implementing a second handler.

The registration lines already landed are:

| Area | `src/gui/contract.ts` | Server route table | Live screen table |
| --- | --- | --- | --- |
| B | `export * from "./contract/profile.ts";` | `profileRoutes,` | `...profileScreens,` |
| C | `export * from "./contract/enrollment.ts";` | `enrollmentRoutes,` | `...enrollmentScreens,` |
| D | `export * from "./contract/synchronization.ts";` | `synchronizationRoutes,` | `...synchronizationScreens,` |
| E | `export * from "./contract/administration.ts";` | `administrationRoutes,` | `...administrationScreens,` |

Owners fill these exports in their own modules. They add **zero** shared registration lines. `tests/gui/**/*.test.ts` is included in Vitest.

### Backend seam and worked Overview example

`WorkspaceBackend` in `ui/src/gui-client.ts` is the injected browser backend. It supplies `session(signal)`, `status(signal)`, `request(path, responseSchema, signal, mutation?)`, and `operation(id, signal)`. The HTTP implementation decodes responses with the shared Effect schemas. Mutations send JSON, the session cookie and `x-canonfig-request: browser`. `GuiRequestError` preserves the CLI message, category and exit code; `ErrorNotice` in `ui/src/live/session.tsx` displays all three.

`LiveScreen` in `ui/src/live/routes.tsx` declares a title, a role-to-path function, and `render({ session, status, backend })`. Returning no path hides the screen for that role. The shell loads actual session/status through the injected backend, then renders only registered screens. Unknown paths never mount a demo screen.

Overview is the worked example: `sessionScreens` registers `overviewPath` and renders the existing `Overview` component with the decoded session/status. `LiveApp({ backend })` defaults to `httpBackend`, so another implementation can provide the same contract without changing the screen. The renderer does not import demo records or simulate a completed operation.

For another area, extract the existing screen's reads and actions into a typed backend prop, pass the area HTTP adapter from its `live/<area>.tsx`, and pass a demo adapter from its demo entry. Keep one screen implementation. Use the area's contract schemas for responses and requests; do not recreate them in the UI. Remove runtime imports of `workspace/store.tsx` and `shared/data.ts` from the live screen's dependency graph. `shared/metadata.ts` holds reusable labels and types without fixtures. Shared components in `workspace/kit.tsx` now read `ScreenContext`, not the simulated store. The live shell provides navigation/loading; an area provider supplies actual groups or publication actions when its screen needs them. Missing operational data is not replaced with seeded groups. The demo provider supplies its own context from its demo store.

Keep the existing exports in an area's `ui/src/workspace/<area>.tsx` as demo wrappers, so `workspace.tsx` does not need edits. Move the one shared screen implementation into an owned sibling module and have both the demo wrapper and live entry inject their adapters there. The live entry must import that shared implementation, not the wrapper that imports the simulated store.

### Typed operations and real journals

An area route export is an Effect that captures its command services once and returns `GuiRoute[]`. Use `queryRoute` for reads and `mutationRoute(method, path, inputSchema, operation, status?)` for explicit operations. The helper rejects invalid JSON, unknown request keys and bodies over 1 MiB before invoking the service. The server requires the session cookie, exact Host/Origin checks, the custom request header and `application/json` for every mutation. Errors use the CLI taxonomy. There is no shell or arbitrary command endpoint.

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

The shipped font bytes fell from 518,156 to 156,000. Manrope is 22,876 bytes; Ioskeley Mono Regular/Medium/SemiBold/Bold are 33,076/33,496/33,356/33,196 bytes. The removed italic was 107,428 bytes. The complete package measured 817,087 bytes packed and 2,876,459 unpacked; the new ceilings are 850,000 and 2,960,000 bytes.

## Screen and action inventory

All endpoints below except `/api/session` and `/api/status` are proposals. `GET` reads, while `POST`, `PUT`, and `DELETE` name explicit operations. “Gap” means the visible operation must be removed from production or added to the shared CLI/domain contract first. Search, filter, tab selection, expanding details, draft edits, Save/Discard confirmation, copy buttons, and navigation stay in the browser unless a row says otherwise.

### Overview, navigation, and presentation

| Screen/action and evidence | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Source/Follower Overview, retry/refresh; `source.tsx`, `follower.tsx` | `status`, `FollowerCommands.status`; phase 1 only renders actual status. | `GET /api/session`, `GET /api/status` | A |
| Demo Overview unpublished queue, latest revision, follower lag, item-by-machine matrix, recent runs, service/agent/harness/backup summaries | Profile catalog, state repository, service status, harness report. Gap: status is not a fleet telemetry API or folder diff API. | `GET /api/profile/changes`, `/api/revisions`, `/api/machines`, `/api/runs` after shared read contracts exist | B/C/D/E by data; A integrates |
| Sidebar, mobile navigation, role-invalid/not-found routes, command palette and keyboard shortcuts; `frame.tsx`, `workspace.tsx`, `routes.ts`, `nav.ts` | Browser routing only. Palette Publish/Add machine/Health check links dispatch the same operation as their screen, not another implementation. | None for navigation | A |
| Tours, chapter picker, next/back/skip/replay, first-visit tips, Get started dismissal, GitHub star prompt; `guide.tsx`, `tour-steps.tsx`, `page-tips.ts`, `kit.tsx` | Browser preferences only. Completion ticks cannot assert a machine operation succeeded. Demo role switch is not a real role change. | None | A |

### Profile and publication

| Screen/action | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| **Live:** Profile Items list/filter/detail, add/edit/remove/save/discard, As written and group selection | Digest-checked `readAuthoringItems`, `writeAuthoringItems` and `editAuthoringConfig`. File items include whole skill trees and `files/`; config items include MCP, hooks, settings, tools, credentials and authored resources. Resource declarations and associated file changes save together. | `GET`/`PUT /api/profile/items`; `PUT /api/profile/config` | B |
| **Live:** Profile Harnesses selection and per-harness Gets/Everything | Comment-preserving edits to `harnesses` and `surfaces`, not local include/exclude. Installed-harness evidence remains D's table. | `GET /api/profile/items`; `PUT /api/profile/config` | B |
| **Live:** Groups create/remove and resource membership. **Hidden:** rewriting existing machine memberships | Authored `groups` through digest-checked config edits. Existing enrollment groups require a new invitation and re-enrollment with `--replace`. | `PUT /api/profile/config`; invitations owned by C | B/C |
| **Live:** Defaults save/discard profile name, default schedule, local allowlist and append-local policy | Digest-checked edits to `profile`, `scheduleDefault` and `local`, preserving unspecified keys. A missing profile requires an explicit ID; existing IDs are read-only in this form. | `PUT /api/profile/config` | B |
| **Live:** Discover tools and inspect findings. **Hidden:** Add selected | `SourceCommands.scan({write:false})`. Selective writes have no exact CLI counterpart. | `POST /api/profile/scan` | B |
| **Live:** Publication reviewer, real folder/resource validation, confirmation and operation polling; revision list/detail/copy fingerprint. **Hidden:** synthetic progress, unpublished sequence prediction and machines-on-revision counts | `folderProfile`, `validateMachineProfile`, publication credential checks, then `SourceCommands.publish`. Publication revalidates before signing. Operation evidence is null until this operation's exact revision commits. | `POST /api/profile/validate`, `/api/publications`; `GET /api/revisions`; `POST /api/revisions/inspect` | B |
| **Live frontend:** Profile Export. Backend and end-to-end verification owned by D | Real verified archive transported as base64 JSON and downloaded as a Blob, with archive digest, manifest digest and signer shown. No browser persistence. | `POST /api/exports` | D; B owns Profile button |
| **Live:** Skill upstream list, track source/ref/subdir, check changes and update | `listSkills`, `trackSkill`, `checkSkills`, `updateSkills` in `src/skills/manager.ts`. Local edits refuse with the CLI conflict category and exit code. Updates recheck before writing and never publish. | `GET /api/skills`; `POST /api/skills/track`, `/check`, `/update` | B |

Area B keeps the existing demo screens unchanged in this phase, as approved during integration. Live screens reuse the list, detail panel and field presentation. Forms cover supported frontmatter, instructions, simple MCP entries, settings keys, groups, defaults and harness surfaces. Unknown fields and full trees use exact editors rather than lossy conversion. Consolidating demo/live screen implementations remains follow-up work.

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
| Standalone map demo controls | **Demo-only:** the demo adapter supplies simulated records to the same map renderer. Its existing controls remain available. | None | C |
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

Live enrollment forms remain separate from the demo forms in this phase, as
authorized during implementation. They reuse the existing controls and list rows.
The map renderer is shared through `map-view.tsx`; `machine-map.tsx` injects demo
fixtures. Consolidating the remaining demo/live form presentation is follow-up
work, not a second implementation of any CLI service.

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
| Enrollment details, copy fingerprints and unenroll | C supplies the safe `GuiEnrollment` read contract and handler. D calls `FollowerCommands.unenroll` exactly: applied files, native schedule and tunnel configuration remain. | `GET`/`DELETE /api/enrollment` | Live; read/copy verification pending C integration |
| Local settings Export | `FollowerCommands.exportArchive`; the server checks the returned archive hash, downloads actual bytes and removes its unique temporary file. No arbitrary output path is accepted. | `POST /api/exports` | Live |

D also owns the Source secrets handlers used by B: `GET /api/secrets` returns
`GuiSecrets`, `PUT /api/secrets` accepts write-only `{ name, value }` and returns
`GuiSecretSummary`, and `DELETE /api/secrets` accepts `{ name }` and returns
`GuiSecretRemoval`. Follower sync returns `GuiSecretSync`. These shapes and
`GuiArchiveDownload` are defined in `src/gui/contract/synchronization.ts`.
Secret values never enter responses, URLs, logs or browser storage; even malformed
secret-request diagnostics omit the submitted input.

The parent approved separate live synchronization screens in
`ui/src/workspace/synchronization/screens.tsx`. The existing simulated screens stay
unchanged for the demo build. Consolidating their presentation behind the backend
seam remains a design follow-up, not a second production data source. No D control
uses simulated state or browser-local persistence.

### Settings and shared secrets

| Screen/action | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Source service status, Install, Remove | **Live.** `source service status/install/remove` through SourceCommands, with Source-role enforcement and native status evidence. Restart is **hidden** because no CLI counterpart exists. | `GET`/`POST`/`DELETE /api/source-service` | E |
| Agent policy mode, built-in/custom harness, model, executable/args, writable paths, evidence limit, Save | **Live.** FollowerCommands get/setAgentPolicy and get/setAgentHarness. Save reports policy success separately if harness save fails. The Source shows the CLI's harness refusal, not a fabricated harness configuration. | `GET`/`PUT /api/agent/policy`, `/api/agent/harness` | E |
| Installers list and Check | **Live.** The same installer binding list, Windows suggestions and bounded check as `installer list/check`. Bind/remove remain terminal operations, not extra GUI buttons. | `GET /api/installers`; `POST /api/installers/:method/check` | E |
| Machine setup journal, Approve plan, Apply | **Live frontend, requires C handlers at integration.** Explicit human approval and the displayed plan digest precede approve/apply. Apply polls its real operation journal. Mark linger done is **hidden** because a checkbox cannot verify readiness. | `GET /api/setup`; `POST /api/setup/approve`, `/apply` | E frontend, C backend |
| Health check Run checks, result detail, fix command copy | **Live.** `doctor --no-input` through FollowerCommands. Failed checks retain the report and CLI category/exit code; copying evidence or a recovery command does not execute it. | `POST /api/doctor` | E |
| Canonfig version status and Check; enable/disable/apply instructions | Status and Check are **live**. Enable, disable and apply are **terminal-only**, with copyable commands and instructions to stop the GUI first. No write endpoint or command-lease exemption. | `GET /api/self-update`; `POST /api/self-update/check` | E |
| Source Secrets list, Set, Replace value, Remove, sharing membership | `secrets list/set/remove`, `listSecrets/storeSecret/removeSecret`, existing failure mapping in `src/secrets/cli.ts`; membership via replacement enrollment. Values remain write-only and absent from logs, URLs, status, and browser persistence. | `GET /api/secrets`; `PUT`/`DELETE /api/secrets/:name` | B frontend, D backend |

Area E uses separate live components for this phase, as approved during implementation. The demo settings and their simulated controls remain unchanged. Live settings reuse `Field`, `SettingRow`, `CommandBox` and `StatusMark`; consolidating the remaining demo/live presentation is follow-up work. The setup page imports C's `GuiSetupStatus` and `GuiSetupJournal` schemas. C's digest-checked approve/apply handlers must be integrated before its successful setup workflow can be verified.

## Decisions for phase 2

1. **Decided:** build one shared authoring API for Profile and follower `local/`, with comment-preserving JSONC edits, existing folder validation, atomic file writes and digest preconditions.
2. **Decided:** read contracts expose only real folder data, enrollment records, stored invitations, run journals and takeover snapshots. No invented telemetry, progress, timestamps or remote schedules.
3. **Decided:** invitation cancellation, selective scan writes, service restart and private-review deletion stay hidden in production until CLI counterparts exist. The demo keeps them. Map appearance customization stays browser-local in localStorage.
4. **Decided:** unenrollment matches the CLI's actual cleanup boundaries. Setup uses plan, explicit human approval and apply through its existing journal. A checkbox cannot certify credentials, host keys, linger or convergence.
5. **Decided:** self-update status/check may become live now. Enable, disable and apply from the GUI remain phase 3, tracked by issue #260, with no command-lease exemption.

## Delivery evidence

`tests/acceptance/gui.test.ts` covers real CLI launch with isolated homes, token exchange and replay refusal, Host/Origin and cookie checks, unconfigured and Source sessions, packaged static HTML, CLI/status parity, and SIGTERM port release. The production Vite build rejects imports of the simulated store or data module. Phase 2 must extend this coverage for its operations and exercise the affected screens in a real browser, including failure/retry and role-invalid routes, without weakening session or lease boundaries.
