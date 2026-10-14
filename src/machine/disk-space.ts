import { lstat, statfs } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Schema } from "effect";

import { InsufficientDiskError } from "./machine-state.errors.ts";

/** Room left on each filesystem for metadata, journals and rounding. */
export const diskMarginBytes = 4n * 1024n * 1024n;

export interface DiskRequirement {
  /** A path the bytes will be written under; it need not exist yet. */
  readonly path: string;
  readonly bytes: bigint;
}

interface FilesystemProbe {
  readonly device: number | bigint;
  readonly availableBytes: bigint;
}

const ErrorWithCode = Schema.Struct({ code: Schema.String });

const errorCode = (cause: unknown): string | undefined =>
  Schema.is(ErrorWithCode)(cause) ? cause.code : undefined;

/**
 * Probe the filesystem a path will be written on. A path that does not exist
 * yet lives on the filesystem of its nearest existing ancestor. A filesystem
 * that cannot be measured is not a blocker: the write itself still fails
 * safely if space runs out.
 */
const probe = async (
  path: string,
  statfsImpl: typeof statfs,
): Promise<FilesystemProbe | undefined> => {
  let candidate = path;
  for (;;) {
    try {
      const metadata = await lstat(candidate);
      const usage = await statfsImpl(candidate);
      return {
        device: metadata.dev,
        availableBytes: BigInt(usage.bavail) * BigInt(usage.bsize),
      };
    } catch (cause) {
      const parent = dirname(candidate);
      if (errorCode(cause) !== "ENOENT" || parent === candidate) return undefined;
      candidate = parent;
    }
  }
};

/** Free bytes on the filesystem holding `path`, or 0 when it cannot be measured. */
export const availableBytes = (
  path: string,
  statfsImpl: typeof statfs = statfs,
): Effect.Effect<bigint> =>
  Effect.promise(() => probe(path, statfsImpl)).pipe(
    Effect.map((measured) => measured?.availableBytes ?? 0n),
  );

/**
 * Check that every filesystem touched by `requirements` can hold what will be
 * written to it, plus a margin. Requirements on the same filesystem add up.
 * Fails with the first filesystem that cannot, naming a path on it.
 */
export const requireFreeSpace = (
  requirements: ReadonlyArray<DiskRequirement>,
  statfsImpl: typeof statfs = statfs,
): Effect.Effect<void, InsufficientDiskError> =>
  Effect.gen(function*() {
    const filesystems = new Map<number | bigint, {
      readonly path: string;
      readonly availableBytes: bigint;
      requiredBytes: bigint;
    }>();
    for (const requirement of requirements) {
      const measured = yield* Effect.promise(() => probe(requirement.path, statfsImpl));
      if (measured === undefined) continue;
      const existing = filesystems.get(measured.device);
      if (existing === undefined) {
        filesystems.set(measured.device, {
          path: requirement.path,
          availableBytes: measured.availableBytes,
          requiredBytes: diskMarginBytes + requirement.bytes,
        });
      } else {
        existing.requiredBytes += requirement.bytes;
      }
    }
    for (const filesystem of filesystems.values()) {
      if (filesystem.availableBytes < filesystem.requiredBytes) {
        return yield* new InsufficientDiskError({
          path: filesystem.path,
          requiredBytes: filesystem.requiredBytes,
          availableBytes: filesystem.availableBytes,
        });
      }
    }
  });
