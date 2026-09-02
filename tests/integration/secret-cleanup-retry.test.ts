import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CredentialReference } from "../../src/domain/brand.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { CredentialStorageError } from "../../src/machine/machine-state.errors.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { applyTransferredSecrets } from "../../src/secrets/secret-store.ts";

const ManifestSchema = Schema.Struct({
  secrets: Schema.Array(Schema.Struct({
    name: Schema.String,
    reference: CredentialReference,
  })),
  retiredReferences: Schema.optional(Schema.Array(CredentialReference)),
});

const readManifest = async (home: string) =>
  Schema.decodeUnknownSync(ManifestSchema)(
    JSON.parse(
      await readFile(join(home, ".canonfig", "secrets.json"), "utf8"),
    ),
  );

describe("shared-secret cleanup retry", () => {
  it("does not create another credential while retired cleanup is blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-secret-retry-"));
    const home = join(root, "home");
    const base = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: home },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
    });
    const secure = Layer.effect(
      MachineState,
      Effect.map(MachineState, (machine) => ({
        ...machine,
        credentialCapability: () =>
          Effect.succeed({
            kind: "secure-noninteractive" as const,
            provider: "secret-service" as const,
          }),
      })),
    ).pipe(Layer.provide(base));
    let credentialWrites = 0;
    const blocked = Layer.effect(
      MachineState,
      Effect.map(MachineState, (machine) => ({
        ...machine,
        storeCredential: (input: Parameters<typeof machine.storeCredential>[0]) =>
          machine.storeCredential(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                credentialWrites += 1;
              })
            ),
          ),
        removeCredential: (reference: typeof CredentialReference.Type) =>
          Effect.fail(new CredentialStorageError({
            operation: "remove credential",
            reference: String(reference),
            message: "injected persistent removal failure",
          })),
      })),
    ).pipe(Layer.provide(secure));

    try {
      await Effect.runPromise(
        applyTransferredSecrets({
          schemaVersion: 1,
          secrets: [{ name: "rotated", value: "first" }],
        }).pipe(Effect.provide(secure)),
      );

      await expect(
        Effect.runPromise(
          applyTransferredSecrets({
            schemaVersion: 1,
            secrets: [{ name: "rotated", value: "second" }],
          }).pipe(Effect.provide(blocked)),
        ),
      ).rejects.toMatchObject({
        category: "storage",
        operation: "replace shared secrets",
      });
      const afterFirstFailure = await readManifest(home);
      const activeReference = afterFirstFailure.secrets[0]!.reference;
      expect(credentialWrites).toBe(1);
      expect(afterFirstFailure.retiredReferences).toHaveLength(1);

      await expect(
        Effect.runPromise(
          applyTransferredSecrets({
            schemaVersion: 1,
            secrets: [{ name: "rotated", value: "third" }],
          }).pipe(Effect.provide(blocked)),
        ),
      ).rejects.toMatchObject({
        category: "storage",
        operation: "clean retired secrets",
      });
      const afterSecondFailure = await readManifest(home);
      expect(credentialWrites).toBe(1);
      expect(afterSecondFailure.secrets[0]!.reference).toBe(activeReference);
      expect(afterSecondFailure.retiredReferences).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
