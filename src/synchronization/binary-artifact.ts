import { posix, win32 } from "node:path";
import { Effect, Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";
import { recipeSourceDetails, recipeValidationIssue } from "../domain/recipe-versions.ts";
import type { ToolRecipeRef } from "../domain/resource.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { sha256BytesHex } from "../profile/profile-codec.ts";
import { incomingMessageRequest, verifyNpmArtifactBytes, type NpmArtifactRequest } from "./npm-artifact.ts";

const maximumBytes = 128 * 1024 * 1024;
const timeoutMilliseconds = 30_000;

export class BinaryArtifactError extends TaggedError<BinaryArtifactError>()("BinaryArtifactError", {
  message: Schema.String,
}) {}

export const binaryRecipeProblem = (recipe: ToolRecipeRef): string | undefined => {
  const issue = recipeValidationIssue(recipe);
  if (issue !== undefined) return issue.reason;
  if (recipe.method !== "binary") return "Expected a binary recipe";
  if (recipe.architecture === undefined) return "Binary recipe requires an explicit x64 or arm64 architecture";
  const metadata = recipeSourceDetails(recipe.source);
  if (metadata.source === undefined || metadata.integrity === undefined) return "Binary recipe requires an HTTPS source and sha256 or sha512 integrity";
  if (recipe.buildPolicy?.mode === "required") return "Binary recipes cannot execute build steps";
  return undefined;
};

/** Only native executable formats are accepted. Archives and scripts are never executed. */
export const binaryFormatProblem = (bytes: Uint8Array, platform: ToolRecipeRef["platform"], architecture: string): string | undefined => {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (platform === "linux" && b.length >= 64 && b.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
    if (b[4] === 2 && b[5] === 1 && [2, 3].includes(b.readUInt16LE(16)) && b.readUInt16LE(18) === (architecture === "arm64" ? 183 : 62)) return undefined;
    return "ELF executable architecture does not match the recipe";
  }
  if (platform === "macos" && b.length >= 32 && b.readUInt32LE(0) === 0xfeedfacf) {
    if (b.readUInt32LE(4) === (architecture === "arm64" ? 0x0100000c : 0x01000007) && b.readUInt32LE(12) === 2) return undefined;
    return "Mach-O executable architecture does not match the recipe";
  }
  if (platform === "windows" && b.length >= 64 && b[0] === 77 && b[1] === 90) {
    const offset = b.readUInt32LE(60);
    if (offset <= b.length - 24 && b.readUInt32LE(offset) === 0x4550 && b.readUInt16LE(offset + 4) === (architecture === "arm64" ? 0xaa64 : 0x8664) && (b.readUInt16LE(offset + 22) & 0x2000) === 0) return undefined;
    return "PE executable architecture does not match the recipe";
  }
  return "Unsupported artifact: supply a single native executable, not an archive, script, or universal binary";
};

export const binaryDestination = Effect.fn("BinaryArtifact.destination")(function* (recipe: ToolRecipeRef) {
  const machine = yield* MachineState;
  const { home } = yield* machine.userDirectories();
  const paths = home.platform === "windows" ? win32 : posix;
  const name = home.platform === "windows" && !recipe.package.toLowerCase().endsWith(".exe") ? `${recipe.package}.exe` : recipe.package;
  for (const directory of [home.absolute, paths.join(home.absolute, ".local"), paths.join(home.absolute, ".local", "bin")]) {
    const parent = yield* machine.normalizePath({ path: directory });
    const object = yield* machine.inspectPath(parent).pipe(Effect.catchTag("MachineFilesystemError", (error) =>
      /\bENOENT\b/u.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)));
    if (object === undefined) break;
    if (object.kind !== "directory") return yield* new BinaryArtifactError({ message: "Binary destination ancestors must be real directories, not symlinks or other objects" });
  }
  return { home, path: yield* machine.normalizePath({ path: paths.join(home.absolute, ".local", "bin", name) }) };
});

/** Uses the npm artifact transport's HTTPS request boundary, with a total deadline and bounded redirects. */
export const downloadBinaryArtifact = (recipe: ToolRecipeRef, request: NpmArtifactRequest = incomingMessageRequest) => Effect.tryPromise({
  try: async (interrupted) => {
    const problem = binaryRecipeProblem(recipe);
    if (problem !== undefined) throw new Error(problem);
    const metadata = recipeSourceDetails(recipe.source);
    const controller = new AbortController();
    const signal = AbortSignal.any([interrupted, controller.signal]);
    const timer = setTimeout(() => controller.abort(new Error("binary download deadline exceeded")), timeoutMilliseconds);
    try {
      let source = metadata.source!;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await request(source, { timeoutMilliseconds, signal });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          // Close rather than drain untrusted redirect bodies.
          await response.body[Symbol.asyncIterator]().return?.();
          const location = response.headers?.location;
          if (!Schema.is(Schema.String)(location) || redirects === 5) throw new Error("invalid or excessive binary artifact redirects");
          const next = new URL(location, source);
          if (next.protocol !== "https:" || next.username || next.password || next.hash) throw new Error("binary redirects must remain credential-free HTTPS");
          source = next.href;
          continue;
        }
        if (response.statusCode !== 200) {
          await response.body[Symbol.asyncIterator]().return?.();
          throw new Error(`binary artifact HTTP status ${response.statusCode}`);
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          size += chunk.byteLength;
          if (size > maximumBytes) throw new Error("binary artifact exceeds 128 MiB limit");
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks, size);
        if (!verifyNpmArtifactBytes(bytes, metadata.integrity!)) throw new Error("binary artifact integrity mismatch");
        const invalid = binaryFormatProblem(bytes, recipe.platform, recipe.architecture!);
        if (invalid !== undefined) throw new Error(invalid);
        return bytes;
      }
      throw new Error("binary redirect limit exceeded");
    } finally { clearTimeout(timer); controller.abort(); }
  },
  catch: (cause) => new BinaryArtifactError({ message: cause instanceof Error ? cause.message : "binary artifact download failed" }),
});

/** No takeover: an existing destination is accepted only when its bytes already match. */
export const installBinaryArtifact = Effect.fn("BinaryArtifact.install")(function* (
  recipe: ToolRecipeRef,
  request: NpmArtifactRequest = incomingMessageRequest,
) {
  const machine = yield* MachineState;
  const problem = binaryRecipeProblem(recipe);
  if (problem !== undefined) return yield* new BinaryArtifactError({ message: problem });
  const { home, path } = yield* binaryDestination(recipe);
  if (home.platform !== recipe.platform || recipe.architecture !== process.arch) return yield* new BinaryArtifactError({ message: "Binary recipe does not match the native platform and architecture" });
  // The portable safe-root mkdir implementation renames its root. It must
  // never operate on the user's home directory to create an install folder.
  const paths = home.platform === "windows" ? win32 : posix;
  const directory = yield* machine.normalizePath({ path: paths.dirname(path.absolute) });
  const directoryObject = yield* machine.inspectPath(directory).pipe(Effect.catchTag("MachineFilesystemError", (error) =>
    /\bENOENT\b/u.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)));
  if (directoryObject?.kind !== "directory") {
    return yield* new BinaryArtifactError({ message: `Create the real directory ${directory.absolute} before installing a binary recipe; Canonfig will not relocate the home directory to create it` });
  }
  const bytes = yield* downloadBinaryArtifact(recipe, request);
  const digest = sha256BytesHex(bytes);
  const existing = yield* machine.inspectPath(path).pipe(Effect.catchTag("MachineFilesystemError", (error) =>
    /\bENOENT\b/u.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)));
  if (existing !== undefined) {
    if (existing.kind === "regular") {
      const current = yield* machine.digestFile({ path });
      if (current.value === digest) return { path, digest };
    }
    return yield* new BinaryArtifactError({ message: "Binary destination is occupied; move the existing executable aside explicitly before installation" });
  }
  yield* machine.atomicWrite({ path, anchor: home, content: bytes, mode: 0o755, noReplace: true });
  return { path, digest };
});
