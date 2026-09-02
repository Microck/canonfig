import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

const oldVersion = "2.1.1";
const newVersion = "2.2.0";

const replaceOnce = (text, search, replacement, label) => {
  const first = text.indexOf(search);
  if (first === -1) throw new Error(`missing ${label} marker`);
  if (text.indexOf(search, first + search.length) !== -1) {
    throw new Error(`ambiguous ${label} marker`);
  }
  return text.replace(search, replacement);
};

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

const versionFiles = [];
for (const path of trackedFiles) {
  const content = readFileSync(path, "utf8");
  if (!content.includes(oldVersion)) continue;
  writeFileSync(path, content.replaceAll(oldVersion, newVersion), "utf8");
  versionFiles.push(path);
}
if (versionFiles.length < 15) {
  throw new Error(`expected at least 15 versioned files, updated ${versionFiles.length}`);
}

const readmePath = "README.md";
let readme = readFileSync(readmePath, "utf8");
readme = replaceOnce(
  readme,
  "the npm package is `@microck/canonfig`; the installed binary is `canonfig`.\n\n## quickstart",
  `the npm package is \`@microck/canonfig\`; the installed binary is \`canonfig\`.\n\n## local command log\n\nCanonfig writes privacy-safe JSON Lines lifecycle records to\n\`~/.canonfig/canonfig.log\`. Each record contains only the normalized command,\ntimestamp, process ID, duration, and exit code. Arguments, stdout, stderr,\ninvitation payloads, and secret values are never logged.\n\nThe file is restricted to the current user on POSIX and Windows. Disable it or\nselect another path when needed:\n\n\`\`\`bash\nCANONFIG_LOG=off canonfig status\nCANONFIG_LOG_FILE=/tmp/canonfig.jsonl canonfig doctor --no-input\n\`\`\`\n\n\`SIGINT\` and \`SIGTERM\` write a completion event before the signal is\nre-raised. \`SIGKILL\` cannot be observed by the process and therefore cannot\nproduce one.\n\n## quickstart`,
  "README command-log",
);
readme = replaceOnce(
  readme,
  "## resource kinds and apply policies",
  `## harness configuration files\n\nHarness configuration can be scaffolded as YAML or strict JSON. YAML remains\nthe default; JSON is selected explicitly and uses the same schema and compiler:\n\n\`\`\`bash\ncanonfig harness init\ncanonfig harness init --format json\ncanonfig harness validate\ncanonfig harness plan\ncanonfig harness apply\n\`\`\`\n\nCanonfig rejects projects containing more than one of\n\`.canonfig/harness.yaml\`, \`.canonfig/harness.yml\`, and\n\`.canonfig/harness.json\` instead of silently choosing one.\n\n## resource kinds and apply policies`,
  "README harness-config",
);
readme = replaceOnce(
  readme,
  "- [operate skill](skills/operate-canonfig/SKILL.md)\n\n## license",
  "- [operate skill](skills/operate-canonfig/SKILL.md)\n- [release runbook](docs/release-runbook.md)\n\n## license",
  "README release-runbook link",
);
writeFileSync(readmePath, readme, "utf8");

const securityPath = "website/content/docs/reference/security.mdx";
let security = readFileSync(securityPath, "utf8");
security = replaceOnce(
  security,
  "## Agent execution",
  `## Privacy-safe command logs\n\nCanonfig appends JSON Lines lifecycle records to\n\`~/.canonfig/canonfig.log\`. Records contain the normalized command name,\ntimestamp, process ID, duration, and exit code only. They never contain argv,\nstdout, stderr, invitation payloads, credential values, or shared-secret\nvalues. Unknown command shapes are recorded as \`unknown\` rather than copying\nunrecognized tokens.\n\nThe log is mode \`0600\` on POSIX. On Windows, Canonfig installs a protected\ncurrent-user-only ACL before the first append and skips logging if it cannot\nsecure the file. Logging failures never change command behavior. Set\n\`CANONFIG_LOG=off\` to disable logging or \`CANONFIG_LOG_FILE\` to select a\ndifferent path.\n\n\`SIGINT\` and \`SIGTERM\` produce completion records before Canonfig re-sends\nthe signal. \`SIGKILL\` cannot be observed and cannot produce a completion\nrecord.\n\n## Agent execution`,
  "security command-log",
);
writeFileSync(securityPath, security, "utf8");

const cli = `---
title: "Reference: complete CLI reference"
description: Canonfig 2.2 commands, harness configuration, shared secrets, logging controls, and exit semantics.
---

Canonfig requires Node.js 24 or newer. Commands render human-readable output by
default. Add the global \`--json\` option to receive a stable
\`canonfig.cli/v1\` envelope.

## Global options and environment

\`\`\`text
canonfig --help
canonfig --version
\`\`\`

\`-h\` and \`-V\` are the short forms. \`--json\` can appear anywhere in a
command.

Canonfig writes privacy-safe JSON Lines command lifecycle records to
\`~/.canonfig/canonfig.log\`. Use \`CANONFIG_LOG=off\` to disable them or
\`CANONFIG_LOG_FILE\` to select another path. Arguments and command output are
never recorded.

## Source Machine

\`\`\`text
canonfig source init
canonfig source scan --file AGENTS.md --file package.json
canonfig source publish --proposal package.json --profile workstation --name Workstation --reviewer operator
canonfig source serve --host 127.0.0.1 --port 17342
canonfig source invite --endpoint https://127.0.0.1:17342 --expires 15m --group developers
canonfig source revoke follower-one
\`\`\`

\`source serve\` defaults to \`127.0.0.1:17342\`. Invitation duration uses a
positive integer plus \`ms\`, \`s\`, \`m\`, or \`h\` and cannot exceed 24
hours. Repeat \`--group\` to add Follower Groups.

## Follower enrollment and synchronization

\`\`\`text
canonfig follower enroll "$INVITE" --name laptop --profile workstation
canonfig sync --plan
canonfig sync --apply
canonfig sync --apply --no-input
canonfig recover --no-input
canonfig status
canonfig status --follower follower-one
canonfig doctor --no-input --timeout-ms 5000
\`\`\`

\`--plan\` and \`--apply\` are mutually exclusive. With neither, \`sync\`
plans. A successful apply also synchronizes shared secrets when the follower has
the \`canonfig:secrets\` group. \`recover\` accepts only \`--no-input\`.

## Shared secrets

\`\`\`text
printf %s "$GITHUB_TOKEN" | canonfig secrets set github-token
canonfig secrets list
canonfig secrets sync
canonfig secrets remove github-token
\`\`\`

\`secrets set\` reads the value from standard input only. Secret values require
the native noninteractive credential store and are never accepted in argv,
printed, or written to JSON. \`secrets sync\` is an explicit retry; normal
successful \`sync --apply\` runs synchronize automatically.

## Harness configuration

\`\`\`text
canonfig harness init
canonfig harness init --format json
canonfig harness validate
canonfig harness targets
canonfig harness plan
canonfig harness apply
canonfig harness status
canonfig harness diff
canonfig harness clean
canonfig harness doctor
\`\`\`

YAML is the default scaffold. \`--format json\` creates strict, pretty-printed
\`.canonfig/harness.json\` and is valid only with \`harness init\`. YAML and
JSON use the same schema and compiler. Canonfig rejects ambiguous projects that
contain multiple supported harness configuration files.

## Profiles and agent policy

\`\`\`text
canonfig profile list
canonfig profile show revision-one
canonfig profile select workstation
canonfig agent policy
canonfig agent policy deterministic-only
canonfig agent policy agent-propose
canonfig agent policy agent-apply
canonfig agent harness
canonfig agent harness codex --executable /opt/codex --allow-path /home/operator/.canonfig --allow-leaf-executable npm --allow-origin https://registry.npmjs.org --allow-capability restart --maximum-input-bytes 4096
\`\`\`

Harness kinds are \`codex\`, \`claude\`, and \`gemini\`. Capabilities are
\`elevation\`, \`login\`, \`restart\`, and \`reboot\`. Allow origins must be
exact HTTPS origins.

## Scheduling

\`\`\`text
canonfig schedule set daily@00:00
canonfig schedule set weekly:Mon@12:30 --timezone Europe/Paris
canonfig schedule set daily@00:00 --executable /opt/canonfig
canonfig schedule status
canonfig schedule remove
\`\`\`

The schedule CLI accepts daily and weekly calendars only.

## JSON envelope

\`\`\`json
{
  "schema": "canonfig.cli/v1",
  "command": "status",
  "status": "success",
  "exitCode": 0,
  "message": "status completed",
  "data": {}
}
\`\`\`

Secret-like fields are recursively redacted before human or JSON rendering.
Structured failures are written to standard error; structured successes are
written to standard output.

## Exit codes

| Code | Meaning |
| ---: | --- |
| \`0\` | Success |
| \`1\` | Internal failure |
| \`2\` | Usage or configuration |
| \`3\` | Human Action Required |
| \`4\` | Conflict or Follower Drift |
| \`5\` | Authentication or revocation |
| \`6\` | Transport |
| \`7\` | Verification or apply failure |
`;
writeFileSync("website/content/docs/reference/cli.mdx", cli, "utf8");

const runbook = `# Release runbook

This runbook releases the public \`@microck/canonfig\` package and matching
GitHub release. Never rewrite a published tag or reuse a published version.

## 1. Select the version

Use semantic versioning:

- patch for backward-compatible fixes;
- minor for backward-compatible features;
- major for breaking command, schema, state, or platform changes.

Confirm the target does not already exist on npm or as a Git tag.

## 2. Prepare the release branch

1. Start from the latest green \`main\`.
2. Update the root package, workspace package, lockfile, CLI version constant,
   release validator, tests, install skills, and pinned install examples.
3. Update README and website documentation for every user-visible change.
4. Search the repository for the previous version and explain any intentional
   remaining reference.
5. Use a single \`chore(release): prepare vX.Y.Z\` commit or squash to one at
   merge.

## 3. Validate

Run from a clean checkout with Node.js 24:

\`\`\`bash
npm ci
npm run typecheck
npm run lint
npm test
npm run release:validate
npm run build
git diff --check
\`\`\`

The pull request must also pass Linux, macOS, Windows, packed CLI, native
credential-store, and acceptance jobs. Resolve all CodeRabbit P0, P1, and P2
findings before merge.

## 4. Publish

After the release preparation commit is on \`main\`:

\`\`\`bash
npm publish --access public --provenance
git tag -a vX.Y.Z -m "Canonfig vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "Canonfig vX.Y.Z" --notes-file RELEASE_NOTES.md
\`\`\`

Publish npm first. Create the tag and GitHub release only after npm accepts the
package so a release page never points to an unavailable version.

## 5. Verify

\`\`\`bash
npm view @microck/canonfig@X.Y.Z version
npm install --global @microck/canonfig@X.Y.Z
canonfig --version
canonfig --help
canonfig doctor --no-input --timeout-ms 5000
\`\`\`

Confirm the npm version, GitHub tag, release notes, documentation deployment,
and \`main\` CI. Compare the release tag with the preparation commit.

## Failure handling

Do not move or delete a published tag. If npm publication succeeded but the
package is defective, deprecate the exact version with a recovery message and
prepare a new patch release. If publication failed before npm accepted the
version, fix the release branch and retry the same unpublished version.
`;
writeFileSync("docs/release-runbook.md", runbook, "utf8");

unlinkSync("tools/release/prepare-v2.2.0.mjs");
unlinkSync(".github/workflows/prepare-v2.2.0.yml");

process.stdout.write(
  `Prepared v${newVersion}; updated ${versionFiles.length} versioned files and release documentation.\n`,
);
