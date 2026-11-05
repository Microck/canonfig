import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { describeRuntimeError } from "../../src/cli/failure-taxonomy.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { UnconfirmedPublicationError } from "../../src/machine/machine-state.errors.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { exportFolder } from "../../src/projection/archive.ts";
import { intendedExecutable } from "../../src/projection/folder.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";

/**
 * `exportFolder` and the guarded machine reads and writes it publishes
 * through, with the real Linux machine layer and SQLite in a temporary HOME.
 * The substitutions wrap the real `atomicWrite`: one creates the output first,
 * the way a concurrent process would between the checks and publication; one
 * lets the real write publish and then reports a failed check after it.
 */

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const posix = process.platform !== "win32";
const SECRET = "sk-live-4f9a2c1e8b7d";

// These machines are standalone, and only a Source's export loads its signer.
const sourceSigner = Effect.die("a standalone export never signs");

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const home = () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-archive-export-"));
  roots.push(root);
  const homeDirectory = join(root, "home");
  const folder = join(homeDirectory, ".canonfig");
  write(join(folder, "canonfig.jsonc"), "{ \"version\": 1, \"harnesses\": [] }\n");
  write(join(folder, "AGENTS.md"), "# Instructions\n");
  const machine = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: homeDirectory }, { name: "XDG_CACHE_HOME", value: join(homeDirectory, ".cache") }],
    credentialPolicy: { kind: "local-file", path: join(homeDirectory, "credentials") },
  });
  const run = <A, E>(effect: Effect.Effect<A, E, MachineState>, layer: Layer.Layer<MachineState> = machine) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  const exporting = (options: { readonly force?: boolean; readonly layer?: Layer.Layer<MachineState> } = {}) =>
    Effect.runPromise(exportFolder({
      folder,
      output: "out.tar.gz",
      cwd: homeDirectory,
      includeHarnesses: false,
      force: options.force ?? false,
      now: new Date("2026-11-05T00:00:00.000Z"),
      sourceSigner,
    }).pipe(
      Effect.flip,
      Effect.provide(Layer.merge(stateRepositoryLayer(join(folder, "state.sqlite")), options.layer ?? machine)),
    ));
  return { root, home: homeDirectory, folder, machine, run, exporting, output: join(homeDirectory, "out.tar.gz") };
};

describe("export refuses what must not leave the machine", () => {
  it("refuses a token in a canonfig.jsonc comment", async () => {
    const target = home();
    write(join(target.folder, "canonfig.jsonc"), `{\n  // token: ${SECRET}\n  "version": 1,\n  "harnesses": []\n}\n`);
    const error = await target.exporting();
    expect(error._tag).toBe("ArchiveRequestError");
    expect(error.message).toContain("literal credential");
    expect(error.message).not.toContain(SECRET);
    expect(existsSync(target.output)).toBe(false);
  });

  it("refuses a token in a hook script", async () => {
    const target = home();
    write(join(target.folder, "hooks", "format.sh"), `#!/bin/sh\nexport API_TOKEN=${SECRET}\n`);
    const error = await target.exporting();
    // Paths are reported from the resolved folder (macOS /var -> /private/var).
    expect(error).toMatchObject({ _tag: "ArchiveRequestError", path: join(realpathSync.native(target.folder), "hooks", "format.sh") });
    expect(error.message).toContain("literal credential");
    expect(error.message).not.toContain(SECRET);
    expect(existsSync(target.output)).toBe(false);
  });

  it("refuses a file past the content limit from its size, before reading it", async () => {
    const target = home();
    const big = join(target.folder, "skills", "big", "blob.bin");
    write(big, "");
    // Sparse: the size is there, the bytes are not, so only a size check
    // before reading can refuse it quickly.
    truncateSync(big, 129 * 1024 * 1024);
    const error = await target.exporting();
    expect(error.message).toContain("past 134217728 bytes");
    expect(existsSync(target.output)).toBe(false);
  });

  it.skipIf(!posix)("refuses a FIFO instead of waiting on it", async () => {
    const target = home();
    rmSync(join(target.folder, "AGENTS.md"));
    execFileSync("mkfifo", [join(target.folder, "AGENTS.md")]);
    const error = await target.exporting();
    expect(error.message).toContain("AGENTS.md");
    expect(existsSync(target.output)).toBe(false);
  }, 10_000);
});

describe("export publishes without replacing", () => {
  it("refuses an output that appears after the checks, keeping its content", async () => {
    const target = home();
    // The real writer, after another process created the output.
    const racing = Layer.effect(MachineState, Effect.gen(function*() {
      const machine = yield* MachineState;
      return MachineState.of({
        ...machine,
        atomicWrite: (input) =>
          Effect.sync(() => writeFileSync(input.path.absolute, "raced")).pipe(Effect.andThen(machine.atomicWrite(input))),
      });
    })).pipe(Layer.provide(target.machine));
    const error = await target.exporting({ layer: racing });
    expect(error._tag).toBe("ArchiveConflictError");
    expect(readFileSync(target.output, "utf8")).toBe("raced");
  });
});

describe("export after the archive is published", () => {
  it.each([
    ["in-place", "holds the complete archive"],
    ["replaced", "does not hold this archive"],
  ] as const)("reports %s without claiming nothing was written, and keeps the path", async (state, expected) => {
    const target = home();
    write(target.output, "earlier archive");
    // The real write publishes; then a check after publication fails, as a
    // failed directory flush or a changed name would.
    const failing = Layer.effect(MachineState, Effect.gen(function*() {
      const machine = yield* MachineState;
      return MachineState.of({
        ...machine,
        atomicWrite: (input) =>
          machine.atomicWrite(input).pipe(Effect.flatMap((published) =>
            Effect.fail(new UnconfirmedPublicationError({ path: input.path.absolute, state, published, message: "the check failed" }))
          )),
      });
    })).pipe(Layer.provide(target.machine));
    const error = await target.exporting({ force: true, layer: failing });
    expect(error._tag).toBe("ArchivePublicationError");
    const { message } = describeRuntimeError(error);
    expect(message).toContain(expected);
    expect(message).toContain("The earlier archive at this path was already replaced.");
    expect(message).not.toContain("nothing was written");
    expect(existsSync(target.output)).toBe(true);
  });
});

describe("export keeps a Windows Source's hook intent", () => {
  it("marks a script an enabled hook runs executable on Windows only", () => {
    const enabled = new Set(["hooks/format.sh"]);
    expect(intendedExecutable("hooks/format.sh", false, enabled, "win32")).toBe(true);
    // Named only by disabled hooks, so not in the enabled set.
    expect(intendedExecutable("hooks/off.sh", false, enabled, "win32")).toBe(false);
    // A Unix Source reports the real bit, which wins either way.
    expect(intendedExecutable("hooks/format.sh", false, enabled, "linux")).toBe(false);
    expect(intendedExecutable("hooks/off.sh", true, enabled, "linux")).toBe(true);
  });
});

describe.skipIf(!posix)("anchored machine reads and writes", () => {
  it("refuses to read or write through an ancestor link below the anchor", async () => {
    const target = home();
    const outside = join(target.root, "outside");
    write(join(outside, "secret.txt"), "outside the anchor\n");
    symlinkSync(outside, join(target.home, "linked"));
    const read = await target.run(Effect.gen(function*() {
      const machine = yield* MachineState;
      return yield* machine.readFile({
        path: yield* machine.normalizePath({ path: join(target.home, "linked", "secret.txt") }),
        anchor: yield* machine.normalizePath({ path: target.home }),
        maximumBytes: 1024,
      }).pipe(Effect.flip);
    }));
    expect(read._tag).toBe("MachineFilesystemError");
    const written = await target.run(Effect.gen(function*() {
      const machine = yield* MachineState;
      return yield* machine.atomicWrite({
        path: yield* machine.normalizePath({ path: join(target.home, "linked", "out.tar.gz") }),
        anchor: yield* machine.normalizePath({ path: target.home }),
        content: new TextEncoder().encode("archive"),
        mode: 0o600,
      }).pipe(Effect.flip);
    }));
    expect(written._tag).toBe("MachineFilesystemError");
    expect(existsSync(join(outside, "out.tar.gz"))).toBe(false);
  });

  it("fails a no-replace write on an existing file and leaves it alone", async () => {
    const target = home();
    write(target.output, "keep me");
    const error = await target.run(Effect.gen(function*() {
      const machine = yield* MachineState;
      return yield* machine.atomicWrite({
        path: yield* machine.normalizePath({ path: target.output }),
        anchor: yield* machine.normalizePath({ path: target.home }),
        noReplace: true,
        content: new TextEncoder().encode("replaced"),
        mode: 0o600,
      }).pipe(Effect.flip);
    }));
    expect(error.message).toContain("EEXIST");
    expect(readFileSync(target.output, "utf8")).toBe("keep me");
  });

  it("removes a file only while the name still refers to the one a write published", async () => {
    const target = home();
    const removed = await target.run(Effect.gen(function*() {
      const machine = yield* MachineState;
      const path = yield* machine.normalizePath({ path: target.output });
      const published = yield* machine.atomicWrite({ path, content: new TextEncoder().encode("ours"), mode: 0o600 });
      // Another process puts its own file at the name.
      yield* Effect.sync(() => {
        writeFileSync(`${target.output}.theirs`, "theirs");
        renameSync(`${target.output}.theirs`, target.output);
      });
      yield* machine.removeFile({ path, identity: published });
      const kept = readFileSync(target.output, "utf8");
      const ours = yield* machine.atomicWrite({ path, content: new TextEncoder().encode("ours again"), mode: 0o600 });
      yield* machine.removeFile({ path, identity: ours });
      return { kept, gone: !existsSync(target.output) };
    }));
    expect(removed).toEqual({ kept: "theirs", gone: true });
  });
});
