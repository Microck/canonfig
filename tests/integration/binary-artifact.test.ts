import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { prepareResourceAction, verifyResource, type ResourceExecutionContext } from "../../src/synchronization/resource-executors.ts";

const integrity = (bytes: Uint8Array) => `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
const recipeFor = (bytes: Uint8Array): ToolRecipeRef => ({
  method: "binary", platform: "linux", package: "fixture-true", version: "1.0.0", architecture: process.arch,
  source: { source: "https://example.com/releases/1.0.0/fixture-true", integrity: integrity(bytes) },
});
const transport = (bytes: Uint8Array): NpmArtifactRequest => async () => ({ statusCode: 200, body: (async function* () { yield bytes; })() });

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

  it.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))("installs verified bytes, resolves under bounded PATH, and runs the actual executable", async () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-binary-"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const bytes = readFileSync("/bin/true");
    const recipe = recipeFor(bytes);
    const shadowDirectory = join(home, ".npm-global", "bin");
    mkdirSync(shadowDirectory, { recursive: true });
    writeFileSync(join(shadowDirectory, recipe.package), "#!/bin/sh\nexit 73\n", { mode: 0o755 });
    const layer = linuxMachineStateLayer({ environment: [{ name: "HOME", value: home }, { name: "PATH", value: shadowDirectory }] });
    try {
      const checked = await Effect.runPromise(Effect.gen(function* () {
        const id = Schema.decodeUnknownSync(ResourceId)("binary-tool");
        const context: ResourceExecutionContext = {
          run: Schema.decodeUnknownSync(RunId)("binary-run"),
          action: {
            id: Schema.decodeUnknownSync(ActionId)("binary-install"), resource: id, kind: "install-tool", before: [],
            detail: { ...recipe, method: "binary", kind: "install-tool", toolId: recipe.package },
          },
          resource: { id, kind: "tool", policy: "ensure", target: recipe.package, dependsOn: [], blobs: [] },
          desired: { kind: "tool", toolId: recipe.package, recipes: [recipe, { method: "npm", platform: "linux", package: recipe.package, version: "0.9.0" }], loginRequired: false },
          verification: { method: "command", command: [recipe.package] },
          artifacts: new Map(), limits: defaultSynchronizationExecutionLimits,
          binaryArtifactRequest: transport(bytes),
        };
        const prepared = yield* prepareResourceAction(context);
        yield* prepared.execute;
        const installed = yield* installBinaryArtifact(recipe, transport(bytes));
        const machine = yield* MachineState;
        const discovered = yield* machine.findExecutable({ name: recipe.package, searchPath: [], installMethods: [{ method: "binary" }] });
        const result = yield* machine.runProcess({ executable: discovered.path, arguments: [], timeoutMilliseconds: 5_000, maximumOutputBytes: 1024 });
        const repeated = yield* installBinaryArtifact(recipe, transport(bytes));
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
