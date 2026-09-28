import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Cause, Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { CredentialStorageError } from "../src/machine/machine-state.errors.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { nativeSecretStoreLayer } from "../src/secrets/native-secret-store.ts";
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
  it("lists every entry beneath a managed directory without following symlinks out", async () => {
    // Observation only ever inspected owned and desired paths, so a file the
    // operator added was invisible and therefore unremovable, which made
    // `replace` behave exactly like `mirror-owned` for anything foreign.
    const root = mkdtempSync(join(tmpdir(), "canonfig-list-directory-"));
    const managed = join(root, "managed");
    const outside = join(root, "outside");
    mkdirSync(join(managed, "nested"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(managed, "owned.txt"), "owned");
    writeFileSync(join(managed, "foreign.txt"), "foreign");
    writeFileSync(join(managed, "nested", "deep.txt"), "deep");
    writeFileSync(join(outside, "secret.txt"), "must not be listed");
    symlinkSync(outside, join(managed, "link"));

    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const machine = yield* MachineState;
        const path = yield* machine.normalizePath({ path: managed });
        return yield* machine.listDirectory(path);
      }).pipe(Effect.provide(
        linuxMachineStateLayer({
          credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
          environment: environment(root),
        }),
      )),
    );

    expect(listed.map((entry) => `${entry.path}:${entry.kind}`)).toEqual([
      "foreign.txt:regular",
      "link:symlink",
      "nested:directory",
      "nested/deep.txt:regular",
      "owned.txt:regular",
    ]);
    // The symlinked directory is reported but never descended into, so a link
    // cannot walk the listing out of the managed root.
    expect(listed.some((entry) => entry.path.includes("secret"))).toBe(false);
  });

  it("lists nothing for a directory that does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-list-absent-"));
    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const machine = yield* MachineState;
        const path = yield* machine.normalizePath({ path: join(root, "absent") });
        return yield* machine.listDirectory(path);
      }).pipe(Effect.provide(
        linuxMachineStateLayer({
          credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
          environment: environment(root),
        }),
      )),
    );
    expect(listed).toEqual([]);
  });

  it("replaces an empty directory with a standalone symlink but preserves non-empty directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-standalone-symlink-"));
    try {
      const empty = join(root, "empty");
      const blocked = join(root, "blocked");
      const target = join(root, "target.txt");
      mkdirSync(empty);
      mkdirSync(blocked);
      writeFileSync(join(blocked, "child.txt"), "preserve");
      writeFileSync(target, "target");
      const layer = linuxMachineStateLayer({ environment: environment(root) });

      await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const emptyPath = yield* machine.normalizePath({ path: empty });
          yield* machine.replaceSymlink({ path: emptyPath, target });
        }).pipe(Effect.provide(layer)),
      );
      expect(readlinkSync(empty)).toBe(target);

      await expect(Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const blockedPath = yield* machine.normalizePath({ path: blocked });
          yield* machine.replaceSymlink({ path: blockedPath, target });
        }).pipe(Effect.provide(layer)),
      )).rejects.toMatchObject({
        _tag: "MachineFilesystemError",
        operation: "replace symlink",
      });
      expect(readFileSync(join(blocked, "child.txt"), "utf8")).toBe("preserve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies a root-contained source while atomically replacing a final symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const target = join(managed, "nested", "settings.json");
      const outside = join(root, "outside.json");
      const source = join(managed, "source.txt");
      mkdirSync(managed);
      writeFileSync(outside, "outside");
      writeFileSync(source, "managed");

      await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({ path: target });
          const outsidePath = yield* machine.normalizePath({ path: outside });
          const sourcePath = yield* machine.normalizePath({ path: source });
          const sourceDigest = (yield* machine.digestFile({ path: sourcePath })).value;
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "symlink",
              target: outsidePath.absolute,
            },
          });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: { file: source, digest: sourceDigest },
            },
          });
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
          safeRootMutationStrategy: "portable",
        }))),
      );

      expect(readFileSync(target, "utf8")).toBe("managed");
      expect(readFileSync(outside, "utf8")).toBe("outside");
      expect(readFileSync(source, "utf8")).toBe("managed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces conflicting final object kinds but preserves non-empty directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const target = join(managed, "entry");
      const blocked = join(managed, "blocked");
      mkdirSync(managed);
      writeFileSync(target, "file");
      mkdirSync(blocked);
      writeFileSync(join(blocked, "child.txt"), "preserve");
      const layer = linuxMachineStateLayer({
        environment: environment(root),
        safeRootMutationStrategy: "portable",
      });

      const kinds = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({ path: target });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: { kind: "directory", mode: 0o700 },
          });
          const directory = yield* machine.inspectPath(targetPath);
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("replacement"),
            },
          });
          const regular = yield* machine.inspectPath(targetPath);
          return { directory, regular };
        }).pipe(Effect.provide(layer)),
      );

      expect(kinds).toEqual({
        directory: { kind: "directory" },
        regular: { kind: "regular" },
      });
      expect(readFileSync(target, "utf8")).toBe("replacement");

      await expect(Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const blockedPath = yield* machine.normalizePath({ path: blocked });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: blockedPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("replacement"),
            },
          });
        }).pipe(Effect.provide(layer)),
      )).rejects.toMatchObject({
        _tag: "MachineFilesystemError",
        operation: "mutate managed path",
      });
      expect(readFileSync(join(blocked, "child.txt"), "utf8")).toBe("preserve");
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

  it("inspects final objects without following links and refuses non-regular reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-no-follow-"));
    try {
      const outside = join(root, "outside.txt");
      const link = join(root, "link.txt");
      const directory = join(root, "directory");
      writeFileSync(outside, "outside");
      mkdirSync(directory);
      symlinkSync(outside, link);

      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const linkPath = yield* machine.normalizePath({ path: link });
          const directoryPath = yield* machine.normalizePath({ path: directory });
          const specialPath = yield* machine.normalizePath({ path: "/dev/null" });
          const linkKind = yield* machine.inspectPath(linkPath);
          const directoryKind = yield* machine.inspectPath(directoryPath);
          const specialKind = yield* machine.inspectPath(specialPath);
          const linkDigest = yield* machine.digestFile({ path: linkPath }).pipe(Effect.exit);
          const linkRead = yield* machine.readFile({
            path: linkPath,
            maximumBytes: 1024,
          }).pipe(Effect.exit);
          const directoryDigest = yield* machine.digestFile({ path: directoryPath }).pipe(Effect.exit);
          return { linkKind, directoryKind, specialKind, linkDigest, linkRead, directoryDigest };
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
        }))),
      );

      expect(result.linkKind).toEqual({ kind: "symlink" });
      expect(result.directoryKind).toEqual({ kind: "directory" });
      expect(result.specialKind).toEqual({ kind: "special" });
      expect(result.linkDigest._tag).toBe("Failure");
      expect(result.linkRead._tag).toBe("Failure");
      expect(result.directoryDigest._tag).toBe("Failure");
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("systemd unit rendering", () => {
  // Checked against systemd 249 with a real user unit: "%%" collapses to "%" at
  // load time and "$$" to "$" at start time, inside double quotes too, while a
  // bare "%h" or "${HOME}" expands to the home directory. The program path is
  // the exception: systemd leaves "$" alone there and "$$" fails to start. The
  // asserted line is the one that parses back to the original argv.
  it("escapes specifier and variable characters so ExecStart parses back to the argv", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-systemd-render-"));
    try {
      const rendered = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          return yield* machine.renderSchedulerJob({
            name: "canonfig-sync",
            description: "Canonfig follower synchronization",
            executable: { platform: "linux", absolute: "/home/user/.nvm/v24%h$1/bin/node" },
            arguments: ["sync", "--path", 'a "100%" ${HOME} $HOME \\ value'],
            calendar: { kind: "daily", localTime: "00:00" },
          });
        }).pipe(Effect.provide(linuxMachineStateLayer({ environment: environment(root) }))),
      );

      expect(rendered.service).toContain(
        'ExecStart="/home/user/.nvm/v24%%h$1/bin/node" "sync" "--path" '
          + '"a \\"100%%\\" $${HOME} $$HOME \\\\ value"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bounded process cleanup", () => {
  it("terminates the process group after a timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-process-tree-"));
    const childPidPath = join(root, "child.pid");
    try {
      const parentScript = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const exit = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({ path: process.execPath });
          return yield* machine.runProcess({
            executable,
            arguments: ["-e", parentScript],
            timeoutMilliseconds: 500,
            maximumOutputBytes: 1024,
          }).pipe(Effect.exit);
        }).pipe(Effect.provide(linuxMachineStateLayer({ environment: environment(root) }))),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(Cause.pretty(exit.cause)).toContain("ProcessTimeoutError");
      const childPid = Number(readFileSync(childPidPath, "utf8"));
      await expect.poll(() => {
        try {
          process.kill(childPid, 0);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 2_000 }).toBe(false);
    } finally {
      if (existsSync(childPidPath)) {
        const childPid = Number(readFileSync(childPidPath, "utf8"));
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The expected path: the timed-out process group is already gone.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Behaves like libsecret 0.20's secret-tool: `store` keeps at most 8192 bytes
// of piped input, reports "password is too long" and still exits 0; `lookup`
// prints the stored bytes with no newline when stdout is not a terminal and
// refuses a value that is not valid UTF-8; `clear` and `lookup` exit 1 for a
// missing item. FAKE_SECRET_LIMIT/FAKE_SECRET_QUIET model a store that
// truncates without saying so.
const fakeSecretTool = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const [operation, ...rest] = process.argv.slice(2);
const attributes = operation === "store" ? rest.slice(1) : rest;
const directory = process.env.FAKE_SECRET_STORE;
fs.appendFileSync(path.join(directory, "..", "bus.log"), (process.env.DBUS_SESSION_BUS_ADDRESS ?? "") + "\\n");
const item = path.join(directory, Buffer.from(attributes.join("=")).toString("hex"));
const limit = Number(process.env.FAKE_SECRET_LIMIT ?? "8192");
if (operation === "store") {
  const input = fs.readFileSync(0);
  if (input.length >= limit && process.env.FAKE_SECRET_QUIET !== "1") {
    process.stderr.write("secret-tool: password is too long\\n");
  }
  fs.writeFileSync(item, input.subarray(0, limit));
  process.exit(0);
}
if (!fs.existsSync(item)) process.exit(1);
if (operation === "lookup") {
  const bytes = fs.readFileSync(item);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    process.stderr.write("secret-tool: Secret does not contain a valid password.\\n");
    process.exit(1);
  }
  process.stdout.write(bytes);
  process.exit(0);
}
if (operation === "clear") {
  fs.rmSync(item);
  process.exit(0);
}
process.exit(2);
`;

const secretServiceFixture = (
  options: {
    readonly limit?: number;
    readonly quiet?: boolean;
    readonly bus?: { readonly name: string; readonly value: string } | undefined;
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-secret-service-"));
  const bin = join(root, "bin");
  const store = join(root, "store");
  mkdirSync(bin);
  mkdirSync(store);
  writeFileSync(join(bin, "secret-tool"), fakeSecretTool, { mode: 0o755 });
  const entries = [
    ...environment(root).filter((entry) => entry.name !== "PATH"),
    { name: "PATH", value: `${bin}:${dirnameOfExecutable}` },
    { name: "FAKE_SECRET_STORE", value: store },
    { name: "FAKE_SECRET_LIMIT", value: String(options.limit ?? 8192) },
    ...(options.quiet === true ? [{ name: "FAKE_SECRET_QUIET", value: "1" }] : []),
    ...(options.bus === undefined
      ? [{ name: "DBUS_SESSION_BUS_ADDRESS", value: "unix:path=/nonexistent/canonfig-test-bus" }]
      : [options.bus]),
  ];
  return {
    root,
    store,
    layer: nativeSecretStoreLayer(linuxMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      environment: entries,
    })),
  };
};

const roundTrip = (value: string) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const reference = yield* machine.storeCredential({
      name: "canonfig-shared-secret:big",
      value: Redacted.make(value),
    });
    const loaded = yield* machine.loadCredential({ reference });
    return { reference: String(reference), value: Redacted.value(loaded) };
  });

describe("Secret Service credential storage", () => {
  it("round-trips a 12000-byte secret exactly although secret-tool keeps 8192 bytes per item", async () => {
    const fixture = secretServiceFixture();
    try {
      // Multibyte characters at odd offsets make every part boundary land
      // inside a UTF-8 sequence unless the split respects code points.
      const value = `a${"é".repeat(5999)}z`;
      expect(Buffer.byteLength(value, "utf8")).toBe(12000);
      const stored = await Effect.runPromise(roundTrip(value).pipe(Effect.provide(fixture.layer)));

      expect(stored.value).toBe(value);
      expect(stored.reference).toMatch(/^secret-service:[0-9a-f]{64}:2$/u);
      const items = readdirSync(fixture.store);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(statSync(join(fixture.store, item)).size).toBeLessThan(8192);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses, and removes, a credential the store truncates without reporting it", async () => {
    const fixture = secretServiceFixture({ limit: 4000, quiet: true });
    try {
      const error = await Effect.runPromise(
        Effect.flip(roundTrip("x".repeat(12000))).pipe(Effect.provide(fixture.layer)),
      );

      expect(error).toBeInstanceOf(CredentialStorageError);
      expect(error.message).toContain("for a 12000-byte credential");
      expect(readdirSync(fixture.store)).toEqual([]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps leading BOM and newlines byte-exact", async () => {
    const fixture = secretServiceFixture();
    try {
      for (const value of ["\uFEFFleading BOM", "X\n\n", "value\r\n", "\n\nleading", "single\n"]) {
        const stored = await Effect.runPromise(roundTrip(value).pipe(Effect.provide(fixture.layer)));
        expect(stored.value).toBe(value);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reaches the user bus at $XDG_RUNTIME_DIR/bus when DBUS_SESSION_BUS_ADDRESS is unset", async () => {
    const runtime = mkdtempSync(join(tmpdir(), "cf-run-"));
    const socket = join(runtime, "bus");
    const server: Server = createServer();
    await new Promise<void>((resolveListen) => server.listen(socket, resolveListen));
    const fixture = secretServiceFixture({
      bus: { name: "XDG_RUNTIME_DIR", value: runtime },
    });
    try {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const capability = yield* machine.credentialCapability();
          const stored = yield* roundTrip("bus-value");
          return { capability, stored };
        }).pipe(Effect.provide(fixture.layer)),
      );

      expect(result.capability.kind).toBe("secure-noninteractive");
      expect(result.stored.value).toBe("bus-value");
      const buses = new Set(
        readFileSync(join(fixture.root, "bus.log"), "utf8").split("\n").filter((line) => line !== ""),
      );
      expect([...buses]).toEqual([`unix:path=${socket}`]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(runtime, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("names the missing bus and a headless remedy instead of dbus-run-session", async () => {
    const runtime = mkdtempSync(join(tmpdir(), "cf-run-"));
    const fixture = secretServiceFixture({
      bus: { name: "XDG_RUNTIME_DIR", value: runtime },
    });
    try {
      const capability = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          return yield* machine.credentialCapability();
        }).pipe(Effect.provide(fixture.layer)),
      );

      expect(capability.kind).toBe("unavailable");
      if (capability.kind !== "unavailable") return;
      expect(capability.recovery).toContain(`${join(runtime, "bus")} is not a D-Bus socket`);
      expect(capability.recovery).toContain(`export XDG_RUNTIME_DIR=/run/user/${process.getuid?.() ?? 0}`);
      expect(capability.recovery).toContain("loginctl enable-linger");
      expect(capability.recovery).toContain("Do not use dbus-run-session");
    } finally {
      rmSync(runtime, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
