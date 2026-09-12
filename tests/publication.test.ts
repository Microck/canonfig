import { generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { scanDiscovery } from "../src/profile/discovery.ts";
import {
  InvalidPublicationResourcesError,
  PublicationReviewRequiredError,
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
import { sha256BytesHex, sha256Hex } from "../src/profile/profile-codec.ts";

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

const runCatalog = <A, E>(
  database: string,
  signer: ProfileRevisionSigner,
  effect: Effect.Effect<A, E, ProfileCatalog>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(
    Effect.provide(profileCatalogLayer(signer)),
    Effect.provide(stateRepositoryLayer(database)),
  ));

describe("reviewed profile publication", () => {
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
        verify: { method: "digest", digest: "b".repeat(64) },
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
        verify: { method: "digest", digest: "c".repeat(64) },
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
        verify: { method: "digest", digest: "d".repeat(64) },
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
        verify: { method: "digest", digest: "a".repeat(64) },
      },
      {
        id: "native-skill", kind: "skill", target: "~/.bytes/skill",
        spec: { kind: "skill", name: "native", files: [
          { path: "bin/native", source: "native" },
        ] },
        verify: { method: "digest", digest: "b".repeat(64) },
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
});
