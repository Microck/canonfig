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
import { gunzipSync } from "node:zlib";

import { Effect, Schema } from "effect";
import type { JsonValue } from "../profile/profile-codec.ts";

const defaultMaximumBytes = 32 * 1024 * 1024;
const defaultTimeoutMilliseconds = 30_000;
const maximumArchiveEntries = 4_096;
const maximumArchiveBytes = 128 * 1024 * 1024;
const maximumManifestBytes = 1 * 1024 * 1024;
const tarBlockBytes = 512;

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

const NpmJsonObject = Schema.Record(Schema.String, Schema.MutableJson);
type NpmJsonObject = Schema.Schema.Type<typeof NpmJsonObject>;

interface NpmPackageManifest {
  readonly path: string;
  readonly directory: string;
  readonly value: NpmJsonObject;
}

interface NpmArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes?: Uint8Array | undefined;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

const tarString = (
  header: Uint8Array,
  offset: number,
  length: number,
): string => {
  const end = header.subarray(offset, offset + length).indexOf(0);
  const value = header.subarray(
    offset,
    offset + (end < 0 ? length : end),
  );
  return textDecoder.decode(value);
};

const tarOctal = (
  header: Uint8Array,
  offset: number,
  length: number,
): number | undefined => {
  const raw = tarString(header, offset, length).replace(/^\s+|\s+$/gu, "");
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) return undefined;
  const value = Number.parseInt(raw, 8);
  return Number.isSafeInteger(value) ? value : undefined;
};

const tarChecksumValid = (header: Uint8Array): boolean => {
  const expected = tarOctal(header, 148, 8);
  if (expected === undefined) return false;
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return actual === expected;
};

const normalizedArchivePath = (name: string, prefix: string): string | undefined => {
  const rawPath = `${prefix}${prefix.length > 0 && name.length > 0 ? "/" : ""}${name}`;
  const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (
    path.length === 0
    || path.includes("\0")
    || path.includes("\\")
    || path.startsWith("/")
    || path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    || (path !== "package" && !path.startsWith("package/"))
  ) {
    return undefined;
  }
  return path;
};

type ArchiveParseResult =
  | { readonly ok: true; readonly entries: ReadonlyArray<NpmArchiveEntry> }
  | { readonly ok: false; readonly message: string };

const parseNpmArchive = (bytes: Uint8Array): ArchiveParseResult => {
  let expanded: Uint8Array;
  try {
    expanded = gunzipSync(bytes, { maxOutputLength: maximumArchiveBytes });
  } catch {
    return {
      ok: false,
      message: "npm artifact is not a bounded gzip-compressed tar archive",
    };
  }
  const entries: Array<NpmArchiveEntry> = [];
  const byPath = new Map<string, NpmArchiveEntry>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + tarBlockBytes <= expanded.byteLength) {
    const header = expanded.subarray(offset, offset + tarBlockBytes);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += tarBlockBytes;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;
    if (entries.length >= maximumArchiveEntries || !tarChecksumValid(header)) {
      return {
        ok: false,
        message: "npm artifact has too many entries or an invalid tar header",
      };
    }
    let name: string;
    let prefix: string;
    try {
      name = tarString(header, 0, 100);
      prefix = tarString(header, 345, 155);
    } catch {
      return { ok: false, message: "npm artifact contains an invalid UTF-8 tar path" };
    }
    const path = normalizedArchivePath(name, prefix);
    if (path === undefined) return { ok: false, message: "npm artifact contains an unsafe tar path" };
    const type = header[156];
    const kind = type === 0 || type === 48
      ? "file"
      : type === 5
      ? "directory"
      : undefined;
    if (kind === undefined) {
      return {
        ok: false,
        message: "npm artifact contains a symlink, hardlink, special file, or extended tar entry",
      };
    }
    const size = tarOctal(header, 124, 12);
    if (size === undefined || size > maximumArchiveBytes) {
      return {
        ok: false,
        message: "npm artifact contains an invalid or oversized tar entry",
      };
    }
    const dataOffset = offset + tarBlockBytes;
    const paddedSize = Math.ceil(size / tarBlockBytes) * tarBlockBytes;
    if (
      dataOffset > expanded.byteLength
      || paddedSize > expanded.byteLength - dataOffset
      || entries.reduce((total, entry) => total + (entry.bytes?.byteLength ?? 0), 0) + size
        > maximumArchiveBytes
    ) {
      return { ok: false, message: "npm artifact exceeds the archive decompression limit" };
    }
    const entry: NpmArchiveEntry = {
      path,
      kind,
      bytes: kind === "file"
        ? expanded.slice(dataOffset, dataOffset + size)
        : undefined,
    };
    if (byPath.has(path)) {
      return { ok: false, message: "npm artifact contains duplicate tar paths" };
    }
    if (
      kind === "file"
      && [...byPath.keys()].some((existing) => existing.startsWith(`${path}/`))
    ) {
      return {
        ok: false,
        message: "npm artifact contains a file/descendant tar path collision",
      };
    }
    const pathParts = path.split("/");
    for (let index = 1; index < pathParts.length - 1; index += 1) {
      const ancestorPath = pathParts.slice(0, index + 1).join("/");
      if (byPath.get(ancestorPath)?.kind === "file") {
        return {
          ok: false,
          message: "npm artifact contains a file/descendant tar path collision",
        };
      }
    }
    byPath.set(path, entry);
    entries.push(entry);
    offset = dataOffset + paddedSize;
  }
  if (
    zeroBlocks < 2
    || expanded.subarray(offset).some((byte) => byte !== 0)
  ) {
    return { ok: false, message: "npm artifact has truncated or trailing tar data" };
  }
  return { ok: true, entries };
};

type DependencyObjectResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string };

const dependencyObject = (
  value: JsonValue | undefined,
  field: string,
): DependencyObjectResult => {
  if (value === undefined) return { ok: true, value: {} };
  if (!Schema.is(NpmJsonObject)(value)) {
    return {
      ok: false,
      message: `npm package manifest field ${field} must be an object`,
    };
  }
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (
      !/^(?:[A-Za-z0-9][A-Za-z0-9._~-]*|@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+)$/u.test(name)
      || !Schema.is(Schema.String)(spec)
      || spec.length === 0
    ) {
      return {
        ok: false,
        message: `npm package manifest has an invalid ${field} dependency`,
      };
    }
    result[name] = spec;
  }
  return { ok: true, value: result };
};

const dependencySpecificationError = (
  field: string,
  name: string,
  specification: string,
): string | undefined =>
  /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specification)
    || specification.startsWith("git@")
    || specification.includes("\\")
    || /^(?:\.{1,2}[/]|[/]|~[/]|[A-Za-z]:[/])/u.test(specification)
    ? `npm package manifest ${field} dependency ${name} is an external or ambiguous specification`
    : undefined;

const embeddedPackageManifest = (
  manifests: ReadonlyMap<string, NpmPackageManifest>,
  directory: string,
  name: string,
): NpmPackageManifest | undefined => {
  let current = directory;
  while (current.startsWith("package")) {
    const candidate = `${current}/node_modules/${name}/package.json`;
    const manifest = manifests.get(candidate);
    if (manifest !== undefined) return manifest;
    if (current === "package") break;
    const separator = current.lastIndexOf("/");
    if (separator < 0) break;
    current = current.slice(0, separator);
  }
  return undefined;
};

type BundledDependencyResult =
  | { readonly ok: true; readonly value: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

const bundledDependencyNames = (
  manifest: NpmPackageManifest,
): BundledDependencyResult => {
  const bundled = manifest.value.bundledDependencies;
  const bundle = manifest.value.bundleDependencies;
  if (bundled !== undefined && bundle !== undefined) {
    return {
      ok: false,
      message: "npm package manifest has ambiguous bundledDependencies and bundleDependencies",
    };
  }
  const value = bundled ?? bundle;
  if (value === undefined) return { ok: true, value: [] };
  if (!Schema.is(Schema.Array(Schema.String))(value) || value.some((name) =>
    !/^(?:[A-Za-z0-9][A-Za-z0-9._~-]*|@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+)$/u.test(name)
  )) {
    return {
      ok: false,
      message: "npm package manifest has invalid bundled dependency metadata",
    };
  }
  if (new Set(value).size !== value.length) {
    return {
      ok: false,
      message: "npm package manifest has duplicate bundled dependency metadata",
    };
  }
  return { ok: true, value };
};

/**
 * Inspect the exact reviewed tarball before giving it to a package manager.
 * The top-level SRI digest authenticates every byte, while this inspection
 * proves that npm has no unreviewed dependency or package-manager indirection
 * to resolve. Only dependency trees physically embedded in the same archive
 * are accepted.
 */
export const validateNpmArtifactProvenance = (
  bytes: Uint8Array,
  packageName?: string | undefined,
  version?: string | undefined,
): string | undefined => {
  const parsed = parseNpmArchive(bytes);
  if (!parsed.ok) return parsed.message;
  const manifests = new Map<string, NpmPackageManifest>();
  for (const entry of parsed.entries) {
    if (!entry.path.endsWith("/package.json") || entry.kind !== "file") continue;
    const content = entry.bytes;
    if (content === undefined || content.byteLength > maximumManifestBytes) {
      return "npm package manifest exceeds the size limit";
    }
    let value: JsonValue;
    try {
      value = Schema.decodeUnknownSync(Schema.MutableJson)(
        JSON.parse(textDecoder.decode(content)),
      );
    } catch {
      return "npm artifact contains invalid package manifest JSON";
    }
    if (!Schema.is(NpmJsonObject)(value)) {
      return "npm package manifest must be a JSON object";
    }
    const directory = entry.path.slice(0, -"/package.json".length);
    manifests.set(entry.path, {
      path: entry.path,
      directory,
      value,
    });
  }
  const root = manifests.get("package/package.json");
  if (root === undefined) return "npm artifact has no unambiguous package/package.json";
  if (
    packageName !== undefined
    && (
      !Schema.is(Schema.String)(root.value.name)
      || root.value.name !== packageName
    )
  ) {
    return "npm package manifest name does not match the reviewed package";
  }
  if (
    version !== undefined
    && (
      !Schema.is(Schema.String)(root.value.version)
      || root.value.version !== version
    )
  ) {
    return "npm package manifest version does not match the reviewed version";
  }
  const bundled = bundledDependencyNames(root);
  if (!bundled.ok) return bundled.message;
  const bundledSet = new Set(bundled.value);
  const rootDependencies = dependencyObject(root.value.dependencies, "dependencies");
  const rootOptionalDependencies = dependencyObject(
    root.value.optionalDependencies,
    "optionalDependencies",
  );
  if (!rootDependencies.ok) return rootDependencies.message;
  if (!rootOptionalDependencies.ok) return rootOptionalDependencies.message;
  if (
    root.value.peerDependencies !== undefined
    || root.value.peerDependenciesMeta !== undefined
  ) {
    return "npm package manifest declares peer dependency resolution metadata";
  }
  if (
    root.value.packageManager !== undefined
    || root.value.devEngines !== undefined
    || root.value.workspaces !== undefined
  ) {
    return "npm package manifest declares install-time package manager indirection";
  }
  const rootDependencyNames = new Set([
    ...Object.keys(rootDependencies.value),
    ...Object.keys(rootOptionalDependencies.value),
  ]);
  for (const name of rootDependencyNames) {
    if (!bundledSet.has(name)) {
      return `npm package dependency ${name} is not declared as bundled`;
    }
  }
  for (const name of bundledSet) {
    if (embeddedPackageManifest(manifests, root.directory, name) === undefined) {
      return `npm bundled dependency ${name} is not embedded in the artifact`;
    }
  }
  if (rootDependencyNames.size === 0 && bundledSet.size > 0) {
    return "npm artifact has bundled dependencies without declared dependencies";
  }
  const referencedManifestPaths = new Set<string>([root.path]);
  for (const manifest of manifests.values()) {
    if (
      manifest.path !== root.path
      && !manifest.path.includes("/node_modules/")
    ) {
      return "npm artifact contains a package manifest outside node_modules";
    }
    const dependencies = dependencyObject(manifest.value.dependencies, "dependencies");
    const optionalDependencies = dependencyObject(
      manifest.value.optionalDependencies,
      "optionalDependencies",
    );
    if (!dependencies.ok) return dependencies.message;
    if (!optionalDependencies.ok) return optionalDependencies.message;
    if (
      manifest.value.peerDependencies !== undefined
      || manifest.value.peerDependenciesMeta !== undefined
    ) {
      return "npm embedded package declares peer dependency resolution metadata";
    }
    if (
      manifest.value.packageManager !== undefined
      || manifest.value.devEngines !== undefined
      || manifest.value.workspaces !== undefined
    ) {
      return "npm embedded package declares install-time package manager indirection";
    }
    for (const [field, values] of [
      ["dependencies", dependencies.value],
      ["optionalDependencies", optionalDependencies.value],
    ] as const) {
      for (const [name, specification] of Object.entries(values)) {
        const specificationError = dependencySpecificationError(field, name, specification);
        if (specificationError !== undefined) return specificationError;
        const embedded = embeddedPackageManifest(manifests, manifest.directory, name);
        if (embedded === undefined) {
          return `npm embedded package dependency ${name} is not fully embedded`;
        }
        referencedManifestPaths.add(embedded.path);
      }
    }
  }
  for (const manifest of manifests.values()) {
    if (!referencedManifestPaths.has(manifest.path)) {
      return `npm artifact contains an unreferenced embedded package ${manifest.path}`;
    }
  }
  return undefined;
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
