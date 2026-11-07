# Local browser GUI served by `canonfig ui`

Status: live backend and shared-screen cutover implemented. Production and demo use one screen tree.

## Frontend paths

`ui/` is the permanent frontend package. Both data sources use the screens in `ui/src/workspace/` and components in `ui/src/shared/`. The screen-facing interface is `workspace/workspace-types.ts`; `store.tsx` owns the context. `LiveWorkspaceProvider` composes per-area hooks, while `SimulatedWorkspaceProvider` owns demo fixtures and actions. Production enters through `ui/src/live-app.tsx`; `ui/src/gui-client.ts` owns HTTP requests and schema decoding. Vite's build-selected `@app` entrypoint and bundle guard keep simulated modules out of production.

Demo browser paths identify the role and screen: `/source/profile`, `/source/machines`, `/follower/sync`, and `/follower/local-settings`. Settings live below each role's `/settings/` path. Profile Groups and Defaults have their own paths under `/source/profile/`; the machine list is `/source/machines/list` or `/follower/machines/list`. Demo first-run setup is `/setup`.

The URL owns navigation state. In the demo, `/` opens `/source/overview`. In production it opens the actual machine's Overview, `/source/overview` or `/follower/overview`, and unconfigured machines open `/setup`. Both providers use the shared sidebar groups and route definitions; the live session gates the actual role and supported routes. Unsupported or wrong-role paths show an unavailable page linking to that role's starting page. There are no aliases for the retired role/variant query routing.

## Serving architecture


`canonfig ui [--port n] [--no-open]` starts a foreground Node HTTP server in `src/gui/server.ts`, with an Effect-scoped lifetime inside the CLI process. It binds only to `127.0.0.1`, on an operating-system-selected free port by default. The CLI prints a launch URL and opens it unless `--no-open` is set. Bare `canonfig` keeps printing help.

The initial `GET /?token=<single-use-token>` validates Host and Origin before exchanging the token for an `HttpOnly; SameSite=Strict; Path=/` session cookie and redirecting with HTTP 303 to `/`. Assets and API requests require that cookie. The accepted origin is exactly `http://127.0.0.1:<port>`; GET navigation may omit Origin, but an incorrect Origin is rejected. The token cannot establish another session after use. The server holds the normal command lease. Ctrl-C and POSIX SIGTERM close the server and release its scope. On Windows, Ctrl-Break follows the Ctrl-C shutdown path, and console close follows the termination path, subject to Windows' roughly ten-second forced-exit deadline. Programmatic Windows kills cannot run finalizers; the next command or updater reclaims a reader lease only after the OS confirms its PID no longer exists.

Each server instance uses its own random cookie name because browser cookies are shared across ports on the same host. Opening another GUI does not replace the first server's session.

Agent harness responses use the CLI credential sanitizer. Argument and environment collections containing literal credentials are write-only: reads and save responses omit the entire collection, not editable redaction markers. Omitted collections preserve their stored values on save; an explicit replacement array replaces them. The browser leaves an undisclosed argument list unchanged until replacement arguments are entered.

The backend calls existing Effect services in-process rather than spawning the CLI. `GuiQueries.session()` reads the local role records through the same StateRepository layer as the CLI, without probing a remote Source. `FollowerCommands.status()` supplies Overview, including Source and unconfigured roles. Area routes expose profile authoring/publication, enrollment/setup, synchronization/local state and administration through their existing command services. `GET /api/operations/:id` polls session-local operation tickets and their domain journals. Results contain no fabricated progress or success. Status is not fleet telemetry: unreached follower lifecycle stages on a Source must not be presented as a failed Source service.

`FollowerCommands.synchronize` owns the complete apply sequence, including shared-secret refresh and its CLI failure category. CLI output and GUI tickets report success only after both stages finish. If files converge but secret refresh fails, the operation fails and retains the file run's journal as evidence.

Skill track, check and update return operation tickets too. Their Git and filesystem promises are not cancellable, so server shutdown waits for them and their cleanup. A disconnected browser cannot make the server idle while they run, and self-update refuses its lease handoff until they settle.

`src/gui/contract.ts` re-exports Effect Schemas and same-named types from per-area modules in `src/gui/contract/`. The frontend imports these contracts directly; no generated or copied contract is maintained in `ui/`. Session carries role, machine name, version, and folder path. Status validates its machine role, lifecycle and tunnel fields while retaining the CLI's additional status properties. Errors reuse the CLI's `category`, `exitCode`, and `message`. Area route factories live in `src/gui/routes/`; mutations require the session cookie, a custom request header and JSON decoded by Effect Schema.

The API supports Source authoring/publication, enrollment, synchronization, local settings and administration through the shared workspace screens. Setup uses the shared onboarding flow with real import offers and explicit plan-digest approval. Missing CLI operations remain hidden. Map appearance is browser-local; it never changes an enrollment record. A follower's stored Source identity contains no machine name, so the map labels it "Source" and shows its endpoint separately. Named evidence replaces raw status JSON in the interface. Verification and platform limits are recorded in [the integration plan](../plans/canonfig-ui.md#phase-2d-one-screen-tree-two-data-sources).

The Canonical Folder defined by ADR 0003 is the authoring source of truth. `src/projection/authoring.ts` provides shared file and skill-tree editing for canonical and local folders, with comment-preserving JSONC key edits, digest preconditions and full candidate validation before atomic file publication through MachineState. The GUI does not maintain a second profile store. The typed slice interface, injected `WorkspaceBackend`, capabilities and completed area ownership are documented in the integration plan.

### Browser workflow ownership

Operation tickets are a schema union: running carries a journal, succeeded requires a result, and failed requires a CLI diagnostic. The server owns terminal transitions and invokes a successful result's delivery callback once, after the response finishes.

The live Follower keeps command submission, ticket observation, lost observation and terminal results in one command lifecycle. A failed poll retains the ticket and blocks further mutations until observation resumes. Only a successful plan enables Apply; a completed restore, review or recovery does not. Local configuration changes invalidate that readiness.

Profile editors own their baseline, draft mode and submitted revision. A save refresh accepts only the submitted generation as clean, preserving any newer edits against the refreshed digests. Local-item and secret forms freeze their submitted drafts until the write settles. Local file reads belong to file identities and upload generations, so removing a file, changing its mode or choosing a newer upload cannot accept an older read.

Publication review belongs to the observed folder snapshot and is invalidated by a write or changed observation. Discovery distinguishes scanning, results and failure, with an explicit retry. Agent policy save records policy commitment separately from harness commitment, retaining the partial-success state if the second write fails. Built-in harness drafts carry a model; custom drafts carry arguments.

Invitation dialogs retain immutable submitted values, including the selected follower, after creation even if inventory refresh removes that follower. Revocation cannot be dismissed while its server request is running; reopening a failed confirmation starts without the earlier error.

The frontend is a static React 19 single-page app built with Vite and shipped in `dist/ui` in the npm package. The public demo remains a separate build with simulated operations. Package validation must measure the combined CLI and production UI rather than excluding the browser assets.

Build commands force Vite's production environment before it selects the entrypoint. This also applies when `npm pack` inherits `NODE_ENV=test` from the packaged-executable suite. Only an explicit demo build selects simulated screens; the packaged-assets regression checks the live session client and absence of the demo skill repository.

### Self-update from the GUI

The live Version page in Settings supports status, checks, enable, disable and apply through the same updater as the CLI. First enable requires the absolute npm CLI path and explicit confirmation that every other Canonfig process and schedule has stopped. Unsupported installations and updater failures preserve the CLI's `human-action-required` category, exit code 3 and exact message.

The GUI holds a managed command lease. A self-update mutation suspends only that server's own lease, never another process's reader file. Other GUI requests cannot start domain work during the handoff. Enable registers the server's lease after opt-in; disable removes coordination settings only while other commands are idle. Check leaves the lease intact. A second GUI, Source, watcher or other command still blocks activation and disable. Deferred activation is a successful result with the CLI detail and exit code 0, not an update failure.

The authenticated JSON endpoints are:

| Endpoint | Body | Response |
| --- | --- | --- |
| `GET /api/self-update` | None | `GuiSelfUpdateStatus` |
| `POST /api/self-update/check` | `{}` | `GuiSelfUpdateCheck` |
| `POST /api/self-update/enable` | `{ "npmCli": "/absolute/path/to/npm-cli.js", "confirmIdle": true }` | `GuiSelfUpdateStatus` |
| `POST /api/self-update/disable` | `{}` | `GuiSelfUpdateStatus` |
| `POST /api/self-update/apply` | `{}` | HTTP 202 with `GuiOperationTicket` |

Apply uses the existing `GET /api/operations/:id` polling contract. Its journal is `GuiSelfUpdateProgress`, `{ phase, candidate }`, read from persisted updater progress. `phase` is `checking`, `staging`, `verifying`, `activating` or `complete`; `candidate` is a version string or `null` before selection. The successful result is `GuiSelfUpdateCheck` with status `updated`, `current` or `deferred`. Progress reports actual updater work, not a timer.

After activation, the server waits for the final successful operation response to finish before closing its HTTP server, releasing its scope and exiting cleanly. The page retains the update result and tells the person to run `canonfig ui` again for a new authenticated session. It does not restart services or continue using the old process against the new package. A current or deferred result keeps the server running and reacquires its ordinary lease. Pre-activation failures also re-enter normal coordination rather than bypassing a pending transaction or another updater's gate. Once the candidate rename succeeds, receipt or progress failures return `updated` with a bookkeeping warning and retain restart-required semantics, never normal command admission.

## Considered options

- **Bare `canonfig` opens the GUI**: rejected; it breaks every caller that runs `canonfig` for help and fails on machines without a browser.
- **Reuse the `source serve` HTTPS server**: rejected; it exists only on a Source Machine, sits behind the transport version handshake, and serves Follower Machines, not people.
- **Spawn the CLI with `--json` per action**: rejected; it re-parses argv, loses typed errors, and pays process start-up per click.
- **GUI-owned profile store or whole-file rewrite**: rejected; both drift from the file the CLI publishes or destroy the author's comments.
- **Next.js**: rejected; a local tool has no server rendering, routing, or deployment needs that justify it. dithercn requires React 19, Tailwind v4, and shadcn, which rules out non-React stacks.
- **Network-reachable or background-service GUI**: rejected; any page or host that can reach the port could publish revisions or apply syncs. Loopback plus a session token blocks cross-site requests and DNS rebinding at no cost to the user.
