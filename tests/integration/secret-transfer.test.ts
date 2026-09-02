import { mkdtempSync, rmSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  CertificateFingerprint,
  CredentialReference,
  GroupName,
} from "../../src/domain/brand.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { enrollFollower } from "../../src/enrollment/follower-client.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import type {
  FollowerEnrollment,
  SourceServerHandle,
} from "../../src/enrollment/enrollment.types.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { CredentialStorageError } from "../../src/machine/machine-state.errors.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import {
  applyTransferredSecrets,
  clearTransferredSecrets,
  loadSharedSecrets,
  maximumSecretBytes,
  maximumSharedSecretPayloadBytes,
  removeSecret,
  SECRET_SHARE_GROUP,
  storeSecret,
} from "../../src/secrets/secret-store.ts";
import { fetchSharedSecrets } from "../../src/secrets/secret-client.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";

const temporaryDirectories: Array<string> = [];
const openServers: Array<SourceServerHandle> = [];
const runtimes: Array<SourceRuntime> = [];
const SecretManifestReferenceSchema = Schema.Struct({
  secrets: Schema.Array(Schema.Struct({
    name: Schema.String,
    reference: CredentialReference,
  })),
  retiredReferences: Schema.optional(Schema.Array(CredentialReference)),
});

type SecretManifestReference = typeof SecretManifestReferenceSchema.Type;

interface SourceRuntime {
  readonly runPromise: <Value, Failure>(
    effect: Effect.Effect<
      Value,
      Failure,
      Enrollment | MachineState | StateRepository
    >,
  ) => Promise<Value>;
  readonly dispose: () => Promise<void>;
}

interface Fixture {
  readonly root: string;
  readonly sourceHome: string;
  readonly followerHome: string;
  readonly sourceMachine: Layer.Layer<MachineState>;
  readonly followerMachine: Layer.Layer<MachineState>;
  readonly runtime: SourceRuntime;
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

type TestPlatform = "linux" | "macos" | "windows";

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const localFileMachineLayer = (
  platform: TestPlatform,
  root: string,
): Layer.Layer<MachineState> => {
  const options = {
    environment: [
      { name: "HOME", value: join(root, "home") },
      { name: "PATH", value: join(root, "bin") },
    ],
    credentialPolicy: {
      kind: "local-file" as const,
      path: join(root, "credentials"),
    },
  };
  switch (platform) {
    case "macos":
      return macosMachineStateLayer(options);
    case "windows":
      return windowsMachineStateLayer(options);
    case "linux":
      return linuxMachineStateLayer(options);
  }
};

// Integration tests use a deterministic temporary credential backend while
// advertising the secure-store capability that production requires. Dedicated
// tests below prove that unwrapped local-file layers are rejected.
const secureTestMachineLayer = (
  layer: Layer.Layer<MachineState>,
): Layer.Layer<MachineState> =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, (machine) => ({
      ...machine,
      credentialCapability: () =>
        Effect.succeed({
          kind: "secure-noninteractive" as const,
          provider: "secret-service" as const,
        }),
    })),
  ).pipe(Layer.provide(layer));

const failingRemovalMachineLayer = (
  layer: Layer.Layer<MachineState>,
): Layer.Layer<MachineState> =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, (machine) => ({
      ...machine,
      removeCredential: (reference: typeof CredentialReference.Type) =>
        Effect.fail(new CredentialStorageError({
          operation: "remove credential",
          reference: String(reference),
          message: "injected credential removal failure",
        })),
    })),
  ).pipe(Layer.provide(layer));

const machineLayer = (root: string) => {
  const home = join(root, "home");
  const local = localFileMachineLayer("linux", root);
  return {
    home,
    layer: secureTestMachineLayer(local),
  };
};

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-secrets-"));
  temporaryDirectories.push(root);
  const source = machineLayer(join(root, "source"));
  const follower = machineLayer(join(root, "follower"));
  const runtime = ManagedRuntime.make(
    EnrollmentLive.pipe(
      Layer.provideMerge(stateRepositoryLayer(join(root, "source.sqlite"))),
      Layer.provideMerge(source.layer),
    ),
  );
  runtimes.push(runtime);
  return {
    root,
    sourceHome: source.home,
    followerHome: follower.home,
    sourceMachine: source.layer,
    followerMachine: follower.layer,
    runtime,
  };
};

const group = (name: string) => Schema.decodeUnknownSync(GroupName)(name);

const start = async (setup: Fixture): Promise<SourceServerHandle> => {
  await setup.runtime.runPromise(Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    yield* enrollment.initializeSource();
  }));
  const server = await setup.runtime.runPromise(startSourceServer());
  openServers.push(server);
  return server;
};

const enroll = async (
  setup: Fixture,
  server: SourceServerHandle,
  groups: ReadonlyArray<typeof GroupName.Type>,
): Promise<FollowerEnrollment> => {
  const invitation = await setup.runtime.runPromise(Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    return yield* enrollment.createInvitation({
      endpoint: server.endpoint,
      expiresInMilliseconds: 60_000,
      groups,
    });
  }));
  return Effect.runPromise(
    enrollFollower({
      invitation,
      followerName: "Secret Follower",
    }).pipe(Effect.provide(setup.followerMachine)),
  );
};

const runFollower = <Value, Failure>(
  setup: Fixture,
  effect: Effect.Effect<Value, Failure, MachineState>,
): Promise<Value> =>
  Effect.runPromise(effect.pipe(Effect.provide(setup.followerMachine)));

const requestRaw = async (
  setup: Fixture,
  server: SourceServerHandle,
  enrolled: FollowerEnrollment,
  path: string,
): Promise<RawResponse> => {
  const credential = await runFollower(setup, Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.loadCredential({
      reference: enrolled.credentialReference,
    });
  }));
  const endpoint = new URL(server.endpoint);
  return new Promise<RawResponse>((resolveResponse, rejectResponse) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: endpoint.hostname.replaceAll("[", "").replaceAll("]", ""),
      port: endpoint.port,
      path,
      method: "GET",
      rejectUnauthorized: false,
      headers: {
        authorization: `Bearer ${Redacted.value(credential)}`,
      },
    }, (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveResponse({
        status: response.statusCode ?? 500,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", rejectResponse);
    request.end();
  });
};

const readSecretManifest = async (
  setup: Fixture,
): Promise<SecretManifestReference> =>
  Schema.decodeUnknownSync(SecretManifestReferenceSchema)(
    JSON.parse(
      await readFile(
        join(setup.followerHome, ".canonfig", "secrets.json"),
        "utf8",
      ),
    ),
  );

const storedValue = async (
  setup: Fixture,
  name: string,
): Promise<string | undefined> => {
  try {
    const manifest = await readSecretManifest(setup);
    const entry = manifest.secrets.find((secret) => secret.name === name);
    if (entry === undefined) return undefined;
    const value = await runFollower(setup, Effect.gen(function*() {
      const machine = yield* MachineState;
      return yield* machine.loadCredential({ reference: entry.reference });
    }));
    return Redacted.value(value);
  } catch (cause) {
    if (
      cause instanceof Error
      && "code" in cause
      && String(cause.code) === "ENOENT"
    ) return undefined;
    throw cause;
  }
};

describe("secure secret transfer", () => {
  it("moves authorized secrets over pinned TLS and removes stale source values", async () => {
    const setup = fixture();
    const secretValue = "github-token-value-that-never-belongs-in-json";
    await setup.runtime.runPromise(storeSecret("github-token", secretValue));
    const server = await start(setup);
    const enrolled = await enroll(setup, server, [group(SECRET_SHARE_GROUP)]);

    const fetched = await runFollower(setup, fetchSharedSecrets({
      endpoint: server.endpoint,
      tlsFingerprint: server.fingerprint,
      credentialReference: enrolled.credentialReference,
    }));
    expect(fetched.status).toBe("shared");
    if (fetched.status !== "shared") throw new Error("expected shared secrets");
    expect(fetched.payload.secrets).toEqual([{
      name: "github-token",
      value: secretValue,
    }]);

    await runFollower(setup, applyTransferredSecrets(fetched.payload));
    expect(await storedValue(setup, "github-token")).toBe(secretValue);
    expect(await runFollower(setup, loadSharedSecrets())).toEqual({
      schemaVersion: 1,
      secrets: [],
    });

    const sourceManifest = join(setup.sourceHome, ".canonfig", "secrets.json");
    const followerManifest = join(setup.followerHome, ".canonfig", "secrets.json");
    expect(await readFile(sourceManifest, "utf8")).not.toContain(secretValue);
    expect(await readFile(followerManifest, "utf8")).not.toContain(secretValue);
    if (process.platform !== "win32") {
      expect((await stat(sourceManifest)).mode & 0o777).toBe(0o600);
      expect((await stat(followerManifest)).mode & 0o777).toBe(0o600);
    }

    await setup.runtime.runPromise(removeSecret("github-token"));
    const empty = await runFollower(setup, fetchSharedSecrets({
      endpoint: server.endpoint,
      tlsFingerprint: server.fingerprint,
      credentialReference: enrolled.credentialReference,
    }));
    expect(empty.status).toBe("shared");
    if (empty.status !== "shared") throw new Error("expected shared secrets");
    expect(empty.payload.secrets).toEqual([]);
    await runFollower(setup, applyTransferredSecrets(empty.payload));
    expect(await storedValue(setup, "github-token")).toBeUndefined();
  });

  it("normalizes localhost to the canonical loopback address before dialing", async () => {
    const setup = fixture();
    await setup.runtime.runPromise(storeSecret("localhost-token", "loopback-only"));
    const server = await start(setup);
    const enrolled = await enroll(setup, server, [group(SECRET_SHARE_GROUP)]);

    const fetched = await runFollower(setup, fetchSharedSecrets({
      endpoint: server.endpoint.replace("127.0.0.1", "localhost"),
      tlsFingerprint: server.fingerprint,
      credentialReference: enrolled.credentialReference,
    }));

    expect(fetched.status).toBe("shared");
    if (fetched.status !== "shared") throw new Error("expected shared secrets");
    expect(fetched.payload.secrets).toEqual([{
      name: "localhost-token",
      value: "loopback-only",
    }]);
  });

  it("clears source-owned secrets when the sharing grant disappears", async () => {
    const setup = fixture();
    await setup.runtime.runPromise(storeSecret("revoked-token", "remove-me"));
    const server = await start(setup);
    const enrolled = await enroll(setup, server, [group(SECRET_SHARE_GROUP)]);
    const fetched = await runFollower(setup, fetchSharedSecrets({
      endpoint: server.endpoint,
      tlsFingerprint: server.fingerprint,
      credentialReference: enrolled.credentialReference,
    }));
    if (fetched.status !== "shared") throw new Error("expected shared secrets");
    await runFollower(setup, applyTransferredSecrets(fetched.payload));
    expect(await storedValue(setup, "revoked-token")).toBe("remove-me");

    await setup.runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      yield* enrollment.updateFollowerGroups(enrolled.follower.id, []);
    }));
    const revoked = await runFollower(setup, fetchSharedSecrets({
      endpoint: server.endpoint,
      tlsFingerprint: server.fingerprint,
      credentialReference: enrolled.credentialReference,
    }));

    expect(revoked).toEqual({
      status: "not-shared",
      secrets: ["revoked-token"],
    });
    expect(await storedValue(setup, "revoked-token")).toBeUndefined();
  });

  it("clears source-owned secrets when the follower credential is revoked", async () => {
    const setup = fixture();
    await setup.runtime.runPromise(storeSecret("revoked-device-token", "remove-me-too"));
    const server = await start(setup);
    const enrolled = await enroll(setup, server, [group(SECRET_SHARE_GROUP)]);
    const fetched = await runFollower(setup, fetchSharedSecrets({
      endpoint: server.endpoint,
      tlsFingerprint: server.fingerprint,
      credentialReference: enrolled.credentialReference,
    }));
    if (fetched.status !== "shared") throw new Error("expected shared secrets");
    await runFollower(setup, applyTransferredSecrets(fetched.payload));

    await setup.runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      yield* enrollment.revokeFollower(enrolled.follower.id);
    }));
    await expect(
      runFollower(setup, fetchSharedSecrets({
        endpoint: server.endpoint,
        tlsFingerprint: server.fingerprint,
        credentialReference: enrolled.credentialReference,
      })),
    ).rejects.toMatchObject({
      category: "authentication",
      operation: "authenticate secret transfer",
    });
    expect(await storedValue(setup, "revoked-device-token")).toBeUndefined();
  });

  it("does not reveal whether secrets exist to unauthorized followers", async () => {
    const setup = fixture();
    await setup.runtime.runPromise(storeSecret("private-token", "do-not-transfer"));
    const server = await start(setup);
    const enrolled = await enroll(setup, server, []);

    const fetched = await runFollower(setup, fetchSharedSecrets({
      endpoint: server.endpoint,
      tlsFingerprint: server.fingerprint,
      credentialReference: enrolled.credentialReference,
    }));
    const [secretsResponse, missingResponse] = await Promise.all([
      requestRaw(setup, server, enrolled, "/v1/transport/secrets"),
      requestRaw(setup, server, enrolled, "/v1/transport/not-a-route"),
    ]);

    expect(fetched).toEqual({ status: "not-shared", secrets: [] });
    expect(secretsResponse).toEqual(missingResponse);
    await expect(
      access(join(setup.followerHome, ".canonfig", "secrets.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects local-file storage before opening the secret transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-secret-preflight-"));
    temporaryDirectories.push(root);
    const fingerprint = Schema.decodeUnknownSync(CertificateFingerprint)(
      "a".repeat(64),
    );
    const reference = Schema.decodeUnknownSync(CredentialReference)(
      `local-file:${join(root, "follower.credential")}`,
    );

    await expect(
      Effect.runPromise(
        fetchSharedSecrets({
          endpoint: "https://127.0.0.1:1",
          tlsFingerprint: fingerprint,
          credentialReference: reference,
          timeoutMilliseconds: 100,
        }).pipe(
          Effect.provide(localFileMachineLayer("linux", root)),
        ),
      ),
    ).rejects.toMatchObject({
      category: "storage",
      operation: "fetch shared secrets",
    });
  });

  it("rejects source values that collide with a local secret", async () => {
    const setup = fixture();
    await runFollower(setup, storeSecret("collision", "local-value"));

    await expect(
      runFollower(setup, applyTransferredSecrets({
        schemaVersion: 1,
        secrets: [{ name: "collision", value: "source-value" }],
      })),
    ).rejects.toMatchObject({
      category: "usage",
      operation: "apply transferred secrets",
    });
    expect(await storedValue(setup, "collision")).toBe("local-value");
  });

  it("keeps replaced source credentials tracked until removal can retry", async () => {
    const setup = fixture();
    await runFollower(setup, applyTransferredSecrets({
      schemaVersion: 1,
      secrets: [{ name: "rotated", value: "old-value" }],
    }));
    const oldReference = (await readSecretManifest(setup)).secrets[0]!.reference;
    const failingLayer = failingRemovalMachineLayer(setup.followerMachine);

    await expect(
      Effect.runPromise(
        applyTransferredSecrets({
          schemaVersion: 1,
          secrets: [{ name: "rotated", value: "new-value" }],
        }).pipe(Effect.provide(failingLayer)),
      ),
    ).rejects.toMatchObject({
      category: "storage",
      operation: "replace shared secrets",
    });
    expect((await readSecretManifest(setup)).retiredReferences)
      .toContain(oldReference);

    await runFollower(setup, applyTransferredSecrets({
      schemaVersion: 1,
      secrets: [{ name: "rotated", value: "new-value" }],
    }));
    expect((await readSecretManifest(setup)).retiredReferences ?? []).toEqual([]);
    expect(await storedValue(setup, "rotated")).toBe("new-value");
  });

  it("keeps deleted source credentials tracked until removal can retry", async () => {
    const setup = fixture();
    await runFollower(setup, applyTransferredSecrets({
      schemaVersion: 1,
      secrets: [{ name: "deleted", value: "old-value" }],
    }));
    const oldReference = (await readSecretManifest(setup)).secrets[0]!.reference;
    const failingLayer = failingRemovalMachineLayer(setup.followerMachine);

    await expect(
      Effect.runPromise(
        applyTransferredSecrets({
          schemaVersion: 1,
          secrets: [],
        }).pipe(Effect.provide(failingLayer)),
      ),
    ).rejects.toMatchObject({
      category: "storage",
      operation: "replace shared secrets",
    });
    expect((await readSecretManifest(setup)).retiredReferences)
      .toContain(oldReference);

    await runFollower(setup, applyTransferredSecrets({
      schemaVersion: 1,
      secrets: [],
    }));
    expect((await readSecretManifest(setup)).retiredReferences ?? []).toEqual([]);
  });

  it("keeps revoked source credentials tracked until removal can retry", async () => {
    const setup = fixture();
    await runFollower(setup, applyTransferredSecrets({
      schemaVersion: 1,
      secrets: [{ name: "grant-revoked", value: "old-value" }],
    }));
    const oldReference = (await readSecretManifest(setup)).secrets[0]!.reference;
    const failingLayer = failingRemovalMachineLayer(setup.followerMachine);

    await expect(
      Effect.runPromise(
        clearTransferredSecrets().pipe(Effect.provide(failingLayer)),
      ),
    ).rejects.toMatchObject({
      category: "storage",
      operation: "clear transferred secrets",
    });
    expect((await readSecretManifest(setup)).retiredReferences)
      .toContain(oldReference);

    await runFollower(setup, clearTransferredSecrets());
    expect((await readSecretManifest(setup)).retiredReferences ?? []).toEqual([]);
  });

  it("rejects an encoded payload that would exceed the transport ceiling", async () => {
    const setup = fixture();
    const value = "\u0001".repeat(maximumSecretBytes);
    const accepted: Array<{ readonly name: string; readonly value: string }> = [];
    while (
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: 1,
        secrets: [...accepted, { name: `secret-${accepted.length}`, value }],
      })).byteLength <= maximumSharedSecretPayloadBytes
    ) {
      const secret = { name: `secret-${accepted.length}`, value };
      await setup.runtime.runPromise(storeSecret(secret.name, secret.value));
      accepted.push(secret);
    }

    await expect(
      setup.runtime.runPromise(storeSecret(`secret-${accepted.length}`, value)),
    ).rejects.toMatchObject({
      category: "usage",
      operation: "store secret",
    });
  });

  it("rejects local-file credential mode on every platform seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-secret-policy-"));
    temporaryDirectories.push(root);

    for (const platform of ["linux", "macos", "windows"] as const) {
      await expect(
        Effect.runPromise(
          storeSecret("blocked", "never-write-plaintext").pipe(
            Effect.provide(localFileMachineLayer(platform, join(root, platform))),
          ),
        ),
      ).rejects.toMatchObject({
        category: "storage",
        operation: "store secret",
      });
    }
  });

  it("enforces the secret limit in UTF-8 bytes", async () => {
    const setup = fixture();
    const oversized = "é".repeat(Math.floor(maximumSecretBytes / 2) + 1);

    await expect(
      setup.runtime.runPromise(storeSecret("oversized", oversized)),
    ).rejects.toMatchObject({
      category: "usage",
      operation: "validate secret value",
    });
  });
});
