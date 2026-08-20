import { createHash } from "node:crypto";
import { createServer, type Server } from "node:https";
import { readFile, readdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { generate } from "selfsigned";

import {
  makeNpmArtifactTransport,
  type NpmArtifactRequest,
  type NpmArtifactResponse,
  validateNpmArtifactProvenance,
} from "../../src/synchronization/npm-artifact.ts";
import type { JsonValue } from "../../src/profile/profile-codec.ts";

const source = "https://registry.npmjs.org/fixture-tool/-/fixture-tool-1.2.3.tgz";
const temporaryDirectories: Array<string> = [];
const servers: Array<Server> = [];

const bytesFor = (value: string): Buffer => Buffer.from(value);

const integrityFor = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

interface TarFixtureEntry {
  readonly path: string;
  readonly content?: Uint8Array | undefined;
  readonly type?: number | undefined;
  readonly declaredSize?: number | undefined;
}

const tarArchive = (entries: ReadonlyArray<TarFixtureEntry>): Buffer =>
  gzipSync(Buffer.concat([
    ...entries.flatMap((entry) => {
      const content = Buffer.from(entry.content ?? new Uint8Array());
      const header = Buffer.alloc(512);
      header.write(entry.path, 0, 100, "utf8");
      header.write("0000644\0", 100, 8, "ascii");
      header.write("0000000\0", 108, 8, "ascii");
      header.write("0000000\0", 116, 8, "ascii");
      header.write(
        `${(entry.declaredSize ?? content.byteLength).toString(8).padStart(11, "0")}\0`,
        124,
        12,
        "ascii",
      );
      header.write("00000000000\0", 136, 12, "ascii");
      header.fill(0x20, 148, 156);
      header[156] = entry.type ?? 0x30;
      header.write("ustar\0", 257, 6, "ascii");
      header.write("00", 263, 2, "ascii");
      const checksum = header.reduce((total, byte) => total + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
      const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
      return [header, content, padding];
    }),
    Buffer.alloc(1024),
  ]));

const packageManifest = (
  value: JsonValue,
): Buffer => Buffer.from(JSON.stringify(value));

const fixtureServer = async (
  responseBody: (response: import("node:http").ServerResponse) => void,
): Promise<{ readonly request: NpmArtifactRequest; readonly requests: () => number }> => {
  const certificate = await generate(
    [{ name: "commonName", value: "canonfig-fixture" }],
    {
      algorithm: "sha256",
      keyType: "ec",
      curve: "P-256",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      ],
    },
  );
  let requestCount = 0;
  const server = createServer(
    { key: certificate.private, cert: certificate.cert },
    (_request, response) => responseBody(response),
  );
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const decodedAddress = Schema.decodeUnknownOption(
    Schema.Struct({ port: Schema.Int }),
  )(address);
  if (decodedAddress._tag === "None") {
    throw new Error("fixture server did not bind an address");
  }
  const endpoint = `https://127.0.0.1:${decodedAddress.value.port}/fixture.tgz`;
  const request: NpmArtifactRequest = (_source, options): Promise<NpmArtifactResponse> =>
    new Promise((resolve, reject) => {
      requestCount += 1;
      const request = import("node:https").then(({ request: httpsRequest }) =>
        httpsRequest(endpoint, {
          method: "GET",
          ca: certificate.cert,
          rejectUnauthorized: true,
        }, (response) => resolve({
          statusCode: response.statusCode ?? 500,
          headers: response.headers,
          body: response,
        }))
      );
      void request.then((client) => {
        const fail = (cause: unknown): void =>
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        const abort = (): void => client.destroy(new Error("fixture aborted"));
        if (options.signal?.aborted === true) {
          abort();
          fail(new Error("fixture aborted"));
          return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        client.setTimeout(options.timeoutMilliseconds, () =>
          client.destroy(new Error("fixture timed out")));
        client.once("error", fail);
        client.once("close", () =>
          options.signal?.removeEventListener("abort", abort));
        client.end();
      });
    });
  return {
    request,
    requests: () => requestCount,
  };
};

const cacheDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-npm-artifact-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(directory, { recursive: true, force: true }));
  }));
});

describe("verified npm artifact transport", () => {
  it.each([
    ["transitive dependencies", tarArchive([
      {
        path: "package/package.json",
        content: packageManifest({
          name: "fixture-tool",
          version: "1.2.3",
          dependencies: { first: "1.0.0" },
          bundledDependencies: ["first"],
        }),
      },
      {
        path: "package/node_modules/first/package.json",
        content: packageManifest({
          name: "first",
          version: "1.0.0",
          dependencies: { second: "1.0.0" },
        }),
      },
      {
        path: "package/node_modules/second/package.json",
        content: packageManifest({ name: "second", version: "1.0.0" }),
      },
    ])],
    ["optional dependencies", tarArchive([
      {
        path: "package/package.json",
        content: packageManifest({
          name: "fixture-tool",
          version: "1.2.3",
          optionalDependencies: { optional: "1.0.0" },
          bundledDependencies: ["optional"],
        }),
      },
      {
        path: "package/node_modules/optional/package.json",
        content: packageManifest({ name: "optional", version: "1.0.0" }),
      },
    ])],
  ] as const)("accepts fully embedded %s", (_name, bytes) => {
    expect(validateNpmArtifactProvenance(bytes, "fixture-tool", "1.2.3")).toBeUndefined();
  });

  it.each([
    ["unbundled dependency", {
      dependencies: { dependency: "1.0.0" },
    }],
    ["peer dependency", {
      peerDependencies: { peer: "1.0.0" },
    }],
    ["optional peer metadata", {
      peerDependenciesMeta: { peer: { optional: true } },
    }],
    ["workspace dependency", {
      dependencies: { dependency: "workspace:*" },
      bundledDependencies: ["dependency"],
    }],
    ["package manager indirection", {
      packageManager: "pnpm@9.0.0",
    }],
    ["bundled dependency missing", {
      dependencies: { dependency: "1.0.0" },
      bundledDependencies: ["dependency"],
    }],
    ["bundled dependency metadata ambiguity", {
      dependencies: { dependency: "1.0.0" },
      bundledDependencies: ["dependency"],
      bundleDependencies: ["dependency"],
    }],
  ] as const)("rejects %s", (_name, fields) => {
    const bytes = tarArchive([{
      path: "package/package.json",
      content: packageManifest({
        name: "fixture-tool",
        version: "1.2.3",
        ...fields,
      }),
    }]);
    expect(validateNpmArtifactProvenance(bytes, "fixture-tool", "1.2.3")).toMatch(
      /npm|dependency|package manager/iu,
    );
  });

  it.each([
    ["path traversal", [{ path: "package/../package.json" }]],
    ["symlink", [{ path: "package/link", type: 0x32 }]],
    ["duplicate manifest", [
      { path: "package/package.json" },
      { path: "package/package.json" },
    ]],
    ["oversized entry", [{
      path: "package/package.json",
      declaredSize: 128 * 1024 * 1024 + 1,
    }]],
  ] as const)("rejects malicious or oversized %s archives", (_name, entries) => {
    expect(validateNpmArtifactProvenance(tarArchive(entries))).toMatch(
      /npm artifact/iu,
    );
  });

  it("fetches exact bytes through local HTTPS and reuses a verified cache entry", async () => {
    const body = bytesFor("valid npm tarball bytes");
    const fixture = await fixtureServer((response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(body);
    });
    const cache = cacheDirectory();
    const transport = makeNpmArtifactTransport(fixture.request);
    const input = {
      source,
      packageName: "fixture-tool",
      version: "1.2.3",
      integrity: integrityFor(body),
      cacheDirectory: cache,
    } as const;
    const first = await Effect.runPromise(transport.download(input));
    const second = await Effect.runPromise(transport.download(input));

    expect(await readFile(first.path)).toEqual(body);
    expect(second).toEqual(first);
    expect(fixture.requests()).toBe(1);
    expect(await readdir(join(cache))).toEqual([
      "sha512-"
        + input.integrity.slice("sha512-".length).replaceAll("/", "_").replaceAll("+", "-")
        + ".tgz",
    ]);
  });

  it("rejects changed bytes without persisting an unverified cache entry", async () => {
    const expected = bytesFor("expected bytes");
    const fixture = await fixtureServer((response) => {
      response.writeHead(200);
      response.end("changed bytes");
    });
    const cache = cacheDirectory();
    const error = await Effect.runPromise(Effect.flip(
      makeNpmArtifactTransport(fixture.request).download({
        source,
        packageName: "fixture-tool",
        version: "1.2.3",
        integrity: integrityFor(expected),
        cacheDirectory: cache,
      }),
    ));

    expect(error._tag).toBe("NpmArtifactError");
    expect(error.message).toContain("integrity mismatch");
    expect(await readdir(cache)).toEqual([]);
  });

  it("rejects redirects, unsupported integrity, and source escapes before persistence", async () => {
    let redirected = false;
    const fixture = await fixtureServer((response) => {
      redirected = true;
      response.writeHead(302, { location: "https://evil.example.test/changed.tgz" });
      response.end();
    });
    const cache = cacheDirectory();
    const transport = makeNpmArtifactTransport(fixture.request);
    const redirectError = await Effect.runPromise(Effect.flip(transport.download({
      source,
      packageName: "fixture-tool",
      version: "1.2.3",
      integrity: integrityFor(bytesFor("redirected")),
      cacheDirectory: cache,
    })));
    const invalidError = await Effect.runPromise(Effect.flip(transport.download({
      source,
      packageName: "fixture-tool",
      version: "1.2.3",
      integrity: "sha1-invalid",
      cacheDirectory: cache,
    })));
    const sourceError = await Effect.runPromise(Effect.flip(transport.download({
      source: "https://registry.npmjs.org/fixture-tool/-/fixture-tool-9.9.9.tgz",
      packageName: "fixture-tool",
      version: "1.2.3",
      integrity: integrityFor(bytesFor("source")),
      cacheDirectory: cache,
    })));

    expect(redirected).toBe(true);
    expect(fixture.requests()).toBe(1);
    expect(redirectError.message).toContain("redirects are not followed");
    expect(invalidError.message).toContain("supported sha256 or sha512");
    expect(sourceError.message).toContain("canonical npm registry tarball");
    expect(await readdir(cache)).toEqual([]);
  });

  it("redownloads tampered cache bytes and removes interrupted partial downloads", async () => {
    const body = bytesFor("cache reuse bytes");
    const fixture = await fixtureServer((response) => {
      response.writeHead(200);
      response.end(body);
    });
    const cache = cacheDirectory();
    const input = {
      source,
      packageName: "fixture-tool",
      version: "1.2.3",
      integrity: integrityFor(body),
      cacheDirectory: cache,
    } as const;
    const transport = makeNpmArtifactTransport(fixture.request);
    const first = await Effect.runPromise(transport.download(input));
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(first.path, "tampered"));
    await Effect.runPromise(transport.download(input));
    expect(fixture.requests()).toBe(2);

    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interruptedFixture = await fixtureServer((response) => {
      response.writeHead(200);
      response.write(body.subarray(0, 3));
      release?.();
    });
    const controller = new AbortController();
    const interruptedInput = {
      ...input,
      cacheDirectory: cacheDirectory(),
      integrity: integrityFor(bytesFor("different interrupted body")),
    };
    const interrupted = Effect.runPromise(
      makeNpmArtifactTransport(interruptedFixture.request).download({
        ...interruptedInput,
        signal: controller.signal,
      }),
    );
    await started;
    controller.abort();
    await expect(interrupted).rejects.toMatchObject({ _tag: "NpmArtifactError" });
    expect(await readdir(interruptedInput.cacheDirectory)).toEqual([]);
  });
});
