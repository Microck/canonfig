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

## CLI/GUI capability matrix additions

| Capability | Source Machine | Follower Machine | Before setup |
| --- | --- | --- | --- |
| Report a Canonfig issue, check or turn off automatic reporting | Sidebar → Issue reporting | Sidebar → Issue reporting | Open glossary → Issue reporting |
| Enable automatic issue reporting | Agent consent prompt or CLI | Agent consent prompt or CLI | Agent consent prompt or CLI |
| Project Profile commands as native commands or Agent Skills | Harnesses → Surfaces → Commands, then Sync | Existing sync plan and apply; the Source selects the surfaces | Source setup can import existing native commands |
| Machine-readable preview and submission (`report-issue`) | CLI | CLI | CLI |
| Launch an MCP server with `canonfig mcp run` | Harness-managed CLI process | Harness-managed CLI process | Harness-managed CLI process |

The launcher hands stdio to an MCP server and forwards signals for the harness.
Its lease ends after the child starts. The existing Version page handles user-initiated updates.

The browser links to the Canonfig issue templates and can revoke consent.
Automatic opt-in stays with the agent or CLI because it authorizes filing
from that environment’s GitHub CLI account. Neither workflow requires setup. See [the CLI reference](https://canonfig.micr.dev/docs/reference/cli#report-a-canonfig-issue).

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

The writer holds the existing cross-process run lock, checks each item's digest, validates the complete candidate with the existing folder loader in memory, and re-reads the authoring snapshot before publication. Invalid candidates and stale preconditions write no authoring files. Local additions or modifications outside `local.allow` are refused; unchanged retained entries and removals remain permitted after the Source narrows its policy. Every changed file publishes through anchored `MachineState.atomicWrite`; create uses no-replace publication. Files are protected at 0600, executable scripts at 0700. Symlinks, special files and traversal are refused. Canonical and local file schemas validate base64 in linear time without recursive regular-expression matching, including large binary skill assets.

Atomicity is per file, not a whole-directory transaction. Whole-skill replacement removes digest-checked obsolete files and empty directories before publishing new files, so a path can change between a file and a directory. A filesystem failure midway through a multi-file skill/resource edit must be reported and reloaded; do not report the whole edit as saved. The run lock serializes Canonfig writers. Digests detect hand edits visible at the final check, not an external editor racing the subsequent filesystem rename.

### Fonts and release size

`ui/scripts/subset-fonts.py` reproduces subsets from the phase-1 Git revision `2039144`, using `fonttools[woff]` 4.62.1. It keeps Latin plus the punctuation/symbols found in UI source, OpenType layout features and license metadata. The unused italic face and its CSS declaration are removed; the four referenced upright weights and both OFL texts remain. Keep the release size measurement and budget in `tools/release/validate-release.ts` aligned with the packaged production UI.

The shipped font bytes fell from 518,156 to 156,000. Manrope is 22,876 bytes; Ioskeley Mono Regular/Medium/SemiBold/Bold are 33,076/33,496/33,356/33,196 bytes. The removed italic was 107,428 bytes. The complete shared-screen production package measured 1,237,671 bytes packed and 4,277,427 unpacked. Release ceilings are 1,290,000 and 4,410,000 bytes, retaining about 4% packed and 3% unpacked headroom.

## Screen and action inventory

The rows below record the integrated state: live, browser-local, demo-only, hidden or terminal-only. `GET` reads, while `POST`, `PUT` and `DELETE` name explicit operations. Search, filter, tab selection, expanding details, draft edits, Save/Discard confirmation, copy buttons and navigation stay in the browser unless a row says otherwise.

### Overview, navigation, and presentation

| Screen/action and evidence | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Source/Follower Overview and Reload | **Live:** `FollowerCommands.status` supplies actual machine evidence. Follower technical details render persisted completion receipt stages, exact applied revision/run, build identity, second-run no-op, MCP qualification and open recovery actions/owner/drift, plus enrollment recovery. Empty sections are hidden. Source technical details retain public fingerprints only. | `GET /api/session`, `GET /api/status` | A |
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
| **Live:** Discover tools, inspect findings and confirm with the counted Add accepted tools action. Selective acceptance remains unavailable because the domain writes the complete accepted set. | `SourceCommands.scan({write:false})`, then `scan({write:true,reviewDigest})` after the explicit all-tools action. Changed findings/configuration require a new scan. Existing declarations stay unchanged; changes remain unpublished. | `POST /api/profile/scan`, `/api/profile/scan/accept` | B |
| **Live:** Publication reviewer, real folder/resource validation, confirmation and operation polling; revision list/detail/copy fingerprint. **Hidden:** synthetic progress, unpublished sequence prediction and machines-on-revision counts | `compileFolder` (the folder read, validation, credential checks and compilation publication uses), then `SourceCommands.publish` with the validation's `reviewDigest`. Publication compiles again and refuses content whose digest differs, so an edit after validation needs a new review; the approval records that digest. Operation evidence is null until this operation's exact revision commits. | `POST /api/profile/validate`, `/api/publications`; `GET /api/revisions`; `POST /api/revisions/inspect` | B |
| **Live:** All stored profile histories, optional profile filter, resource-change counts and recorded reviewer; exact revision-ID lookup, labeled summary and collapsed remaining raw record | StateRepository revisions and persisted revision approvals. Resource changes compare each revision with the preceding stored revision of the same profile, or an empty inventory for its first stored revision. Missing approvals are shown as not recorded. Inspection returns a record or JSON null for an absent ID; actual read failures remain errors. Selection and lookup use IDs, not cross-history sequence numbers. | `GET /api/revisions`; `POST /api/revisions/inspect` with `GuiRevisionInspection` response | B |
| **Live:** Profile Export with optional managed harness files, and archive import with verification/preview, independently supplied expected signer and explicit replacement consent | `exportArchive` and `importArchive` use private temporary files removed after each operation. Harness entries are verified, never restored. Import is permitted on Source/unconfigured machines and refused on enrolled Followers. Import neither publishes nor applies harness files. | `POST /api/exports`, `/api/imports/preview`, `/api/imports`; operation polling | D; B owns Profile controls |
| **Live:** Skill upstream list, track source/ref/subdir, single-skill checks and updates, Profile > Skills > Skill updates for all tracked or selected skills with file review and explicit batch apply | `listSkills`, `trackSkill`, `checkSkills`, `updateSkills` in `src/skills/manager.ts`. Check is the CLI dry-run preview and retains every skill's local-edit verdict. One selected-set update transaction refuses local edits or drift from the reviewed paths, installed/upstream commits and baseline/content digests before staging, and never publishes. Check requests carry `names`, with an empty array selecting all tracked skills. Apply carries a nonempty `expected` array naming only the reviewed skills, never an all-skills selector. Track, check and update return HTTP 202 operation tickets. Lost check/update polling retains the ticket and blocks writes until observation resumes. Their server-owned work survives browser disconnection and finishes before shutdown releases the command lease. | `GET /api/skills`; `POST /api/skills/track`, `/check`, `/update` | B |

Area B uses the same profile, publication, revision, skill and Source Secret screens for both providers. Live field editors preserve supported frontmatter and JSONC values. Tool recipes, unknown fields, hook scripts, `files/` content and full skill trees use exact-text/tree controls inside the same detail panel. Saves check the captured config and item digests. After a conflict, Reload keeps the draft and shows the new disk version beside it. The person must choose **Discard my edits** or **Re-apply my edits** before saving against the new digests. Revision inspection has its own cancellable, revision-keyed request, separate from mutations; a superseded response cannot replace the selected revision. Live publication shows real validation and committed revisions, without predicted sequence numbers or synthetic progress. The demo retains its simulated flows.

Source Secrets is live through D's shared contract: names and origins, set/replace a write-only value, and confirmed removal. The Updated column is omitted when no update times are recorded. Values never enter browser persistence. Sharing membership changes remain replacement invitations, not an invented membership mutation. B adds no duplicate secrets or export handlers.

Canonical authoring also runs projection's `projectResources` boundary check on the full authored resource set before any candidate writes, before machine-local `excludeResources` filtering. Authored targets inside any adapter-owned or never-touch path are refused with the projection diagnostic, without writing the config or its associated files.

### Machines, invitations, and onboarding

| Screen/action | CLI/service mapping | Proposed endpoint | Owner |
| --- | --- | --- | --- |
| Source machine map/list and follower detail | **Live:** safe enrollment inventory includes identity, name, groups, enrollment date, revocation, pending and credential-presence/lifecycle flags. Selected details show enrollment date, credential lifecycle and the public Source fingerprint; revocation, pending enrollment and missing credentials appear only when present. Credential references and values stay private. Health shows each machine's latest doctor report, sent by the follower after `canonfig doctor` or its health check (the Source records its own), with when it ran and each check and MCP server that needs attention. Revision, platform, schedule and recovery claims stay **hidden**, because the Source has no telemetry for them. | `GET /api/machines`; detail selection is browser-local | C |
| Follower map/list, Source detail, this-machine detail | **Live:** local enrollment only, including public Source fingerprints. Sibling followers are never returned. | `GET /api/enrollment` | C |
| Add machine: endpoint, expiry, groups, invitation download, transfer/tunnel/enroll instructions | **Live:** `SourceCommands.invite` delivers the real envelope through a private temporary file, which is removed after reading. Download returns that envelope, not a simulated certificate. Optional label is **hidden**, because invitations do not reserve names. | `POST /api/invitations` | C |
| Pending invitations and Cancel | Stored invitation metadata is **live** through StateRepository. Cancellation is **hidden**, because no CLI cancel operation exists. Neither listing nor errors expose bearer codes, nonce digests or credential references. | `GET /api/machines` includes `invitations` | C |
| Disconnect/revoke follower confirmation | **Live:** explicit confirmation calls `SourceCommands.revoke`. | `POST /api/machines/revoke` | C |
| Change groups and replacement invitation | **Live:** creates a new invitation; the follower explicitly chooses replacement enrollment. Existing remote membership is never silently rewritten. | `POST /api/invitations`; `POST /api/enrollment` with `replace: true` | C |
| Map select/open/add, pan/zoom/fit, drag nodes, reset layout; customize name/purpose/icon, upload icon, preset/custom colour, reset appearance | **Browser-local, except the Source card on a Source:** the shared map view uses localStorage. The Source's own name, purpose, preset icon and colour are also saved to `~/.canonfig/source-look.json` and served to Followers at `GET /v1/source/look`; an uploaded icon stays local. Names and appearance never change hostnames or enrollment identities. Enrollment-only links show no fabricated transfer animation. | None | C |
| Standalone map demo controls | **Hidden in live:** the demo adapter supplies simulated records to the shared renderer. | None | C |
| Setup role, harness picks, import offers/collisions/skips/secret opt-in, review, approve, apply and status | **Live:** calls SetupCommands in-process, preserves the exact import offers and plan digest, and requires explicit approval. Draft changes require re-planning. Unconfigured sessions route to `/setup`. Arbitrary profile-name, service-port and scan controls are **hidden** here because they are not setup inputs; profile naming follows the CLI hostname rule, while service/scan remain separate operations. | `POST /api/setup/plan`, `/approve`, `/apply`; `GET /api/setup` | C |
| Follower invitation file/paste/inspect, SSH host/user/host-key trust, name, exclusions, default schedule, Join/Open | **Live:** validates the actual invitation envelope, starts the real tunnel with a verified host-key file, and calls follower enroll. Post-enrollment exclusions and schedule call D's handlers; schedule errors preserve the CLI requirement to apply a profile first. | `POST /api/enrollment/inspect`, `/api/enrollment/tunnel`, `/api/enrollment`; `PUT /api/harnesses`, `/api/schedule` | C, D preference handlers |
| Unconfigured-machine archive import | **Live:** role-choice entry opens the same verified archive preview/import flow as Source Profile. Import does not create a Source identity or enroll the machine. | `POST /api/imports/preview`, `/api/imports` | C/D |

#### Area C setup contract for settings

`GuiSetupStatus` is the response to `GET /api/setup`. It preserves the CLI's stage,
approval state, current plan digest, item verdicts, evidence, provenance and recorded
choices. `POST /api/setup/plan` accepts `GuiSetupPlanInput` and returns
`GuiSetupJournal`, the existing domain SetupJournal schema. `POST /api/setup/approve`
accepts `{ approver, planDigest }` and returns that same journal. `POST /api/setup/apply`
accepts `{ planDigest }` and returns `GuiOperationTicket` with HTTP 202. Area E uses
these same endpoints and schemas, not a second setup controller.

The first Source onboarding step offers **Skip reading existing tool configuration**
before continuing to the first plan. That choice uses `imports: { kind: "none" }` for every plan in that
visit, including harness changes. It is not the same as reading import offers
and leaving every item unchecked.

Settings > Setup technical details use persisted status, including role, scope,
mode, intent, discovery paths and digests, current-plan approval history with
approver/date/digest, stage rows with completion times and copyable short digests,
item outcomes and provenance. They remain available after a fresh page load.

An enrolled Follower can open replacement onboarding from Settings > Enrollment.
Consent explains that a new identity revokes the previous identity and removes
its credential, resets agent policy to deterministic-only, removes the agent
harness and secret bindings, and resets stored schedule and local-execution
choices. Applied files, native jobs, tunnel configuration and local files are
not removed by enrollment. Same-identity credential rotation keeps those
follower-owned settings.


Approve/apply reject stale digests with `conflict-or-drift` and exit code 4. The
domain controller compares the requested digest while holding a cross-process
setup-journal lock through the mutation. Plan, approve and apply all use that lock,
including CLI invocations. CLI approve/apply do not present an interactive digest
confirmation, so they retain their existing behavior against the current journal;
GUI requests supply the digest shown in the review.
Apply polling reads real setup status only while it matches the captured plan
digest; a later unrelated plan is not presented as the operation's journal.
Enrollment and tunnel tickets have no setup journal. No browser completion
checkbox certifies readiness.

Enrollment now uses the shared machine screens and onboarding wizard in both builds.
The live controller preserves setup digests and human approval, inspects real
invitation files or pasted envelopes, and runs enrollment or tunnel operations.
Only the simulated onboarding adapter imports demo fixtures. Configured Setup
reads the same backend journal. Map appearance stays browser-local; demo purposes
and remote telemetry never become live machine facts.

### Synchronization and local state

| Screen/action | CLI/service mapping | Endpoint | State |
| --- | --- | --- | --- |
| Source, unenrolled local and Follower Sync plan/apply | `FollowerCommands.synchronize` selects local projection without enrollment or remote synchronization when enrolled. Publishing remains separate. A plan returns `planDigest`; Apply requires that digest and compares a fresh plan under the domain apply lock before takeover, publication or execution. Changed content or targets require a new review. Plan and apply are polled operations with exact-run evidence. | `POST /api/sync/plan`; `POST /api/sync/apply` with `{ planDigest }` | Live |
| Source/local and Follower Recover, Abandon, Check again | `FollowerCommands.recover/abandon`; confirmations preserve the CLI's no-rollback semantics. Local open-run evidence is read separately from enrollment status. | `GET /api/local/synchronization`; `POST /api/recovery`, `/api/recovery/abandon`, `/api/sync/plan` | Live |
| Source/local and Follower adoption review creation | `sync --plan --review-local`; returns only review metadata. Open the reported JSON path in a local editor on the machine running Canonfig, inspect `sourceAddition`, `retainedLocal` and `proposedText`, then delete the private review when finished. | `POST /api/sync/reviews` | Live |
| Adoption review exact text and deletion | Files can contain arbitrary secrets from existing instructions. Exact text stays filesystem-only rather than passing through browser responses, diagnostics or persistence. | None | Filesystem-only |
| Schedule cadence, Source default, days/time, saved IANA zone in the field, machine-zone default, native status, Save and confirmed Remove after the form | `FollowerCommands.scheduleStatus/setSchedule/removeSchedule`; host time zone is read on the server, not inferred from the browser. Named zones retain the CLI's Linux-only restriction. Removal deletes the native job and persists disabled automation so later applies do not reinstall it. Next-run and platform facts appear only when supplied by native status. | `GET`/`PUT`/`DELETE /api/schedule` | Live |
| Local instructions, rules, skills, agents, commands: list, add, edit, rename, delete, save, discard | Shared authoring API with `scope: "local"`, Source `local.allow`, digest preconditions, binary-safe skill assets, executable flags and reload on conflicts. Rename is one checked transaction. | `GET`/`PUT /api/local/items`; an empty file list deletes the item | Live |
| Local MCP/settings keys and backups preference | `editAuthoringConfig` updates `local/local.jsonc` with digest checks and preserves comments. Backup disable requires confirmation. | `PUT /api/local/preferences` | Live |
| Source/Follower native MCP preservation, all or selected harnesses | `local mcp preserve` and `project`, with repeatable `--harness <id>`, change routine machine-local policy, so GUI coverage is required. Local settings > Kept on this machine > Native MCP offers an all-harness switch, per-harness checkboxes and the saved count. Digest-checked saves use the shared policy shorthand; sync remains a separate review/apply step. | `GET /api/local/items`; `PUT /api/local/preferences` | Live for Source and Follower |
| Source/Follower collision replacement, overlays and exact key claims in Local settings | `FollowerCommands.overlays`; item and key-claim names stay in JSON bodies. Claims release ownership without editing native values. Confirmed removal permits the next sync to write the published value again. Local declarations are never published. | `GET`/`PUT`/`DELETE /api/local/overlays` | Live for Source and Follower |
| Source/Follower machine-local harness include/exclude | `FollowerCommands.harnesses`; `GuiHarnessReport` exposes actual installed/listed/excluded state. Every harness has an exclusion control, including unlisted harnesses. Including only removes an exclusion; it never lists a harness or applies files. Source Profile selection remains separate publication authoring. | `GET`/`PUT /api/harnesses` | Live for Source and Follower |
| Retained append-local content details | No protected content-read API exists. | None | Hidden |
| Source/local and Follower Backups list, explicit snapshot selection, confirmed restore and outcome | `listSnapshots` includes both takeover and import-replacement snapshots; `FollowerCommands.restore` preserves drift checks and journaled recovery. Harness restore releases/excludes restored surfaces; folder restore first snapshots current entries. | `GET /api/backups`; `POST /api/backups/restore` | Live |
| Follower Secrets list, Set local secret, Replace value, Remove local copy and Update secrets | `listSecrets/storeSecret/removeSecret` manage this machine's credential store. Source-owned values cannot be replaced locally; deleting their cached copy does not revoke the Source value and an update can restore it. `synchronizeSharedSecrets` preserves local entries and refuses name collisions. Names and origins only, never values. | `GET`/`PUT`/`DELETE /api/secrets`; `POST /api/secrets/sync` | Live |
| Tunnel configure/change, status, start, stop and confirmed forget | `FollowerCommands.startTunnel/tunnelStatus/restartTunnel/stopTunnel`; Settings configures transport independently of enrollment using an inspected invitation and explicit host-key trust. Shared advanced fields offer IPv4/IPv6 loopback, ports and 1000..300000 ms start timeout (default 30000). Saved starts use operation tickets and accept the same timeout. Stop keeps restart configuration; confirmed forget deletes it without changing enrollment or applied files. | `POST /api/enrollment/inspect`, `/api/enrollment/tunnel`; `GET /api/tunnel`; `POST /api/tunnel/start`, `/api/tunnel/stop` | Live |
| Enrollment details, copy fingerprints and unenroll | C supplies the safe `GuiEnrollment` read contract and handler. D calls `FollowerCommands.unenroll` exactly: applied files, native schedule and tunnel configuration remain. | `GET`/`DELETE /api/enrollment` | Live; integrated with C |
| Local settings Export, with Include managed harness files | `FollowerCommands.exportArchive`; the server checks the archive hash, downloads actual bytes and removes its unique temporary file. Included harness entries are verified, not restored by import. Enrolled Followers cannot import archives. | `POST /api/exports` | Live |

D owns the secret handlers used by both role screens: `GET /api/secrets` returns
`GuiSecrets`, `PUT /api/secrets` accepts write-only `{ name, value }` and returns
`GuiSecretSummary` for a local-origin entry, and `DELETE /api/secrets` accepts `{ name }` and returns
`GuiSecretRemoval`. Both configured roles can set/remove; Follower sync returns `GuiSecretSync`. These shapes and
`GuiArchiveDownload` are defined in `src/gui/contract/synchronization.ts`.
Secret values never enter responses, URLs, logs or browser storage; even malformed
secret-request diagnostics omit the submitted input.
Follower-local values support local agent secret bindings and are never sent upstream.
Both roles retain the CLI's secure noninteractive credential-storage requirement.
Follower removal requires confirmation that only this machine's copy is deleted,
not the upstream secret or other machines' copies.

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
| Agent policy, built-in/custom harness, model, executable/args, writable paths, evidence limit and authorization bounds | **Live on enrolled Followers.** Harness preparation works with deterministic-only policy. Exact HTTPS origins, leaf executables and symbolic secret bindings are editable through shared CLI/domain validation. Advanced elevation/login/restart/reboot toggles show consequences and require save review. Stored execution models and environment names are summarized without secret values; undisclosed collections stay write-only and are preserved. Increasing execution permission saves the reviewed bounds first; reducing permission saves the policy first. Partial failures report which write committed. | `GET`/`PUT /api/agent/policy`, `/api/agent/harness` | E |
| Installers list and Check | **Live.** The same installer binding list, Windows suggestions and bounded check as `installer list/check`. Bind/remove remain terminal operations, not extra GUI buttons. | `GET /api/installers`; `POST /api/installers/:method/check` | E |
| Machine setup journal, Approve plan, Apply | **Live:** E uses C's integrated handlers. Explicit human approval and the displayed plan digest precede approve/apply. Apply polls its real operation journal. Mark linger done is **hidden** because a checkbox cannot verify readiness. | `GET /api/setup`; `POST /api/setup/approve`, `/apply` | E frontend, C backend |
| Health check Run checks, advanced probe timeout, result detail, fix command copy | **Live.** `doctor --no-input` through FollowerCommands. The timeout defaults to 5000 ms and accepts integers from 1 through 300000 ms, in a collapsed Advanced checks section below the results. Failed checks retain the report and CLI category/exit code; copying evidence or a recovery command does not execute it. The MCP servers check starts every server the installed harnesses declare and lists each one's result in the check's details, so it needs no separate screen. | `POST /api/doctor` with optional `timeoutMilliseconds` | E |
| Version status, Check, Enable, Disable, Apply | **Live.** Uses the CLI updater with an own-lease handoff. Apply polls persisted progress and delivers the final result before clean server shutdown. Other processes still block activation and disable. | `GET /api/self-update`; `POST /api/self-update/check`, `/enable`, `/disable`, `/apply`; `GET /api/operations/:id` | E |
| Source Secrets list, Set, Replace value, Remove, sharing membership | **Live:** `listSecrets/storeSecret/removeSecret` use the CLI failure mapping. Membership changes require replacement enrollment. Values remain write-only and absent from logs, URLs, status and browser persistence. | `GET`/`PUT`/`DELETE /api/secrets` | B frontend, D backend |

Area E now uses the shared workspace settings screens through the administration slice described in Phase 2d. Its separate live administration components have been removed. Setup remains owned by area C.

## Decisions for phase 2

1. **Decided:** build one shared authoring API for Profile and follower `local/`, with comment-preserving JSONC edits, existing folder validation, atomic file writes and digest preconditions.
2. **Decided:** read contracts expose only real folder data, enrollment records, stored invitations, run journals and takeover snapshots. No invented telemetry, progress, timestamps or remote schedules.
3. **Decided:** invitation cancellation, selective scan writes, service restart and private-review deletion stay hidden in production until CLI counterparts exist. Discovery supports confirmed acceptance of all accepted tools through the CLI's existing writer, not selective writes. The demo keeps its selective controls. Map appearance customization stays browser-local in localStorage, except the Source card customized on the Source, which Followers fetch so every map shows the Source the same way.
4. **Decided:** unenrollment matches the CLI's actual cleanup boundaries. Setup uses plan, explicit human approval and apply through its existing journal. A checkbox cannot certify credentials, host keys, linger or convergence.
5. **Decided:** #260 adds enable, disable and apply from the GUI through the existing updater. Only the requesting server's own lease is suspended. Other processes and unfinished transactions retain their existing protections. See the implementation close-out below and ADR 0001 for the API.

### Fresh-machine reads and page loading

Missing setup is a successful read, not a CLI failure presented as HTTP 400:

| Read | Missing state | Configured state |
| --- | --- | --- |
| `GET /api/agent/policy` | `{ configured: false, default: "deterministic-only" }` | `{ configured: true, value: policy }` |
| `GET /api/agent/harness` | `{ configured: false }` | `{ configured: true, value: harness }` |
| `GET /api/local/overlays` | `{ configured: false, overlays: [], pending: localDeclarations }` before the Follower has a canonical mirror | Existing resolved overlay report |

A freshly enrolled Follower already has a stored deterministic-only policy. Its policy read correctly reports the saved mode. Missing harness defaults use codex, the CLI's 1 MiB evidence limit, and empty permission lists. Harness bounds can be prepared while deterministic-only remains selected; saving settings does not run an agent. Agent settings are Follower-only, matching the CLI execution boundary.

The GET audit retained existing successful empty states for schedule, tunnel, Source service, installers, secrets, enrollment inventory, backups, setup, profile items, revisions and skills. Wrong-role requests, malformed records and filesystem/native-service failures remain errors. Policy presence uses the runtime's actual policy path and recognizes only `ENOENT` as absence.

`livePageResources` lists each route's reads. Session and status are shared; Overview reads nothing else. Source-only and Follower-only pages never fetch for the wrong role. Source Secrets and Profile Groups load `/api/machines` for recipients and members, including its loading/error state and page Reload. The session cache deduplicates shared reads, preserves loaded data across navigation, and exposes pending/error state to the existing skeletons. Reload invalidates the current page's resources; mutations invalidate affected cached evidence before it is next used. Local MCP/settings editors reset from the real `local.jsonc` digest after a confirmed reload, not their synthetic display path. Setup apply invalidates status, profile, harness, skill and local evidence on success and failure because either outcome can change disk state. Settings reads and Setup journal reads also survive page revisits. Backend data stays in memory, never localStorage.

### Fresh-machine verification

Playwright ran from `/tmp/pw` against a locally rebuilt package, an init-only Source and a joined, unsynchronized Follower, each with isolated HOME/XDG state. It visited all 30 allowed routes, including profile and machine tabs, waited for no `[aria-busy=true]` before screenshots, revisited every route and checked cold entries. All 95 recorded page checks passed with zero console errors and zero HTTP 4xx/5xx responses. All 30 cached revisits made zero API requests. Saving the untouched Source policy persisted deterministic-only without a harness write. The run stopped its three disposable server processes.

Final screenshots and machine-readable results are under `/tmp/canonfig-ui/lazy/run-R8OL64/`; the pristine `d6f85ae` baseline is `/tmp/canonfig-ui/lazy/run-sbv4xN/report.json`. Baseline navigation recorded 64 HTTP errors and 64 corresponding console errors, confined to policy, harness and local-overlay reads.

Cold-entry API GET counts include one session and one status request. A dash means the role has no such live page; grouped paths have the same count individually.

| Route suffix | Source before → after | Follower before → after |
| --- | --- | --- |
| `overview` | 13 → 2 | 16 → 2 |
| `profile` | 13 → 5 | - |
| `profile/harnesses` | 13 → 5 | - |
| `profile/groups`, `profile/defaults` | 13 → 4 | - |
| `machines`, `machines/list` | 13 → 5 | 16 → 3 |
| `revisions` | 13 → 3 | - |
| `secrets` | 13 → 3 | 16 → 4 |
| `sync`, `schedule` | - | 16 → 3 |
| `local-settings` | - | 16 → 5 |
| `backups` | - | 16 → 4 |
| `settings/service` | 13 → 3 | - |
| `settings/agent` | 13 → 4 | 16 → 4 |
| `settings/installers` | 13 → 3 | 16 → 3 |
| `settings/setup` | 14 → 3 | 17 → 3 |
| `settings/health` | 13 → 2 | 16 → 2 |
| `settings/tunnel` | - | 16 → 3 |
| `settings/enrollment` | - | 16 → 5 |
| `settings/version` | 13 → 3 | 16 → 3 |

The disposable Paris Raft run passed UI typechecking, production and demo builds with the production import guard, root TypeScript checking, root lint, the 20 GUI acceptance/route tests, all 66 UI navigation/resource/authoring tests, and release validation. The mounted resource tests count actual HTTP requests, cover both roles, scoped Reload, cached Setup plan application and exactly one post-apply refresh. API tests distinguish absence from malformed/unreadable records and preserve CLI absence errors and runtime policy-path overrides.

## Remaining follow-ups

Fresh-machine absence handling and route-scoped loading are complete, with the evidence above. They are no longer follow-ups; the remaining boundaries are:

- Setup mutations serialize within the GUI, and journal writes use their IO lock. The plan-digest check and subsequent domain command are not one cross-process transaction. Another CLI process can replace the journal between those steps; a future domain-level operation must own that complete boundary.
- Native schedule installation requires a running systemd user manager on Linux. Acceptance uses task-owned users and managers inside the disposable Raft guest, never the operator's manager.
- Vite reports a vendor chunk above its 500 kB advisory threshold. Production and demo builds succeed; this is a bundle-splitting follow-up, not a missing route.


## Delivery evidence

The earlier area evidence below records focused authoring and administration exercises. The final integrated acceptance record follows the Phase 2d section and supersedes earlier incomplete-check notes.

## Phase 2d: one screen tree, two data sources

`ui/src/workspace/workspace-types.ts` defines the screen-facing `Workspace` interface. It combines `OverviewSlice`, `ProfileSlice`, `MachinesSlice`, `FollowerSlice` and the typed `AdministrationSlice` from `administration-types.ts`. Field names stay unchanged where their meaning holds. Revision, sync progress, machine platform/state, snapshot counts and other evidence that the backend does not report are optional. Live screens omit the corresponding demo telemetry or explain that it is not reported.

`store.tsx` owns only the React context and browser-local UI state. `SimulatedWorkspaceProvider` in `simulated-store.tsx` retains the demo's fixtures and actions. `LiveWorkspaceProvider` in `live-provider.tsx` composes the hooks in `workspace/live/{overview,profile,machines,follower,administration}.ts`. The providers use the same navigation state, `workspace.tsx` screen tree, `frame.tsx`, sidebar groups, icons, route tabs and mobile navigation. The production bundle guard rejects simulated providers, the demo application and `shared/data.ts`.

Each live resource exposes loading and its decoded CLI error. `LiveWorkspaceProvider` selects and loads only the active page's resources, so the existing skeletons and `ErrorNotice` show pending or failed reads without replacing them with fixture data. `live/resource.ts` owns the session cache, abortable reads and real operation-ticket polling. Backend state is never persisted in browser storage. Map appearance, dismissed guidance and unfinished UI drafts remain browser-local.

`capabilities` separates unavailable CLI operations from the demo: invitation cancellation, selective scan writes, service restart and private-review deletion are false in production. Discovery instead offers explicit all-tools acceptance through the real scan writer. `simulatedTelemetry` is false too. Profile, enrollment, follower writes and self-update mutations are live; their hooks supply the shared forms.

Production session/token bootstrap remains in `live-app.tsx`. Its session determines the allowed role and routes; unconfigured machines redirect to `/setup`. The old screen registry is gone. Both builds now render the shared onboarding flow, with a real enrollment controller in production and fixture injection in the demo. Live tours include the navigation introduction and Agent policy, without claiming remote health or the demo's Source name.

### Worked example

Overview reads the actual session and CLI status without treating unreachable follower lifecycle stages as Source failures. Source service, Agent policy, Installers, Health check and Version all use the shared settings screens. Source service exposes real status/install/remove, not restart. Source policy saves do not attempt forbidden harness writes; direct Source harness writes still preserve the CLI refusal. Doctor retains failed reports and their CLI diagnostics. Version exposes status/check and terminal instructions for mutations. `ui/src/live/administration.tsx` and the old live Overview have been removed.

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

Packaged-browser checks used a disposable Source home and named `agent-browser` sessions. They exercised Overview, role-invalid navigation, the mobile navigation sheet, Source service reload, initial Agent policy creation and reload, a real npm installer binding and successful Check, doctor with retained failed-probe evidence, and the real self-update installation refusal. The later fresh-machine read update replaces the original missing-policy error with an explicit unconfigured response and an unsaved CLI-default form. Native service install/remove and self-update mutations were not run on the controller.

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

Not exercised in this Linux acceptance: native macOS/Windows behavior and self-update mutations. The latter were outside this phase; #260's implementation and verification are recorded separately below. Native Source service install/remove was exercised only in the disposable guest after the Follower's final unenrollment.

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

The old release ceilings rejected the measured package, so they were raised only after measurement, with those bytes recorded beside the new limits. All 100 final screenshots, the signed export, page-width evidence and verification logs are retained under `/tmp/canonfig-ui/final/`. Remaining product follow-ups from that acceptance were the setup cross-process transaction boundary, advisory bundle splitting and GUI self-update lease handoff, not unfinished area cutovers.

## Issue #260: GUI self-update implementation

The Version page now uses the existing CLI updater for enable, disable, check and apply. Enable requires an npm CLI path and confirmation that every other process and schedule is idle. A managed lease releases only the current GUI's reader file during mutations and reacquires through normal coordination if the server continues. A second GUI or command still defers apply and prevents disable.

Apply returns an operation ticket and polls persisted `{ phase, candidate }` progress through checking, staging, verifying, activating and complete. Its result preserves the CLI's current, deferred or updated outcome. Deferred is successful with the CLI detail and exit code 0; failures preserve the CLI message, category and exit code. Activation delivers the completed operation response before the server closes and the page asks for `canonfig ui` to be restarted. The exact endpoints and lifecycle are in [ADR 0001](../adr/0001-local-browser-gui.md#self-update-from-the-gui).

The added acceptance coverage uses disposable homes, npm prefixes, local package fixtures and real subprocesses. It covers enable/check/apply, another command's lease, exact CLI failure and disable refusal, package activation and process/port cleanup. A slow request-body case verifies that another request cannot clear the server's update reservation. Coordination tests cover own-lease ownership and interrupted-transaction recovery.

Verification completed in a disposable Paris Raft workspace:

- UI typecheck, production build with its module-graph guard, demo build, root TypeScript compilation and `npm run lint` passed. Root and website lint reported no warnings or errors.
- The GUI acceptance/routes, self-update, command-log and GUI plumbing suites passed 65 tests across nine files, with two platform-specific command-log tests skipped. The self-update suite accounts for 25 tests, and the new real-npm GUI integration accounts for two. A focused rerun passed both GUI update cases after adding exact CLI failure parity.
- Rendered live resource tests and update-gate tests passed all 11 cases. The installed page retained its restart command and made no further requests after client navigation.
- Documentation validation checked 438 command examples across 61 files. Skill validation checked three skill structures.
- Release validation passed metadata, naming, secret-pattern, clean-install and binary checks: 438 packaged files, 1,243,025 packed bytes and 4,292,975 unpacked bytes.

Playwright from `/tmp/pw` then exercised the locally rebuilt package at 1920×1080 and 390×844. Both viewports completed turn-on with idle confirmation, check, a deferred install while a real second GUI held a lease, and installation after that process stopped. Both servers exited with code 0, and both disposable installations reported 6.0.1. No browser page errors occurred. All 12 screenshots waited for no `[aria-busy=true]` and are retained with `results.json` under `/tmp/canonfig-ui/self-update/`, named `<width>-{off,enable,enabled,available,deferred,installed}.png`.

The Raft workspace and all disposable browser processes, homes and npm prefixes were removed. Native macOS/Windows execution and a full future-release package were not exercised: the local candidate is a minimal real npm package with executable version/help checks. No live installation, public registry write, push or issue closure occurred. Vite still reports its advisory large-chunk warning. Issue #260 remains open until merge.
