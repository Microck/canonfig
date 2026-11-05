import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { SourceSignature } from "../src/domain/brand.ts";
import type { ProfileRevision } from "../src/domain/profile.ts";
import type { ConfigValue } from "../src/domain/resource.ts";
import { InvalidPublicationInputError, PublicationSourceError } from "../src/profile/profile-catalog.errors.ts";
import { profileCatalogLayer } from "../src/profile/profile-catalog.layer.ts";
import { ProfileCatalog } from "../src/profile/profile-catalog.service.ts";
import type { ProfileRevisionSigner } from "../src/profile/publication.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";

/**
 * `canonfig source publish` compiles the Canonical Folder. Every case builds
 * a real folder on disk, signs with a real Ed25519 key and stores into real
 * SQLite; nothing is mocked.
 */

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const write = (path: string, content: string | Buffer, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

interface Workspace {
  readonly directory: string;
  /** The Source's `~/.canonfig/`. */
  readonly folder: string;
  readonly database: string;
}

/** The Source's canonfig.jsonc: one item of every kind. */
const baseConfig = {
  profile: { id: "workstation", name: "Workstation" },
  harnesses: ["claude-code", "codex"],
  mcp: {
    docs: { transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_MCP_TOKEN" } } },
    git: { transport: "stdio", command: "uvx", args: ["mcp-server-git"], requires: ["tools/uv"] },
  },
  hooks: [{ id: "format", event: "after_tool", run: ["hooks/format.sh"], timeoutMs: 5000 }],
  settings: { codex: { model_reasoning_effort: "high" } },
  tools: {
    uv: {
      executable: "uv",
      recipes: [{ platform: "linux", method: "uv", package: "uv", version: "0.4.0" }],
    },
  },
  credentials: { "docs-token": { reference: "DOCS_MCP_TOKEN" } },
  groups: { work: ["mcp/docs", "skills/deploy"] },
  scheduleDefault: "daily@09:00",
  local: { allow: ["skills", "mcp"] },
} satisfies Readonly<Record<string, ConfigValue>>;

/** A Source's `~/.canonfig/` with the base config plus `config`, its files, and its state database. */
const workspace = (config: Readonly<Record<string, ConfigValue>> = {}): Workspace => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-publication-"));
  temporaryDirectories.push(directory);
  const folder = join(directory, ".canonfig");
  writeConfig(folder, { ...baseConfig, ...config });
  write(join(folder, "AGENTS.md"), "# Global instructions\n");
  write(join(folder, "rules", "style.md"), "---\ndescription: Style\n---\nUse two spaces.\n");
  write(join(folder, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\nRun scripts/run.sh.\n");
  write(join(folder, "skills", "deploy", "scripts", "run.sh"), "#!/bin/sh\necho deploy\n", 0o755);
  write(join(folder, "agents", "reviewer.md"), "---\ndescription: Reviews\n---\nReview.\n");
  write(join(folder, "commands", "ship.md"), "---\ndescription: Ship\n---\nShip it.\n");
  write(join(folder, "hooks", "format.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  return { directory, folder, database: join(directory, "state.sqlite") };
};

/** Write canonfig.jsonc; an undefined entry is left out, as JSON.stringify drops it. */
const writeConfig = (folder: string, config: Readonly<Record<string, ConfigValue | undefined>>) =>
  write(join(folder, "canonfig.jsonc"), `// Source folder\n${JSON.stringify({ version: 1, ...config }, undefined, 2)}\n`);

const makeSigner = () => {
  const keys = generateKeyPairSync("ed25519");
  const calls = { signed: 0, verified: 0 };
  const signer: ProfileRevisionSigner = {
    keyId: "test-source-key",
    sign: (payload) => Effect.sync(() => {
      calls.signed += 1;
      return Schema.decodeUnknownSync(SourceSignature)(
        `ed25519:${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`,
      );
    }),
    verify: (payload, signature) => Effect.sync(() => {
      calls.verified += 1;
      return verify(null, Buffer.from(payload), keys.publicKey, Buffer.from(signature.slice("ed25519:".length), "base64url"));
    }),
  };
  return { signer, calls };
};

const publishAt = (
  fixture: Workspace,
  signer: ProfileRevisionSigner,
  publishedAt = "2026-11-03T12:00:00Z",
): Promise<ProfileRevision> =>
  Effect.runPromise(Effect.gen(function*() {
    const catalog = yield* ProfileCatalog;
    return yield* catalog.publish({ folder: fixture.folder, reviewer: "reviewer@example.test", publishedAt });
  }).pipe(
    Effect.provide(profileCatalogLayer(signer)),
    Effect.provide(stateRepositoryLayer(fixture.database)),
  ));

const publishFailure = (fixture: Workspace, signer: ProfileRevisionSigner) =>
  Effect.runPromise(Effect.gen(function*() {
    const catalog = yield* ProfileCatalog;
    return yield* Effect.flip(catalog.publish({ folder: fixture.folder, reviewer: "reviewer@example.test", publishedAt: "2026-11-03T12:00:00Z" }));
  }).pipe(
    Effect.provide(profileCatalogLayer(signer)),
    Effect.provide(stateRepositoryLayer(fixture.database)),
  ));

/** Rows publication would have written; a refused publish leaves all of them empty. */
const persisted = (database: string) => {
  const connection = new DatabaseSync(database);
  try {
    return connection.prepare(`
      SELECT
        (SELECT COUNT(*) FROM profile_revisions) AS revisions,
        (SELECT COUNT(*) FROM resource_blob_manifests) AS blobs,
        (SELECT COUNT(*) FROM revision_approvals) AS approvals
    `).get();
  } finally {
    connection.close();
  }
};

const resourceOf = (revision: ProfileRevision, id: string) => revision.resources.find((resource) => resource.id === id);

describe("publishing the Canonical Folder", () => {
  it("signs one resource per item, with groups, schedule and the folder-wide items", async () => {
    const fixture = workspace();
    const signing = makeSigner();
    const revision = await publishAt(fixture, signing.signer);

    expect(revision.profileId).toBe("workstation");
    expect(revision.sequence).toBe(1);
    expect(revision.resources.map((resource) => resource.id).sort()).toEqual([
      "agents:reviewer",
      "commands:ship",
      "credentials:docs-token",
      "harnesses",
      "hook-scripts:format.sh",
      "hooks:format",
      "instructions",
      "local-policy",
      "mcp:docs",
      "mcp:git",
      "rules:style",
      "settings:codex",
      "skills:deploy",
      "tools:uv",
    ]);
    expect(resourceOf(revision, "instructions")).toMatchObject({ kind: "file", target: "AGENTS.md" });
    expect(resourceOf(revision, "skills:deploy")).toMatchObject({ kind: "skill", target: "skills/deploy", groups: ["work"] });
    expect(resourceOf(revision, "mcp:docs")).toMatchObject({ kind: "config", target: "canonfig.jsonc#mcp.docs", groups: ["work"] });
    expect(resourceOf(revision, "mcp:git")).toMatchObject({ dependsOn: ["tools:uv"] });
    expect(resourceOf(revision, "mcp:git")?.groups).toBeUndefined();
    expect(resourceOf(revision, "hooks:format")).toMatchObject({ dependsOn: ["hook-scripts:format.sh"] });
    expect(resourceOf(revision, "hook-scripts:format.sh")?.spec).toMatchObject({ kind: "file", executable: true });
    expect(resourceOf(revision, "tools:uv")).toMatchObject({ kind: "tool", target: "uv" });
    expect(resourceOf(revision, "credentials:docs-token")).toMatchObject({ kind: "credential", target: "DOCS_MCP_TOKEN" });
    expect(revision.groups).toEqual([{ name: "work" }]);
    expect(revision.scheduleDefault).toEqual({ type: "daily", at: "09:00", timezone: "local" });
    expect(signing.calls).toEqual({ signed: 1, verified: 1 });
  });

  it("does not infer execute intent from a disabled-only hook", async () => {
    const fixture = workspace({
      hooks: [{ id: "format", event: "after_tool", run: ["hooks/format.sh"], enabled: false }],
    });
    chmodSync(join(fixture.folder, "hooks", "format.sh"), 0o600);
    const revision = await publishAt(fixture, makeSigner().signer);
    expect(resourceOf(revision, "hook-scripts:format.sh")?.spec)
      .toMatchObject({ kind: "file", executable: false });
  });

  it("publishes hooks with their authored positions, whatever their ids sort to", async () => {
    const fixture = workspace({
      hooks: [
        { id: "zeta", event: "after_tool", run: ["hooks/format.sh"] },
        { id: "alpha", event: "after_tool", run: ["hooks/format.sh"] },
      ],
    });
    const revision = await publishAt(fixture, makeSigner().signer);
    const position = (id: string) => {
      const spec = resourceOf(revision, `hooks:${id}`)?.spec;
      return spec?.kind === "config" ? spec.keys[0]?.value : undefined;
    };
    expect(position("zeta")).toMatchObject({ position: 0, hook: { id: "zeta" } });
    expect(position("alpha")).toMatchObject({ position: 1, hook: { id: "alpha" } });
  });

  it("never publishes what lies outside the authoring allowlist", async () => {
    const fixture = workspace();
    const secret = "machine-local-only-bytes";
    write(join(fixture.folder, "notes.txt"), secret);
    write(join(fixture.folder, "setup.json"), secret);
    write(join(fixture.folder, "installers", "npm.json"), secret);
    write(join(fixture.folder, ".backups", "2026", "manifest.json"), secret);
    write(join(fixture.folder, "local", "skills", "mine", "SKILL.md"), `---\nname: mine\ndescription: ${secret}\n---\n`);
    const revision = await publishAt(fixture, makeSigner().signer);

    expect(revision.canonicalBytes).not.toContain(secret);
    expect(revision.canonicalBytes).not.toContain("notes.txt");
    expect(revision.resources.some((resource) => resource.id.includes("mine"))).toBe(false);
  });

  it.each([
    ["an undeclared canonfig.jsonc key", (folder: string) => writeConfig(folder, { ...baseConfig, extra: true }), "extra"],
    ["a file in rules/ that is not a document", (folder: string) => write(join(folder, "rules", "notes.txt"), "x"), "only <id>.md documents"],
    ["a hook script no hook runs", (folder: string) => write(join(folder, "hooks", "orphan.sh"), "#!/bin/sh\n", 0o755), "is not run by any hook"],
    ["a group naming an undeclared item", (folder: string) => writeConfig(folder, { ...baseConfig, groups: { work: ["skills/missing"] } }), "skills/missing"],
    ["a folder without a profile", (folder: string) => writeConfig(folder, { ...baseConfig, profile: undefined }), "\"profile\""],
  ] as const)("refuses %s before signing", async (_name, change, message) => {
    const fixture = workspace();
    change(fixture.folder);
    const signing = makeSigner();
    const failure = await publishFailure(fixture, signing.signer);
    expect(failure).toBeInstanceOf(InvalidPublicationInputError);
    if (failure instanceof InvalidPublicationInputError) expect(failure.reason).toContain(message);
    expect(signing.calls.signed).toBe(0);
    expect(persisted(fixture.database)).toEqual({ revisions: 0, blobs: 0, approvals: 0 });
  });

  it.skipIf(process.platform === "win32").each([
    ["the instructions", "AGENTS.md"],
    ["a skill file", "skills/deploy/scripts/run.sh"],
    ["a hook script", "hooks/format.sh"],
  ])("refuses %s linked to a file outside the folder", async (_name, path) => {
    const fixture = workspace();
    const outside = join(fixture.directory, "outside-secret.txt");
    write(outside, "outside the Canonical Folder");
    rmSync(join(fixture.folder, path));
    symlinkSync(outside, join(fixture.folder, path));
    const signing = makeSigner();
    const failure = await publishFailure(fixture, signing.signer);
    expect([InvalidPublicationInputError, PublicationSourceError].some((type) => failure instanceof type)).toBe(true);
    expect(String(failure.message)).toMatch(/link|outside/u);
    expect(signing.calls.signed).toBe(0);
    expect(persisted(fixture.database)).toEqual({ revisions: 0, blobs: 0, approvals: 0 });
  });

  it.each([
    ["a separate password argument", { mcp: { tool: { transport: "stdio", command: "tool", args: ["--password", "publication-disposable-value"] } } }],
    ["an equals token argument", { mcp: { tool: { transport: "stdio", command: "tool", args: ["--api-token=publication-disposable-value"] } } }],
    ["URL user information", { mcp: { remote: { transport: "streamable-http", url: "https://operator:publication-disposable-value@example.test/mcp" } } }],
    ["a URL secret query", { mcp: { remote: { transport: "streamable-http", url: "https://example.test/mcp?api_key=publication-disposable-value" } } }],
    ["an authorization header", { mcp: { remote: { transport: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "Bearer publication-disposable-value" } } } }],
    ["a literal environment entry", { mcp: { tool: { transport: "stdio", command: "tool", env: { API_TOKEN: "publication-disposable-value" } } } }],
    ["a credential-named setting", { settings: { codex: { api_key: "publication-disposable-value" } } }],
    ["a nested credential field", { settings: { codex: { authentication: { clientSecret: "publication-disposable-value" } } } }],
  ] as const)("rejects %s before signing or storing anything", async (_name, items) => {
    const fixture = workspace();
    writeConfig(fixture.folder, { profile: { id: "workstation", name: "W" }, harnesses: ["codex"], ...items });
    rmSync(join(fixture.folder, "hooks"), { recursive: true });
    const signing = makeSigner();
    const failure = await publishFailure(fixture, signing.signer);
    expect(failure).toBeInstanceOf(InvalidPublicationInputError);
    expect(String(failure.message)).toContain("literal credential");
    expect(String(failure.message)).not.toContain("publication-disposable-value");
    expect(signing.calls).toEqual({ signed: 0, verified: 0 });
    expect(persisted(fixture.database)).toEqual({ revisions: 0, blobs: 0, approvals: 0 });
  });

  it("judges credentials by value, not by an item named like one", async () => {
    // An MCP server or hook called `api-key` is a name; its values are
    // environment references, so it publishes.
    const fixture = workspace({
      mcp: { "api-key": { transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "API_KEY" } } } },
      hooks: [{ id: "api-token", event: "after_tool", run: ["hooks/format.sh"] }],
      groups: {},
    });
    const revision = await publishAt(fixture, makeSigner().signer);
    expect(resourceOf(revision, "mcp:api-key")).toBeDefined();
    expect(resourceOf(revision, "hooks:api-token")).toBeDefined();
  });

  it("republishes equal content as the same revision and anything else as the next sequence", async () => {
    const fixture = workspace();
    const signing = makeSigner();
    const first = await publishAt(fixture, signing.signer);
    const equal = await publishAt(fixture, signing.signer, "2026-11-03T13:00:00Z");
    expect(equal).toEqual(first);
    expect(signing.calls.signed).toBe(1);

    write(join(fixture.folder, "AGENTS.md"), "# Changed instructions\n");
    const changed = await publishAt(fixture, signing.signer, "2026-11-03T14:00:00Z");
    expect(changed.sequence).toBe(2);
    expect(changed.id).not.toBe(first.id);

    // Restoring older content is a new latest revision, not a rollback.
    write(join(fixture.folder, "AGENTS.md"), "# Global instructions\n");
    const restored = await publishAt(fixture, signing.signer, "2026-11-03T15:00:00Z");
    expect(restored.sequence).toBe(3);
    expect(restored.digest).toBe(first.digest);
    expect(restored.id).toBe(`${first.id}:3`);
  });

  it("keeps one profile per Source", async () => {
    const fixture = workspace();
    const signing = makeSigner();
    await publishAt(fixture, signing.signer);
    const config = readFileSync(join(fixture.folder, "canonfig.jsonc"), "utf8");
    write(join(fixture.folder, "canonfig.jsonc"), config.replace("\"workstation\"", "\"laptop\""));
    const failure = await publishFailure(fixture, signing.signer);
    expect(failure).toBeInstanceOf(InvalidPublicationInputError);
    expect(String(failure.message)).toContain("this Source publishes profile workstation");
  });

  it.each([
    ["an unlisted harness", { hermes: ["mcp"] }, "surfaces names hermes, which harnesses does not list"],
    ["a category the harness cannot take", { codex: ["commands"] }, "surfaces.codex: OpenAI Codex does not support commands"],
  ])("refuses to publish a surfaces selection with %s", async (_case, surfaces, message) => {
    const fixture = workspace({ surfaces });
    const failure = await publishFailure(fixture, makeSigner().signer);
    expect(String(failure.message)).toContain(message);
  });

  it("publishes a valid surfaces selection", async () => {
    const fixture = workspace({ surfaces: { codex: ["mcp", "skills"] } });
    const published = await publishAt(fixture, makeSigner().signer);
    expect(published.resources.map((resource) => resource.id)).toContain("surfaces");
  });

  it("refuses a folder whose revision metadata exceeds the transport budget", async () => {
    const fixture = workspace();
    const notes = join(fixture.folder, "skills", "deploy", "notes");
    mkdirSync(notes, { recursive: true });
    for (let index = 0; index < 12_000; index += 1) writeFileSync(join(notes, `note-${index}.md`), "fixture");
    const signing = makeSigner();
    const failure = await publishFailure(fixture, signing.signer);
    expect(failure).toBeInstanceOf(InvalidPublicationInputError);
    expect(String(failure.message)).toContain("transport limit");
    expect(signing.calls.signed).toBe(0);
    expect(persisted(fixture.database)).toEqual({ revisions: 0, blobs: 0, approvals: 0 });
  }, 60_000);

  it("hashes and stores folder files without memory that grows with their size", () => {
    const directory = mkdtempSync(join(tmpdir(), "canonfig-publication-large-"));
    temporaryDirectories.push(directory);
    const mebibyte = 1024 * 1024;
    // A cheap deterministic pattern, distinct per mebibyte so every chunk differs.
    const block = Buffer.alloc(mebibyte);
    for (let index = 0; index < block.length; index += 1) block[index] = (index * 31) & 0xff;
    // Each size gets its own folder whose one skill holds the large file.
    const writePattern = (name: string, mebibytes: number) => {
      const folder = join(directory, name);
      write(join(folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "large-profile", name: "Large" }, harnesses: [] }));
      write(join(folder, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Large file\n---\n`);
      const hash = createHash("sha256");
      const descriptor = openSync(join(folder, "skills", name, "data.bin"), "w");
      for (let index = 0; index < mebibytes; index += 1) {
        block.writeUInt32BE(index, 0);
        block.write(name, 4);
        hash.update(block);
        writeSync(descriptor, block);
      }
      closeSync(descriptor);
      return hash.digest("hex");
    };
    writePattern("warm", 32);
    writePattern("medium", 32);
    const largeDigest = writePattern("large", 160);
    const script = join(import.meta.dirname, "fixtures", "publication", "publish-large-source.mts");
    const output = join(directory, "result.json");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--expose-gc", script, join(directory, "state.sqlite"), directory, output],
      { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    // SAFETY: the child writes exactly this JSON shape.
    const result = JSON.parse(readFileSync(output, "utf8")) as {
      readonly mediumGrowthKiB: number;
      readonly largeGrowthKiB: number;
      readonly digest: string;
      readonly blobBytes: number;
      readonly rangeBytes: number;
      readonly rangeChunks: number;
    };
    expect(result.digest).toBe(largeDigest);
    expect(result.blobBytes).toBe(160 * mebibyte);
    expect(result.rangeBytes).toBe(8 * mebibyte);
    expect(result.rangeChunks).toBe(8);
    // The large file is 128 MiB bigger than the medium one. Holding a file
    // whole adds at least one copy of it. Streaming adds a bounded amount of
    // collectable garbage that does not track file size.
    expect(result.largeGrowthKiB - result.mediumGrowthKiB).toBeLessThan(64 * 1024);
  }, 180_000);
});
