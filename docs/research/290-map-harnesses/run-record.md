# Run record

## Authorized scope

Issue #290, branch `feat/map-harnesses`, based on origin/main `7070b8487191ec813e6405ab53d5591e9459a1df`. Follow emil-prototype phases 1-6 only. Build three isolated variants at `/proto/map-harnesses`, compare to the film, check keyboard and console, measure M40, 320px and 320-follower cases. Commit research separately, commit prototype, push. No PR, promotion, backend changes or production writes before the user's choice.

## Execution

- Single design child, maisa-codex/gpt-6-astra. No subagents.
- Paid-tier upgrades and purchased-credit spending: not authorized. Keenable calls report `paid: false`.
- Disposable HOME: `/tmp/canonfig-map-290.YGEynu`.
- No reads or writes of live Canonfig state or harness roots. No source service or schedule changes.
- Jujutsu cannot initialize inside this Git worktree. Git used instead. Initial checkout encountered an existing shared config lock; no lock removed. Switching to the newly created branch completed the checkout.
- Repo `AGENTS.md` and `docs/agents/` absent on the current main. Global instructions, GLOSSARY, all ADRs and architecture read.
- Code graph has no indexed projects. Bounded source reads avoid a large indexing job. Semantic find failed with provider HTTP 402; exact scoped search used instead.
- Octen design key absent. No credentials requested or changed. The supplied film and official product documentation provide the references.

## Contract evidence

`GuiMachines` contains enrollment records only. `GuiHarnessReport` is machine-local selection/detection evidence, not per-harness convergence. The source transport has no follower observation upload endpoint. Completion receipts and action journals are local. Details and a proposed end-to-end contract belong in README.md.

## Verification and handoff

Prototype phases 1-6 are complete. Evidence and limits are in README.md, benchmarks-final.json and browser-checks.json. The user has not selected a winner. Production code and reporting contracts remain unchanged. Commit and push only the research folder and isolated prototype paths, in separate commits; the task tracker and VCS record those external actions.

- Task-owned detached server: npm session 3172693, Vite PID 3172710, bound to `0.0.0.0:5290`. Standard input is `/dev/null`.
- Log: `/home/ubuntu/.omp/run/daemons/16285d9949d1b219/daemons/canonfig-map-290-prototype/output.log`.
- Browser-verified picker: `http://yoga-ashburn-local-1.tailc896c6.ts.net:5290/proto/map-harnesses`.
- Restart command: README.md. Leave this server running for the user's choice.
- No broad tests or production build. UI typecheck and scoped Oxlint passed. Browser interaction and frame-time evidence is agent-run only.
- `ce-simplify-code` reuse, quality and efficiency passes ran inline because this child may not delegate. No additional changes. No independent review claimed.

## Maintainer PR decision

Read `CONTRIBUTING.md` and `.github/pull_request_template.md` from `origin/main` after `git fetch origin main`. The maintainer explicitly permits a ready-for-review PR without prior human testing when phase 7 authorizes creation. This overrides the repository's pre-submission human-testing gate, not its disclosure requirements. Do not open a PR during phase 6.

Record these exact disclosure values when preparing that PR:

- `agent_name`: `OMP`
- `agent_version`: `18.18.7`, observed from `omp --version`, which returned `omp/18.18.7`.
- `model_used`: `maisa-codex/gpt-6-astra via OMP`
- `human_testing`: `none yet; maintainer to test before merge`

Use a conventional PR title, never `chore(release): ...`. Tick only verification boxes whose exact checks ran. The scoped UI lint run does not prove the broader root or UI lint commands, and browser automation does not count as human testing. Re-read the template and observe any later checks before filing. Link the created PR through the T3 tool immediately. No merge, release or deployment is authorized.
