import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

interface SkillContract {
  readonly name: string;
  readonly descriptionTerms: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly bodyTerms: ReadonlyArray<string>;
}

const projectRoot = resolve(import.meta.dirname, "../..");

const contracts: ReadonlyArray<SkillContract> = [
  {
    name: "setup-canonfig",
    descriptionTerms: [
      "on this computer",
      "locally",
      "Source Machine",
      "Follower Machine",
    ],
    files: [
      "SKILL.md",
      "agents/openai.yaml",
      "references/source.md",
      "references/follower.md",
    ],
    bodyTerms: [
      "canonfig harnesses --json",
      "Which harness do you use most?",
      "What should Canonfig manage?",
      "Where should the shared config apply?",
      "Apply the changes shown above?",
      "canonfig sync --plan --json",
      "canonfig sync --apply --no-input --json",
      "canonfig local mcp preserve --harness <id>",
      "canonfig setup plan --role source",
      "canonfig follower enroll --stdin",
      "canonfig source publish",
      "canonfig restore",
      "Takeover Snapshot",
      "Human Action Required",
    ],
  },
  {
    name: "operate-canonfig",
    descriptionTerms: [
      "syncs",
      "Takeover Snapshots",
      "Follower Drift",
      "Human Action Required",
      "Source",
      "Follower",
    ],
    files: [
      "SKILL.md",
      "agents/openai.yaml",
      "references/multi-machine.md",
    ],
    bodyTerms: [
      "canonfig status --json",
      "canonfig harnesses --json",
      "canonfig doctor --no-input --timeout-ms 5000 --json",
      "canonfig sync --plan",
      "canonfig sync --apply",
      "canonfig local mcp preserve",
      "canonfig restore",
      "canonfig recover",
      "canonfig report-issue",
      "canonfig source publish",
      "canonfig source invite",
      "canonfig source revoke",
      "canonfig schedule set",
      "Secret Service",
      "Keychain",
      "Credential Manager",
      "systemd",
      "launchd",
      "Task Scheduler",
    ],
  },
];

const assertIncludes = (
  text: string,
  expected: string,
  location: string,
): void => {
  if (!text.includes(expected)) {
    throw new Error(`${location} must include ${JSON.stringify(expected)}`);
  }
};

const validateFrontmatter = (
  skillName: string,
  skillMarkdown: string,
): string => {
  const match = /^---\nname: (?<name>[a-z0-9-]+)\ndescription: (?<description>[^\n]+)\n---\n/u.exec(
    skillMarkdown,
  );
  if (match?.groups === undefined) {
    throw new Error(`${skillName}/SKILL.md has invalid frontmatter`);
  }
  if (match.groups.name !== skillName) {
    throw new Error(`${skillName}/SKILL.md frontmatter name does not match its directory`);
  }
  if (match.groups.description.trim().length < 80) {
    throw new Error(`${skillName}/SKILL.md description is not a useful trigger pointer`);
  }
  return match.groups.description;
};

for (const contract of contracts) {
  const skillRoot = resolve(projectRoot, "skills", contract.name);
  for (const relativePath of contract.files) {
    const path = resolve(skillRoot, relativePath);
    const fileStatus = await stat(path);
    if (!fileStatus.isFile()) {
      throw new Error(`${path} must be a file`);
    }
  }

  const skillPath = resolve(skillRoot, "SKILL.md");
  const skillMarkdown = await readFile(skillPath, "utf8");
  const description = validateFrontmatter(contract.name, skillMarkdown);
  if (skillMarkdown.split(/\r?\n/u).length > 500) {
    throw new Error(`${skillPath} exceeds the 500-line progressive-disclosure limit`);
  }
  if (skillMarkdown.includes("TODO")) {
    throw new Error(`${skillPath} contains an unresolved template marker`);
  }
  for (const term of contract.descriptionTerms) {
    assertIncludes(description, term, `${skillPath} description`);
  }

  const disclosedText = (
    await Promise.all(
      contract.files
        .filter((relativePath) => relativePath.endsWith(".md"))
        .map((relativePath) => readFile(resolve(skillRoot, relativePath), "utf8")),
    )
  ).join("\n");
  for (const term of contract.bodyTerms) {
    assertIncludes(disclosedText, term, skillRoot);
  }

  const agentMetadata = await readFile(
    resolve(skillRoot, "agents/openai.yaml"),
    "utf8",
  );
  assertIncludes(agentMetadata, `$${contract.name}`, `${contract.name}/agents/openai.yaml`);
}

process.stdout.write(`Validated ${contracts.length} Canonfig skill structures.\n`);
