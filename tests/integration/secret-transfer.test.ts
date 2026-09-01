import { mkdtempSync, rmSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
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
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  applyTransferredSecrets,
  loadSharedSecrets,
  maximumSecretBytes,
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
});

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
  readonly sourceMachine: ReturnType<typeof linuxMachineStateLayer>;
  readonly followerMachine: ReturnType<typeof linuxMachineStateLayer>;
  readonly runtime: SourceRuntime;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const machineLayer = (root: string) => {
  const home = join(root, "home");
  return {
    home,
    layer: linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: home },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
    }),
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

const storedValue = async (
  setup: Fixture,
  name: string,
): Promise<string | undefined> => {
  const manifestPath = join(setup.followerHome, ".canonfig", "secrets.json");
  try {
    const manifest = Schema.decodeUnknownSync(SecretManifestReferenceSchema)(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
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

    expect(fetched).toEqual({ status: "not-shared" });
    await expect(
      access(join(setup.followerHome, ".canonfig", "secrets.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
