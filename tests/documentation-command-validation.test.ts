import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateDocumentation } from "../website/scripts/validate-commands.ts";

const withDocumentationFixture = async <Value>(
  use: (root: string, docs: string) => Promise<Value>,
): Promise<Value> => {
  const root = await mkdtemp(path.join(tmpdir(), "canonfig-docs-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  try {
    return await use(root, docs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const fenced = (command: string): string => `# Commands\n\n\`\`\`bash\n${command}\n\`\`\`\n`;

describe("documentation command validation", () => {
  it("rejects an invalid Canonfig example from a docs directory", async () =>
    withDocumentationFixture(async (_root, docs) => {
      await writeFile(
        path.join(docs, "invalid.md"),
        fenced("canonfig source scan"),
        "utf8",
      );

      await expect(validateDocumentation([docs])).rejects.toThrow(
        /source scan requires at least one --file/u,
      );
    }));

  it("rejects an invalid Canonfig invocation after a pipe", async () =>
    withDocumentationFixture(async (_root, docs) => {
      await writeFile(
        path.join(docs, "pipeline.md"),
        fenced("printf %s token | canonfig source publish"),
        "utf8",
      );

      await expect(validateDocumentation([docs])).rejects.toThrow(
        /source publish requires --proposal or --profile-file/u,
      );
    }));

  it("accepts a valid piped secret command", async () =>
    withDocumentationFixture(async (_root, docs) => {
      const file = path.join(docs, "secrets.md");
      await writeFile(
        file,
        fenced('printf %s "$GITHUB_TOKEN" | canonfig secrets set github-token'),
        "utf8",
      );

      await expect(validateDocumentation([docs])).resolves.toEqual({
        checked: 1,
        files: [file],
      });
    }));
});
