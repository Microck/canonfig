// Publishes and digests `source` files of increasing size through the real
// catalog and repository in one process, and reports the peak RSS each run
// adds over the RSS before it. Run by tests/publication.test.ts with the
// profile directory holding warm.bin, medium.bin, and large.bin.
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

import { Effect, Schema } from "effect";

import { SourceSignature } from "../../../src/domain/brand.ts";
import type { ProfileResourceInput } from "../../../src/domain/profile.ts";
import { profileContentDigests } from "../../../src/profile/compiler.ts";
import { profileCatalogLayer } from "../../../src/profile/profile-catalog.layer.ts";
import { ProfileCatalog } from "../../../src/profile/profile-catalog.service.ts";
import type { DiscoveryScanResult } from "../../../src/profile/discovery.ts";
import {
  acceptPublicationProposal,
  resolveResourceSources,
  type ProfileRevisionSigner,
} from "../../../src/profile/publication.ts";
import { stateRepositoryLayer } from "../../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../../src/state/state-repository.service.ts";

const [database, directory, output] = process.argv.slice(2) as [string, string, string];
const keys = generateKeyPairSync("ed25519");
const signer: ProfileRevisionSigner = {
  keyId: "test-source-key",
  sign: (payload) =>
    Effect.sync(() =>
      Schema.decodeUnknownSync(SourceSignature)(
        `ed25519:${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`,
      )
    ),
  verify: () => Effect.succeed(true),
};
const emptyDiscoveryProposal: DiscoveryScanResult = {
  resources: [],
  tools: [],
  skills: [],
  evidence: [],
  agentTasks: [],
  scannedPaths: [],
};
const sourced = (id: string, source: string): ProfileResourceInput => ({
  id,
  kind: "file",
  target: `~/.canonfig/${id}`,
  spec: { kind: "file", source },
  verify: { method: "digest" },
});

const run = (resources: ReadonlyArray<ProfileResourceInput>) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const catalog = yield* ProfileCatalog;
      const now = new Date().toISOString();
      const profile = {
        id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("ProfileId")))("large-profile"),
        name: "Large",
      };
      const revision = yield* catalog.publish({
        proposal: emptyDiscoveryProposal,
        profile: { ...profile, resources, directory },
        review: acceptPublicationProposal(emptyDiscoveryProposal, "reviewer@example.test", now),
        publishedAt: now,
      });
      const resolved = yield* resolveResourceSources(resources, directory);
      const digests = profileContentDigests(
        { ...profile, version: 2, groups: [], resources: resolved.resources },
        resolved.sources,
      );
      const repository = yield* StateRepository;
      const range = yield* repository.readResourceBlobRange({
        blob: digests.find((entry) => entry.id === resources.at(-1)!.id)!.computedDigest,
        offset: 0,
        maximumBytes: 8 * 1024 * 1024,
      });
      return { revision, digests, range };
    }).pipe(
      Effect.provide(profileCatalogLayer(signer)),
      Effect.provide(stateRepositoryLayer(database)),
    ),
  );

/** Peak RSS a run adds over the RSS before it, sampled while it runs. */
const measure = async (resources: ReadonlyArray<ProfileResourceInput>) => {
  // Run with --expose-gc so the baseline excludes collectable garbage.
  if (typeof globalThis.gc === "function") globalThis.gc();
  // getrusage maxRSS is a process-lifetime high-water mark, so the peak is
  // sampled from the current RSS instead.
  const baseline = process.memoryUsage.rss();
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 5);
  const result = await run(resources);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage.rss());
  return { result, growthKiB: Math.round((peak - baseline) / 1024) };
};

// The warm-up file grows the SQLite page cache and allocator pools to their
// steady size, so later runs add only what depends on file size.
await measure([sourced("warm", "warm.bin")]);
const medium = await measure([sourced("medium", "medium.bin")]);
const large = await measure([sourced("large", "large.bin")]);
const spec = large.result.revision.resources.find((entry) => entry.id === "large")?.spec;
writeFileSync(output, JSON.stringify({
  mediumGrowthKiB: medium.growthKiB,
  largeGrowthKiB: large.growthKiB,
  digest: large.result.digests.find((entry) => entry.id === "large")!.computedDigest,
  blobBytes: spec?.kind === "file" ? spec.bytes : undefined,
  rangeBytes: large.result.range?.byteLength,
  rangeChunks: large.result.range?.chunks.length,
}));
