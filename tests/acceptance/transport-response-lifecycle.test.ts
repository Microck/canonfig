import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { generate } from "selfsigned";
import { afterEach, describe, expect, it } from "vitest";

import { CertificateFingerprint, CredentialReference } from "../../src/domain/brand.ts";
import {
  authenticateFollower,
  fetchRevision,
  listRevisions,
} from "../../src/enrollment/follower-client.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { canonicalJson, digestOf } from "../../src/profile/profile-codec.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

// Only loadCredential is used by these pinned-transport calls. No OS vault
// receives a value, and this fixture's value grants access to no real service.
const machine = Layer.effect(MachineState, Effect.gen(function*() {
  const base = yield* MachineState;
  return MachineState.of({
    ...base,
    loadCredential: () => Effect.succeed(Redacted.make("disposable-test-credential")),
  });
})).pipe(Layer.provide(linuxMachineStateLayer()));

const source = async (route: "json" | "metadata" | "blob") => {
  const certificate = await generate([{ name: "commonName", value: "loopback-test" }], {
    keyType: "ec",
    curve: "P-256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
  });
  const signing = generateKeyPairSync("ed25519");
  const fingerprint = sha256(signing.publicKey.export({ format: "der", type: "spki" }));
  const blob = Buffer.from('{"kind":"file","content":"synthetic fixture"}');
  const blobId = sha256(blob);
  const unsigned = {
    id: "fixture:one",
    profileId: "fixture",
    sequence: 1,
    digest: sha256("fixture"),
    publishedAt: "2026-01-01T00:00:00.000Z",
    resources: [{
      id: "fixture-file", kind: "file", policy: "replace", target: "~/.fixture",
      dependsOn: [], blobs: [blobId], verify: { method: "digest", digest: blobId },
    }],
    signingKeyId: `ed25519:${fingerprint}`,
    signingPublicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
    sourceSignature: "ed25519:synthetic",
  };
  const unsignedJson = Schema.decodeUnknownSync(Schema.MutableJson)(unsigned);
  const metadataDigest = digestOf(unsignedJson);
  const signedJson = Schema.decodeUnknownSync(Schema.MutableJson)({ ...unsigned, metadataDigest });
  const metadata = {
    ...unsigned, metadataDigest,
    signature: `ed25519:${sign(null, Buffer.from(canonicalJson(signedJson)), signing.privateKey).toString("base64url")}`,
  };
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const state = { truncate: true };
  const server = createServer({ key: certificate.private, cert: certificate.cert }, (request, response) => {
    request.resume();
    const isBlob = request.url?.startsWith("/v1/transport/blobs/") === true;
    const isMetadata = request.url?.startsWith("/v1/transport/revisions/") === true;
    const shouldTruncate = state.truncate && (
      route === "blob" ? isBlob : route === "metadata" ? !isBlob : true
    );
    const bytes = isBlob ? blob : Buffer.from(JSON.stringify(isMetadata ? metadata : { revisions: [] }));
    if (!shouldTruncate) {
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
      return;
    }
    response.writeHead(200, { "content-length": bytes.length + 100 });
    response.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.socket?.destroy();
    }, 25);
    timers.add(timer);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)));
  });
  const address = server.address();
  if (address === null || Schema.is(Schema.String)(address)) throw new Error("missing fixture address");
  return {
    state, blob, blobId,
    input: {
      endpoint: `https://127.0.0.1:${address.port}`,
      tlsFingerprint: Schema.decodeUnknownSync(CertificateFingerprint)(
        sha256(new X509Certificate(certificate.cert).raw),
      ),
      sourceFingerprint: Schema.decodeUnknownSync(CertificateFingerprint)(fingerprint),
      credentialReference: Schema.decodeUnknownSync(CredentialReference)("fixture:credential"),
      timeoutMilliseconds: 1000,
    },
  };
};

describe("pinned HTTP response lifecycle", () => {
  it("settles a truncated enrollment JSON response without an unhandled stream error", async () => {
    const fixture = await source("json");
    const result = await Effect.runPromise(
      Effect.result(authenticateFollower(fixture.input)).pipe(
        Effect.timeoutOption(3000), Effect.provide(machine),
      ),
    );
    expect(Option.isSome(result), "request did not settle after response closure").toBe(true);
    if (Option.isSome(result)) {
      expect(result.value._tag).toBe("Failure");
      if (result.value._tag === "Failure") expect(result.value.failure._tag).toBe("EnrollmentTransportError");
    }
  });

  it("settles a truncated revision-list response without waiting for a closed socket timeout", async () => {
    const fixture = await source("metadata");
    const result = await Effect.runPromise(
      Effect.result(listRevisions(fixture.input)).pipe(
        Effect.timeoutOption(3000), Effect.provide(machine),
      ),
    );
    expect(Option.isSome(result), "request did not settle after response closure").toBe(true);
    if (Option.isSome(result)) expect(result.value._tag).toBe("Failure");
  });

  it("never caches partial blob bytes and retries the same revision successfully", async () => {
    const fixture = await source("blob");
    const cache = await mkdtemp(join(tmpdir(), "canonfig-response-"));
    cleanup.push(() => rm(cache, { recursive: true, force: true }));
    const input = { ...fixture.input, revisionId: "fixture:one", cacheDirectory: cache };
    const result = await Effect.runPromise(
      Effect.result(fetchRevision(input)).pipe(Effect.timeoutOption(3000), Effect.provide(machine)),
    );
    expect(Option.isSome(result), "partial blob request remained unsettled").toBe(true);
    if (Option.isSome(result)) expect(result.value._tag).toBe("Failure");
    expect(await readdir(join(cache, "blobs"))).toEqual([]);
    expect(await readdir(join(cache, "revisions"))).toEqual([]);

    fixture.state.truncate = false;
    const fetched = await Effect.runPromise(fetchRevision(input).pipe(Effect.provide(machine)));
    expect(fetched.downloadedBlobs).toBe(1);
    expect(await readFile(fetched.blobs[0]!.path)).toEqual(fixture.blob);
    expect(await readdir(join(cache, "blobs"))).toEqual([fixture.blobId]);

    const repeated = await Effect.runPromise(fetchRevision(input).pipe(Effect.provide(machine)));
    expect(repeated.downloadedBlobs).toBe(0);
    expect(repeated.reusedBlobs).toBe(1);
  });
});
