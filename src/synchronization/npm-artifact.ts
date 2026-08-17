import { createHash, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

import { Effect, Schema } from "effect";

const defaultMaximumBytes = 32 * 1024 * 1024;
const defaultTimeoutMilliseconds = 30_000;

export class NpmArtifactError extends Schema.TaggedError<NpmArtifactError>()(
  "NpmArtifactError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface NpmArtifactDownloadInput {
  readonly source: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly cacheDirectory: string;
  readonly maximumBytes?: number | undefined;
  readonly timeoutMilliseconds?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface VerifiedNpmArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly integrity: string;
  readonly source: string;
}

export interface NpmArtifactResponse {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface NpmArtifactRequestOptions {
  readonly timeoutMilliseconds: number;
  readonly signal?: AbortSignal | undefined;
}

export type NpmArtifactRequest = (
  source: string,
  options: NpmArtifactRequestOptions,
) => Promise<NpmArtifactResponse>;

export interface NpmArtifactTransport {
  readonly download: (
    input: NpmArtifactDownloadInput,
  ) => Effect.Effect<VerifiedNpmArtifact, NpmArtifactError>;
}

const safeBase64 = /^[A-Za-z0-9+/]+={0,2}$/u;

const expectedIntegrity = (
  value: string,
): { readonly algorithm: "sha256" | "sha512"; readonly digest: Buffer } | undefined => {
  const match = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (match === null || !safeBase64.test(match[2]!)) return undefined;
  const algorithm = match[1];
  if (algorithm !== "sha256" && algorithm !== "sha512") return undefined;
  const digest = Buffer.from(match[2]!, "base64");
  if (digest.byteLength !== (algorithm === "sha256" ? 32 : 64)) return undefined;
  return { algorithm, digest };
};

export const verifyNpmArtifactBytes = (
  bytes: Uint8Array,
  integrity: string,
): boolean => {
  const expected = expectedIntegrity(integrity);
  if (expected === undefined) return false;
  const actual = createHash(expected.algorithm).update(bytes).digest();
  return actual.length === expected.digest.length
    && actual.equals(expected.digest);
};

const npmTarballPath = (
  packageName: string,
  version: string,
): string => {
  const packagePart = packageName.startsWith("@")
    ? packageName.slice(packageName.indexOf("/") + 1)
    : packageName;
  return `/${packageName}/-/${packagePart}-${version}.tgz`;
};

/**
 * A reviewed artifact is a single, exact npm registry URL. This check is
 * intentionally stricter than URL parsing: equivalent spellings must not
 * create multiple cache identities or permit an origin/path substitution.
 */
export const validateNpmArtifactSource = (
  source: string,
  packageName: string,
  version: string,
): string | undefined => {
  const expected = `https://registry.npmjs.org${npmTarballPath(packageName, version)}`;
  if (source !== expected) {
    return "source is not the canonical npm registry tarball for the declared package and version";
  }
  try {
    const url = new URL(source);
    if (
      url.protocol !== "https:"
      || url.origin !== "https://registry.npmjs.org"
      || url.username.length > 0
      || url.password.length > 0
      || url.search.length > 0
      || url.hash.length > 0
      || url.port.length > 0
      || decodeURIComponent(url.pathname) !== npmTarballPath(packageName, version)
    ) {
      return "source is not a credential-free canonical HTTPS npm registry tarball";
    }
  } catch {
    return "source is not a valid canonical HTTPS npm registry tarball";
  }
  return undefined;
};

const validateInput = (
  input: NpmArtifactDownloadInput,
): string | undefined =>
  validateNpmArtifactSource(input.source, input.packageName, input.version)
  ?? (expectedIntegrity(input.integrity) === undefined
    ? "artifact integrity must be a supported sha256 or sha512 SRI value"
    : undefined);

const filesystemMessage = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message.replace(/\s+/gu, " ").slice(0, 1024)
    : "filesystem operation failed";

const cacheName = (integrity: string): string =>
  `${integrity.replaceAll("/", "_").replaceAll("+", "-")}.tgz`;

const cachePathFor = (
  input: NpmArtifactDownloadInput,
): string => join(input.cacheDirectory, cacheName(input.integrity));

const cacheLockPathFor = (path: string): string => `${path}.lock`;

const ensureCacheDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
};

const readVerifiedCache = async (
  path: string,
  integrity: string,
  maximumBytes: number,
): Promise<Uint8Array | undefined> => {
  try {
    const details = await lstat(path);
    if (!details.isFile()) {
      await rm(path, { force: true });
      return undefined;
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > maximumBytes || !verifyNpmArtifactBytes(bytes, integrity)) {
      await rm(path, { force: true });
      return undefined;
    }
    return bytes;
  } catch {
    return undefined;
  }
};

const writeVerifiedCache = async (
  path: string,
  chunks: AsyncIterable<Uint8Array>,
  integrity: string,
  maximumBytes: number,
  signal?: AbortSignal | undefined,
): Promise<number> => {
  const temporary = `${path}.${randomUUID()}.part`;
  const expected = expectedIntegrity(integrity);
  if (expected === undefined) throw new Error("unsupported artifact integrity");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0;
  const hash = createHash(expected.algorithm);
  try {
    handle = await open(temporary, "wx", 0o600);
    for await (const chunk of chunks) {
      if (signal?.aborted === true) throw new Error("artifact download interrupted");
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        throw new Error("artifact response exceeds the size limit");
      }
      hash.update(value);
      await handle.write(value);
    }
    if (signal?.aborted === true) throw new Error("artifact download interrupted");
    if (!hash.digest().equals(expected.digest)) {
      throw new Error("artifact integrity mismatch");
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    return bytes;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const acquireCacheLock = async (
  path: string,
  timeoutMilliseconds: number,
): Promise<Awaited<ReturnType<typeof open>>> =>
  open(cacheLockPathFor(path), "wx", 0o600).catch(async (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
    const details = await lstat(cacheLockPathFor(path)).catch(() => {
      throw cause;
    });
    if (Date.now() - details.mtimeMs <= timeoutMilliseconds) throw cause;
    await rm(cacheLockPathFor(path), { force: true });
    return await open(cacheLockPathFor(path), "wx", 0o600);
  });

const releaseCacheLock = async (
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> => {
  await handle.close().catch(() => undefined);
  await rm(cacheLockPathFor(path), { force: true }).catch(() => undefined);
};

const incomingMessageRequest = (
  source: string,
  options: NpmArtifactRequestOptions,
): Promise<NpmArtifactResponse> =>
  new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const request = httpsRequest(source, {
      method: "GET",
      headers: {
        accept: "application/octet-stream",
        "accept-encoding": "identity",
      },
    }, (response) => {
      settled = true;
      resolveResponse({
        statusCode: response.statusCode ?? 500,
        headers: response.headers,
        // SAFETY: IncomingMessage is Node's async iterable readable response;
        // each yielded Buffer is a Uint8Array consumed by the bounded writer.
        body: response as IncomingMessage & AsyncIterable<Uint8Array>,
      });
    });
    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      rejectResponse(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const abort = (): void => {
      request.destroy(new Error("artifact download interrupted"));
    };
    if (options.signal?.aborted === true) {
      fail(new Error("artifact download interrupted"));
      request.destroy();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    request.setTimeout(options.timeoutMilliseconds, () => {
      request.destroy(new Error("artifact request timed out"));
    });
    request.once("error", fail);
    request.once("close", () => options.signal?.removeEventListener("abort", abort));
    request.end();
  });

const downloadWithRequest = (
  request: NpmArtifactRequest,
  input: NpmArtifactDownloadInput,
): Effect.Effect<VerifiedNpmArtifact, NpmArtifactError> =>
  Effect.gen(function*() {
    const invalid = validateInput(input);
    if (invalid !== undefined) {
      return yield* new NpmArtifactError({
        operation: "validate npm artifact",
        message: invalid,
      });
    }
    const maximumBytes = input.maximumBytes ?? defaultMaximumBytes;
    const timeoutMilliseconds = input.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
    if (
      !Number.isSafeInteger(maximumBytes)
      || maximumBytes <= 0
      || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds <= 0
    ) {
      return yield* new NpmArtifactError({
        operation: "validate npm artifact limits",
        message: "artifact size and timeout limits must be positive safe integers",
      });
    }
    const path = cachePathFor(input);
    yield* Effect.tryPromise({
      try: () => ensureCacheDirectory(input.cacheDirectory),
      catch: (cause) => new NpmArtifactError({
        operation: "create npm artifact cache",
        message: filesystemMessage(cause),
      }),
    });
    const cached = yield* Effect.tryPromise({
      try: () => readVerifiedCache(path, input.integrity, maximumBytes),
      catch: (cause) => new NpmArtifactError({
        operation: "read npm artifact cache",
        message: filesystemMessage(cause),
      }),
    });
    if (cached !== undefined) {
      return {
        path,
        bytes: cached.byteLength,
        integrity: input.integrity,
        source: input.source,
      };
    }
    const lockAttempt = yield* Effect.tryPromise({
      try: () => acquireCacheLock(path, timeoutMilliseconds),
      catch: (cause) => new NpmArtifactError({
        operation: "lock npm artifact cache",
        message: filesystemMessage(cause),
      }),
    }).pipe(Effect.match({
      onFailure: (error) => ({ error }),
      onSuccess: (handle) => ({ handle }),
    }));
    if ("error" in lockAttempt) {
      const concurrent = yield* Effect.promise(() =>
        readVerifiedCache(path, input.integrity, maximumBytes).catch(() => undefined)
      );
      if (concurrent !== undefined) {
        return {
          path,
          bytes: concurrent.byteLength,
          integrity: input.integrity,
          source: input.source,
        };
      }
      return yield* new NpmArtifactError({
        operation: "lock npm artifact cache",
        message: "artifact cache is being written concurrently",
      });
    }
    const lock = lockAttempt.handle;
    const lockedDownload = Effect.gen(function*() {
      const lockedCached = yield* Effect.tryPromise({
        try: () => readVerifiedCache(path, input.integrity, maximumBytes),
        catch: (cause) => new NpmArtifactError({
          operation: "read npm artifact cache",
          message: filesystemMessage(cause),
        }),
      });
      if (lockedCached !== undefined) {
        return {
          path,
          bytes: lockedCached.byteLength,
          integrity: input.integrity,
          source: input.source,
        };
      }
      const response = yield* Effect.tryPromise({
        try: () => request(input.source, {
          timeoutMilliseconds,
          signal: input.signal,
        }),
        catch: (cause) => new NpmArtifactError({
          operation: "request npm artifact",
          message: cause instanceof Error
            ? cause.message.replace(/\s+/gu, " ").slice(0, 1024)
            : "artifact request failed",
        }),
      });
      if (response.statusCode !== 200) {
        return yield* new NpmArtifactError({
          operation: "request npm artifact",
          message: response.statusCode >= 300 && response.statusCode < 400
            ? "artifact redirects are not followed"
            : `artifact request returned status ${response.statusCode}`,
        });
      }
      const written = yield* Effect.tryPromise({
        try: () => writeVerifiedCache(
          path,
          response.body,
          input.integrity,
          maximumBytes,
          input.signal,
        ),
        catch: (cause) => new NpmArtifactError({
          operation: "verify and cache npm artifact",
          message: cause instanceof Error
            ? cause.message.replace(/\s+/gu, " ").slice(0, 1024)
            : "artifact could not be verified and cached",
        }),
      });
      return {
        path,
        bytes: written,
        integrity: input.integrity,
        source: input.source,
      };
    });
    return yield* lockedDownload.pipe(
      Effect.ensuring(Effect.promise(() => releaseCacheLock(path, lock))),
    );
  });

export const makeNpmArtifactTransport = (
  request: NpmArtifactRequest = incomingMessageRequest,
): NpmArtifactTransport => ({
  download: (input) => downloadWithRequest(request, input),
});

export const defaultNpmArtifactTransport = makeNpmArtifactTransport();
