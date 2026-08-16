import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProfileRevisionId,
  SourceSignature,
} from "../src/domain/brand.ts";
import type { ProfileRevision } from "../src/domain/profile.ts";
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
    expect(published.revision.sequence).toBe(1);
    expect(published.revision.id).toBe(
      `profile-publication:${published.revision.digest}`,
    );
    expect(published.revision.resources[0]?.blobs[0]).toMatch(/^[a-f0-9]{64}$/u);
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
