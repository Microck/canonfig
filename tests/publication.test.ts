import { generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProfileRevisionId,
  SourceSignature,
} from "../src/domain/brand.ts";
import type {
  ProfileResourceInput,
  ProfileRevision,
} from "../src/domain/profile.ts";
import type { ConfigValue } from "../src/domain/resource.ts";
import { describeRuntimeError } from "../src/cli/failure-taxonomy.ts";
import { scanDiscovery, type DiscoveryScanResult } from "../src/profile/discovery.ts";
import {
  EmptyPublicationError,
  InvalidPublicationInputError,
  InvalidPublicationResourcesError,
  PublicationReviewRequiredError,
  PublicationSourceError,
  UnresolvedPublicationProposalError,
} from "../src/profile/profile-catalog.errors.ts";
import { profileCatalogLayer } from "../src/profile/profile-catalog.layer.ts";
import { ProfileCatalog } from "../src/profile/profile-catalog.service.ts";
import {
  acceptPublicationProposal,
  digestDiscoveryProposal,
  revisionSigningPayload,
  type ProfileRevisionSigner,
  type PublishProfileInput,
} from "../src/profile/publication.ts";
import {
  RevisionImmutableError,
  RevisionNotFoundError,
} from "../src/state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";
import { StateRepository } from "../src/state/state-repository.service.ts";
import {
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "../src/profile/profile-codec.ts";
import { renderConfigDocument } from "../src/synchronization/config-codec.ts";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const workspace = () => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-publication-"));
  temporaryDirectories.push(directory);
  return { directory, database: join(directory, "state.sqlite") };
};

const proposal = async (
  directory: string,
  name = "fixture-tool",
  version = "1.2.3",
) => {
  const packageDirectory = join(directory, `${name}-${version}`);
  mkdirSync(packageDirectory, { recursive: true });
  const path = join(packageDirectory, "package.json");
  writeFileSync(path, JSON.stringify({
    canonfig: {
      tools: [{
        ecosystem: "npm",
        name,
        executable: name,
        version,
        source: `lock:${name}:${version}`,
        upstream: `https://example.test/${name}`,
      }],
    },
  }));
  return Effect.runPromise(scanDiscovery({
    files: [{ path, kind: "package-metadata" }],
    path: "",
  }));
};

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
      const encoded = signature.slice("ed25519:".length);
      return verify(
        null,
        Buffer.from(payload),
        keys.publicKey,
        Buffer.from(encoded, "base64url"),
      );
    }),
  };
  return { signer, calls };
};

const inputFor = (
  discovery: Awaited<ReturnType<typeof proposal>>,
  name = "Published profile",
): PublishProfileInput => ({
  proposal: discovery,
  profile: {
    id: Schema.decodeUnknownSync(
      Schema.String.pipe(Schema.brand("ProfileId")),
    )("profile-publication"),
    name,
  },
  review: acceptPublicationProposal(
    discovery,
    "reviewer@example.test",
    "2026-08-15T12:00:00Z",
  ),
  publishedAt: "2026-08-15T12:01:00Z",
});

const authoredInput = (
  discovery: DiscoveryScanResult,
  resources: ReadonlyArray<ProfileResourceInput>,
  directory?: string,
): PublishProfileInput => {
  const input = inputFor(discovery);
  return { ...input, profile: { ...input.profile, resources, directory } };
};

const authoredFile = (id: string, content: string): ProfileResourceInput => ({
  id,
  kind: "file",
  target: `~/.canonfig/${id}.txt`,
  spec: { kind: "file", content },
  verify: { method: "digest" },
});

const runCatalog = <A, E>(
  database: string,
  signer: ProfileRevisionSigner,
  effect: Effect.Effect<A, E, ProfileCatalog>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(
    Effect.provide(profileCatalogLayer(signer)),
    Effect.provide(stateRepositoryLayer(database)),
  ));

const authoredConfig = (value: ConfigValue, path = "mcpServers.fixture"): ProfileResourceInput => ({
  id: "client-config",
  kind: "config",
  target: "~/.canonfig/client.json",
  spec: { kind: "config", format: "json", keys: [{ path, value }] },
  verify: { method: "digest" },
});

describe("reviewed profile publication", () => {
  it.each([
    ["separate password argument", { args: ["--password", "publication-disposable-value"] }],
    ["equals token argument", { args: ["--api-token=publication-disposable-value"] }],
    ["URL user information", { url: "https://operator:publication-disposable-value@example.test/mcp" }],
    ["URL secret query", { url: "https://example.test/mcp?api_key=publication-disposable-value&limit=10" }],
    ["encoded URL secret query", { url: "https://example.test/mcp?api%5fkey=publication-disposable-value" }],
    ["authorization header", { headers: { Authorization: "Bearer publication-disposable-value" } }],
    ["literal environment entry", { env: { API_TOKEN: "publication-disposable-value" } }],
    ["named environment entry", { environment: [{ name: "API_TOKEN", value: "publication-disposable-value" }] }],
    ["nested credential field", { authentication: { clientSecret: "publication-disposable-value" } }],
    ["reference with literal suffix", { args: ["--password=${API_TOKEN}publication-disposable-value"] }],
  ] as const)("rejects %s before signing or persisting any publication data", async (_name, value) => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const error = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* Effect.flip(catalog.publish(authoredInput(discovery, [
          authoredFile("not-persisted", "ordinary file bytes"),
          authoredConfig(value),
        ])));
      }),
    );
    expect(error).toBeInstanceOf(InvalidPublicationInputError);
    if (error instanceof InvalidPublicationInputError) {
      expect(error.reason).toContain("client-config");
      expect(error.reason).toContain("literal credential");
      expect(error.reason).toContain("symbolic environment reference");
      expect(error.reason).toContain("canonfig secrets set");
      expect(error.reason).not.toContain("publication-disposable-value");
    }
    expect(signing.calls).toEqual({ signed: 0, verified: 0 });
    const database = new DatabaseSync(fixture.database);
    try {
      expect(database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM profile_revisions) AS revisions,
          (SELECT COUNT(*) FROM resource_blobs) AS blobs,
          (SELECT COUNT(*) FROM profile_revision_blobs) AS revisionBlobs,
          (SELECT COUNT(*) FROM revision_approvals) AS approvals
      `).get()).toEqual({ revisions: 0, blobs: 0, revisionBlobs: 0, approvals: 0 });
    } finally {
      database.close();
    }
  });

  it("does not include unsafe recipe arguments in publication contract failures", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const error = await runCatalog(fixture.database, signing.signer, Effect.gen(function*() {
      const catalog = yield* ProfileCatalog;
      return yield* Effect.flip(catalog.publish(authoredInput(discovery, [{
        id: "unsafe-tool",
        kind: "tool",
        target: "~/.local/bin/unsafe-tool",
        spec: {
          kind: "tool",
          toolId: "unsafe-tool",
          recipes: [{
            platform: "linux",
            method: "npm",
            package: "https://operator:publication-disposable-value@example.test/tool.tgz",
            version: "1.2.3",
          }],
        },
        verify: { method: "executable-present", executable: "unsafe-tool" },
      }])));
    }));
    expect(error).toBeInstanceOf(InvalidPublicationResourcesError);
    if (error instanceof InvalidPublicationResourcesError) {
      const messages = error.errors.map((issue) => describeRuntimeError(issue).message).join("; ");
      expect(messages).toContain("npm-family package must be an exact registry name");
      expect(messages).not.toContain("publication-disposable-value");
    }
    expect(signing.calls).toEqual({ signed: 0, verified: 0 });
  });

  it("preserves ordinary query parameters in a reviewed Python index", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const indexPolicy = {
      url: "https://example.test/simple?mirror=regional",
      reviewedBy: "reviewer",
      reviewedAt: "2026-09-30T00:00:00Z",
    };
    const revision = await runCatalog(fixture.database, signing.signer, Effect.gen(function*() {
      const catalog = yield* ProfileCatalog;
      return yield* catalog.publish(authoredInput(discovery, [{
        id: "reviewed-python",
        kind: "tool",
        target: "~/.local/bin/reviewed-python",
        spec: {
          kind: "tool",
          toolId: "reviewed-python",
          recipes: [{ platform: "linux", method: "uv", package: "reviewed-python", version: "1.2.3", indexPolicy }],
        },
        verify: { method: "executable-present", executable: "reviewed-python" },
      }]));
    }));
    const resource = revision.resources.find((entry) => entry.id === "reviewed-python");
    expect(resource?.spec).toMatchObject({ recipes: [{ indexPolicy }] });
    expect(signing.calls).toEqual({ signed: 1, verified: 1 });
  });

  it("rejects literal credentials in a separately authored config key", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const error = await runCatalog(fixture.database, signing.signer, Effect.gen(function*() {
      const catalog = yield* ProfileCatalog;
      return yield* Effect.flip(catalog.publish(authoredInput(discovery, [
        authoredConfig("publication-disposable-value", "mcpServers.fixture.env.API_TOKEN"),
      ])));
    }));
    expect(error).toBeInstanceOf(InvalidPublicationInputError);
    if (error instanceof InvalidPublicationInputError) {
      expect(error.reason).toContain("env.API_TOKEN");
      expect(error.reason).not.toContain("publication-disposable-value");
    }
    expect(signing.calls).toEqual({ signed: 0, verified: 0 });
  });

  it("publishes symbolic secret bindings and ordinary arguments without changing their bytes", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const config = authoredConfig({
      command: "ordinary-server",
      args: ["--password", "${API_TOKEN}", "--api-key={env:API_KEY}", "--port", "9000", "--token-budget", "1000", "--stdio"],
      env: { API_TOKEN: "${API_TOKEN}", SERVICE_API_KEY: { fromEnv: "API_KEY" }, PATH: "/usr/bin" },
      headers: { Authorization: "Bearer ${API_TOKEN}" },
      url: "https://example.test/mcp?api_key=${API_KEY}&limit=10",
      credentialReference: "local-api-token",
      secretBindings: [{ name: "API_TOKEN", secret: "shared-api-token" }],
    });
    const revision = await runCatalog(fixture.database, signing.signer, Effect.gen(function*() {
      const catalog = yield* ProfileCatalog;
      return yield* catalog.publish(authoredInput(discovery, [config]));
    }));
    const published = revision.resources.find((resource) => resource.id === config.id);
    expect(published?.spec).toEqual(config.spec);
    expect(JSON.parse(revision.canonicalBytes)).toMatchObject({
      resources: expect.arrayContaining([expect.objectContaining({ id: config.id, spec: config.spec })]),
    });
    const approval = await Effect.runPromise(Effect.flatMap(StateRepository, (repository) =>
      repository.loadRevisionApproval(revision.id)
    ).pipe(Effect.provide(stateRepositoryLayer(fixture.database))));
    expect(approval?.revisionDigest).toBe(revision.digest);
  });

  it("rejects unreviewed proposals without inferring acceptance", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const input = {
      ...inputFor(discovery),
      review: { decision: "pending" as const },
    };

    const error = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* Effect.flip(catalog.publish(input));
      }),
    );

    expect(error).toBeInstanceOf(PublicationReviewRequiredError);
    expect(signing.calls).toEqual({ signed: 0, verified: 0 });
  });

  it("rejects review-only evidence and outstanding Agent Tasks", async () => {
    const fixture = workspace();
    const path = join(fixture.directory, "AGENTS.md");
    writeFileSync(path, "Try `unresolved-tool --version` if useful.\n");
    const discovery = await Effect.runPromise(scanDiscovery({
      files: [{ path, kind: "agents" }],
      path: "",
    }));
    const signing = makeSigner();
    const error = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* Effect.flip(catalog.publish(inputFor(discovery)));
      }),
    );

    expect(error).toBeInstanceOf(UnresolvedPublicationProposalError);
    if (error instanceof UnresolvedPublicationProposalError) {
      expect(error.reasons.some((reason) => reason.startsWith("agent-task:")))
        .toBe(true);
      expect(error.reasons.some((reason) =>
        reason.startsWith("evidence-needs-review:")
      )).toBe(true);
    }
  });

  it("rejects invalid converted resources", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const invalidTool = { ...discovery.tools[0]!, executable: "" };
    const invalid = {
      ...discovery,
      tools: [invalidTool],
      resources: [invalidTool],
    };
    const signing = makeSigner();
    const error = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* Effect.flip(catalog.publish(inputFor(invalid)));
      }),
    );

    expect(error).toBeInstanceOf(InvalidPublicationResourcesError);
  });

  it("rejects noncanonical npm artifact sources before publication", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const tool = discovery.tools[0]!;
    const invalidTool = {
      ...tool,
      recipes: [{
        ...tool.recipes[0]!,
        source: "HTTPS://registry.npmjs.org/fixture-tool/-/fixture-tool-1.2.3.tgz",
      }],
    };
    const invalid = {
      ...discovery,
      tools: [invalidTool],
      resources: [invalidTool],
    };
    const signing = makeSigner();
    const error = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* Effect.flip(catalog.publish(inputFor(invalid)));
      }),
    );

    expect(error).toBeInstanceOf(InvalidPublicationResourcesError);
    expect(signing.calls).toEqual({ signed: 0, verified: 0 });
  });

  it("canonically publishes, signs, verifies, persists, and looks up revisions", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const published = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const revision = yield* catalog.publish(inputFor(discovery));
        const loaded = yield* catalog.getRevision(revision.id);
        return { revision, loaded };
      }),
    );

    expect(published.loaded).toEqual(published.revision);
    const approval = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadRevisionApproval(published.revision.id)
      ).pipe(Effect.provide(stateRepositoryLayer(fixture.database))),
    );
    expect(approval).toMatchObject({
      proposalDigest: digestDiscoveryProposal(discovery),
      revisionDigest: published.revision.digest,
      reviewer: "reviewer@example.test",
    });
    expect(published.revision.sequence).toBe(1);
    expect(published.revision.scheduleDefault).toBeUndefined();
    expect(published.revision.id).toBe(
      `profile-publication:${published.revision.digest}`,
    );
    expect(published.revision.resources[0]?.blobs).toEqual([]);
    // SAFETY: publication canonicalBytes is validated JSON with this recipe shape.
    const canonical = JSON.parse(published.revision.canonicalBytes) as {
      readonly resources: ReadonlyArray<{
        readonly spec: {
          readonly recipes: ReadonlyArray<{ readonly source?: string | undefined }>;
        };
      }>;
    };
    expect(canonical.resources[0]?.spec.recipes[0]?.source)
      .toBe("lock:fixture-tool:1.2.3");
    expect(signing.calls).toEqual({ signed: 1, verified: 1 });
    expect(JSON.stringify(published.revision)).not.toContain("PRIVATE KEY");

    const unsigned = {
      id: published.revision.id,
      profileId: published.revision.profileId,
      sequence: published.revision.sequence,
      canonicalBytes: published.revision.canonicalBytes,
      digest: published.revision.digest,
      publishedAt: published.revision.publishedAt,
      resources: published.revision.resources,
      groups: published.revision.groups,
      signingKeyId: signing.signer.keyId,
    };
    expect(await Effect.runPromise(
      signing.signer.verify(
        revisionSigningPayload(unsigned),
        published.revision.signature,
      ),
    )).toBe(true);
  });

  it("round-trips a reviewed uv sdist build policy through publication", async () => {
    const fixture = workspace();
    const path = join(fixture.directory, "package.json");
    writeFileSync(path, JSON.stringify({
      canonfig: {
        tools: [{
          ecosystem: "uv",
          name: "sdist-tool",
          executable: "sdist-tool",
          version: "2.0.0",
          source: "pyproject.toml",
          upstream: "https://pypi.org/project/sdist-tool/",
          buildPolicy: {
            mode: "required",
            reviewedBy: "reviewer@example.test",
            reviewedAt: "2026-08-16T00:00:00Z",
            executables: ["sdist-tool"],
            paths: ["/tmp/sdist-tool"],
            origins: ["https://pypi.org"],
            capabilities: ["execute", "read-files", "write-files"],
            steps: [{
              executable: "sdist-tool",
              arguments: ["-m", "build"],
            }],
          },
        }],
      },
    }, null, 2));
    const discovery = await Effect.runPromise(scanDiscovery({
      files: [{ path, kind: "package-metadata" }],
      path: "",
    }));
    const signing = makeSigner();
    const published = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const revision = yield* catalog.publish(inputFor(discovery));
        const loaded = yield* catalog.getRevision(revision.id);
        return { revision, loaded };
      }),
    );

    expect(published.loaded).toEqual(published.revision);
    // SAFETY: The published canonical payload is JSON with the profile resource shape.
    const canonical = JSON.parse(published.loaded.canonicalBytes) as {
      readonly resources: ReadonlyArray<{
        readonly spec: {
          readonly recipes: ReadonlyArray<{
            readonly method: string;
            readonly buildPolicy?: { readonly mode: string; readonly reviewedBy?: string };
          }>;
        };
      }>;
    };
    const recipe = canonical.resources
      .flatMap((resource) => resource.spec.recipes)
      .find((candidate) => candidate.method === "uv");
    expect(recipe?.buildPolicy).toMatchObject({
      mode: "required",
      reviewedBy: "reviewer@example.test",
    });
  });

  it("publishes reviewed skills into immutable canonical revisions", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const skill = {
      kind: "skill" as const,
      id: "reviewed-skill",
      sourcePath: join(fixture.directory, "AGENTS.md"),
      target: "skills/reviewed-skill",
      files: [{ path: "SKILL.md", content: "# reviewed skill\n" }],
      evidence: [],
      reviewStatus: "accepted" as const,
    };
    const withSkill = {
      ...discovery,
      resources: [...discovery.resources, skill],
      skills: [skill],
    };
    const signing = makeSigner();
    const first = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* catalog.publish(inputFor(withSkill));
      }),
    );

    expect(first.resources.map((resource) => [resource.id, resource.kind])).toEqual([
      ["fixture-tool", "tool"],
      ["reviewed-skill", "skill"],
    ]);
    // SAFETY: ProfileCatalog emits canonicalBytes as JSON with a resources array.
    const canonical = JSON.parse(first.canonicalBytes) as {
      readonly resources: ReadonlyArray<{ readonly id: string; readonly spec: { readonly kind: string } }>;
    };
    expect(canonical.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "reviewed-skill",
        spec: expect.objectContaining({ kind: "skill" }),
      }),
    ]));
    expect(first.resources.find((resource) => resource.id === "reviewed-skill")?.blobs[0])
      .toMatch(/^[a-f0-9]{64}$/u);

    const changedSkill = {
      ...skill,
      files: [{ path: "SKILL.md", content: "# changed reviewed skill\n" }],
    };
    const changed = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* catalog.publish(inputFor({
          ...discovery,
          resources: [...discovery.resources, changedSkill],
          skills: [changedSkill],
        }));
      }),
    );
    expect(changed.id).not.toBe(first.id);
    expect(changed.digest).not.toBe(first.digest);
    expect(first.resources.find((resource) => resource.id === "reviewed-skill"))
      .not.toEqual(changed.resources.find((resource) => resource.id === "reviewed-skill"));
  });

  it("excludes rejected and unreviewed skills while publishing reviewed tools", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const accepted = {
      kind: "skill" as const,
      id: "accepted-skill",
      sourcePath: join(fixture.directory, "AGENTS.md"),
      target: "skills/accepted-skill",
      files: [{ path: "SKILL.md", content: "# accepted\n" }],
      evidence: [],
      reviewStatus: "accepted" as const,
    };
    const rejected = {
      ...accepted,
      id: "rejected-skill",
      target: "skills/rejected-skill",
      reviewStatus: "needs-review" as const,
    };
    const published = await runCatalog(
      fixture.database,
      makeSigner().signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* catalog.publish(inputFor({
          ...discovery,
          resources: [...discovery.resources, accepted, rejected],
          skills: [accepted, rejected],
        }));
      }),
    );

    expect(published.resources.map((resource) => resource.id)).toEqual([
      "accepted-skill",
      "fixture-tool",
    ]);
    expect(published.resources.some((resource) => resource.id === "rejected-skill"))
      .toBe(false);
  });

  it("carries every authored resource kind into the signed revision", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const authoredResources: ReadonlyArray<ProfileResourceInput> = [
      {
        id: "authored-file",
        kind: "file",
        target: "~/.canonfig/authored.txt",
        spec: { kind: "file", content: "authored\n", executable: false },
        verify: { method: "digest", digest: sha256Hex("authored\n") },
      },
      {
        id: "authored-directory",
        kind: "directory",
        target: "~/.canonfig/authored-directory",
        spec: {
          kind: "directory",
          files: [{ path: "nested.txt", content: "nested\n" }],
        },
        verify: { method: "digest" },
      },
      {
        id: "authored-config",
        kind: "config",
        target: "~/.canonfig/authored.json",
        spec: {
          kind: "config",
          format: "json",
          keys: [{ path: "authored.value", value: true }],
        },
        verify: { method: "digest" },
      },
      {
        id: "authored-skill",
        kind: "skill",
        target: "skills/authored-skill",
        spec: {
          kind: "skill",
          name: "authored-skill",
          files: [{ path: "SKILL.md", content: "# authored\n" }],
        },
        verify: { method: "digest" },
      },
      {
        id: "authored-tool",
        kind: "tool",
        target: "authored-tool",
        spec: {
          kind: "tool",
          toolId: "authored-tool",
          recipes: [{
            platform: "linux",
            method: "npm",
            package: "authored-tool",
            version: "1.0.0",
          }],
        },
        verify: { method: "command", command: ["authored-tool", "--version"] },
      },
      {
        id: "authored-credential",
        kind: "credential",
        target: "credentials/authored",
        spec: { kind: "credential", reference: "secure-store://authored" },
        verify: { method: "credential-present", reference: "secure-store://authored" },
      },
      
    ];
    const published = await runCatalog(
      fixture.database,
      makeSigner().signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* catalog.publish({
          ...inputFor(discovery),
          profile: {
            ...inputFor(discovery).profile,
            resources: authoredResources,
            scheduleDefault: {
              type: "daily",
              at: "04:30",
              timezone: "local",
            },
          },
        });
      }),
    );

    expect(published.resources.map((resource) => resource.id)).toEqual([
      "authored-config",
      "authored-credential",
      "authored-directory",
      "authored-file",
      "authored-skill",
      "authored-tool",
      "fixture-tool",
    ]);
    expect(published.scheduleDefault).toEqual({
      type: "daily",
      at: "04:30",
      timezone: "local",
    });
    // SAFETY: publication canonicalBytes is validated JSON with these fields.
    const canonical = JSON.parse(published.canonicalBytes) as {
      readonly scheduleDefault: unknown;
      readonly resources: ReadonlyArray<{ readonly id: string; readonly spec: { readonly kind: string } }>;
    };
    expect(canonical.scheduleDefault).toEqual(published.scheduleDefault);
    expect(canonical.resources.map((resource) => resource.spec.kind)).toEqual([
      "config",
      "credential",
      "directory",
      "file",
      "skill",
      "tool",
      "tool",
    ]);
  });

  it("publishes byte-exact file trees as compact per-file blobs", async () => {
    const fixture = workspace();
    const assets = join(fixture.directory, "profile");
    mkdirSync(assets);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x1a, 0x0a]);
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xff]);
    const native = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x02]);
    writeFileSync(join(assets, "image.png"), png);
    writeFileSync(join(assets, "empty"), Buffer.alloc(0));
    writeFileSync(join(assets, "fixture.zip"), archive);
    writeFileSync(join(assets, "native"), native);
    chmodSync(join(assets, "native"), 0o755);
    symlinkSync("image.png", join(assets, "image-link"));
    const discovery = await proposal(fixture.directory);
    const resources: ReadonlyArray<ProfileResourceInput> = [
      {
        id: "png", kind: "file", target: "~/.bytes/image.png",
        spec: { kind: "file", source: "image.png" },
        verify: { method: "digest", digest: sha256BytesHex(png) },
      },
      {
        id: "empty", kind: "file", target: "~/.bytes/empty",
        spec: { kind: "file", source: "empty" },
        verify: { method: "digest", digest: sha256BytesHex(Buffer.alloc(0)) },
      },
      {
        id: "archive-tree", kind: "directory", target: "~/.bytes/archive",
        spec: { kind: "directory", files: [
          { path: "fixture.zip", source: "fixture.zip" },
          { path: "image-link", source: "image-link" },
        ] },
        verify: { method: "digest" },
      },
      {
        id: "native-skill", kind: "skill", target: "~/.bytes/skill",
        spec: { kind: "skill", name: "native", files: [
          { path: "bin/native", source: "native" },
        ] },
        verify: { method: "digest" },
      },
    ];
    const result = await runCatalog(
      fixture.database,
      makeSigner().signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const revision = yield* catalog.publish({
          ...inputFor(discovery),
          profile: {
            ...inputFor(discovery).profile,
            directory: assets,
            resources,
          },
        });
        const repository = yield* StateRepository;
        const ranges = yield* Effect.forEach(
          revision.resources.flatMap((resource) => resource.blobs),
          (blob) => repository.readResourceBlobRange({
            blob,
            offset: 0,
            maximumBytes: 3,
          }),
        );
        return { revision, ranges };
      }),
    );
    const published = result.revision.resources.filter((resource) =>
      ["png", "empty", "archive-tree", "native-skill"].includes(resource.id)
    );
    expect(published.flatMap((resource) => resource.blobs)).toEqual(
      expect.arrayContaining([
        sha256BytesHex(png),
        sha256BytesHex(Buffer.alloc(0)),
        sha256BytesHex(archive),
        sha256BytesHex(native),
      ]),
    );
    const archiveSpec = published.find((resource) => resource.id === "archive-tree")?.spec;
    expect(archiveSpec?.kind).toBe("directory");
    if (archiveSpec?.kind !== "directory") throw new Error("missing published archive directory");
    expect(archiveSpec.files.find((file) => file.path === "image-link"))
      .toMatchObject({ path: "image-link", symlinkTo: "image.png", executable: false, mode: 0 });
    expect(archiveSpec.files.find((file) => file.path === "fixture.zip"))
      .toMatchObject({ path: "fixture.zip", blob: sha256BytesHex(archive), bytes: archive.byteLength });
    expect(published.find((resource) => resource.id === "native-skill")?.spec)
      .toMatchObject({
        files: [{ path: "bin/native", blob: sha256BytesHex(native), mode: 0o755, executable: true }],
      });
    expect(result.ranges.every((range) => range !== undefined)).toBe(true);
    expect(result.ranges.filter((range) => range?.totalBytes !== 0)
      .every((range) => range?.content.byteLength === 3)).toBe(true);
    expect(result.revision.canonicalBytes).not.toContain(png.toString("base64"));
    expect(result.revision.canonicalBytes).not.toContain("\"content\"");
  });

  it("returns the original immutable revision for duplicate publication", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const result = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const first = yield* catalog.publish(inputFor(discovery));
        const duplicate = yield* catalog.publish({
          ...inputFor(discovery),
          publishedAt: "2026-08-15T13:00:00Z",
        });
        return { first, duplicate };
      }),
    );

    expect(result.duplicate).toEqual(result.first);
    expect(signing.calls).toEqual({ signed: 1, verified: 1 });
  });

  it("uses canonical equivalence for stable content ids and digests", async () => {
    const fixture = workspace();
    const firstProposal = await proposal(fixture.directory);
    const equivalentDirectory = join(fixture.directory, "equivalent");
    mkdirSync(equivalentDirectory);
    const equivalentPath = join(equivalentDirectory, "package.json");
    writeFileSync(equivalentPath, JSON.stringify({
      canonfig: {
        tools: [{
          upstream: "https://example.test/fixture-tool",
          source: "lock:fixture-tool:1.2.3",
          version: "1.2.3",
          executable: "fixture-tool",
          name: "fixture-tool",
          ecosystem: "npm",
        }],
      },
    }, null, 2));
    const equivalentProposal = await Effect.runPromise(scanDiscovery({
      files: [{ path: equivalentPath, kind: "package-metadata" }],
      path: "",
    }));
    expect(digestDiscoveryProposal(equivalentProposal))
      .not.toBe(digestDiscoveryProposal(firstProposal));
    const signing = makeSigner();
    const result = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const first = yield* catalog.publish(inputFor(firstProposal));
        const equivalent = yield* catalog.publish(inputFor(equivalentProposal));
        return { first, equivalent };
      }),
    );

    expect(result.equivalent.id).toBe(result.first.id);
    expect(result.equivalent.digest).toBe(result.first.digest);
    expect(result.equivalent.canonicalBytes).toBe(result.first.canonicalBytes);
  });

  it("increments sequences monotonically and orders resources deterministically", async () => {
    const fixture = workspace();
    const alpha = await proposal(fixture.directory, "alpha-tool", "1.0.0");
    const zed = await proposal(fixture.directory, "zed-tool", "2.0.0");
    const combined = {
      ...alpha,
      resources: [...zed.resources, ...alpha.resources],
      tools: [...zed.tools, ...alpha.tools],
      evidence: [...zed.evidence, ...alpha.evidence],
      agentTasks: [...zed.agentTasks, ...alpha.agentTasks],
      scannedPaths: [...zed.scannedPaths, ...alpha.scannedPaths],
    };
    const changed = await proposal(fixture.directory, "alpha-tool", "1.1.0");
    const signing = makeSigner();
    const result = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const first = yield* catalog.publish(inputFor(combined));
        const second = yield* catalog.publish(inputFor(changed, "Changed profile"));
        return { first, second };
      }),
    );

    expect(result.first.resources.map((resource) => resource.id)).toEqual([
      "alpha-tool",
      "zed-tool",
    ]);
    expect(result.second.sequence).toBe(2);
  });

  it("keeps stored revisions immutable and reports missing lookups", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const result = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const repository = yield* StateRepository;
        const revision = yield* catalog.publish(inputFor(discovery));
        const changed: ProfileRevision = {
          ...revision,
          canonicalBytes: `${revision.canonicalBytes} `,
        };
        const immutable = yield* Effect.flip(
          repository.publishRevision({ revision: changed }),
        );
        const missing = yield* Effect.flip(catalog.getRevision(
          Schema.decodeUnknownSync(ProfileRevisionId)(
            "profile-publication:missing",
          ),
        ));
        return { immutable, missing };
      }),
    );

    expect(result.immutable).toBeInstanceOf(RevisionImmutableError);
    expect(result.missing).toBeInstanceOf(RevisionNotFoundError);
  });

  it("publishes older content again as a new latest revision", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const kept = authoredFile("kept", "kept\n");
    const restorable = authoredFile("restorable", "restorable\n");
    const at = (minute: number, resources: ReadonlyArray<ProfileResourceInput>) => ({
      ...authoredInput(discovery, resources),
      publishedAt: `2026-08-15T12:0${minute}:00Z`,
    });
    const result = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const repository = yield* StateRepository;
        const first = yield* catalog.publish(at(1, [kept, restorable]));
        const removal = yield* catalog.publish(at(2, [kept]));
        const restored = yield* catalog.publish(at(3, [kept, restorable]));
        const repeated = yield* catalog.publish(at(4, [kept, restorable]));
        const latest = yield* repository.getLatestRevision(first.profileId);
        return { first, removal, restored, repeated, latest };
      }),
    );

    expect([result.first.sequence, result.removal.sequence, result.restored.sequence])
      .toEqual([1, 2, 3]);
    expect(result.restored.id).not.toBe(result.first.id);
    expect(result.restored.canonicalBytes).toBe(result.first.canonicalBytes);
    expect(result.restored.publishedAt).toBe("2026-08-15T12:03:00Z");
    expect(result.latest).toEqual(result.restored);
    // Publishing what is already latest stays idempotent.
    expect(result.repeated).toEqual(result.restored);
    expect(signing.calls).toEqual({ signed: 3, verified: 3 });
  });

  it("refuses to sign an empty revision unless the author allows it", async () => {
    const fixture = workspace();
    const scanned = join(fixture.directory, "CLAUDE.md");
    const empty: DiscoveryScanResult = {
      resources: [], tools: [], skills: [], evidence: [], agentTasks: [], scannedPaths: [scanned],
    };
    const signing = makeSigner();
    const result = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const refused = yield* Effect.flip(catalog.publish(inputFor(empty)));
        const signedBeforeAllowing = signing.calls.signed;
        const allowed = yield* catalog.publish({ ...inputFor(empty), allowEmpty: true });
        return { refused, signedBeforeAllowing, allowed };
      }),
    );

    expect(result.refused).toBeInstanceOf(EmptyPublicationError);
    expect(result.refused).toMatchObject({ scannedPaths: [scanned] });
    expect(describeRuntimeError(result.refused)).toMatchObject({
      category: "usage-or-configuration",
      message: expect.stringContaining("--allow-empty"),
    });
    expect(result.signedBeforeAllowing).toBe(0);
    expect(result.allowed.resources).toEqual([]);
  });

  it("reads resource sources only from inside the profile directory", async () => {
    const fixture = workspace();
    const profileDirectory = join(fixture.directory, "profile");
    const elsewhere = join(fixture.directory, "elsewhere");
    mkdirSync(profileDirectory);
    mkdirSync(elsewhere);
    const outside = join(fixture.directory, "outside.txt");
    writeFileSync(outside, "outside the profile\n");
    writeFileSync(join(elsewhere, "nested.txt"), "nested outside\n");
    writeFileSync(join(profileDirectory, "inside.txt"), "inside\n");
    symlinkSync(outside, join(profileDirectory, "escape-link"));
    symlinkSync(elsewhere, join(profileDirectory, "escape-directory"));
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const escaping = ["../outside.txt", "sub/../../outside.txt", outside, "escape-link", "escape-directory/nested.txt"];
    const sourced = (source: string): ProfileResourceInput => ({
      id: "sourced", kind: "file", target: "~/.canonfig/sourced.txt",
      spec: { kind: "file", source }, verify: { method: "digest" },
    });
    const result = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const refused = yield* Effect.forEach(escaping, (source) =>
          Effect.flip(catalog.publish(authoredInput(discovery, [sourced(source)], profileDirectory)))
        );
        const inside = yield* catalog.publish(
          authoredInput(discovery, [sourced("inside.txt")], profileDirectory),
        );
        return { refused, inside };
      }),
    );

    expect(result.refused.map((error) => error instanceof PublicationSourceError ? error.path : error))
      .toEqual(escaping);
    expect(result.refused.map((error) => describeRuntimeError(error).category))
      .toEqual(escaping.map(() => "usage-or-configuration"));
    expect(result.inside.resources.find((resource) => resource.id === "sourced")?.blobs)
      .toEqual([sha256Hex("inside\n")]);
    expect(signing.calls).toEqual({ signed: 1, verified: 1 });
  });

  it("computes omitted digests as followers do and rejects a wrong one before signing", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const configSpec = {
      kind: "config" as const,
      format: "json" as const,
      keys: [{ path: "mcp.enabled", value: true }],
    };
    const config: ProfileResourceInput = {
      id: "client-config", kind: "config", target: "~/.canonfig/client.json",
      spec: configSpec, verify: { method: "digest" },
    };
    const skill: ProfileResourceInput = {
      id: "review-skill", kind: "skill", target: "skills/review-skill",
      spec: { kind: "skill", name: "review-skill", files: [{ path: "SKILL.md", content: "# review\n" }] },
      verify: { method: "digest" },
    };
    const configDigest = sha256BytesHex(renderConfigDocument(configSpec));
    const skillDigest = directoryVerificationDigest([
      { path: "SKILL.md", digest: sha256Hex("# review\n"), executable: false },
    ]);
    const result = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        const computed = yield* catalog.publish(authoredInput(discovery, [config, skill]));
        const wrong = yield* Effect.flip(catalog.publish(authoredInput(discovery, [
          { ...config, verify: { method: "digest", digest: "0".repeat(64) } },
          { ...skill, verify: { method: "digest", digest: skillDigest } },
        ])));
        return { computed, wrong };
      }),
    );

    // SAFETY: publication canonicalBytes is validated JSON with a resources array.
    const canonical = JSON.parse(result.computed.canonicalBytes) as {
      readonly resources: ReadonlyArray<{ readonly id: string; readonly verify: unknown }>;
    };
    expect(canonical.resources.find((resource) => resource.id === "client-config")?.verify)
      .toEqual({ method: "digest", digest: configDigest });
    expect(canonical.resources.find((resource) => resource.id === "review-skill")?.verify)
      .toEqual({ method: "digest", digest: skillDigest });
    expect(result.wrong).toBeInstanceOf(InvalidPublicationResourcesError);
    expect(result.wrong instanceof InvalidPublicationResourcesError ? result.wrong.errors : [])
      .toEqual([expect.objectContaining({
        _tag: "VerificationDigestMismatchError",
        id: "client-config",
        declaredDigest: "0".repeat(64),
        computedDigest: configDigest,
      })]);
    expect(signing.calls).toEqual({ signed: 1, verified: 1 });
  });

  it("rejects an unpinned automatic installer recipe before signing", async () => {
    const fixture = workspace();
    const discovery = await proposal(fixture.directory);
    const signing = makeSigner();
    const error = await runCatalog(
      fixture.database,
      signing.signer,
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* Effect.flip(catalog.publish(authoredInput(discovery, [{
          id: "ruff", kind: "tool", target: "ruff",
          spec: { kind: "tool", toolId: "ruff", recipes: [{ platform: "linux", method: "uv", package: "ruff" }] },
          verify: { method: "command", command: ["ruff", "--version"] },
        }])));
      }),
    );

    expect(error instanceof InvalidPublicationResourcesError ? error.errors : error)
      .toEqual([expect.objectContaining({
        _tag: "InvalidRecipeError",
        id: "ruff",
        reason: expect.stringContaining("requires an exact \"version\""),
      })]);
    expect(signing.calls).toEqual({ signed: 0, verified: 0 });
  });
});
