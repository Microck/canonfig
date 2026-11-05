import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { Effect, Schema } from "effect";

import { ContentDigest, ResourceId, Timestamp, type FollowerId } from "../domain/brand.ts";
import { ConfigValue } from "../domain/resource.ts";
import { localProjectionFollower, type AppliedResourceRecord } from "../domain/synchronization.ts";
import { TaggedError } from "../domain/tagged-error.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";
import { asJson, sha256BytesHex } from "../profile/profile-codec.ts";
import { literalCredentialLocation } from "../profile/publication-credentials.ts";
import { containsLiteralCredential } from "../secrets/credential-policy.ts";
import { packageVersion } from "../runtime/build-identity.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { configKeysDigest, getConfigPath, parseConfigDocument, renderConfigDocument } from "../synchronization/config-codec.ts";
import {
  AUTHORING_ENTRIES,
  CanonicalFolderError,
  decodeFolderConfig,
  decodeLocalConfig,
  holdsEntries,
  listFolderFiles,
} from "./folder.ts";
import { TARGET_IDS } from "./model.ts";
import {
  directoryResource,
  fileResource,
  parseSurfaceResourceId,
  planBuilt,
  sharedSkillsOwner,
  type BuiltResource,
  type LocalRevisionPlan,
} from "./plan.ts";

/**
 * `canonfig export` and `canonfig import`: the Canonical Folder as one
 * `.tar.gz`, and that archive back into `~/.canonfig/`.
 *
 * An archive holds `manifest.json` first, then regular files only:
 *
 * - `folder/...`: the authoring allowlist (`canonfig.jsonc`, `AGENTS.md`,
 *   `rules/`, `skills/`, `agents/`, `commands/`, `hooks/`) plus `local/`.
 *   Nothing else in `~/.canonfig/` is read, so state, backups, the hook
 *   runtime, logs, installers and credentials never enter an archive.
 * - `harnesses/<harness>/<path below home>` with `--include-harnesses`: the
 *   harness files Canonfig manages here, taken from the Applied Resource
 *   Records, and only when they still hold exactly what Canonfig wrote. A
 *   shared file such as `~/.claude.json` contributes only its owned keys.
 *
 * The manifest lists every other entry with size, SHA-256 and mode, so an
 * auditor can check what left the machine with standard tools. It is an
 * integrity record, not a signature: whoever can change the archive can
 * rewrite the manifest too, so compare the archive's own SHA-256 (printed by
 * export) when the copy crossed an untrusted channel.
 *
 * Import verifies every checksum before anything is planned, then writes the
 * folder entries as one journaled Synchronization Run (see `importLocal` in
 * sync.ts). Harness files are verified and reported, never written: the next
 * `canonfig sync` projects the imported folder through the normal takeover
 * path, with its snapshot.
 */

/** The request cannot be carried out as given; nothing was written. */
export class ArchiveRequestError extends TaggedError<ArchiveRequestError>()(
  "ArchiveRequestError",
  { path: Schema.String, message: Schema.String },
) {}

/** Something already on this machine blocks the export or import; nothing was written. */
export class ArchiveConflictError extends TaggedError<ArchiveConflictError>()(
  "ArchiveConflictError",
  { path: Schema.String, message: Schema.String },
) {}

/** The file is not an intact Canonfig export; nothing was written. */
export class ArchiveIntegrityError extends TaggedError<ArchiveIntegrityError>()(
  "ArchiveIntegrityError",
  { path: Schema.String, message: Schema.String },
) {}

export const MANIFEST_PATH = "manifest.json";
const FOLDER_PREFIX = "folder/";
const HARNESS_PREFIX = "harnesses/";
/** The folder entries an archive may hold: the authoring allowlist plus `local/`. */
const FOLDER_ENTRIES: ReadonlyArray<string> = [...AUTHORING_ENTRIES, "local"];
/** The two folder entries that are files; every other entry is a directory. */
const FOLDER_FILES: ReadonlySet<string> = new Set(["canonfig.jsonc", "AGENTS.md"]);
const HARNESS_DIRECTORIES: ReadonlySet<string> = new Set([...TARGET_IDS, sharedSkillsOwner]);

const MAXIMUM_FILES = 20_000;
const MAXIMUM_CONTENT_BYTES = 128 * 1024 * 1024;
const MAXIMUM_PATH_BYTES = 1024;
/**
 * The tar stream bound: content plus, per entry, a PAX header, its path
 * record (at most 1024 bytes of path), a file header and block padding, which
 * stays below 4 KiB. Import refuses a larger file or stream before parsing,
 * so a crafted archive cannot expand without limit.
 */
const MAXIMUM_ARCHIVE_BYTES = MAXIMUM_CONTENT_BYTES + MAXIMUM_FILES * 4096;
/** The largest harness file export reads, as for takeover snapshots. */
const MAXIMUM_HARNESS_FILE_BYTES = 8 * 1024 * 1024;

const ManifestFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: ContentDigest,
  /** POSIX permission bits as four octal digits, `0644`. */
  mode: Schema.String.check(Schema.isPattern(/^0[0-7]{3}$/u, { expected: "an octal mode such as 0644" })),
  /** Harness entries: the harness and the original path below home, `~/.claude/CLAUDE.md`. */
  harness: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  /** A shared harness file: the entry holds only these owned keys, not the whole file. */
  keys: Schema.optional(Schema.Array(Schema.String)),
});
type ManifestFile = typeof ManifestFile.Type;

export const MachineRole = Schema.Literals(["source", "follower", "standalone"]);
export type MachineRole = typeof MachineRole.Type;

const ExportManifest = Schema.Struct({
  format: Schema.Literal("canonfig-export"),
  version: Schema.Literal(1),
  canonfigVersion: Schema.String,
  createdAt: Timestamp,
  role: MachineRole,
  files: Schema.Array(ManifestFile),
});
type ExportManifest = typeof ExportManifest.Type;

/** One archive entry with the manifest fields it carries besides its digest. */
interface ArchiveFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
  readonly harness?: string | undefined;
  readonly target?: string | undefined;
  readonly keys?: ReadonlyArray<string> | undefined;
}

// ── paths ────────────────────────────────────────────────────────────────

/**
 * Why a path cannot be an archive entry, or undefined. Entries are relative,
 * `/`-separated and portable to Linux, macOS and Windows, so extracting an
 * archive anywhere can neither escape the extraction directory nor lose a
 * file to a name the platform refuses.
 */
const archivePathProblem = (value: string): string | undefined => {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/") || /^[a-z]:/iu.test(value)) {
    return "is not a relative path with / separators";
  }
  if (Buffer.byteLength(value) > MAXIMUM_PATH_BYTES) return `is longer than ${MAXIMUM_PATH_BYTES} bytes`;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "has an empty, . or .. segment";
  }
  const unportable = (segment: string) =>
    [...segment].some((character) => character.charCodeAt(0) < 0x20)
    || /[:<>"|?*]/u.test(segment)
    || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment);
  return segments.some(unportable) ? "has a name some operating systems cannot store" : undefined;
};

/** File names that hold credentials by convention; neither export nor import accepts one. */
const credentialFileName = (name: string): boolean =>
  name === ".env" || name.startsWith(".env.") || /^(?:auth|credentials)\.json$/iu.test(name);

/** The folder entry (`skills`, `AGENTS.md`) a path below `folder/` belongs to, if the allowlist admits it. */
const folderEntryOf = (folderPath: string): string | undefined => {
  const [entry = "", ...rest] = folderPath.split("/");
  if (!FOLDER_ENTRIES.includes(entry)) return undefined;
  return FOLDER_FILES.has(entry) === (rest.length === 0) ? entry : undefined;
};

const byPath = (left: { readonly path: string }, right: { readonly path: string }) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

const modeText = (mode: number): string => `0${(mode & 0o777).toString(8).padStart(3, "0")}`;

/** Two paths that only differ in case or Unicode form become one file on macOS and Windows. */
const caseCollision = (paths: ReadonlyArray<string>): string | undefined => {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const folded = path.normalize("NFC").toLowerCase();
    const earlier = seen.get(folded);
    if (earlier !== undefined) return `${earlier} and ${path}`;
    seen.set(folded, path);
  }
  return undefined;
};

// ── tar.gz ───────────────────────────────────────────────────────────────

const writeOctal = (header: Buffer, offset: number, length: number, value: number): void => {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
};

const tarHeader = (name: string, size: number, mode: number, type: "0" | "x"): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  // Every timestamp is 0, so equal input gives equal bytes.
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
};

const padded = (content: Uint8Array): ReadonlyArray<Buffer> =>
  [Buffer.from(content), Buffer.alloc((512 - content.length % 512) % 512)];

/**
 * A POSIX tar stream, gzip-compressed, of `files` in the given order. Each
 * entry carries its path in a PAX record, so UTF-8 and long paths are never
 * truncated; owner, group and times are 0.
 */
const encodeArchive = (files: ReadonlyArray<ArchiveFile>): Uint8Array => {
  const parts: Array<Buffer> = [];
  for (const [index, file] of files.entries()) {
    const payload = `path=${file.path}\n`;
    // A PAX record's length counts its own decimal digits.
    let length = Buffer.byteLength(payload) + 3;
    while (length !== Buffer.byteLength(payload) + String(length).length + 1) {
      length = Buffer.byteLength(payload) + String(length).length + 1;
    }
    const record = Buffer.from(`${length} ${payload}`);
    parts.push(tarHeader(`PaxHeaders/${index}`, record.length, 0o644, "x"), ...padded(record));
    parts.push(tarHeader(`file-${index}`, file.content.length, file.mode & 0o777, "0"), ...padded(file.content));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]), { level: 9 });
};

interface TarEntry {
  readonly path: string;
  readonly mode: number;
  readonly content: Uint8Array;
}

/** An octal header field, or undefined when it holds anything but octal digits. */
const readOctal = (header: Buffer, offset: number, length: number): number | undefined => {
  const text = header.subarray(offset, offset + length).toString("latin1").replace(/^ +/u, "").replace(/[\0 ]+$/u, "");
  return /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : undefined;
};

const entryKind = (type: string): string => {
  switch (type) {
    case "1": return "a hard link";
    case "2": return "a symbolic link";
    case "3": return "a character device";
    case "4": return "a block device";
    case "5": return "a directory";
    case "6": return "a FIFO";
    default: return `an entry of type '${type}'`;
  }
};

/**
 * Parse an export's tar stream strictly: ustar headers with valid checksums,
 * regular files, and PAX records that carry only `path`. Links, devices,
 * directories and every other entry type are refused rather than skipped, so
 * nothing the manifest does not describe can ride along.
 */
const decodeArchive = (path: string, compressed: Uint8Array): ReadonlyArray<TarEntry> => {
  const fail = (message: string) => new ArchiveIntegrityError({ path, message });
  let tar: Buffer;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAXIMUM_ARCHIVE_BYTES });
  } catch (error) {
    throw fail(`is not a gzip-compressed tar archive of at most ${MAXIMUM_ARCHIVE_BYTES} bytes (${error instanceof Error ? error.message : String(error)})`);
  }
  const entries: Array<TarEntry> = [];
  let offset = 0;
  let paxPath: string | undefined;
  for (;;) {
    if (offset + 512 > tar.length) throw fail("ends before its end-of-archive marker");
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (readOctal(header, 148, 8) !== sum) throw fail(`has a damaged entry header at byte ${offset}`);
    if (header.subarray(257, 263).toString("latin1") !== "ustar\0") throw fail("is not a POSIX tar archive");
    const size = readOctal(header, 124, 12);
    if (size === undefined) throw fail(`has an entry without a size at byte ${offset}`);
    const start = offset + 512;
    if (start + size > tar.length) throw fail("ends inside an entry");
    const body = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156]!);
    if (type === "x") {
      if (paxPath !== undefined) throw fail("has two extended headers in a row");
      paxPath = paxPathOf(body, fail);
      continue;
    }
    const name = paxPath ?? ustarName(header);
    paxPath = undefined;
    if (type !== "0" && type !== "\0") throw fail(`holds ${name}, ${entryKind(type)}; an export holds regular files only`);
    const mode = readOctal(header, 100, 8);
    if (mode === undefined || mode > 0o777) throw fail(`holds ${name} with a special or unreadable mode; an export holds plain permission bits only`);
    entries.push({ path: name, mode, content: body });
    if (entries.length > MAXIMUM_FILES + 1) throw fail(`holds more than ${MAXIMUM_FILES} files`);
  }
  if (paxPath !== undefined) throw fail("ends after an extended header with no entry");
  return entries;
};

const ustarName = (header: Buffer): string => {
  const field = (offset: number, length: number) => {
    const bytes = header.subarray(offset, offset + length);
    const end = bytes.indexOf(0);
    return bytes.subarray(0, end < 0 ? length : end).toString("utf8");
  };
  const prefix = field(345, 155);
  const name = field(0, 100);
  return prefix.length > 0 ? `${prefix}/${name}` : name;
};

/** The `path` of a PAX extended header; any other field is refused. */
const paxPathOf = (body: Buffer, fail: (message: string) => ArchiveIntegrityError): string => {
  let path: string | undefined;
  let position = 0;
  while (position < body.length) {
    const space = body.indexOf(0x20, position);
    const length = space < 0 ? Number.NaN : Number(body.subarray(position, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= 0 || position + length > body.length || body[position + length - 1] !== 0x0a) {
      throw fail("has a malformed extended header");
    }
    const record = body.subarray(space + 1, position + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    const key = equals < 0 ? record : record.slice(0, equals);
    if (key !== "path" || path !== undefined) throw fail(`has an extended header field '${key}'; an export records only paths there`);
    path = record.slice(equals + 1);
    position += length;
  }
  if (path === undefined) throw fail("has an extended header without a path");
  return path;
};

// ── manifest verification ────────────────────────────────────────────────

/** A folder file an archive restores, relative to `~/.canonfig/`. */
export interface ArchivedFolderFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
}

export interface VerifiedArchive {
  readonly manifest: Omit<ExportManifest, "files">;
  readonly manifestSha256: ContentDigest;
  readonly archiveSha256: ContentDigest;
  readonly folderFiles: ReadonlyArray<ArchivedFolderFile>;
  /** Harness entries, checked like the rest and never written. */
  readonly harnessFiles: ReadonlyArray<ManifestFile>;
}

/**
 * Check an export before anything uses it: `manifest.json` comes first and
 * lists every other entry exactly once with its size, SHA-256 and mode, and
 * every entry sits inside the allowlist. Any difference refuses the whole
 * archive.
 */
const verifyArchive = (path: string, bytes: Uint8Array): VerifiedArchive => {
  const fail = (message: string) => new ArchiveIntegrityError({ path, message });
  const [first, ...entries] = decodeArchive(path, bytes);
  if (first?.path !== MANIFEST_PATH) throw fail(`does not start with ${MANIFEST_PATH}, so it is not a Canonfig export`);
  let manifest: ExportManifest;
  try {
    manifest = Schema.decodeUnknownSync(ExportManifest)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(first.content)));
  } catch (error) {
    throw fail(`has an unreadable ${MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const listed = new Map<string, ManifestFile>();
  for (const file of manifest.files) {
    const problem = archivePathProblem(file.path);
    if (problem !== undefined) throw fail(`${MANIFEST_PATH} lists ${file.path}, which ${problem}`);
    if (file.path === MANIFEST_PATH || listed.has(file.path)) throw fail(`${MANIFEST_PATH} lists ${file.path} twice`);
    listed.set(file.path, file);
  }
  const collision = caseCollision([...listed.keys()]);
  if (collision !== undefined) throw fail(`holds ${collision}, which differ only in case`);

  const folderFiles: Array<ArchivedFolderFile> = [];
  const harnessFiles: Array<ManifestFile> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.path === MANIFEST_PATH || seen.has(entry.path)) throw fail(`holds ${entry.path} twice`);
    seen.add(entry.path);
    const file = listed.get(entry.path);
    if (file === undefined) throw fail(`holds ${entry.path}, which ${MANIFEST_PATH} does not list`);
    if (entry.content.length !== file.size || sha256BytesHex(entry.content) !== file.sha256) {
      throw fail(`${entry.path} does not match its checksum in ${MANIFEST_PATH}; the archive was changed or damaged after export`);
    }
    if (modeText(entry.mode) !== file.mode) throw fail(`${entry.path} has mode ${modeText(entry.mode)}, but ${MANIFEST_PATH} records ${file.mode}`);
    const segments = entry.path.split("/");
    if (credentialFileName(segments.at(-1)!)) throw fail(`holds ${entry.path}, a credential file name; an export never holds one`);
    if (entry.path.startsWith(FOLDER_PREFIX) && folderEntryOf(entry.path.slice(FOLDER_PREFIX.length)) !== undefined) {
      folderFiles.push({ path: entry.path.slice(FOLDER_PREFIX.length), content: entry.content, mode: entry.mode });
      continue;
    }
    // `harnesses/<harness>/<path below home>`, with the manifest naming the same harness.
    const harness = entry.path.startsWith(HARNESS_PREFIX) && segments.length > 2 ? segments[1]! : undefined;
    if (harness !== undefined && HARNESS_DIRECTORIES.has(harness) && file.harness === harness) {
      harnessFiles.push(file);
      continue;
    }
    throw fail(`holds ${entry.path}, which is outside what an export may hold (folder/<authored entry or local> and harnesses/<harness>/)`);
  }
  const missing = [...listed.keys()].find((listedPath) => !seen.has(listedPath));
  if (missing !== undefined) throw fail(`${MANIFEST_PATH} lists ${missing}, which the archive does not hold`);
  if (!folderFiles.some((file) => file.path === "canonfig.jsonc")) throw fail("holds no folder/canonfig.jsonc, so it is not a Canonfig export");
  const { files: _files, ...summary } = manifest;
  return {
    manifest: summary,
    manifestSha256: sha256BytesHex(first.content),
    archiveSha256: sha256BytesHex(bytes),
    folderFiles,
    harnessFiles,
  };
};

// ── export ───────────────────────────────────────────────────────────────

export interface MachineIdentity {
  readonly role: MachineRole;
  /** Whose Applied Resource Records describe this machine's harnesses. */
  readonly follower: FollowerId;
}

/** Which role this machine plays: an enrolled follower, an initialized Source, or neither. */
export const machineIdentity = Effect.gen(function*() {
  const repository = yield* StateRepository;
  const configuration = yield* repository.getFollowerSynchronizationConfiguration();
  const identity: MachineIdentity = configuration !== undefined
    ? { role: "follower", follower: configuration.follower.id }
    : {
      role: (yield* repository.getEnrollmentSource()) === undefined ? "standalone" : "source",
      follower: localProjectionFollower,
    };
  return identity;
});

/**
 * Run filesystem work for an export or import. Archive and folder errors pass
 * through with their own wording; anything else (a permission error, say)
 * becomes a request error naming `path`.
 */
const archiveWork = <A>(path: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) =>
      error instanceof ArchiveRequestError || error instanceof ArchiveConflictError
        || error instanceof ArchiveIntegrityError || error instanceof CanonicalFolderError
        ? error
        : new ArchiveRequestError({ path, message: `cannot be read: ${error instanceof Error ? error.message : String(error)}` }),
  });

const errorCode = (error: Error): string | undefined => "code" in error ? String(error.code) : undefined;
const isMissing = (error: Error): boolean => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";

/** A path's own status without following it, or undefined when nothing is there. */
const lstatIfPresent = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return undefined;
    throw error;
  }
};

/**
 * The bytes left of an export's content limit. Every read is bounded by what
 * remains, so the limit holds before a file is loaded, not after.
 */
interface ContentBudget {
  remaining: number;
}

const overBudget = (path: string) =>
  new ArchiveRequestError({
    path,
    message: `would take the export past ${MAXIMUM_CONTENT_BYTES} bytes of content, the most an archive holds; move large files out of the folder, then export again`,
  });

/**
 * One regular file's bytes, read through the machine's guarded reader: no
 * link anywhere below `anchor`, a non-blocking open so a FIFO is refused
 * rather than waited on, the size checked before reading and enforced while
 * reading against the budget. Undefined when the file does not exist.
 */
const readBudgeted = (anchor: string, path: string, budget: ContentBudget, limit = budget.remaining) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const content = yield* machine.readFile({
      path: yield* machine.normalizePath({ path }),
      anchor: yield* machine.normalizePath({ path: anchor }),
      maximumBytes: Math.min(limit, budget.remaining),
    }).pipe(
      Effect.map((bytes): Uint8Array | undefined => bytes),
      Effect.catchTag("FileSizeLimitError", () =>
        limit < budget.remaining
          ? Effect.fail(new ArchiveRequestError({ path, message: `is larger than ${limit} bytes, the most export reads from one harness file` }))
          : Effect.fail(overBudget(path))
      ),
      Effect.catchTag("MachineFilesystemError", (error) =>
        /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message)
          ? Effect.succeed(undefined)
          : Effect.fail(new ArchiveRequestError({ path, message: `cannot be exported: ${error.message}; an export holds regular files reached without links only` }))
      ),
    );
    if (content !== undefined) budget.remaining -= content.length;
    return content;
  });

/**
 * The folder's authored entries and `local/`, as `folder/...` entries, each
 * file read exactly once: these bytes are the ones checked for credentials
 * and the ones archived. The directory listings refuse links and anything
 * resolving outside the folder, as publication does; the reads are anchored
 * at the folder, so an ancestor swapped for a link after listing is refused.
 * A folder file's mode is 0755 when its owner may execute it, else 0644.
 */
const collectFolder = (folder: string, budget: ContentBudget) =>
  Effect.gen(function*() {
    const realFolder = yield* archiveWork(folder, () => realpath(folder));
    const files: Array<ArchiveFile> = [];
    for (const entry of FOLDER_ENTRIES) {
      const listed = FOLDER_FILES.has(entry)
        ? [{ path: entry, executable: false }]
        : (yield* archiveWork(join(folder, entry), () => listFolderFiles(realFolder, entry)))
          .map((file) => ({ path: `${entry}/${file.path}`, executable: file.executable }));
      for (const file of listed) {
        const absolute = join(realFolder, ...file.path.split("/"));
        if (credentialFileName(basename(absolute))) {
          return yield* new ArchiveRequestError({ path: absolute, message: "is a credential file; an export never holds one. Move it out of the Canonical Folder, then export again" });
        }
        const content = yield* readBudgeted(realFolder, absolute, budget);
        if (content === undefined) {
          if (FOLDER_FILES.has(entry)) continue;
          return yield* new ArchiveRequestError({ path: absolute, message: "disappeared while the export read the folder; run the export again" });
        }
        files.push({ path: `${FOLDER_PREFIX}${file.path}`, content, mode: file.executable ? 0o755 : 0o644 });
      }
    }
    return files;
  });

/**
 * Refuse any secret value in the bytes about to be archived. Every folder
 * file, comments and hook scripts included, gets the literal-credential
 * pattern check; the items `canonfig.jsonc` and `local/local.jsonc` declare,
 * decoded from those same bytes, also get publication's field-name rule, so
 * MCP secrets must be environment references.
 */
const assertNoLiteralCredentials = (folder: string, files: ReadonlyArray<ArchiveFile>) =>
  Effect.gen(function*() {
    const refuse = (path: string, location: string) =>
      new ArchiveRequestError({
        path,
        message: `has a literal credential${location} [REDACTED]; an export never holds secret values. Replace it with an environment reference such as { "fromEnv": "NAME" } or $NAME, then export again`,
      });
    const textOf = (path: string) => {
      const file = files.find((candidate) => candidate.path === `${FOLDER_PREFIX}${path}`);
      return file === undefined ? undefined : new TextDecoder().decode(file.content);
    };
    for (const file of files) {
      if (containsLiteralCredential(new TextDecoder().decode(file.content))) {
        return yield* refuse(join(folder, ...file.path.slice(FOLDER_PREFIX.length).split("/")), "");
      }
    }
    const configPath = join(folder, "canonfig.jsonc");
    const configText = textOf("canonfig.jsonc");
    if (configText === undefined) {
      return yield* new ArchiveRequestError({ path: configPath, message: "does not exist, so there is no Canonical Folder to export; create it with 'canonfig setup plan --role source'" });
    }
    const localPath = join(folder, "local", "local.jsonc");
    const localText = textOf("local/local.jsonc");
    const [config, local] = yield* Effect.try({
      try: () => [decodeFolderConfig(configPath, configText), localText === undefined ? {} : decodeLocalConfig(localPath, localText)] as const,
      catch: (error) => error instanceof CanonicalFolderError ? error : new ArchiveRequestError({ path: configPath, message: String(error) }),
    });
    const items = (file: string, values: { readonly mcp?: object | undefined; readonly settings?: object | undefined }, hooks: ReadonlyArray<{ readonly id: string }> = []) => [
      ...Object.entries(values.mcp ?? {}).map(([name, value]) => [file, `mcp.${name}`, value] as const),
      ...hooks.map((hook) => [file, `hooks.${hook.id}`, hook] as const),
      ...Object.entries(values.settings ?? {}).map(([harness, value]) => [file, `settings.${harness}`, value] as const),
    ];
    for (const [file, itemPath, value] of [...items(configPath, config, config.hooks ?? []), ...items(localPath, local)]) {
      const location = literalCredentialLocation(itemPath, Schema.decodeUnknownSync(ConfigValue)(asJson(value)));
      if (location !== undefined) return yield* refuse(file, ` at ${location}`);
    }
  });

/** A harness surface export left out, and why. */
export interface SkippedHarnessSurface {
  readonly harness: string;
  readonly surface: string;
  readonly target: string;
  readonly reason: string;
}

const changedSinceApply = "changed since Canonfig last applied it, so it no longer holds only what Canonfig wrote";

interface CapturedFile {
  /** Below the surface's target, for a directory's owned files. */
  readonly below?: string | undefined;
  readonly content: Uint8Array;
  readonly mode: number;
  readonly keys?: ReadonlyArray<string> | undefined;
}

/** A surface's files, or why export leaves the surface out. */
type SurfaceCapture = { readonly files: ReadonlyArray<CapturedFile> } | { readonly leftOut: string };

/**
 * What one applied harness surface holds now, when that is exactly what
 * Canonfig last wrote: a file, the owned files of a directory, or the owned
 * keys of a shared file rendered alone. Reads are anchored at the real home
 * directory and bounded by the budget; a surface left out gives its bytes
 * back to the budget.
 */
const surfaceFiles = (record: AppliedResourceRecord, target: MachinePath, home: string, budget: ContentBudget) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const kindOf = (path: MachinePath) =>
      machine.inspectPath(path).pipe(
        Effect.map((object): string => object.kind),
        Effect.catchTag("MachineFilesystemError", (error) =>
          /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message) ? Effect.succeed("absent") : Effect.fail(error)
        ),
      );
    const before = budget.remaining;
    const read = (path: MachinePath) => readBudgeted(home, path.absolute, budget, MAXIMUM_HARNESS_FILE_BYTES);
    const leftOut = (reason: string): SurfaceCapture => {
      budget.remaining = before;
      return { leftOut: reason };
    };
    const kind = yield* kindOf(target);
    const unexpected = (expected: string) => leftOut(kind === "absent" ? "is missing" : `is a ${kind}, not a ${expected}`);
    switch (record.kind) {
      case "file": {
        if (record.symlinkTo !== undefined) return leftOut("is a link Canonfig applied, which an export does not hold");
        if (kind !== "regular") return unexpected("regular file");
        const content = yield* read(target);
        if (content === undefined || sha256BytesHex(content) !== record.digest) return leftOut(changedSinceApply);
        return { files: [{ content, mode: (yield* machine.permissions(target)).mode }] } satisfies SurfaceCapture;
      }
      case "directory": {
        if (kind !== "directory") return unexpected("directory");
        const files: Array<CapturedFile> = [];
        for (const owned of record.ownedFiles ?? []) {
          if (owned.objectKind === "directory") continue;
          if (owned.objectKind === "symlink" || owned.symlinkTo !== undefined) return leftOut("holds a link Canonfig applied, which an export does not hold");
          const child = yield* machine.normalizePath({ path: owned.path, base: target });
          if ((yield* kindOf(child)) !== "regular") return leftOut(changedSinceApply);
          const content = yield* read(child);
          if (content === undefined || sha256BytesHex(content) !== owned.digest) return leftOut(changedSinceApply);
          files.push({ below: owned.path, content, mode: (yield* machine.permissions(child)).mode });
        }
        return { files } satisfies SurfaceCapture;
      }
      case "config": {
        if (kind !== "regular") return unexpected("regular file");
        const format = record.configFormat;
        const keys = record.ownedKeys ?? [];
        if (format === undefined || keys.length === 0) return leftOut("has no owned keys on record");
        const bytes = yield* read(target);
        if (bytes === undefined) return leftOut("is missing");
        let document;
        try {
          document = parseConfigDocument(format, new TextDecoder().decode(bytes));
        } catch {
          return leftOut(`cannot be parsed as ${format}`);
        }
        if (configKeysDigest(format, document, keys) !== record.digest) return leftOut(changedSinceApply);
        const present = keys.flatMap((key) => {
          const value = getConfigPath(document, key);
          return value === undefined ? [] : [{ path: key, value }];
        });
        // Only the owned keys leave the machine: every other key of a shared
        // file (logins, trust, history) is the harness's own state.
        const content = renderConfigDocument({ format, keys: present });
        budget.remaining = before - content.length;
        return { files: [{ content, mode: 0o600, keys: present.map((entry) => entry.path) }] } satisfies SurfaceCapture;
      }
      default:
        return leftOut(`is a ${record.kind ?? "untyped"} resource, which an export does not hold`);
    }
  });

/**
 * `--include-harnesses`: every harness file Canonfig manages here, from its
 * Applied Resource Records, as `harnesses/<harness>/<path below home>`. A
 * surface that changed since Canonfig applied it is left out and reported, so
 * an archive never holds content Canonfig did not write.
 */
const collectHarnesses = (records: ReadonlyArray<AppliedResourceRecord>, budget: ContentBudget) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const home = (yield* machine.userDirectories()).home;
    const realHome = yield* archiveWork(home.absolute, () => realpath(home.absolute));
    const paths = home.platform === "windows" ? win32 : posix;
    const files: Array<ArchiveFile> = [];
    const skipped: Array<SkippedHarnessSurface> = [];
    for (const record of [...records].sort((left, right) => left.resource < right.resource ? -1 : left.resource > right.resource ? 1 : 0)) {
      const parsed = parseSurfaceResourceId(record.resource);
      if (parsed === undefined || record.target === undefined) continue;
      const fromHome = paths.relative(home.absolute, record.target);
      const skip = (reason: string) => skipped.push({ harness: parsed.harness, surface: parsed.surface, target: record.target!, reason });
      if (fromHome === "" || fromHome === ".." || fromHome.startsWith(`..${paths.sep}`) || paths.isAbsolute(fromHome)) {
        skip("is outside the home directory");
        continue;
      }
      const belowHome = fromHome.split(paths.sep).join("/");
      const target = yield* machine.normalizePath({ path: paths.join(realHome, fromHome) });
      const captured = yield* surfaceFiles(record, target, realHome, budget);
      if ("leftOut" in captured) {
        skip(captured.leftOut);
        continue;
      }
      for (const file of captured.files) {
        const below = file.below === undefined ? belowHome : `${belowHome}/${file.below}`;
        files.push({
          path: `${HARNESS_PREFIX}${parsed.harness}/${below}`,
          content: file.content,
          mode: file.mode & 0o777,
          harness: parsed.harness,
          target: `~/${below}`,
          keys: file.keys,
        });
      }
    }
    return { files, skipped };
  });

/**
 * Where the archive goes: a `.tar.gz` in an existing directory inside the
 * home directory and outside the Canonical Folder. Without `--output`, a
 * timestamped name in the working directory. These checks fail early with a
 * clear message; publication enforces them again (see `exportFolder`).
 */
const destinationOf = async (input: ExportInput, home: string) => {
  const stamp = input.now.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  const requested = resolve(input.cwd, input.output ?? `canonfig-export-${stamp}.tar.gz`);
  if (!requested.endsWith(".tar.gz")) throw new ArchiveRequestError({ path: requested, message: "must end in .tar.gz" });
  let parent: string;
  try {
    parent = await realpath(dirname(requested));
  } catch {
    throw new ArchiveRequestError({ path: dirname(requested), message: "does not exist; create the directory or choose another --output" });
  }
  const inside = (root: string, path: string) => {
    const fromRoot = relative(root, path);
    return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
  };
  const realHome = await realpath(home);
  if (!inside(realHome, parent)) {
    throw new ArchiveRequestError({ path: requested, message: `is outside the home directory ${home}; Canonfig writes only inside it, so choose an --output below it` });
  }
  const realFolder = await realpath(input.folder).catch(() => resolve(input.folder));
  if (inside(realFolder, parent)) {
    throw new ArchiveRequestError({ path: requested, message: `is inside the Canonical Folder ${input.folder}; choose an --output outside it` });
  }
  const destination = join(parent, basename(requested));
  const existing = await lstatIfPresent(destination);
  if (existing?.isDirectory() === true) throw new ArchiveRequestError({ path: destination, message: "is a directory; name the archive file" });
  if (existing !== undefined && !input.force) throw outputExists(destination);
  return { destination, realHome };
};

const outputExists = (destination: string) =>
  new ArchiveConflictError({ path: destination, message: "already exists; pass --force to replace it, or choose another --output" });

export interface ExportInput {
  readonly folder: string;
  /** As typed; relative to `cwd`. */
  readonly output?: string | undefined;
  readonly cwd: string;
  readonly includeHarnesses: boolean;
  /** Replace an existing archive at the output path. */
  readonly force: boolean;
  readonly now: Date;
}

/**
 * `canonfig export`: write the folder (and with `includeHarnesses` the
 * managed harness files) to one private `.tar.gz`. It changes nothing
 * Canonfig manages, so it is no Synchronization Run; the command journal in
 * `canonfig.log` records it, and the manifest records what it holds.
 */
export const exportFolder = Effect.fn("Archive.export")(function*(input: ExportInput) {
  const machine = yield* MachineState;
  const repository = yield* StateRepository;
  const identity = yield* machineIdentity;
  const home = (yield* machine.userDirectories()).home.absolute;
  const { destination, realHome } = yield* archiveWork(input.output ?? input.cwd, () => destinationOf(input, home));
  const budget: ContentBudget = { remaining: MAXIMUM_CONTENT_BYTES };
  const folderFiles = yield* collectFolder(input.folder, budget);
  // Harness files are not pattern-scanned: each is a projection of these
  // checked items, and a harness config spells an environment reference in
  // its own syntax (Codex `env_http_headers` maps a header to a bare
  // variable name), which the pattern would misread as a literal.
  yield* assertNoLiteralCredentials(input.folder, folderFiles);
  const harnesses = input.includeHarnesses
    ? yield* collectHarnesses(yield* repository.loadAppliedResources(identity.follower), budget)
    : { files: [], skipped: [] };
  const files = [...folderFiles, ...harnesses.files].sort(byPath);

  const refuse = (message: string) => new ArchiveRequestError({ path: input.folder, message });
  if (files.length > MAXIMUM_FILES) return yield* refuse(`holds ${files.length} files; an export holds at most ${MAXIMUM_FILES}`);
  const bytes = files.reduce((total, file) => total + file.content.length, 0);
  if (bytes > MAXIMUM_CONTENT_BYTES) return yield* refuse(`holds ${bytes} bytes; an export holds at most ${MAXIMUM_CONTENT_BYTES}`);
  for (const file of files) {
    const problem = archivePathProblem(file.path);
    if (problem !== undefined) return yield* refuse(`${file.path} cannot go into an archive: it ${problem}; rename it, then export again`);
  }
  const collision = caseCollision(files.map((file) => file.path));
  if (collision !== undefined) return yield* refuse(`holds ${collision}, which differ only in case and would overwrite each other on macOS and Windows; rename one, then export again`);

  const createdAt = Schema.decodeUnknownSync(Timestamp)(input.now.toISOString());
  const manifest: ExportManifest = {
    format: "canonfig-export",
    version: 1,
    canonfigVersion: packageVersion,
    createdAt,
    role: identity.role,
    files: files.map((file) => ({
      path: file.path,
      size: file.content.length,
      sha256: sha256BytesHex(file.content),
      mode: modeText(file.mode),
      harness: file.harness,
      target: file.target,
      keys: file.keys,
    })),
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, undefined, 2)}\n`);
  const archive = encodeArchive([{ path: MANIFEST_PATH, content: manifestBytes, mode: 0o644 }, ...files]);
  // The checked parent is real and below the real home, and the write is
  // anchored there: it publishes only into that directory, reached without
  // links, so a parent swapped since the checks cannot move the archive out
  // of home or into the folder. Without --force it publishes by hard link,
  // which refuses a file even when one appeared after the checks.
  yield* machine.atomicWrite({
    path: yield* machine.normalizePath({ path: destination }),
    anchor: yield* machine.normalizePath({ path: realHome }),
    noReplace: !input.force,
    content: archive,
    mode: 0o600,
  }).pipe(
    Effect.catchTag("MachineFilesystemError", (error): Effect.Effect<never, ArchiveConflictError | ArchiveRequestError> => {
      if (/\bEEXIST\b/u.test(error.message)) return Effect.fail(outputExists(destination));
      if (!input.force && /\b(?:EPERM|ENOTSUP|EOPNOTSUPP|ENOSYS|EXDEV)\b/u.test(error.message)) {
        return Effect.fail(new ArchiveRequestError({
          path: destination,
          message: `could not be published without replacing: this filesystem refused the hard link that guarantees it (${error.message}). Choose an --output on a local disk, or pass --force`,
        }));
      }
      return Effect.fail(new ArchiveRequestError({ path: destination, message: `could not be written: ${error.message}` }));
    }),
  );
  return {
    output: destination,
    bytes: archive.length,
    sha256: sha256BytesHex(archive),
    manifestSha256: sha256BytesHex(manifestBytes),
    role: identity.role,
    createdAt,
    folderFiles: folderFiles.length,
    harnessFiles: harnesses.files.length,
    skippedHarnessSurfaces: harnesses.skipped.length === 0 ? undefined : harnesses.skipped,
  };
});

// ── import ───────────────────────────────────────────────────────────────

export interface ImportPlan extends LocalRevisionPlan {
  readonly archive: VerifiedArchive;
  /** Folder entries that held something and that the run replaces. */
  readonly replaced: ReadonlyArray<string>;
  /** Folder entries that hold something the archive does not speak for; left as they are. */
  readonly kept: ReadonlyArray<string>;
}

/**
 * Read and verify an export, then plan writing its folder entries into
 * `folder`: each file entry as a file, each directory entry as a whole
 * directory, so a replaced `skills/` holds exactly the archive's skills. A
 * folder entry that already holds something is refused unless `replace`.
 * Every write ends Canonfig's ownership in the same run, as restore does:
 * imported files are authored content, never Applied Resource Records a
 * later sync could retire.
 */
export const planImport = (input: {
  readonly folder: string;
  readonly archive: string;
  readonly replace: boolean;
  readonly appliedResources: ReadonlyArray<AppliedResourceRecord>;
}) =>
  Effect.gen(function*() {
    // One no-follow, non-blocking open of a regular file, its size checked on
    // that handle before reading and enforced while reading, so neither a
    // swapped path, a FIFO nor a file that grows can bypass the bound.
    const machine = yield* MachineState;
    const bytes = yield* machine.readFile({
      path: yield* machine.normalizePath({ path: input.archive }),
      maximumBytes: MAXIMUM_ARCHIVE_BYTES,
    }).pipe(
      Effect.catchTag("FileSizeLimitError", () =>
        Effect.fail(new ArchiveIntegrityError({ path: input.archive, message: `is larger than any export (${MAXIMUM_ARCHIVE_BYTES} bytes)` }))),
      Effect.catchTag("MachineFilesystemError", (error) =>
        Effect.fail(new ArchiveRequestError({
          path: input.archive,
          message: /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message) ? "does not exist" : `cannot be read as a regular file: ${error.message}`,
        }))),
    );
    const verified = yield* archiveWork(input.archive, async () => verifyArchive(input.archive, bytes));
    const configuration = verified.folderFiles.find((file) => file.path === "canonfig.jsonc")!;
    yield* Effect.try({
      try: () => decodeFolderConfig(join(input.folder, "canonfig.jsonc"), new TextDecoder().decode(configuration.content)),
      catch: (error) => new ArchiveIntegrityError({
        path: input.archive,
        message: `holds a canonfig.jsonc this Canonfig cannot read: ${error instanceof CanonicalFolderError ? error.message : String(error)}`,
      }),
    });

    const byEntry = new Map<string, Array<ArchivedFolderFile>>();
    for (const file of verified.folderFiles) {
      const entry = folderEntryOf(file.path)!;
      byEntry.set(entry, [...byEntry.get(entry) ?? [], file]);
    }
    const present: Array<string> = [];
    for (const entry of FOLDER_ENTRIES) {
      if (yield* archiveWork(join(input.folder, entry), () => holdsEntries(join(input.folder, entry)))) {
        present.push(entry);
      }
    }
    // The authored folder must be empty, and `local/` too when the archive
    // brings its own: an import never writes over what is there unasked.
    const occupied = present.filter((entry) => entry !== "local" || byEntry.has("local"));
    if (!input.replace && occupied.length > 0) {
      return yield* new ArchiveConflictError({
        path: input.folder,
        message: `already holds ${occupied.join(", ")}, and an import never overwrites them unasked. Export them first if you want a copy, then pass --replace to replace the entries the archive holds, or move them out of ${input.folder}`,
      });
    }

    const built: Array<BuiltResource> = [];
    for (const entry of FOLDER_ENTRIES) {
      const files = byEntry.get(entry);
      if (files === undefined) continue;
      const id = Schema.decodeUnknownSync(ResourceId)(`import:${entry}`);
      const target = join(input.folder, entry);
      const executable = (mode: number) => (mode & 0o100) !== 0;
      built.push(FOLDER_FILES.has(entry)
        ? fileResource(id, target, "replace", files[0]!.content, executable(files[0]!.mode))
        : directoryResource(id, target, "replace", files.map((file) => ({
          path: file.path.slice(entry.length + 1),
          content: file.content,
          executable: executable(file.mode),
        }))));
    }
    const planned = yield* planBuilt({
      follower: localProjectionFollower,
      origin: "archive",
      originDigest: verified.manifestSha256,
      built,
      retired: [],
      appliedResources: input.appliedResources,
      endsOwnership: built.map((item) => item.resource.id),
    });
    return {
      ...planned,
      archive: verified,
      replaced: present.filter((entry) => byEntry.has(entry)),
      kept: present.filter((entry) => !byEntry.has(entry)),
    } satisfies ImportPlan;
  });
