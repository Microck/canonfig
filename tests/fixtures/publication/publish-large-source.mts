// Publishes Canonical Folders holding files of increasing size through the
// real catalog and repository in one process, and reports the peak RSS each
// run adds over the RSS before it. Run by tests/publication.test.ts with the
// root holding the folders warm/, medium/ and large/, each with one skill of
// the same name whose data.bin is the large file.
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { SourceSignature } from "../../../src/domain/brand.ts";
import { profileCatalogLayer } from "../../../src/profile/profile-catalog.layer.ts";
import { ProfileCatalog } from "../../../src/profile/profile-catalog.service.ts";
import type { ProfileRevisionSigner } from "../../../src/profile/publication.ts";
import { stateRepositoryLayer } from "../../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../../src/state/state-repository.service.ts";

const [database, root, output] = process.argv.slice(2) as [string, string, string];
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

/** Publish one folder and read back the first 8 MiB of its large file's blob. */
const run = (name: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const catalog = yield* ProfileCatalog;
      const revision = yield* catalog.publish({
        folder: join(root, name),
        reviewer: "reviewer@example.test",
        publishedAt: new Date().toISOString(),
      });
      const spec = revision.resources.find((entry) => entry.id === `skills:${name}`)?.spec;
      const file = spec?.kind === "skill" ? spec.files.find((entry) => entry.path === "data.bin") : undefined;
      if (file?.blob === undefined) throw new Error(`the ${name} revision has no data.bin blob`);
      const repository = yield* StateRepository;
      const range = yield* repository.readResourceBlobRange({ blob: file.blob, offset: 0, maximumBytes: 8 * 1024 * 1024 });
      return { blob: file.blob, bytes: file.bytes, range };
    }).pipe(
      Effect.provide(profileCatalogLayer(signer)),
      Effect.provide(stateRepositoryLayer(database)),
    ),
  );

/** Peak RSS a run adds over the RSS before it, sampled while it runs. */
const measure = async (name: string) => {
  // Run with --expose-gc so the baseline excludes collectable garbage.
  if (typeof globalThis.gc === "function") globalThis.gc();
  // getrusage maxRSS is a process-lifetime high-water mark, so the peak is
  // sampled from the current RSS instead.
  const baseline = process.memoryUsage.rss();
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 5);
  const result = await run(name);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage.rss());
  return { result, growthKiB: Math.round((peak - baseline) / 1024) };
};

// The warm-up file grows the SQLite page cache and allocator pools to their
// steady size, so later runs add only what depends on file size.
await measure("warm");
const medium = await measure("medium");
const large = await measure("large");
writeFileSync(output, JSON.stringify({
  mediumGrowthKiB: medium.growthKiB,
  largeGrowthKiB: large.growthKiB,
  digest: large.result.blob,
  blobBytes: large.result.bytes,
  rangeBytes: large.result.range?.byteLength,
  rangeChunks: large.result.range?.chunks.length,
}));
