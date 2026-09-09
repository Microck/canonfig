import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Schema } from "effect";

export interface BuildFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BuildReceipt {
  readonly schema: "canonfig.build/v1";
  readonly packageVersion: string;
  readonly sourceDigest: string;
  readonly compiledDigest: string;
  readonly sourceFiles: ReadonlyArray<BuildFile>;
  readonly compiledFiles: ReadonlyArray<BuildFile>;
  readonly git: { readonly commit: string; readonly dirty: boolean } | null;
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digestFiles = (files: ReadonlyArray<BuildFile>): string => hash(JSON.stringify(files));

/** Do not follow links into files outside the reviewed build inputs. */
const filesUnder = (root: string, directory: string): ReadonlyArray<string> => {
  const absolute = join(root, directory);
  let metadata;
  try {
    metadata = lstatSync(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error(`Build input is a symlink: ${directory}`);
  if (metadata.isFile()) return [directory];
  if (!metadata.isDirectory()) throw new Error(`Build input is not a regular file: ${directory}`);
  return readdirSync(absolute).sort(compare).flatMap((name) => filesUnder(root, join(directory, name)));
};

const describeFiles = (root: string, paths: ReadonlyArray<string>): ReadonlyArray<BuildFile> =>
  [...new Set(paths.map((path) => relative(root, join(root, path)).split(sep).join("/")))].sort(compare).map((path) => {
    const content = readFileSync(join(root, path));
    return { path, bytes: content.byteLength, sha256: hash(content) };
  });

const gitIdentity = (root: string): BuildReceipt["git"] => {
  const options = { cwd: root, encoding: "utf8" as const, timeout: 5_000, maxBuffer: 1024 * 1024 };
  const commit = spawnSync("git", ["rev-parse", "--verify", "HEAD"], options);
  if (commit.status !== 0 || !/^[a-f0-9]{40,64}$/u.test(commit.stdout.trim())) return null;
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal", "--", "src", "tools/release", "package.json", "package-lock.json", "tsconfig.json"], options);
  if (status.status !== 0) return null;
  return { commit: commit.stdout.trim(), dirty: status.stdout.length > 0 };
};

/** The digests describe actual bytes; a clean Git label alone is never build identity. */
export const createBuildReceipt = (root: string): BuildReceipt => {
  const manifest = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.NonEmptyString }))(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
  );
  const sourceFiles = describeFiles(root, [
    ...filesUnder(root, "src"),
    ...filesUnder(root, "tools/release"),
    ...["package.json", "package-lock.json", "tsconfig.json"].flatMap((path) => filesUnder(root, path)),
  ]);
  const compiledFiles = describeFiles(root, filesUnder(root, "dist").filter((path) => path.endsWith(".js")));
  if (compiledFiles.length === 0) throw new Error("Cannot create a build receipt before compiling the CLI");
  return {
    schema: "canonfig.build/v1",
    packageVersion: manifest.version,
    sourceDigest: digestFiles(sourceFiles),
    compiledDigest: digestFiles(compiledFiles),
    sourceFiles,
    compiledFiles,
    git: gitIdentity(root),
  };
};

/**
 * The receipt stays out of `dist` on purpose: the published package ships only
 * compiled JavaScript, and a per-file hash manifest is build evidence for CI,
 * not payload for every install. CI preserves this file as a workflow artifact.
 */
export const buildReceiptPath = (root: string): string => join(root, "build-receipt.json");

export const writeBuildReceipt = (root: string): BuildReceipt => {
  const receipt = createBuildReceipt(root);
  writeFileSync(buildReceiptPath(root), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
  return receipt;
};
