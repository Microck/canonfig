import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ToolRecipeRef } from "../../src/domain/resource.ts";
import { ActionDetailSchema } from "../../src/domain/synchronization.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { binaryFormatProblem, binaryRecipeProblem, downloadBinaryArtifact, installBinaryArtifact } from "../../src/synchronization/binary-artifact.ts";
import type { NpmArtifactRequest } from "../../src/synchronization/npm-artifact.ts";
import { observeFollowerResource } from "../../src/synchronization/observation.ts";
import { ActionId, ResourceId, RunId } from "../../src/domain/brand.ts";
import { defaultSynchronizationExecutionLimits } from "../../src/synchronization/executor.ts";
import { planResource } from "../../src/synchronization/resource-plans.ts";
import { prepareResourceAction, verifyResource, type ResourceExecutionContext } from "../../src/synchronization/resource-executors.ts";

const integrity = (bytes: Uint8Array) => `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
const recipeFor = (bytes: Uint8Array): ToolRecipeRef => ({
  method: "binary", platform: "linux", package: "fixture-true", version: "1.0.0", architecture: process.arch,
  source: { source: "https://example.com/releases/1.0.0/fixture-true", integrity: integrity(bytes) },
});
const transport = (bytes: Uint8Array): NpmArtifactRequest => async () => ({ statusCode: 200, body: (async function* () { yield bytes; })() });

const formats = ["tar.gz", "zip"] as const;
type ArchiveFormat = typeof formats[number];
const entrypoint = "release/bin/tool";
const archiveRecipeFor = (format: ArchiveFormat, archive: Buffer, executable: Buffer) => ({
  ...recipeFor(archive),
  entrypoint,
  source: {
    source: `https://example.com/releases/tool.${format === "tar.gz" ? "tgz" : format}`,
    integrity: integrity(archive),
    archive: { format, executableIntegrity: integrity(executable) },
  },
} satisfies ToolRecipeRef);

interface ArchiveFixtureMember {
  readonly path: string;
  readonly content?: Buffer;
  readonly kind?: "directory" | "symlink" | "hardlink" | "fifo";
  readonly declaredSize?: number;
}

const tarArchive = (members: readonly ArchiveFixtureMember[]): Buffer => gzipSync(Buffer.concat([
  ...members.flatMap(({ path, content = Buffer.alloc(0), kind, declaredSize = content.length }) => {
    const header = Buffer.alloc(512);
    header.write(path);
    header.write(`${declaredSize.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(0x20, 148, 156);
    header[156] = { file: 48, directory: 53, symlink: 50, hardlink: 49, fifo: 54 }[kind ?? "file"];
    header.write("ustar\0", 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    return [header, content, Buffer.alloc((512 - (content.length % 512)) % 512)];
  }),
  Buffer.alloc(1024),
]));

const zipArchive = (members: readonly ArchiveFixtureMember[]): Buffer => {
  const fileRecords: Buffer[] = [];
  const directoryRecords: Buffer[] = [];
  let offset = 0;
  for (const { path, content = Buffer.alloc(0), kind, declaredSize = content.length } of members) {
    const name = Buffer.from(path);
    const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 28);
    const mode = { file: 0o100755, directory: 0o040755, symlink: 0o120777, hardlink: 0, fifo: 0o010644 }[kind ?? "file"];
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    fileRecords.push(local, name, compressed);
    directoryRecords.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(directoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...fileRecords, directory, end]);
};

const archiveFor = (format: ArchiveFormat) => format === "zip" ? zipArchive : tarArchive;
const maximumExpandedBytes = 128 * 1024 * 1024;

describe.each(formats)("%s binary archives", (format) => {
  const archive = archiveFor(format);
  const payload = Buffer.from("not a native executable");
  const validMember = { path: entrypoint, content: payload };
  const failureFor = (members: readonly ArchiveFixtureMember[]) => {
    const bytes = archive(members);
    return Effect.runPromise(Effect.flip(downloadBinaryArtifact(archiveRecipeFor(format, bytes, payload), transport(bytes))));
  };

  it("requires a safe entrypoint and SHA-256 archive and executable digests", () => {
    const recipe = archiveRecipeFor(format, archive([validMember]), payload);
    for (const target of [undefined, "../tool", "/tool", "C:/tool", "release\\tool", "release/../tool"]) {
      expect(() => Schema.decodeUnknownSync(ToolRecipeRef)({ ...recipe, entrypoint: target })).toThrow(/entrypoint/u);
    }
    const { source } = recipe;
    expect(() => Schema.decodeUnknownSync(ToolRecipeRef)({ ...recipe, source: { ...source, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } })).toThrow(/SHA-256/u);
    expect(() => Schema.decodeUnknownSync(ToolRecipeRef)({ ...recipe, source: { ...source, archive: { format } } })).toThrow(/executableIntegrity/u);
  });

  it("rejects an integrity mismatch before trying to parse the archive", async () => {
    const recipe = archiveRecipeFor(format, archive([validMember]), payload);
    const error = await Effect.runPromise(Effect.flip(downloadBinaryArtifact(recipe, transport(Buffer.from("invalid archive")))));
    expect(error.message).toBe("binary artifact integrity mismatch");
  });

  it.each(["../evil", "/evil", "C:/evil", "nested/../evil", "nested\\evil"])("rejects unsafe member %s anywhere in the archive", async (path) => {
    expect((await failureFor([validMember, { path }])).message).toMatch(/path|filename/iu);
  });

  it.each(["symlink", "fifo"] as const)("rejects %s members even outside the entrypoint", async (kind) => {
    expect((await failureFor([validMember, { path: "other", kind }])).message).toMatch(/link|special file/u);
  });

  it("refuses missing and duplicate executable members", async () => {
    expect((await failureFor([{ path: "other", content: payload }])).message).toContain("entrypoint is missing");
    expect((await failureFor([validMember, validMember])).message).toContain("duplicate member paths");
  });

  it("refuses oversized archives and excessive entry counts", async () => {
    expect((await failureFor([{ ...validMember, declaredSize: maximumExpandedBytes + 1 }])).message).toMatch(/oversized|expansion limit/u);
    const members = Array.from({ length: 4_097 }, (_, index) => ({ path: `file-${index}` }));
    expect((await failureFor(members)).message).toContain("entry limit");
  });

  it.each(["macos", "windows"] as const)("validates the extracted %s format and executable digest", async (platform) => {
    // These headers exercise format detection on any host. The Linux workflow below runs a real executable.
    const executable = Buffer.alloc(88);
    if (platform === "macos") {
      executable.writeUInt32LE(0xfeedfacf, 0);
      executable.writeUInt32LE(0x01000007, 4);
      executable.writeUInt32LE(2, 12);
    } else {
      executable.write("MZ");
      executable.writeUInt32LE(64, 60);
      executable.writeUInt32LE(0x4550, 64);
      executable.writeUInt16LE(0x8664, 68);
    }
    const bytes = archive([{ path: entrypoint, content: executable }]);
    const recipe = { ...archiveRecipeFor(format, bytes, executable), platform, architecture: "x64" };
    await expect(Effect.runPromise(downloadBinaryArtifact(recipe, transport(bytes)))).resolves.toEqual(executable);
    const wrongPin = { ...recipe, source: { ...recipe.source, archive: { format, executableIntegrity: integrity(payload) } } };
    const error = await Effect.runPromise(Effect.flip(downloadBinaryArtifact(wrongPin, transport(bytes))));
    expect(error.message).toBe("binary archive executable integrity mismatch");
  });

  it("refuses a non-executable payload even when both digests match", async () => {
    expect((await failureFor([validMember])).message).toContain("Unsupported artifact");
  });
});

it("caps gzip expansion before reading tar headers", async () => {
  const bytes = gzipSync(Buffer.alloc(maximumExpandedBytes + 1));
  const recipe = archiveRecipeFor("tar.gz", bytes, Buffer.alloc(0));
  const error = await Effect.runPromise(Effect.flip(downloadBinaryArtifact(recipe, transport(bytes))));
  expect(error.message).toContain("128 MiB expansion limit");
});

it("rejects a tar hardlink", async () => {
  const bytes = tarArchive([{ path: entrypoint, kind: "hardlink" }]);
  const error = await Effect.runPromise(Effect.flip(downloadBinaryArtifact(archiveRecipeFor("tar.gz", bytes, Buffer.alloc(0)), transport(bytes))));
  expect(error.message).toContain("link");
});

describe("native binary artifacts", () => {
  it("rejects malformed source and destination metadata at the profile boundary", () => {
    const recipe = recipeFor(new Uint8Array());
    for (const packageName of ["../tool", "/bin/tool", "tool\\evil", "tool:evil"]) {
      expect(() => Schema.decodeUnknownSync(ToolRecipeRef)({ ...recipe, package: packageName })).toThrow();
    }
    expect(() => Schema.decodeUnknownSync(ToolRecipeRef)({ ...recipe, source: { source: "https://user:pass@example.com/tool", integrity: integrity(new Uint8Array()) } })).toThrow();
    expect(binaryRecipeProblem({ ...recipe, architecture: undefined })).toContain("architecture");
    expect(binaryRecipeProblem({ ...recipe, source: undefined })).toContain("integrity");
  });

  it.each(["tool.v1", "tool.cmd"])("rejects Windows binary name %s before planning or execution", (packageName) => {
    const recipe = { ...recipeFor(new Uint8Array()), platform: "windows", package: packageName };
    expect(() => Schema.decodeUnknownSync(ToolRecipeRef)(recipe)).toThrow(/must end in .exe/u);
    expect(() => Schema.decodeUnknownSync(ActionDetailSchema)({ ...recipe, kind: "install-tool", toolId: "tool" })).toThrow(/must end in .exe/u);
  });

  it("allows explicit Windows executable names and preserves dotted names on other platforms", () => {
    const recipe = recipeFor(new Uint8Array());
    for (const packageName of ["tool", "tool.v1.exe", "tool.v1.EXE"]) {
      expect(Schema.is(ToolRecipeRef)({ ...recipe, platform: "windows", package: packageName })).toBe(true);
    }
    for (const platform of ["linux", "macos"]) {
      expect(Schema.is(ToolRecipeRef)({ ...recipe, platform, package: "tool.v1" })).toBe(true);
    }
  });

  it("rejects archives and wrong native architectures even with matching integrity", async () => {
    const archive = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
    const failure = await Effect.runPromise(Effect.flip(downloadBinaryArtifact(recipeFor(archive), transport(archive))));
    expect(failure.message).toContain("not an archive");
    const elf = Buffer.alloc(64);
    elf.set([127, 69, 76, 70, 2, 1]);
    elf.writeUInt16LE(183, 18);
    expect(binaryFormatProblem(elf, "linux", "x64")).toContain("architecture");
  });

  it.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch)).each(["script", "wrong-architecture"])(
    "does not recognize matching %s bytes as the installed native pin",
    async (kind) => {
      const home = mkdtempSync(join(tmpdir(), "canonfig-binary-observation-"));
      const directory = join(home, ".local", "bin");
      mkdirSync(directory, { recursive: true });
      const bytes = kind === "script" ? Buffer.from("#!/bin/sh\nexit 0\n") : readFileSync("/bin/true");
      if (kind === "wrong-architecture") bytes.writeUInt16LE(process.arch === "arm64" ? 62 : 183, 18);
      const recipe = recipeFor(bytes);
      writeFileSync(join(directory, recipe.package), bytes, { mode: 0o755 });
      try {
        const observed = await Effect.runPromise(observeFollowerResource(
          { resource: { kind: "tool", target: recipe.package, policy: "ensure" } },
          { kind: "tool", toolId: recipe.package, recipes: [recipe], loginRequired: false },
          { method: "executable-present", executable: recipe.package },
        ).pipe(Effect.provide(linuxMachineStateLayer({ environment: [{ name: "HOME", value: home }] }))));
        expect(observed).toMatchObject({ state: "present", objectKind: "regular", executable: true, installedVersion: undefined });
      } finally { rmSync(home, { recursive: true, force: true }); }
    },
  );

  it("rejects HTTPS downgrade redirects", async () => {
    const request: NpmArtifactRequest = async () => ({ statusCode: 302, headers: { location: "http://example.com/tool" }, body: (async function* () {})() });
    const error = await Effect.runPromise(Effect.flip(downloadBinaryArtifact(recipeFor(new Uint8Array()), request)));
    expect(error.message).toContain("HTTPS");
  });

  it.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch)).each(["bare", ...formats] as const)("installs and runs the verified %s executable", async (format) => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-binary-"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const bytes = readFileSync("/bin/true");
    const download = format === "bare" ? bytes : archiveFor(format)([
      { path: "release/", kind: "directory" },
      { path: entrypoint, content: bytes },
      { path: "release/README", content: Buffer.from("Only the executable is installed") },
    ]);
    const recipe = format === "bare" ? recipeFor(bytes) : archiveRecipeFor(format, download, bytes);
    const shadowDirectory = join(home, ".npm-global", "bin");
    mkdirSync(shadowDirectory, { recursive: true });
    writeFileSync(join(shadowDirectory, recipe.package), "#!/bin/sh\nexit 73\n", { mode: 0o755 });
    const layer = linuxMachineStateLayer({ environment: [{ name: "HOME", value: home }, { name: "PATH", value: shadowDirectory }] });
    try {
      const checked = await Effect.runPromise(Effect.gen(function* () {
        const id = Schema.decodeUnknownSync(ResourceId)("binary-tool");
        const resource = { id, kind: "tool", policy: "ensure", target: recipe.package, dependsOn: [], blobs: [] } satisfies ResourceExecutionContext["resource"];
        const desired = {
          kind: "tool", toolId: recipe.package, loginRequired: false,
          recipes: [Schema.decodeUnknownSync(ToolRecipeRef)(recipe), { method: "npm", platform: "linux", package: recipe.package, version: "0.9.0" }],
        } satisfies ResourceExecutionContext["desired"];
        const [planned] = planResource({ resource, desired, platform: "linux", observed: { state: "absent" } });
        expect(planned?.kind).toBe("install-tool");
        const context: ResourceExecutionContext = {
          run: Schema.decodeUnknownSync(RunId)("binary-run"),
          action: {
            id: Schema.decodeUnknownSync(ActionId)("binary-install"), resource: id, kind: "install-tool", before: [],
            detail: Schema.decodeUnknownSync(ActionDetailSchema)(planned?.detail),
          },
          resource, desired,
          verification: { method: "command", command: [recipe.package] },
          artifacts: new Map(), limits: defaultSynchronizationExecutionLimits,
          binaryArtifactRequest: transport(download),
        };
        const prepared = yield* prepareResourceAction(context);
        yield* prepared.execute;
        const installed = yield* installBinaryArtifact(recipe, transport(download));
        const machine = yield* MachineState;
        const discovered = yield* machine.findExecutable({ name: recipe.package, searchPath: [], installMethods: [{ method: "binary" }] });
        const result = yield* machine.runProcess({ executable: discovered.path, arguments: [], timeoutMilliseconds: 5_000, maximumOutputBytes: 1024 });
        const repeated = yield* installBinaryArtifact(recipe, transport(download));
        const observed = yield* observeFollowerResource({ resource: { kind: "tool", target: recipe.package, policy: "ensure" } },
          { kind: "tool", toolId: "fixture-true", recipes: [recipe], loginRequired: false },
          { method: "command", command: [recipe.package] });
        const commandVerification = yield* verifyResource(context);
        const presenceContext: ResourceExecutionContext = { ...context, verification: { method: "executable-present", executable: recipe.package } };
        const presenceVerification = yield* verifyResource(presenceContext);
        return { installed, repeated, discovered, result, observed, commandVerification, presenceVerification, presenceContext, context };
      }).pipe(Effect.provide(layer)));
      expect(checked.result.exitCode).toBe(0);
      expect(checked.discovered.path).toEqual(checked.installed.path);
      expect(checked.repeated.digest).toBe(checked.installed.digest);
      expect(checked.observed).toMatchObject({ state: "present", objectKind: "regular", installedVersion: "1.0.0", digest: checked.installed.digest });
      expect(readFileSync(checked.installed.path.absolute)).toEqual(bytes);
      expect(readdirSync(join(home, ".local", "bin"))).toEqual([recipe.package]);
      expect(checked.commandVerification.passed).toBe(true);
      expect(checked.presenceVerification.passed).toBe(true);
      rmSync(checked.installed.path.absolute);
      const missingBinary = await Effect.runPromise(verifyResource(checked.presenceContext).pipe(Effect.provide(layer)));
      expect(missingBinary.passed).toBe(false);
      const missingCommand = await Effect.runPromise(verifyResource(checked.context).pipe(Effect.provide(layer)));
      expect(missingCommand).toMatchObject({ passed: false, reason: expect.stringContaining(checked.installed.path.absolute) });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))("refuses a missing destination without moving the home directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-binary-parent-"));
    const sentinel = join(home, "untouched");
    writeFileSync(sentinel, "operator state");
    const bytes = readFileSync("/bin/true");
    try {
      const error = await Effect.runPromise(Effect.flip(installBinaryArtifact(recipeFor(bytes), transport(bytes))).pipe(
        Effect.provide(linuxMachineStateLayer({ environment: [{ name: "HOME", value: home }], safeRootMutationStrategy: "portable" })),
      ));
      expect(error.message).toContain("Create the real directory");
      expect(readFileSync(sentinel, "utf8")).toBe("operator state");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))("does not overwrite on hash mismatch or take over a different existing file", async () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-binary-refusal-"));
    const directory = join(home, ".local", "bin");
    mkdirSync(directory, { recursive: true });
    const target = join(directory, "fixture-true");
    writeFileSync(target, "operator owned");
    const bytes = readFileSync("/bin/true");
    const layer = linuxMachineStateLayer({ environment: [{ name: "HOME", value: home }] });
    try {
      const hashFailure = await Effect.runPromise(Effect.flip(installBinaryArtifact(recipeFor(bytes), transport(Buffer.from("wrong")))).pipe(Effect.provide(layer)));
      expect(hashFailure.message).toContain("integrity mismatch");
      expect(readFileSync(target, "utf8")).toBe("operator owned");
      const collision = await Effect.runPromise(Effect.flip(installBinaryArtifact(recipeFor(bytes), transport(bytes))).pipe(Effect.provide(layer)));
      expect(collision.message).toContain("occupied");
      expect(readFileSync(target, "utf8")).toBe("operator owned");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
