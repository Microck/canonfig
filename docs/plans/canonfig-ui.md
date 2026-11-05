# Canonfig browser UI integration

## Scope and phase 1

`canonfig ui [--port n] [--no-open]` serves the packaged React application in the foreground on `127.0.0.1`. Omitting `--port` asks the operating system for a free port. The launch URL carries a single-use token that establishes a session cookie. The server checks Host and Origin, holds the normal command lease, and releases its resources on Ctrl-C or SIGTERM. Bare `canonfig` still prints help. This server is separate from `source serve` and never becomes a network administration service.

Phase 1 connects only the session and read-only Overview. Other workspace screens, onboarding mutations, and machine-map operations remain demo-only. Production must not report a simulated mutation as successful or populate missing status fields with demo values. An unconfigured machine gets its real role and setup guidance, not a completed setup wizard.

The production entry is `ui/src/live-app.tsx`, selected through Vite's build-selected `@app` entrypoint; `ui/src/gui-client.ts` imports the shared contract directly. Development and demo builds select `App.tsx`. Production supports the current role's Overview path, or `/overview` when unconfigured. Other paths show an unavailable page rather than mounting demo screens. `src/gui/server.ts` uses Node HTTP under a scoped Effect lifetime. Bootstrap exchanges `GET /?token=...` for an HttpOnly, SameSite=Strict, Path=/ cookie, redirects with 303, and requires the cookie for assets and API calls. Host and any supplied Origin must match the actual loopback address and port.

The single contract is `src/gui/contract.ts`, imported directly by both packages. There are no generated copies. Its Effect Schemas and same-named TypeScript types are:

| Contract | Route | Source |
| --- | --- | --- |
| `GuiSession` | `GET /api/session` | `GuiQueries.session()` reads local role records through StateRepository, without network probes. Actual `role` (`source`, `follower`, `unconfigured`), `machineName`, CLI `version`, and `folderPath`. |
| `GuiStatus` | `GET /api/status` | Existing `FollowerCommands.status()` payload. Validate `machineRole`, lifecycle entries with `reached` and `detail`, and tunnel JSON while retaining additional status properties. |
| `GuiError` | Error responses | Existing CLI failure taxonomy, represented by `category`, `exitCode`, and `message`. Do not invent GUI failure categories. |

`src/runtime/layers.ts` implements status. A Source without follower configuration reports unreached follower lifecycle stages. That is not proof the Source service is unhealthy. A follower's response can include synchronization state, active recovery, a completion receipt, and convergence evidence. Phase 1 must not infer a fleet inventory, pending folder changes, or remote machine health from these fields.

## Phase 2 ownership

These are proposed work areas, not implemented endpoints. Each owner changes only its listed files. Before parallel work, the integration owner lands agreed contract additions; feature owners consume them without editing the shared contract or another owner's files. New backend modules below are proposed names. Changes to existing CLI/domain services require a separate, explicitly assigned patch before the dependent UI work.

| Owner | Isolated files | Contract additions to agree first |
| --- | --- | --- |
| A: session and integration | `src/gui/contract.ts`, `src/gui/server.ts`, runtime/CLI wiring, `ui/src/live-app.tsx`, `ui/src/gui-client.ts`, `ui/src/main.tsx`, `ui/vite.config.ts`, `ui/src/workspace/workspace.tsx`, `store.tsx`, `frame.tsx`, `routes.ts`, `nav.ts`, `guide.tsx`, `tour-steps.tsx`, `page-tips.ts`, `kit.tsx` | Operation results, role capabilities, stable error encoding; no generic shell-command endpoint. |
| B: authored profile and publication | `ui/src/workspace/profile.tsx`, `source.tsx`, `skills.tsx`; proposed `src/gui/profile.ts` | Folder items and version/digest preconditions, profile defaults/groups/surfaces, scan proposal, publication result, revisions, upstream skill check. Source Secrets in `source.tsx` belongs here too, using D's backend secret handlers. |
| C: machines and enrollment | `ui/src/workspace/machines.tsx`, `ui/src/onboarding/*`, `ui/src/shared/machine-map/*`; proposed `src/gui/enrollment.ts` | Invitation, enrollment, source/follower identity, setup plan/approval/status, permitted machine summaries. |
| D: local projection and synchronization | `ui/src/workspace/follower.tsx`, `harnesses.tsx`, `schedule.tsx`; proposed `src/gui/synchronization.ts`, `src/gui/secrets.ts` | Sync plan/outcome/recovery, local items/overlays, harness report, snapshots, archive download, native schedule, tunnel status, secret metadata. |
| E: machine administration | `ui/src/workspace/settings.tsx`, `update-gate.ts`; proposed `src/gui/administration.ts` | Source service status, agent policy/harness settings, installer bindings/checks, doctor report, self-update status/check. Setup settings use C's backend setup handlers. |

A owns integration callsites and shared tests; each feature owner owns tests beside its proposed backend module and its screen tests. A runs the combined verification after all changes land. No worker edits the other owner's large screen file just to reuse a handler. B and D coordinate secret request/response shapes; C and E coordinate setup shapes. Ownership includes all files in the three inventoried UI directories; existing test files follow the production file they test.

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
| Profile Items list/filter/detail; add, edit, remove, save/discard; As written preview; group selection | `canonfig.jsonc` and Canonical Folder files, `src/projection/folder.ts` and frontmatter codecs. Gap: no general CLI item CRUD service. Cover instructions, rules, skills, agents, commands, MCP servers, hooks, settings keys, tool recipes, credential references, and authored file/directory/config resources. | `GET /api/profile/items`; `PUT`/`DELETE /api/profile/items/:id` only after shared authoring API | B |
| Profile Harnesses select listed harnesses, per-harness Gets categories/Everything | `harnesses` reports selection; authored `harnesses` and `surfaces` are file edits, not `harnesses include/exclude`. Gap: shared authoring API. | `GET /api/harnesses`; `PUT /api/profile/harnesses` | B; D owns shared table |
| Profile Groups create group, inspect resources/members, add machines/change groups | Authored `groups` needs shared file editing. Existing enrollment groups are immutable; issue a new invitation and re-enroll with `--replace`. | `PUT /api/profile/groups/:name`; `POST /api/invitations` | B/C |
| Profile Defaults save/discard profile name, default schedule, local allowlist and append-local policy | Authored `profile`, `scheduleDefault`, `local.allow`, `local.appendLocal`; no general edit command. | `PUT /api/profile/defaults` | B |
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
| Map select/open/add, pan/zoom/fit, drag nodes, reset layout; Customize name/purpose/icon, upload icon, preset/custom colour, reset appearance | `machine-map.tsx`, `machine-node.tsx`, `model.ts`, `customize-sheet.tsx`: browser-local presentation only, no CLI equivalent. Gap if CLI parity requires these persisted preferences; remove from production or explicitly accept browser-only presentation. | None; never rename OS hostname or follower identity | C |
| Standalone map demo role/publishing/syncing/customize controls; `demo.tsx`, `demo-entry.tsx`, `sync-edge.tsx` | Demo fixtures and rendering only. No real transfer inference from animated edges. | None | C |
| Setup role choice, Back/Continue/change answer; Source profile name, installed harness picks, import offers/collisions/skips/secret opt-in, service/manual port, scan choice, Create/Open | `setup plan/approve/apply/status`, `SetupCommands`; `src/setup/setup.folder.ts` and `src/projection/import.ts`; source service and scan commands are separate. Gap: arbitrary name/service/scan controls must match actual setup inputs or explicit subsequent commands. | `POST /api/setup/plan`, `/approve`, `/apply`; `GET /api/setup`; service and scan endpoints separately | C |
| Follower invitation file/paste/read/use another, SSH host/user/key and trust confirmation, name, exclusions, default schedule, Join/Open | `src/runtime/enrollment-input.ts` real decoder; `tunnel start`, `follower enroll`, `harnesses exclude`, `schedule set --default`. No prefix-only invitation validation or fake certificate/download success. | `POST /api/enrollment/inspect`, `/api/tunnel/start`, `/api/enrollment`; harness/schedule endpoints | C |

### Synchronization and local state

| Screen/action | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Sync Check for updates, plan list/details, Apply changes, held/drift explanation, collision links | `sync --plan/--apply`, `FollowerCommands.synchronize`; real plan/outcome from `src/projection/sync.ts`. Drift panel explains manual resolution, not a force overwrite. | `POST /api/sync/plan`, `/api/sync/apply` | D |
| Interrupted run Recover/Abandon confirmations; Human Action Required Check again | `recover`, `abandon`, corresponding FollowerCommands methods; rerun actual diagnostics/planning for Check again, never clear a boolean as evidence. | `POST /api/recovery`, `/api/recovery/abandon`, `/api/sync/plan` | D |
| Adoption review exact additions/retained text/whole-file preview, Show exact text, Delete review | `sync --plan --review-local` writes private reviews. Gap: no read/delete review command; do not expose private contents in ordinary status/logs. | `POST /api/sync/reviews`; read/delete only after private review API exists | D |
| Schedule cadence/default/days/time, preview next check, Save | `schedule set`, `schedule set --default`, `schedule status`; FollowerCommands schedule methods. Native status must supply platform facts; demo launchd label/wake guarantee is not portable. | `GET`/`PUT /api/schedule` | D |
| Local settings list/details, add/edit/rename/delete/save/discard local instructions/rules/skills/agents/commands/MCP/settings | `local/` authoring and `src/projection/folder.ts`; gap: no local item CRUD command. | `GET /api/local/items`; `PUT`/`DELETE /api/local/items/:id` after shared authoring API | D |
| Local collision replace-published choice; overlays add/remove; key claims harness/key add/remove | `overlay list/set/remove`, `FollowerCommands.overlays`; retain exact key-path and collision semantics. | `GET`/`PUT`/`DELETE /api/local/overlays/:item` | D |
| Local managed harness toggles; backup preference; retained append-local content details | `harnesses include/exclude`, `FollowerCommands.harnesses`; backup preference edits `local/local.jsonc`; retained content is a protected read gap. | `GET /api/harnesses`; `PUT /api/harnesses/:id`; proposed `/api/local/preferences` and `/api/local/retained` after shared APIs | D |
| Backups list, Restore confirmation, restore/exclusion outcome | `restore [snapshot]`, `FollowerCommands.restore`, `src/projection/takeover.ts`. Gap: listing and successful-restore evidence must not be inferred from harness exclusions. | `GET /api/backups`; `POST /api/backups/:id/restore` | D |
| Follower Secrets metadata and Update secrets | `secrets list/sync`, `src/secrets/secret-store.ts`, `secret-client.ts`. | `GET /api/secrets`; `POST /api/secrets/sync` | D |
| Tunnel status/start/stop | `tunnel status/start/stop`, `FollowerCommands.tunnelStatus/restartTunnel/stopTunnel`; recorded configuration supports restart. | `GET /api/tunnel`; `POST /api/tunnel/start`, `/stop` | D |
| Enrollment details/copy fingerprints; Stop syncing from Overview/sidebar/Enrollment | `follower unenroll`, `FollowerCommands.unenroll`. Gap: demo also removes schedule/stops work; CLI leaves schedule/tunnel configuration for explicit `schedule remove` and `tunnel stop --forget`. | `GET /api/enrollment`; `DELETE /api/enrollment` without invented cleanup | D |

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

## Decisions required before phase 2

1. Add shared CLI/domain authoring operations or remove GUI item/group/default/local-file editing. Reuse the Canonical Folder schema and comment-preserving edits, with conflict detection against concurrent hand edits. The browser's demo validators are not authoritative.
2. Add authoritative read contracts for folder changes, machines, invitations, runs, backups, and retained content. Do not manufacture fleet health, progress, timestamps, receipt details, or remote schedules from local status.
3. Remove invitation cancellation, selective scan writes, service restart, and private-review deletion until their CLI counterparts exist. Keep appearance customization explicitly browser-local or remove it for strict CLI parity.
4. Match unenrollment to its actual cleanup boundaries. Match wizard inputs to journaled setup and preserve explicit human approval. A checked box cannot certify credentials, host keys, linger, or convergence.
5. Keep self-update mutations outside the running GUI until normal lease coordination supports them. The same restriction applies to enable/disable, not only patch activation.

## Delivery evidence

`tests/acceptance/gui.test.ts` covers real CLI launch with isolated homes, token exchange and replay refusal, Host/Origin and cookie checks, unconfigured and Source sessions, packaged static HTML, CLI/status parity, and SIGTERM port release. The production Vite build rejects imports of the simulated store or data module. Phase 2 must extend this coverage for its operations and exercise the affected screens in a real browser, including failure/retry and role-invalid routes, without weakening session or lease boundaries.
