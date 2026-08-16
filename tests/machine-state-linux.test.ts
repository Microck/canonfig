import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

const environment = (root: string) => [
  { name: "HOME", value: join(root, "home") },
  { name: "XDG_CONFIG_HOME", value: join(root, "config") },
  { name: "XDG_DATA_HOME", value: join(root, "data") },
  { name: "XDG_CACHE_HOME", value: join(root, "cache") },
  { name: "PATH", value: dirnameOfExecutable },
];

const dirnameOfExecutable = dirname(process.execPath);

machineStateContract("Linux", {
  platform: "linux",
  executable: process.execPath,
  localFileLayer: (root) =>
    linuxMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      environment: environment(root),
    }),
  secureStoreLayer: (root) =>
    linuxMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      environment: environment(root),
    }),
});

describe("portable safe-root mutation", () => {
  it("creates descendants and atomically replaces a final symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const target = join(managed, "nested", "settings.json");
      const outside = join(root, "outside.json");
      mkdirSync(managed);
      writeFileSync(outside, "outside");

      await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({ path: target });
          const outsidePath = yield* machine.normalizePath({ path: outside });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "symlink",
              target: outsidePath,
            },
          });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("managed"),
            },
          });
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
          safeRootMutationStrategy: "portable",
        }))),
      );

      expect(readFileSync(target, "utf8")).toBe("managed");
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an ancestor is a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const outside = join(root, "outside");
      const outsideFile = join(outside, "settings.json");
      mkdirSync(managed);
      mkdirSync(outside);
      writeFileSync(outsideFile, "outside");
      symlinkSync(outside, join(managed, "nested"));

      await expect(Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({
            path: join(managed, "nested", "settings.json"),
          });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("managed"),
            },
          });
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
          safeRootMutationStrategy: "portable",
        }))),
      )).rejects.toMatchObject({
        _tag: "MachineFilesystemError",
        operation: "mutate managed path",
      });
      expect(readFileSync(outsideFile, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the managed root is swapped before isolation", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const displaced = join(root, "displaced");
      const outside = join(root, "outside");
      const outsideFile = join(outside, "settings.json");
      mkdirSync(managed);
      mkdirSync(outside);
      writeFileSync(outsideFile, "outside");

      await expect(Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({
            path: join(managed, "settings.json"),
          });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("managed"),
            },
          });
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
          safeRootMutationStrategy: "portable",
          beforeSafeRootMutation: async () => {
            renameSync(managed, displaced);
            symlinkSync(outside, managed);
          },
        }))),
      )).rejects.toMatchObject({
        _tag: "MachineFilesystemError",
        operation: "mutate managed path",
      });
      expect(readFileSync(outsideFile, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
