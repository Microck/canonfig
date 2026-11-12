# Contributing

## Scope

Canonfig is a TypeScript CLI and local browser UI that publishes an AI agent
setup from one Source Machine and syncs it to Linux, macOS and Windows Follower
Machines. Contributions should stay focused on that: the CLI, the browser UI in
[`ui/`](ui/README.md), the docs site in [`website/`](website), the agent skills
in [`skills/`](skills/README.md), and their tests.

## Report an issue

Use the [issue templates](https://github.com/Microck/canonfig/issues/new/choose):

- **Bug report:** include `canonfig --version`, your OS and architecture,
  `node --version`, whether the machine is a Source or a Follower, the exact
  command or browser UI page, and the full output. For setup, credential,
  harness or sync problems, add `canonfig doctor --no-input --json`.
- **Feature request:** describe the problem first, then the change you want and
  whether it affects the Source, Followers or both.

Never paste credentials, tokens, invitation envelopes, `~/.canonfig/secrets.json`,
anything under `~/.canonfig/credentials/`, or private MCP server values. Report
security problems privately through
[GitHub security advisories](https://github.com/Microck/canonfig/security/advisories/new),
not in a public issue.

## Local setup

You need Node.js 24 or newer and an npm that reads lockfile version 3.

```sh
npm ci
npm ci --prefix ui
npm run build:cli
```

## Checks

Run these before opening a pull request:

```sh
npm run typecheck
npm run lint        # also validates docs command examples and skills
npm test
```

For browser UI changes, also run:

```sh
npm --prefix ui run typecheck
npm --prefix ui run lint
TSX_TSCONFIG_PATH=ui/tsconfig.app.json node --import tsx --test $(git ls-files 'ui/src/**/*.test.ts' 'ui/src/**/*.test.tsx')
```

The full suite is slow. While you work, run the focused test files, then run
the full suite once before you open the pull request. CI runs everything on
Linux, macOS, Windows and Windows ARM.

## Tests

- Test real behavior. Do not mock modules or use mocking frameworks; use real
  implementations, temporary directories and small fixtures.
- A test for a bug must fail without the fix and pass with it.
- Tests must never touch your own machine's setup. Give each test a temporary
  `HOME`, keep credentials out of the system keyring with
  `CANONFIG_LOCAL_CREDENTIAL_ROOT`, and never point a test at a running Source,
  `canonfig ui` or real enrollment.
- Do not weaken or skip a failing test to make a change pass.

## Pull requests

- Keep each pull request to one goal.
- Use a conventional title, such as `fix: ...`, `feat: ...`, `docs: ...` or
  `refactor: ...`. Pull requests are squash-merged, so the title becomes the
  commit message.
- Do not use the title `chore(release): prepare v...`. Merging a pull request
  with that title publishes a release.
- Fill in the pull request template, including what you ran and what happened.
- Update the docs site, README or skills when user-visible behavior changes.
- Keep one current code path. Do not add compatibility shims or fallbacks for
  old local state. If a change breaks a command, exit code, file format or
  browser UI flow, say so in the pull request.
- Do not commit credentials, tokens, invitation envelopes, `secrets.json` or
  personal config.

## AI-Assisted Contributions

AI-assisted contributions are allowed in this project. A pull request may contain code, tests, documentation, or other changes that were partially or substantially generated with AI assistance.

However, AI use must be disclosed. The contributor remains responsible for the full contribution, including all AI-assisted portions. AI-generated work must be tested by a human before submission.

### Your pull request must include

Each field in the AI assistance disclosure exists for contributor verification and project auditing purposes. Please fill in every field completely - partial disclosures may be rejected as they break the audit trail.

AI agents, coding assistants, chatbots, and automated tools must not fabricate, infer, or falsely complete any field. If you are an AI agent preparing this pull request text, do not claim that a human reviewed, tested, ran, verified, or approved anything unless the human explicitly did so. False testing claims will be treated as invalid disclosure.

- `agent_name` - What AI tool, coding assistant, or agent was used?
  Examples: `"Claude Code"`, `"Cursor AI"`, `"OpenAI Codex"`, `"GitHub Copilot"`, `"ChatGPT"`, `"Aider"`, etc.

- `agent_version` - What version of the tool, extension, CLI, or agent was used?
  Provide the exact version shown by the tool when available.

- `model_used` - What model was used?
  This field is required and must name the actual model. `"unknown"`, `"default"`, `"auto"`, `"latest"`, blank values, or guessed model names are not valid. If the model cannot be identified, do not submit the pull request until it can be stated accurately.

- `human_testing` - What tests, checks, or manual validation were performed by a human?
  This field must describe real human testing that actually happened. Do not write that tests were run unless a human ran them. Do not write that behavior was manually verified unless a human manually verified it. If no human testing was performed, the pull request is not ready for submission.

- `contribution_summary` - A one-line summary of what changed.
  Example: `"Added validation for empty config values and updated related tests."`

Before submitting, ensure that:

- you understand the changes being proposed;
- a human has run the relevant tests, checks, or manual validation;
- the disclosure accurately describes the AI tool and model used;
- no field contains fabricated, guessed, or placeholder information;
- the contribution does not knowingly include secrets, private data, copied code, or material that violates licensing requirements;
- any incorrect, unsafe, unnecessary, or unverifiable AI output has been corrected or removed.

Pull requests will not be rejected solely because AI was used. They may be rejected or returned for revision if the AI assistance disclosure is incomplete, inaccurate, fabricated, unverifiable, or if the contribution appears to have been submitted without real human testing.

## Review

This repository is maintained by one person.

- A pull request is merged only after CI passes. Approving reviews are not
  required, because they would block the sole maintainer.
- CodeRabbit reviews pull requests. Answer or fix each of its comments; a
  comment you disagree with needs a reply that says why.
- The maintainer prepares and publishes releases; see the
  [release runbook](docs/release-runbook.md).
