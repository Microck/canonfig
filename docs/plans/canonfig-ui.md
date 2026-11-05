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
| Profile Items list/filter/detail; add, edit, remove, save/discard; As written preview; group selection | Shared `src/projection/authoring.ts`, existing folder loader and frontmatter codecs. Cover instructions, rules, skills, agents, commands, MCP servers, hooks, settings keys, tool recipes, credential references, and authored file/directory/config resources. | `GET /api/profile/items`; `PUT`/`DELETE /api/profile/items/:id` | B |
| Profile Harnesses select listed harnesses, per-harness Gets categories/Everything | `harnesses` reports selection; authored `harnesses` and `surfaces` use `editAuthoringConfig`, not `harnesses include/exclude`. | `GET /api/harnesses`; `PUT /api/profile/harnesses` | B; D owns shared table |
| Profile Groups create group, inspect resources/members, add machines/change groups | Authored `groups` uses `editAuthoringConfig`. Existing enrollment groups are immutable; issue a new invitation and re-enroll with `--replace`. | `PUT /api/profile/groups/:name`; `POST /api/invitations` | B/C |
| Profile Defaults save/discard profile name, default schedule, local allowlist and append-local policy | `editAuthoringConfig` edits `profile`, `scheduleDefault`, `local.allow` and `local.appendLocal`. | `PUT /api/profile/defaults` | B |
| Discover tools, inspect findings, choose proposed tools, Add selected | `source scan`, `SourceCommands.scan({write})`. Gap: scan `--write` accepts all accepted findings, not arbitrary UI picks. | `POST /api/profile/scan`; selective write requires CLI change | B |
| Publish dialog, reviewer, validation progress, confirm/cancel; revisions list, next unpublished revision, revision detail and copy fingerprint | `source publish --reviewer`, `profile list`, `profile inspect`; `SourceCommands.publish/listProfiles/inspectProfile`. No fake percentage or “machines on revision” without evidence. | `POST /api/publications`; `GET /api/revisions`, `/api/revisions/:id` | B |
| Profile Export and Local settings Export | `export`, `FollowerCommands.exportArchive`, `src/projection/archive.ts`; stream a real verified archive, not the demo download. | `POST /api/exports` | D; B owns Profile button |
| Skill Upstream summary, track source/ref/subdir, check file changes, update to commit | `skills list/track/check/update --apply`; `src/skills/manager.ts` `listSkills`, `trackSkill`, check/update functions. Preserve local-edit refusal and recheck at write. | `GET /api/skills`; `POST /api/skills/:name/track`, `/check`, `/update` | B |

### Machines, invitations, and onboarding

| Screen/action | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Source machine map/list, follower detail, state/revision/schedule/group information, What to do and copy recovery command | Enrollment and state repository data; `status` is local and does not prove remote tunnel/health/schedule state. Gap: authoritative machine summary contract. | `GET /api/machines`, `/api/machines/:id` | C |
| Follower map/list, Source detail, this-machine detail | Local enrollment/status only; do not expose sibling followers. | `GET /api/enrollment` | C |
| Add machine: endpoint, optional label, expiry, groups, invitation download, transfer/tunnel/enroll instructions | `source invite --endpoint --output --expires --group`; `SourceCommands.invite`. Optional demo label is not an enrollment name reservation. | `POST /api/invitations` | C |
| Pending invitations and Cancel | No list/cancel method in `SourceCommandsService`; gap, not follower revoke. | No endpoint until CLI/domain support exists | C |
| Disconnect/revoke follower confirmation | `source revoke`, `SourceCommands.revoke`. | `POST /api/machines/:id/revoke` | C |
| Change groups, share secrets with more machines, download replacement invite | New `source invite`, then `follower enroll --replace` on that follower. Never silently rewrite remote membership. | `POST /api/invitations`; local `POST /api/enrollment` with explicit replacement | C |
| Map select/open/add, pan/zoom/fit, drag nodes, reset layout; Customize name/purpose/icon, upload icon, preset/custom colour, reset appearance | `machine-map.tsx`, `machine-node.tsx`, `model.ts`, `customize-sheet.tsx`: browser-local presentation in localStorage, as decided below. | None; never rename OS hostname or follower identity | C |
| Standalone map demo role/publishing/syncing/customize controls; `demo.tsx`, `demo-entry.tsx`, `sync-edge.tsx` | Demo fixtures and rendering only. No real transfer inference from animated edges. | None | C |
| Setup role choice, Back/Continue/change answer; Source profile name, installed harness picks, import offers/collisions/skips/secret opt-in, service/manual port, scan choice, Create/Open | `setup plan/approve/apply/status`, `SetupCommands`; `src/setup/setup.folder.ts` and `src/projection/import.ts`; source service and scan commands are separate. Gap: arbitrary name/service/scan controls must match actual setup inputs or explicit subsequent commands. | `POST /api/setup/plan`, `/approve`, `/apply`; `GET /api/setup`; service and scan endpoints separately | C |
| Follower invitation file/paste/read/use another, SSH host/user/key and trust confirmation, name, exclusions, default schedule, Join/Open | `src/runtime/enrollment-input.ts` real decoder; `tunnel start`, `follower enroll`, `harnesses exclude`, `schedule set --default`. No prefix-only invitation validation or fake certificate/download success. | `POST /api/enrollment/inspect`, `/api/tunnel/start`, `/api/enrollment`; harness/schedule endpoints | C |

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
| Source service status, Install, Remove, Restart | `source service status/install/remove`; SourceCommands service methods. Gap: no restart command; do not hide remove/install behind Restart. | `GET`/`POST`/`DELETE /api/source-service`; no restart endpoint yet | E |
| Agent policy mode, built-in/custom harness, model, executable/args, writable paths, evidence limit, Save | `agent policy`, `agent harness`; FollowerCommands get/setAgentPolicy and get/setAgentHarness. Save spans two existing operations, so report partial failure rather than claim atomicity. | `GET`/`PUT /api/agent/policy`, `/api/agent/harness` | E |
| Installers list and Check | `installer list/check`; functions in `src/synchronization/installer-bindings.ts`, invoked by `src/runtime/installer-cli.ts`. Bind/remove exist in CLI but are not extra GUI buttons in this inventory. | `GET /api/installers`; `POST /api/installers/:method/check` | E |
| Machine setup journal, Approve plan, Apply, mark linger done | `setup status/approve/apply`, SetupCommands. Gap: marking a human step done is not verified readiness; show a fresh doctor report instead. | `GET /api/setup`; `POST /api/setup/approve`, `/apply`; `POST /api/doctor` | E frontend, C backend |
| Health check Run checks, result detail, fix command copy | `doctor --no-input`, `FollowerCommands.doctor`, `src/runtime/doctor.ts`. Copying a command does not run it. | `POST /api/doctor` | E |
| Canonfig version status, Check, Turn on updates (npm path and idle confirmation), Turn off, copy apply command | `self-update status/check/enable/disable/apply`; `src/runtime/self-update/cli.ts` and `core.ts`. Gap: GUI's own lease prevents idle operations, including disable. Keep enable/disable/apply terminal instructions until lease design is resolved; no lease exemption. | `GET /api/self-update`; `POST /api/self-update/check`; no write endpoint | E |
| Source Secrets list, Set, Replace value, Remove, sharing membership | `secrets list/set/remove`, `listSecrets/storeSecret/removeSecret`, existing failure mapping in `src/secrets/cli.ts`; membership via replacement enrollment. Values remain write-only and absent from logs, URLs, status, and browser persistence. | `GET /api/secrets`; `PUT`/`DELETE /api/secrets/:name` | B frontend, D backend |

## Decisions for phase 2

1. **Decided:** build one shared authoring API for Profile and follower `local/`, with comment-preserving JSONC edits, existing folder validation, atomic file writes and digest preconditions.
2. **Decided:** read contracts expose only real folder data, enrollment records, stored invitations, run journals and takeover snapshots. No invented telemetry, progress, timestamps or remote schedules.
3. **Decided:** invitation cancellation, selective scan writes, service restart and private-review deletion stay hidden in production until CLI counterparts exist. The demo keeps them. Map appearance customization stays browser-local in localStorage.
4. **Decided:** unenrollment matches the CLI's actual cleanup boundaries. Setup uses plan, explicit human approval and apply through its existing journal. A checkbox cannot certify credentials, host keys, linger or convergence.
5. **Decided:** self-update status/check may become live now. Enable, disable and apply from the GUI remain phase 3, tracked by issue #260, with no command-lease exemption.

## Delivery evidence

`tests/acceptance/gui.test.ts` covers real CLI launch with isolated homes, token exchange and replay refusal, Host/Origin and cookie checks, unconfigured and Source sessions, packaged static HTML, CLI/status parity, and SIGTERM port release. The production Vite build rejects imports of the simulated store or data module. Phase 2 must extend this coverage for its operations and exercise the affected screens in a real browser, including failure/retry and role-invalid routes, without weakening session or lease boundaries.
