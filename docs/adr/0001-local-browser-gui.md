# Local browser GUI served by `canonfig ui`

Status: accepted. The frontend lives in `ui/`; CLI serving and backend integration remain pending.

## Frontend paths

`ui/` is the permanent frontend package. Application screens live in `ui/src/workspace/`, shared components and demo data in `ui/src/shared/`, and first-run setup in `ui/src/onboarding/`. The frontend currently uses simulated machine data and operations; moving it does not add a working `canonfig ui` command.

Browser paths identify the role and screen: `/source/profile`, `/source/machines`, `/follower/sync`, and `/follower/local-settings`. Settings live below each role's `/settings/` path. Profile Groups and Defaults have their own paths under `/source/profile/`; the machine list is `/source/machines/list` or `/follower/machines/list`. First-run setup is `/setup`.

The URL owns navigation state. Direct loads, refresh, and browser Back/Forward select the same screen. Unknown paths and screens unavailable to a role show a not-found page. `/` opens `/source/overview` in the current demo. There are no aliases for the retired role/variant query routing.

## Target serving architecture


Canonfig gets a browser GUI so a person can configure and operate every Canonfig feature without a Configuration Agent or hand-written JSONC. `canonfig ui` starts a foreground HTTP server inside the CLI process, bound to `127.0.0.1` on a random port, and opens the browser at a URL carrying a one-time session token. Requests without the session cookie, or whose `Host`/`Origin` is not that loopback address, are rejected; the server exits on Ctrl-C. Bare `canonfig` keeps printing help so scripts, agents, SSH sessions, and headless Follower Machines are unaffected; the help text points at `canonfig ui`.

The server calls the existing Effect command services (`SourceCommands`, `FollowerCommands`, `SetupCommands`, harness, secrets, installer) in-process rather than spawning the CLI, so the GUI and the CLI share one implementation, one state database, and one set of failure categories. The GUI is role-aware: it is designed around the Source Machine, and also runs on a Follower Machine and on an unconfigured machine, showing only what that role can do.

The Machine Profile JSONC file on disk stays the only source of truth. The GUI edits it in place with a comment-preserving writer, so hand edits, agent edits, and GUI edits interleave without loss.

The frontend is a static React 19 single-page app (Vite, Tailwind CSS v4, shadcn/ui on Radix Primitives, dithercn for dithered surfaces) built into `dist/ui` and shipped in the npm package. The package size budget in `tools/release/validate-release.ts` is raised to the measured size.

## Considered options

- **Bare `canonfig` opens the GUI**: rejected; it breaks every caller that runs `canonfig` for help and fails on machines without a browser.
- **Reuse the `source serve` HTTPS server**: rejected; it exists only on a Source Machine, sits behind the transport version handshake, and serves Follower Machines, not people.
- **Spawn the CLI with `--json` per action**: rejected; it re-parses argv, loses typed errors, and pays process start-up per click.
- **GUI-owned profile store or whole-file rewrite**: rejected; both drift from the file the CLI publishes or destroy the author's comments.
- **Next.js**: rejected; a local tool has no server rendering, routing, or deployment needs that justify it. dithercn requires React 19, Tailwind v4, and shadcn, which rules out non-React stacks.
- **Network-reachable or background-service GUI**: rejected; any page or host that can reach the port could publish revisions or apply syncs. Loopback plus a session token blocks cross-site requests and DNS rebinding at no cost to the user.
