import { fork } from "node:child_process";
import { writeSync } from "node:fs";
import { lstat, mkdir, readlink, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";

import { directoryEntries, pathEntryMetadata, regularFileBytes, regularFileDigest } from "./regular-file.ts";
import { sameIdentity, verifyAnchoredMutation } from "./anchored-directory.ts";
import { copyVerifiedFileContent } from "./file-content.ts";
import { atomicWriteLeaf, mutatePosixLeaf, removeMatchingFile, setPosixLeafMode } from "./atomic-file.ts";
import { AnchoredMutationUnconfirmedError, FileSizeLimitError, UnconfirmedPublicationError } from "./machine-state.errors.ts";
import { removeTemporaryEntriesAt } from "./temporary-entries.ts";
import type { FileContent, FileIdentity, MachineDirectoryEntry, MachineObject, SafeRootMutation } from "./machine-state.types.ts";

type Operation =
  | { readonly kind: "remove-file"; readonly identity?: FileIdentity | undefined }
  | { readonly kind: "remove-directory" }
  | { readonly kind: "permissions"; readonly mode: number; readonly identity?: FileIdentity | undefined }
  | { readonly kind: "cleanup"; readonly recursive: boolean }
  | { readonly kind: "mutate"; readonly mutation: SafeRootMutation; readonly directoryMode: number; readonly fileMode: number }
  | { readonly kind: "copy"; readonly content: Exclude<FileContent, Uint8Array> }
  | { readonly kind: "list" }
  | { readonly kind: "metadata" }
  | { readonly kind: "readlink" }
  | { readonly kind: "digest"; readonly maximumBytes: number }
  | { readonly kind: "read"; readonly maximumBytes: number; readonly prefixBytes?: number | undefined }
  | {
    readonly kind: "write";
    readonly content: FileContent;
    readonly mode: number;
    readonly createParents: boolean;
    readonly noReplace?: boolean | undefined;
  };

interface AnchoredRequest {
  readonly anchor: string;
  readonly rootIdentity: FileIdentity;
  readonly components: ReadonlyArray<string>;
  readonly path: string;
  readonly operation: Operation;
}

type AnchoredResult =
  | { readonly kind: "unconfirmed-mutation"; readonly operation: string; readonly message: string }
  | { readonly kind: "cleaned"; readonly entries: ReadonlyArray<string> }
  | { readonly kind: "mutated"; readonly identity?: FileIdentity | undefined }
  | { readonly kind: "copied" }
  | { readonly kind: "entries"; readonly entries: ReadonlyArray<MachineDirectoryEntry> }
  | { readonly kind: "metadata"; readonly objectKind: MachineObject["kind"]; readonly mode: number; readonly identity: FileIdentity }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "size"; readonly maximumBytes: number }
  | { readonly kind: "written"; readonly identity: FileIdentity }
  | { readonly kind: "unconfirmed"; readonly published: FileIdentity; readonly message: string; readonly state: "in-place" | "replaced" }
  | { readonly kind: "error"; readonly message: string };

const positionChild = async (request: AnchoredRequest) => {
  const actualRoot = await lstat(".", { bigint: true });
  if (!sameIdentity(actualRoot, request.rootIdentity)) {
    throw new Error("anchor identity changed before opening the directory");
  }
  const operation = request.operation;
  const createMode = operation.kind === "write" && operation.createParents ? 0o700
    : operation.kind === "mutate" && operation.mutation.kind !== "remove" ? operation.directoryMode
    : undefined;
  const identities = [actualRoot];
  for (const part of request.components) {
    if (part === "" || part === "." || part === ".." || basename(part) !== part || part.includes("\0")) {
      throw new Error("the anchored path contains an invalid directory component");
    }
    const before = await lstat(part, { bigint: true }).catch(async (cause: unknown) => {
      if (createMode === undefined
        || !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      await mkdir(part, { mode: createMode });
      return lstat(part, { bigint: true });
    });
    if (!before.isDirectory()) throw new Error(`a real directory is required under the anchor: ${part}`);
    // chdir pins this directory on POSIX. Its inode must match the
    // no-follow lookup even if its name was replaced during the move.
    process.chdir(part);
    const after = await lstat(".", { bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(await lstat("..", { bigint: true }), identities.at(-1)!)) {
      throw new Error(`directory identity changed during anchored lookup: ${part}`);
    }
    identities.push(after);
  }
  return async () => {
    const root = await lstat(request.anchor, { bigint: true });
    if (!root.isDirectory() || !sameIdentity(request.rootIdentity, root)) {
      throw new Error("the configured anchor no longer names the pinned directory");
    }
    let fromLeaf = ".";
    for (let index = identities.length - 1; index >= 0; index--) {
      const identity = identities[index]!;
      const visible = await lstat(fromLeaf, { bigint: true });
      if (!visible.isDirectory() || !sameIdentity(identity, visible)) {
        throw new Error("directory ancestry changed during anchored operation");
      }
      if (index === 0) break;
      fromLeaf += "/..";
      const named = await lstat(`${fromLeaf}/${request.components[index - 1]!}`, { bigint: true });
      if (!named.isDirectory() || !sameIdentity(identity, named)) {
        throw new Error("directory entry changed during anchored operation");
      }
    }
  };
};

const operate = async (request: AnchoredRequest): Promise<AnchoredResult> => {
  try {
    const name = basename(request.path);
    if (name === "" || name === "." || name === ".." || name.includes("\0")) {
      throw new Error("invalid anchored file name");
    }
    const operation = request.operation;
    const verify = await positionChild(request).catch((cause: unknown) => {
      if (operation.kind === "list" && cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (verify === undefined) return { kind: "entries", entries: [] };
    if (operation.kind !== "mutate") await verify();
    const confirm = async (result: AnchoredResult, mutation?: string): Promise<AnchoredResult> => {
      if (mutation === undefined) await verify();
      else await verifyAnchoredMutation(verify, request.path, mutation);
      return result;
    };
    if (operation.kind === "remove-file") {
      await removeMatchingFile(name, operation.identity);
      return await confirm({ kind: "mutated" }, "remove-file");
    }
    if (operation.kind === "remove-directory") {
      await rmdir(name);
      return await confirm({ kind: "mutated" }, "remove-directory");
    }
    if (operation.kind === "permissions") {
      await setPosixLeafMode(name, operation.mode, operation.identity);
      return await confirm({ kind: "mutated" }, "permissions");
    }
    if (operation.kind === "cleanup") {
      return await confirm({ kind: "cleaned", entries: await removeTemporaryEntriesAt(".", operation.recursive, posix, false) }, "cleanup");
    }
    if (operation.kind === "mutate") {
      const identity = await mutatePosixLeaf(".", request.path, operation.mutation, operation.fileMode, verify);
      return { kind: "mutated", identity };
    }
    if (operation.kind === "copy") {
      // The parent passes its open staging file as descriptor 4. Copy
      // directly into it while the worker holds the source parent as cwd.
      await copyVerifiedFileContent(name, operation.content, (chunk, offset, length) =>
        writeSync(4, chunk, offset, length, null));
      return await confirm({ kind: "copied" });
    }
    if (operation.kind === "list") return await confirm({ kind: "entries", entries: await directoryEntries(".") });
    if (operation.kind === "metadata") return await confirm({ kind: "metadata", ...await pathEntryMetadata(name) });
    if (operation.kind === "digest") return await confirm({ kind: "string", value: await regularFileDigest(name, operation.maximumBytes) });
    if (operation.kind === "readlink") return await confirm({ kind: "string", value: await readlink(name) });
    if (operation.kind === "write") {
      const identity = await atomicWriteLeaf(".", request.path, operation.content, operation.mode,
        { noReplace: operation.noReplace, verify });
      return { kind: "written", identity };
    }
    const bytes = await regularFileBytes(name, operation.maximumBytes, operation.prefixBytes);
    return await confirm({ kind: "bytes", bytes });
  } catch (cause) {
    if (cause instanceof AnchoredMutationUnconfirmedError) {
      return { kind: "unconfirmed-mutation", operation: cause.operation, message: cause.message };
    }
    if (cause instanceof FileSizeLimitError) return { kind: "size", maximumBytes: cause.maximumBytes };
    if (cause instanceof UnconfirmedPublicationError) {
      return { kind: "unconfirmed", published: cause.published, message: cause.message, state: cause.state };
    }
    return { kind: "error", message: cause instanceof Error ? cause.message : "anchored file operation failed" };
  }
};

const workerFlag = "--canonfig-posix-anchor-worker";
if (process.send !== undefined && process.argv[2] === workerFlag) {
  process.once("message", (request: AnchoredRequest) => {
    process.send?.({ kind: "ready" }, undefined, {}, () => {
      void operate(request).then((reply) => {
        process.send?.(reply, undefined, {}, () => process.disconnect?.());
      });
    });
  });
}

const operateRelativeTo = async (
  anchor: string,
  path: string,
  operation: Operation,
  destinationFd?: number,
): Promise<AnchoredResult> => {
  const takesDirectory = operation.kind === "list" || operation.kind === "cleanup";
  const directory = takesDirectory ? path : dirname(path);
  const parent = relative(anchor, directory);
  if (parent === ".." || parent.startsWith(`..${sep}`) || isAbsolute(parent) || path === anchor && !takesDirectory) {
    throw new Error(`${path} is not below ${anchor}`);
  }
  const root = await lstat(anchor, { bigint: true });
  if (!root.isDirectory()) throw new Error(`the anchor must be a real directory: ${anchor}`);
  const request: AnchoredRequest = {
    anchor,
    rootIdentity: { dev: root.dev, ino: root.ino },
    components: parent === "" ? [] : parent.split(sep),
    path,
    operation,
  };
  return await new Promise<AnchoredResult>((resolve, reject) => {
    const child = fork(new URL(import.meta.url), [workerFlag], {
      cwd: anchor,
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc", destinationFd ?? "ignore"],
    });
    const deadline = setTimeout(() => { child.kill(); }, 30_000);
    child.once("error", reject);
    let reply: AnchoredResult | undefined;
    child.on("message", (result: AnchoredResult | { readonly kind: "ready" }) => {
      // Do not kill an active writer on a startup deadline. The durable
      // publication and its result must both finish before rollback proceeds.
      if (result.kind === "ready") clearTimeout(deadline);
      else reply = result;
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (code !== 0 || reply === undefined) reject(new Error("anchored file process exited without a result"));
      else if (reply.kind === "error") reject(new Error(reply.message));
      else if (reply.kind === "size") reject(new FileSizeLimitError({ path, maximumBytes: reply.maximumBytes }));
      else if (reply.kind === "unconfirmed-mutation") {
        reject(new AnchoredMutationUnconfirmedError({ path, operation: reply.operation, message: reply.message }));
      } else if (reply.kind === "unconfirmed") {
        reject(new UnconfirmedPublicationError({ path, published: reply.published, message: reply.message, state: reply.state }));
      } else resolve(reply);
    });
    child.send(request, (error) => {
      if (error === null) return;
      child.kill();
      reject(error);
    });
  });
};

/** Read through a short-lived process whose working directory stays pinned. */
export const readPosixAnchoredFile = async (
  anchor: string, path: string, maximumBytes: number, prefixBytes?: number,
): Promise<Buffer> => {
  const reply = await operateRelativeTo(anchor, path, { kind: "read", maximumBytes, prefixBytes });
  if (reply.kind !== "bytes") throw new Error("anchored read returned an unexpected result");
  return reply.bytes;
};

export const writePosixAnchoredFile = async (
  anchor: string,
  path: string,
  operation: Omit<Extract<Operation, { kind: "write" }>, "kind">,
): Promise<FileIdentity> => {
  const reply = await operateRelativeTo(anchor, path, { kind: "write", ...operation });
  if (reply.kind !== "written") throw new Error("anchored write returned an unexpected result");
  return reply.identity;
};

export const statPosixAnchoredFile = async (anchor: string, path: string) => {
  const reply = await operateRelativeTo(anchor, path, { kind: "metadata" });
  if (reply.kind !== "metadata") throw new Error("anchored metadata returned an unexpected result");
  return reply;
};

export const readPosixAnchoredString = async (
  anchor: string,
  path: string,
  operation: Extract<Operation, { kind: "digest" | "readlink" }>,
): Promise<string> => {
  const reply = await operateRelativeTo(anchor, path, operation);
  if (reply.kind !== "string") throw new Error("anchored file lookup returned an unexpected result");
  return reply.value;
};

export const listPosixAnchoredDirectory = async (anchor: string, path: string) => {
  const reply = await operateRelativeTo(anchor, path, { kind: "list" });
  if (reply.kind !== "entries") throw new Error("anchored directory listing returned an unexpected result");
  return reply.entries;
};

export const copyPosixAnchoredFile = async (
  anchor: string, content: Exclude<FileContent, Uint8Array>, destinationFd: number,
): Promise<void> => {
  const reply = await operateRelativeTo(anchor, content.file, { kind: "copy", content }, destinationFd);
  if (reply.kind !== "copied") throw new Error("anchored file copy returned an unexpected result");
};

export const mutatePosixAnchoredEntry = async (
  anchor: string,
  path: string,
  mutation: SafeRootMutation,
  directoryMode: number,
  fileMode: number,
): Promise<FileIdentity | undefined> => {
  const reply = await operateRelativeTo(anchor, path, { kind: "mutate", mutation, directoryMode, fileMode });
  if (reply.kind !== "mutated") throw new Error("anchored mutation returned an unexpected result");
  return reply.identity;
};

export const changePosixAnchoredEntry = async (
  anchor: string,
  path: string,
  operation: Extract<Operation, { kind: "remove-file" | "remove-directory" | "permissions" }>,
): Promise<void> => {
  const reply = await operateRelativeTo(anchor, path, operation);
  if (reply.kind !== "mutated") throw new Error("anchored operation returned an unexpected result");
};

export const cleanPosixAnchoredDirectory = async (anchor: string, path: string, recursive: boolean) => {
  const reply = await operateRelativeTo(anchor, path, { kind: "cleanup", recursive });
  if (reply.kind !== "cleaned") throw new Error("anchored cleanup returned an unexpected result");
  return reply.entries.map((entry) => join(path, entry));
};
