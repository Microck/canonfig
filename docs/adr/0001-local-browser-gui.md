# Local browser GUI served by `canonfig ui`

Status: implemented for the phase 1 server, session, and read-only Overview. Other screens and operations remain demo-only.

## Frontend paths

`ui/` is the permanent frontend package. Demo screens live in `ui/src/workspace/`, shared components and demo data in `ui/src/shared/`, and demo first-run setup in `ui/src/onboarding/`. Production enters through `ui/src/live-app.tsx`; `ui/src/gui-client.ts` owns HTTP requests and schema decoding. Vite's build-selected `@app` entrypoint loads the live application for production and `App.tsx` for development and demo builds, so production never mounts the simulated workspace store.

Demo browser paths identify the role and screen: `/source/profile`, `/source/machines`, `/follower/sync`, and `/follower/local-settings`. Settings live below each role's `/settings/` path. Profile Groups and Defaults have their own paths under `/source/profile/`; the machine list is `/source/machines/list` or `/follower/machines/list`. Demo first-run setup is `/setup`.

The URL owns navigation state. In the demo, `/` opens `/source/overview`. In production it opens the actual machine's Overview: `/source/overview`, `/follower/overview`, or `/overview` for an unconfigured machine. Unsupported or wrong-role paths show an unavailable page linking to that Overview. The unconfigured view offers read-only setup guidance. There are no aliases for the retired role/variant query routing.

## Serving architecture


`canonfig ui [--port n] [--no-open]` starts a foreground Node HTTP server in `src/gui/server.ts`, with an Effect-scoped lifetime inside the CLI process. It binds only to `127.0.0.1`, on an operating-system-selected free port by default. The CLI prints a launch URL and opens it unless `--no-open` is set. Bare `canonfig` keeps printing help.

The initial `GET /?token=<single-use-token>` validates Host and Origin before exchanging the token for an `HttpOnly; SameSite=Strict; Path=/` session cookie and redirecting with HTTP 303 to `/`. Assets and API requests require that cookie. The accepted origin is exactly `http://127.0.0.1:<port>`; GET navigation may omit Origin, but an incorrect Origin is rejected. The token cannot establish another session after use. The server holds the normal command lease, and Ctrl-C or SIGTERM closes the server and releases its scope.

The backend calls existing Effect services in-process rather than spawning the CLI. `GuiQueries.session()` reads the local role records through the same StateRepository layer as the CLI, without probing a remote Source. `FollowerCommands.status()` supplies Overview, including Source and unconfigured roles. `GET /api/session` and `GET /api/status` are the only live data endpoints. Overview and its Reload action render their results without demo fallbacks. Status uses the CLI's output sanitization and is not a fleet inventory: unreached follower lifecycle stages on a Source must not be presented as a failed Source service.

`src/gui/contract.ts` defines Effect Schemas and same-named types for `GuiSession`, `GuiStatus`, and `GuiError`. The frontend imports this file directly; no generated or copied contract is maintained in `ui/`. Session carries role, machine name, version, and folder path. Status validates its machine role, lifecycle and tunnel fields while retaining the CLI's additional status properties. Errors reuse the CLI's `category`, `exitCode`, and `message`.

Further screens must call the existing Source, Follower, Setup, secrets, skills and installer operations through typed backend handlers. Missing CLI operations are recorded in [the integration plan](../plans/canonfig-ui.md), not implemented as GUI-only state mutations.

The Canonical Folder defined by ADR 0003 is the authoring source of truth. Phase 1 does not edit it. Future authoring operations must share CLI/domain validation and preserve JSONC comments and concurrent hand edits, rather than maintaining a GUI-owned profile store.

The frontend is a static React 19 single-page app built with Vite and shipped in `dist/ui` in the npm package. The public demo remains a separate build with simulated operations. Package validation must measure the combined CLI and production UI rather than excluding the browser assets.

### Self-update from the GUI

Once a person opts in to self-updates, every ordinary command holds an update lease while it runs (`commandLease` in `src/runtime/self-update/coordination.ts`), and an update installs only while no lease is held. `canonfig ui` holds that same lease. Applying an update in-process would therefore defer on its own lease. Disabling updates also refuses active commands, and enabling requires an idle installation.

The Canonfig version pages remain demo-only in phase 1. A future live page may expose status and checks, but must direct users to stop the GUI before running self-update mutations in a terminal, including `canonfig self-update apply --apply`. In-GUI activation and the server's lease handoff remain deferred to issue #260. Do not exempt the GUI from the normal lease to make these controls work.

## Considered options

- **Bare `canonfig` opens the GUI**: rejected; it breaks every caller that runs `canonfig` for help and fails on machines without a browser.
- **Reuse the `source serve` HTTPS server**: rejected; it exists only on a Source Machine, sits behind the transport version handshake, and serves Follower Machines, not people.
- **Spawn the CLI with `--json` per action**: rejected; it re-parses argv, loses typed errors, and pays process start-up per click.
- **GUI-owned profile store or whole-file rewrite**: rejected; both drift from the file the CLI publishes or destroy the author's comments.
- **Next.js**: rejected; a local tool has no server rendering, routing, or deployment needs that justify it. dithercn requires React 19, Tailwind v4, and shadcn, which rules out non-React stacks.
- **Network-reachable or background-service GUI**: rejected; any page or host that can reach the port could publish revisions or apply syncs. Loopback plus a session token blocks cross-site requests and DNS rebinding at no cost to the user.
