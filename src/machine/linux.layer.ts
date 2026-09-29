import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { constants as filesystemConstants, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

import { Effect, Layer, Redacted, Schema } from "effect";

import {
  ContentDigest,
  CredentialReference,
  type CredentialReference as CredentialReferenceType,
} from "../domain/brand.ts";
import {
  CredentialStorageError,
  ExecutableNotFoundError,
  FileSizeLimitError,
  HumanActionRequiredError,
  InvalidMachinePathError,
  InvalidSchedulerJobError,
  MachineFilesystemError,
  type MachineStateError,
  ProcessOutputLimitError,
  ProcessStartError,
  ProcessTimeoutError,
} from "./machine-state.errors.ts";
import { MachineState } from "./machine-state.service.ts";
import { relocateFileContent, writeFileContent } from "./file-content.ts";
import { installDestinationDirectories } from "./install-destinations.ts";
import {
  guardEntryName,
  removeTemporaryEntriesAt,
  temporaryEntryName,
} from "./temporary-entries.ts";
import type {
  AtomicWriteInput,
  CredentialStorageCapability,
  DigestFileInput,
  DiscoveredExecutable,
  EnsureDirectoryInput,
  ExecutableQuery,
  FileDigest,
  FileContent,
  FilePermissions,
  LinuxMachineStateOptions,
  LoadCredentialInput,
  MachinePath,
  MachineDirectoryEntry,
  MachineObject,
  NormalizePathInput,
  ProcessEnvironmentEntry,
  ProcessInvocation,
  ProcessResult,
  ReadFileInput,
  RemoveEmptyDirectoryInput,
  RemoveFileInput,
  RemoveTemporaryEntriesInput,
  RenderedSchedulerJob,
  SafeRootMutationInput,
  SchedulerBackend,
  SchedulerCalendar,
  SchedulerJob,
  SchedulerSnapshot,
  SetPermissionsInput,
  StoreCredentialInput,
  SymlinkInput,
  UserDirectories,
  ValidatePathWithinRootInput,
} from "./machine-state.types.ts";

const decode = Schema.decodeUnknownSync;
const defaultDirectoryMode = 0o700;
const defaultFileMode = 0o600;
const maximumProcessInputBytes = 64 * 1024;

class ProcessTimeoutSignal extends Error {}
class ProcessOutputLimitSignal extends Error {}
class ProcessStartSignal extends Error {}
class CredentialCommandSignal extends Error {
  constructor(readonly reason: "timeout" | "output" | "start") {
    super(reason);
  }
}

const terminateProcessTree = (child: ChildProcess): void => {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }

  const taskkill = spawn(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", "/F"],
    { shell: false, stdio: "ignore", windowsHide: true },
  );
  const fallback = setTimeout(() => child.kill("SIGKILL"), 5_000);
  taskkill.once("error", () => {
    clearTimeout(fallback);
    child.kill("SIGKILL");
  });
  taskkill.once("close", () => {
    clearTimeout(fallback);
    child.kill("SIGKILL");
  });
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause
    ? String(cause.code)
    : undefined;

const filesystemError = (
  operation: string,
  path: string,
) => (cause: unknown): MachineFilesystemError =>
  new MachineFilesystemError({ operation, path, message: messageOf(cause) });

const promiseEffect = <Value>(
  operation: string,
  path: string,
  run: (signal: AbortSignal) => Promise<Value>,
): Effect.Effect<Value, MachineFilesystemError> =>
  Effect.tryPromise({
    try: run,
    catch: filesystemError(operation, path),
  });

const objectKind = (
  metadata: Awaited<ReturnType<typeof lstat>>,
): MachineObject["kind"] => {
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isFile()) return "regular";
  if (metadata.isDirectory()) return "directory";
  return "special";
};

const sameFileIdentity = (
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean => left.dev === right.dev && left.ino === right.ino;

const assertStableRegularHandle = async (
  path: string,
  handle: FileHandle,
  opened: Awaited<ReturnType<FileHandle["stat"]>>,
): Promise<void> => {
  if (!opened.isFile()) {
    throw new Error(`path is not a regular file: ${path}`);
  }
  const visible = await lstat(path);
  if (!visible.isFile() || !sameFileIdentity(opened, visible)) {
    throw new Error(`regular file target changed during read: ${path}`);
  }
};

const regularFileBytes = async (
  path: string,
  maximumBytes: number,
): Promise<Buffer> => {
  const handle = await open(
    path,
    filesystemConstants.O_RDONLY
      | filesystemConstants.O_NOFOLLOW
      | filesystemConstants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    await assertStableRegularHandle(path, handle, metadata);
    if (metadata.size > maximumBytes) {
      throw new FileSizeLimitError({ path, maximumBytes });
    }
    const chunks: Array<Buffer> = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maximumBytes)));
    while (true) {
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      const bytes = Buffer.from(chunk.subarray(0, result.bytesRead));
      total += bytes.byteLength;
      if (total > maximumBytes) {
        throw new FileSizeLimitError({ path, maximumBytes });
      }
      chunks.push(bytes);
    }
    await assertStableRegularHandle(path, handle, metadata);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
};

const regularFileDigest = async (
  path: string,
  maximumBytes: number,
): Promise<string> => {
  const handle = await open(
    path,
    filesystemConstants.O_RDONLY
      | filesystemConstants.O_NOFOLLOW
      | filesystemConstants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    await assertStableRegularHandle(path, handle, metadata);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      const bytes = Buffer.from(chunk.subarray(0, result.bytesRead));
      total += bytes.byteLength;
      if (total > maximumBytes) {
        throw new FileSizeLimitError({ path, maximumBytes });
      }
      hash.update(bytes);
    }
    await assertStableRegularHandle(path, handle, metadata);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

const checkLinuxPath = (
  path: MachinePath,
): Effect.Effect<string, InvalidMachinePathError> => {
  if (path.platform !== "linux") {
    return Effect.fail(new InvalidMachinePathError({
      path: path.absolute,
      message: `expected a Linux path, received ${path.platform}`,
    }));
  }
  if (!isAbsolute(path.absolute) || path.absolute.includes("\0")) {
    return Effect.fail(new InvalidMachinePathError({
      path: path.absolute,
      message: "a normalized absolute path without NUL bytes is required",
    }));
  }
  return Effect.succeed(path.absolute);
};

const linuxPath = (absolute: string): MachinePath => ({
  platform: "linux",
  absolute: normalize(absolute),
});

const sameFilesystemIdentity = (
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean => before.dev === after.dev && before.ino === after.ino;

const isWithin = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate);
  return remainder === ""
    || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder));
};

const environmentValue = (
  entries: ReadonlyArray<ProcessEnvironmentEntry>,
  name: string,
): string | undefined => entries.find((entry) => entry.name === name)?.value;

const processEnvironmentEntries = (): ReadonlyArray<ProcessEnvironmentEntry> =>
  Object.entries(process.env).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value }]
  );

const environmentObject = (
  base: ReadonlyArray<ProcessEnvironmentEntry>,
  additions: ReadonlyArray<ProcessEnvironmentEntry>,
  unset: ReadonlyArray<string> = [],
  unsetPrefixes: ReadonlyArray<string> = [],
): NodeJS.ProcessEnv => {
  const output: NodeJS.ProcessEnv = {};
  const blocked = new Set(unset.map((name) => name.toLowerCase()));
  const prefixes = unsetPrefixes.map((prefix) => prefix.toLowerCase());
  for (const entry of base) {
    const lower = entry.name.toLowerCase();
    if (blocked.has(lower) || prefixes.some((prefix) => lower.startsWith(prefix))) continue;
    output[entry.name] = entry.value;
  }
  for (const entry of additions) output[entry.name] = entry.value;
  return output;
};

interface CredentialCommandResult {
  readonly exitCode: number | null;
  readonly standardOutput: Buffer;
  /**
   * First non-empty stderr line, bounded. secret-tool reports only fixed
   * diagnostics there ("Cannot autolaunch D-Bus…", "password is too long"),
   * never secret bytes, so it can reach an operator-facing error.
   */
  readonly diagnostic: string;
}

const credentialCommandTimeoutMilliseconds = 5_000;

const firstDiagnosticLine = (bytes: Buffer): string =>
  bytes.toString("utf8")
    .split("\n")
    .map((line) => line.replace(/\p{Cc}/gu, " ").trim())
    .find((line) => line.length > 0)
    ?.slice(0, 300) ?? "";

const runCredentialCommand = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  environment: ReadonlyArray<ProcessEnvironmentEntry>,
  additions: ReadonlyArray<ProcessEnvironmentEntry>,
  secret?: Uint8Array | undefined,
): Effect.Effect<CredentialCommandResult, HumanActionRequiredError> =>
  Effect.tryPromise({
    try: (signal) => new Promise<CredentialCommandResult>((resolveCommand, rejectCommand) => {
      const child = spawn(executable, [...arguments_], {
        env: environmentObject(environment, additions),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const output: Array<Buffer> = [];
      const errors: Array<Buffer> = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let failure: CredentialCommandSignal["reason"] | undefined;
      const fail = (reason: CredentialCommandSignal["reason"]): void => {
        if (failure !== undefined) return;
        failure = reason;
        child.kill("SIGKILL");
      };
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 1024 * 1024) {
          fail("output");
          return;
        }
        output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 1024 * 1024) {
          fail("output");
          return;
        }
        if (errorBytes < 4096) {
          errors.push(chunk);
          errorBytes += chunk.byteLength;
        }
      });
      child.once("error", () => fail("start"));
      // A tool that exits before reading its input must not crash the CLI
      // with an unhandled EPIPE: its exit status reports the failure.
      child.stdin.on("error", () => undefined);
      const timer = setTimeout(() => fail("timeout"), credentialCommandTimeoutMilliseconds);
      const abort = (): void => {
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure !== undefined) {
          rejectCommand(new CredentialCommandSignal(failure));
          return;
        }
        resolveCommand({
          exitCode,
          standardOutput: Buffer.concat(output),
          diagnostic: firstDiagnosticLine(Buffer.concat(errors)),
        });
      });
      if (secret === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(secret);
      }
    }),
    catch: (cause) => {
      const reason = cause instanceof CredentialCommandSignal ? cause.reason : "start";
      return new HumanActionRequiredError({
        action: "reach Linux credential storage",
        recovery: reason === "timeout"
          ? `${executable} did not answer within ${credentialCommandTimeoutMilliseconds} ms. The Secret Service provider is probably waiting on an unlock prompt this session cannot show: unlock the login keyring for this user (log in with your password, or unlock it in the desktop session), then retry.`
          : reason === "output"
          ? `${executable} produced more than 1 MiB of output; the Secret Service provider did not answer as expected.`
          : `${executable} could not be started. Install the Secret Service client (Debian and Ubuntu: libsecret-tools; Fedora and RHEL: libsecret; Arch: libsecret), then retry.`,
      });
    },
  });

const makeTemporarySibling = (path: string): string =>
  join(dirname(path), temporaryEntryName());

const removeManagedLeaf = async (path: string): Promise<void> => {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await rmdir(path);
    } else {
      await unlink(path);
    }
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
};

const prepareManagedLeafKind = async (
  path: string,
  kind: "directory" | "non-directory",
): Promise<void> => {
  try {
    const metadata = await lstat(path);
    const directory = metadata.isDirectory() && !metadata.isSymbolicLink();
    if (kind === "directory" ? !directory : directory) {
      await removeManagedLeaf(path);
    }
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
};

const syncHandle = (
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> =>
  handle.sync().then(
    () => undefined,
    // Windows raises EPERM for fsync on some filesystems and directory
    // handles; durability there relies on the rename, not the flush.
    (cause: NodeJS.ErrnoException) => {
      if (
        process.platform === "win32"
        && (cause.code === "EPERM" || cause.code === "EINVAL")
      ) {
        return undefined;
      }
      throw cause;
    },
  );

const atomicWriteFile = (
  path: string,
  content: FileContent,
  mode: number,
): Effect.Effect<void, MachineFilesystemError> =>
  promiseEffect("atomically write file", path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: defaultDirectoryMode });
    const temporary = makeTemporarySibling(path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", mode);
      await writeFileContent(handle, content);
      await syncHandle(handle);
      await handle.chmod(mode);
      await handle.close();
      handle = undefined;
      await prepareManagedLeafKind(path, "non-directory");
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try {
        await syncHandle(directory);
      } finally {
        await directory.close();
      }
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }).pipe(Effect.uninterruptible);

const descriptorPath = (handle: FileHandle): string =>
  `/proc/self/fd/${handle.fd}`;

const portableSafeRootMutation = async (
  root: string,
  path: string,
  input: SafeRootMutationInput,
  symlinkTarget: string | undefined,
  beforeMutation: (() => Promise<void>) | undefined,
): Promise<void> => {
  const rootHandle = await open(
    root,
    filesystemConstants.O_RDONLY
      | filesystemConstants.O_DIRECTORY
      | filesystemConstants.O_NOFOLLOW,
  );
  const rootIdentity = await rootHandle.stat();
  const guard = join(dirname(root), guardEntryName());
  const heldRoot = join(guard, basename(root));
  let held = false;
  try {
    await beforeMutation?.();
    const visibleRoot = await lstat(root);
    if (
      visibleRoot.isSymbolicLink()
      || !sameFilesystemIdentity(rootIdentity, visibleRoot)
    ) {
      throw new Error("managed root identity changed before mutation");
    }

    await mkdir(guard, { mode: defaultDirectoryMode });
    await rename(root, heldRoot);
    held = true;
    const isolatedRoot = await lstat(heldRoot);
    if (
      isolatedRoot.isSymbolicLink()
      || !sameFilesystemIdentity(rootIdentity, isolatedRoot)
    ) {
      throw new Error("managed root identity changed while isolating mutation");
    }

    const parts = relative(root, path).split(sep);
    let parent = heldRoot;
    for (const part of parts.slice(0, -1)) {
      const candidate = join(parent, part);
      try {
        const ancestor = await lstat(candidate);
        if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) {
          throw new Error(`managed ancestor is not a directory: ${candidate}`);
        }
      } catch (cause) {
        if (errorCode(cause) !== "ENOENT" || input.mutation.kind === "remove") {
          if (errorCode(cause) === "ENOENT" && input.mutation.kind === "remove") {
            return;
          }
          throw cause;
        }
        await mkdir(candidate, { mode: defaultDirectoryMode });
      }
      parent = candidate;
    }

    const name = parts.at(-1)!;
    const target = join(parent, name);
    if (input.mutation.kind === "remove") {
      await removeManagedLeaf(target);
      return;
    }

    if (input.mutation.kind === "directory") {
      await prepareManagedLeafKind(target, "directory");
      const mode = input.mutation.permissions === undefined ? input.mutation.mode : input.mutation.permissions.mode;
      await mkdir(target, { recursive: true, mode });
      await chmod(target, mode);
      return;
    }

    const temporary = join(parent, temporaryEntryName());
    try {
      if (input.mutation.kind === "symlink") {
        await symlink(symlinkTarget!, temporary);
      } else {
        const mode = input.mutation.permissions?.mode ?? input.mutation.mode ?? defaultFileMode;
        const temporaryHandle = await open(temporary, "wx", mode);
        try {
          await writeFileContent(temporaryHandle, relocateFileContent(input.mutation.content, root, heldRoot));
          await syncHandle(temporaryHandle);
          await temporaryHandle.chmod(mode);
        } finally {
          await temporaryHandle.close();
        }
      }
      await prepareManagedLeafKind(target, "non-directory");
      await rename(temporary, target);
      const parentHandle = await open(
        parent,
        filesystemConstants.O_RDONLY
          | filesystemConstants.O_DIRECTORY
          | filesystemConstants.O_NOFOLLOW,
      );
      try {
        await syncHandle(parentHandle);
      } finally {
        await parentHandle.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  } finally {
    await rootHandle.close().catch(() => undefined);
    if (held) {
      await rename(heldRoot, root);
      held = false;
    }
    if (!held) {
      await rm(guard, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};

const safeRootMutation = (
  input: SafeRootMutationInput,
  beforeMutation?: (() => Promise<void>) | undefined,
  strategy: "descriptor" | "portable" = process.platform === "darwin"
    ? "portable"
    : "descriptor",
): Effect.Effect<void, MachineStateError> =>
  Effect.gen(function*() {
    const root = yield* checkLinuxPath(input.root);
    const path = yield* checkLinuxPath(input.path);
    if (!isWithin(root, path) || path === root) {
      return yield* new MachineFilesystemError({
        operation: "mutate managed path",
        path,
        message: `path is not a descendant of managed root ${root}`,
      });
    }
    const symlinkTarget = input.mutation.kind === "symlink"
      ? input.mutation.target
      : undefined;
    if (symlinkTarget !== undefined && (symlinkTarget.length === 0 || symlinkTarget.includes("\0"))) {
      return yield* new InvalidMachinePathError({
        path: symlinkTarget,
        message: "symlink target must not be empty or contain NUL bytes",
      });
    }
    const remainder = relative(root, path);
    const parts = remainder.split(sep);
    yield* promiseEffect("mutate managed path", path, async () => {
      if (strategy === "portable") {
        await portableSafeRootMutation(
          root,
          path,
          input,
          symlinkTarget,
          beforeMutation,
        );
        return;
      }
      const handles: Array<FileHandle> = [];
      try {
        const rootHandle = await open(
          root,
          filesystemConstants.O_RDONLY
            | filesystemConstants.O_DIRECTORY
            | filesystemConstants.O_NOFOLLOW,
        );
        handles.push(rootHandle);
        const rootIdentity = await rootHandle.stat();
        await beforeMutation?.();
        const visibleRoot = await lstat(root);
        if (
          visibleRoot.isSymbolicLink()
          || !sameFilesystemIdentity(rootIdentity, visibleRoot)
        ) {
          throw new Error("managed root identity changed before mutation");
        }

        let parent = rootHandle;
        for (const part of parts.slice(0, -1)) {
          const candidate = join(descriptorPath(parent), part);
          let child: FileHandle;
          try {
            child = await open(
              candidate,
              filesystemConstants.O_RDONLY
                | filesystemConstants.O_DIRECTORY
                | filesystemConstants.O_NOFOLLOW,
            );
          } catch (cause) {
            if (errorCode(cause) !== "ENOENT" || input.mutation.kind === "remove") {
              if (errorCode(cause) === "ENOENT" && input.mutation.kind === "remove") {
                return;
              }
              throw cause;
            }
            await mkdir(candidate, { mode: defaultDirectoryMode });
            child = await open(
              candidate,
              filesystemConstants.O_RDONLY
                | filesystemConstants.O_DIRECTORY
                | filesystemConstants.O_NOFOLLOW,
            );
          }
          handles.push(child);
          parent = child;
        }

        const name = parts.at(-1)!;
        const target = join(descriptorPath(parent), name);
        if (input.mutation.kind === "remove") {
          await removeManagedLeaf(target);
          await syncHandle(parent);
          return;
        }

        if (input.mutation.kind === "directory") {
          await prepareManagedLeafKind(target, "directory");
          const mode = input.mutation.permissions === undefined ? input.mutation.mode : input.mutation.permissions.mode;
          await mkdir(target, { recursive: true, mode });
          await chmod(target, mode);
          await syncHandle(parent);
          return;
        }

        const temporary = join(descriptorPath(parent), temporaryEntryName());
        try {
          if (input.mutation.kind === "symlink") {
            await symlink(symlinkTarget!, temporary);
          } else {
            const mode = input.mutation.permissions?.mode ?? input.mutation.mode ?? defaultFileMode;
            const temporaryHandle = await open(temporary, "wx", mode);
            try {
              await writeFileContent(temporaryHandle, input.mutation.content);
              await syncHandle(temporaryHandle);
              await temporaryHandle.chmod(mode);
            } finally {
              await temporaryHandle.close();
            }
          }
          await prepareManagedLeafKind(target, "non-directory");
          await rename(temporary, target);
          await syncHandle(parent);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      } finally {
        for (const handle of handles.reverse()) {
          await handle.close().catch(() => undefined);
        }
      }
    });
  }).pipe(Effect.uninterruptible);

const normalizedInputPath = (
  input: NormalizePathInput,
  home: string,
): Effect.Effect<MachinePath, InvalidMachinePathError> => {
  if (input.path.length === 0 || input.path.includes("\0")) {
    return Effect.fail(new InvalidMachinePathError({
      path: input.path,
      message: "path must not be empty or contain NUL bytes",
    }));
  }
  const expanded = input.path === "~"
    ? home
    : input.path.startsWith("~/")
    ? join(home, input.path.slice(2))
    : input.path;
  if (isAbsolute(expanded)) return Effect.succeed(linuxPath(resolve(expanded)));
  if (input.base !== undefined && input.base.platform !== "linux") {
    return Effect.fail(new InvalidMachinePathError({
      path: input.path,
      message: `relative Linux paths cannot use a ${input.base.platform} base`,
    }));
  }
  return Effect.succeed(linuxPath(resolve(input.base?.absolute ?? process.cwd(), expanded)));
};

const readBounded = (
  input: ReadFileInput,
): Effect.Effect<Uint8Array, MachineFilesystemError | FileSizeLimitError | InvalidMachinePathError> =>
  Effect.gen(function*() {
    const path = yield* checkLinuxPath(input.path);
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 0) {
      return yield* new FileSizeLimitError({
        path,
        maximumBytes: input.maximumBytes,
      });
    }
    return yield* Effect.tryPromise({
      try: () => regularFileBytes(path, input.maximumBytes),
      catch: (cause) =>
        cause instanceof FileSizeLimitError
          ? cause
          : filesystemError("read file", path)(cause),
    });
  });

const digest = (
  input: DigestFileInput,
): Effect.Effect<FileDigest, MachineStateError> =>
  Effect.gen(function*() {
    const path = yield* checkLinuxPath(input.path);
    const maximumBytes = input.maximumBytes ?? Number.MAX_SAFE_INTEGER;
    const value = yield* Effect.tryPromise({
      try: () => regularFileDigest(path, maximumBytes),
      catch: (cause) =>
        cause instanceof FileSizeLimitError
          ? cause
          : filesystemError("digest file", path)(cause),
    });
    return {
      algorithm: "sha256",
      value: decode(ContentDigest)(value),
    };
  });

const runBoundedProcess = (
  invocation: ProcessInvocation,
  baseEnvironment: ReadonlyArray<ProcessEnvironmentEntry>,
): Effect.Effect<ProcessResult, MachineStateError> =>
  Effect.gen(function*() {
    const executable = yield* checkLinuxPath(invocation.executable);
    const workingDirectory = invocation.workingDirectory === undefined
      ? undefined
      : yield* checkLinuxPath(invocation.workingDirectory);
    if (
      !Number.isSafeInteger(invocation.timeoutMilliseconds)
      || invocation.timeoutMilliseconds <= 0
    ) {
      return yield* new ProcessTimeoutError({
        executable,
        timeoutMilliseconds: invocation.timeoutMilliseconds,
      });
    }
    if (
      !Number.isSafeInteger(invocation.maximumOutputBytes)
      || invocation.maximumOutputBytes < 0
    ) {
      return yield* new ProcessOutputLimitError({
        executable,
        maximumOutputBytes: invocation.maximumOutputBytes,
      });
    }
    if (
      invocation.standardInput !== undefined
      && invocation.standardInput.byteLength > maximumProcessInputBytes
    ) {
      return yield* new ProcessStartError({
        executable,
        message: `standard input exceeds ${maximumProcessInputBytes} bytes`,
      });
    }
    return yield* Effect.tryPromise({
      try: (signal) => new Promise<ProcessResult>((resolveProcess, rejectProcess) => {
        const output: Array<Buffer> = [];
        const errors: Array<Buffer> = [];
        let outputBytes = 0;
        let failure: Error | undefined;
        const child = spawn(executable, [...invocation.arguments], {
          cwd: workingDirectory,
          env: environmentObject(
            baseEnvironment,
            invocation.environment ?? [],
            invocation.environmentUnset ?? [],
            invocation.environmentUnsetPrefixes ?? [],
          ),
          shell: false,
          stdio: [
            invocation.standardInput === undefined ? "ignore" : "pipe",
            "pipe",
            "pipe",
          ],
          detached: process.platform !== "win32",
        });
        const terminate = (reason: Error): void => {
          if (failure !== undefined) return;
          failure = reason;
          terminateProcessTree(child);
        };
        const capture = (target: Array<Buffer>) => (chunk: Buffer): void => {
          outputBytes += chunk.byteLength;
          if (outputBytes > invocation.maximumOutputBytes) {
            terminate(new ProcessOutputLimitSignal());
            return;
          }
          target.push(chunk);
        };
        if (child.stdout === null || child.stderr === null) {
          terminate(new ProcessStartSignal("process output streams are unavailable"));
        } else {
          child.stdout.on("data", capture(output));
          child.stderr.on("data", capture(errors));
        }
        child.once("error", (cause) => {
          failure = new ProcessStartSignal(messageOf(cause));
        });
        if (invocation.standardInput !== undefined && child.stdin !== null) {
          child.stdin.once("error", (cause) => {
            terminate(new ProcessStartSignal(messageOf(cause)));
          });
          child.stdin.end(invocation.standardInput);
        }
        const timer = setTimeout(
          () => terminate(new ProcessTimeoutSignal()),
          invocation.timeoutMilliseconds,
        );
        const abort = (): void => {
          terminateProcessTree(child);
        };
        signal.addEventListener("abort", abort, { once: true });
        child.once("close", (exitCode, childSignal) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (failure !== undefined) {
            rejectProcess(failure);
            return;
          }
          resolveProcess({
            exitCode,
            signal: childSignal,
            standardOutput: Buffer.concat(output),
            standardError: Buffer.concat(errors),
          });
        });
      }),
      catch: (cause) => {
        if (cause instanceof ProcessTimeoutSignal) {
          return new ProcessTimeoutError({
            executable,
            timeoutMilliseconds: invocation.timeoutMilliseconds,
          });
        }
        if (cause instanceof ProcessOutputLimitSignal) {
          return new ProcessOutputLimitError({
            executable,
            maximumOutputBytes: invocation.maximumOutputBytes,
          });
        }
        return new ProcessStartError({
          executable,
          message: messageOf(cause),
        });
      },
    });
  });

const schedulerExpression = (
  calendar: SchedulerCalendar,
): Effect.Effect<string, InvalidSchedulerJobError> => {
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/u;
  const timezoneSuffix = (): Effect.Effect<string, InvalidSchedulerJobError> => {
    if (calendar.timezone === undefined) return Effect.succeed("");
    if (
      calendar.timezone.trim() !== calendar.timezone
      || calendar.timezone.length === 0
      || /[\n\r\0]/u.test(calendar.timezone)
    ) {
      return Effect.fail(new InvalidSchedulerJobError({
        field: "calendar.timezone",
        message: "systemd calendar timezone must be a non-empty single-line name",
      }));
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: calendar.timezone }).format();
    } catch {
      return Effect.fail(new InvalidSchedulerJobError({
        field: "calendar.timezone",
        message: `unsupported systemd calendar timezone: ${calendar.timezone}`,
      }));
    }
    if (
      calendar.kind === "systemd-on-calendar"
      && (
        calendar.expression.startsWith("@")
        || /(?:^|\s)(?:UTC|GMT|[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+)\s*$/u.test(
          calendar.expression,
        )
      )
    ) {
      return Effect.fail(new InvalidSchedulerJobError({
        field: "calendar.timezone",
        message: "custom systemd expressions with shortcuts or an existing timezone cannot add a named timezone",
      }));
    }
    return Effect.succeed(` ${calendar.timezone}`);
  };
  if (calendar.kind === "systemd-on-calendar") {
    if (
      calendar.expression.trim().length === 0
      || /[\n\r\0]/u.test(calendar.expression)
    ) {
      return Effect.fail(new InvalidSchedulerJobError({
        field: "calendar.expression",
        message: "systemd calendar expression must be non-empty and single-line",
      }));
    }
    return timezoneSuffix().pipe(
      Effect.map((timezone) => `${calendar.expression}${timezone}`),
    );
  }
  if (!validTime.test(calendar.localTime)) {
    return Effect.fail(new InvalidSchedulerJobError({
      field: "calendar.localTime",
      message: "local time must use 24-hour HH:mm format",
    }));
  }
  const prefix = calendar.kind === "daily"
    ? "*-*-*"
    : `${calendar.weekdays.join(",")} *-*-*`;
  return timezoneSuffix().pipe(
    Effect.map((timezone) => `${prefix} ${calendar.localTime}:00${timezone}`),
  );
};

const systemdQuote = (
  value: string,
  field: string,
  role: "executable" | "argument",
): Effect.Effect<string, InvalidSchedulerJobError> => {
  if (/[\n\r\0]/u.test(value)) {
    return Effect.fail(new InvalidSchedulerJobError({
      field,
      message: "systemd command values must be single-line and contain no NUL bytes",
    }));
  }
  // systemd applies three passes to ExecStart=, so three escapes are needed:
  // "%" specifiers (%h, %i, ...) expand on the raw line before word splitting,
  // then the shell-like unquoting removes "\\" and "\"" escapes, and at start
  // time "$VAR" / "${VAR}" expand inside argument words, quoted or not. A
  // literal "%" survives only as "%%" and a literal "$" only as "$$"
  // (systemd.unit(5) "Specifiers", systemd.service(5) "Command lines"). The
  // first word is exempt from the last pass: systemd never expands variables
  // in the program path, so "$$" there names a file that does not exist.
  // Home-directory runtime paths from nvm or an npm prefix land here, so both
  // characters are real.
  const quoted = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("%", "%%");
  return Effect.succeed(
    `"${role === "argument" ? quoted.replaceAll("$", () => "$$") : quoted}"`,
  );
};

const renderSystemdJob = (
  job: SchedulerJob,
): Effect.Effect<RenderedSchedulerJob, MachineStateError> =>
  Effect.gen(function*() {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/u.test(job.name)) {
      return yield* new InvalidSchedulerJobError({
        field: "name",
        message: "job name must be a portable systemd unit stem",
      });
    }
    if (job.description.trim().length === 0 || /[\n\r\0]/u.test(job.description)) {
      return yield* new InvalidSchedulerJobError({
        field: "description",
        message: "description must be non-empty and single-line",
      });
    }
    const executable = yield* checkLinuxPath(job.executable);
    const command = [
      yield* systemdQuote(executable, "executable", "executable"),
      ...yield* Effect.forEach(
        job.arguments,
        (argument, index) => systemdQuote(argument, `arguments[${index}]`, "argument"),
      ),
    ].join(" ");
    const calendar = yield* schedulerExpression(job.calendar);
    const executableDirectory = dirname(executable);
    const servicePath = [...new Set([executableDirectory, "/usr/local/bin", "/usr/bin", "/bin"])]
      .join(":");
    const serviceName = `${job.name}.service`;
    return {
      platform: "linux",
      mechanism: "systemd-user-timer",
      serviceName,
      service: [
        "[Unit]",
        `Description=${job.description}`,
        "",
        "[Service]",
        "Type=oneshot",
        // Keep systemd's default control-group cleanup. Long-lived managed
        // routes recovered by this job belong to separate user services.
        // ExecStart remains absolute. The scheduled process gets only the
        // installing runtime's bin directory plus standard system locations,
        // so npm-managed tools installed beside that runtime remain verifiable
        // without inheriting shell startup state.
        `Environment="PATH=${servicePath}"`,
        `ExecStart=${command}`,
        "",
      ].join("\n"),
      schedule: [
        "[Unit]",
        `Description=${job.description} schedule`,
        "",
        "[Timer]",
        `OnCalendar=${calendar}`,
        "Persistent=true",
        `Unit=${serviceName}`,
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
      ].join("\n"),
    };
  });

const systemdBackend = (
  home: string,
  environment: ReadonlyArray<ProcessEnvironmentEntry>,
): SchedulerBackend => {
  const unitDirectory = join(home, ".config", "systemd", "user");
  const systemctl = environmentValue(environment, "CANONFIG_SYSTEMCTL")
    ?? "/usr/bin/systemctl";
  const loginctl = environmentValue(environment, "CANONFIG_LOGINCTL")
    ?? "/usr/bin/loginctl";
  // Persistent=true timers remember their last trigger in this stamp file.
  const timerStampDirectory = join(
    environmentValue(environment, "XDG_DATA_HOME") ?? join(home, ".local", "share"),
    "systemd",
    "timers",
  );
  const paths = (definition: RenderedSchedulerJob) => {
    const timerName = definition.serviceName.endsWith(".service")
      ? `${definition.serviceName.slice(0, -".service".length)}.timer`
      : `${definition.serviceName}.timer`;
    return {
      service: join(unitDirectory, definition.serviceName),
      timer: join(unitDirectory, timerName),
      timerName,
    };
  };
  const runSystemctl = (
    arguments_: ReadonlyArray<string>,
  ): Effect.Effect<ProcessResult, MachineStateError> =>
    runBoundedProcess({
      executable: linuxPath(systemctl),
      arguments: ["--user", ...arguments_],
      timeoutMilliseconds: 10_000,
      maximumOutputBytes: 1024 * 1024,
    }, environment);
  const requireSuccess = (
    arguments_: ReadonlyArray<string>,
    action: string,
  ): Effect.Effect<void, MachineStateError> =>
    runSystemctl(arguments_).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(new HumanActionRequiredError({
            action,
            recovery:
              "Ensure the systemd user manager is running for this follower, then retry.",
          }))
      ),
    );
  /**
   * The effective state of the timer and its service as the user manager
   * sees them: `ActiveState`, the unit file state, drop-ins, and the calendar
   * it actually uses. The unit files alone cannot show a timer that was
   * stopped, or whose calendar a drop-in replaced.
   */
  const showUnits = (
    timerName: string,
    serviceName: string,
    action: string,
  ): Effect.Effect<
    { readonly timer: Record<string, string>; readonly service: Record<string, string> },
    MachineStateError
  > =>
    runSystemctl([
      "show",
      timerName,
      serviceName,
      "--property=Id,LoadState,ActiveState,UnitFileState,DropInPaths,TimersCalendar,NextElapseUSecRealtime,Result,ExecMainStatus,ExecMainExitTimestamp",
    ]).pipe(
      Effect.flatMap((result) => {
        const units = new Map(
          Buffer.from(result.standardOutput).toString("utf8").split(/\n\s*\n/u).map((block) => {
            const properties: Record<string, string> = {};
            for (const line of block.split("\n")) {
              const separator = line.indexOf("=");
              if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1).trim();
            }
            return [properties.Id ?? "", properties] as const;
          }),
        );
        const timer = units.get(timerName);
        const service = units.get(serviceName);
        // Accept only a complete answer, never an arbitrary query failure.
        if (
          result.exitCode !== 0 || timer?.LoadState === undefined
          || timer.ActiveState === undefined || service === undefined
        ) {
          return Effect.fail(new HumanActionRequiredError({
            action,
            recovery:
              "The systemd user manager returned an indeterminate scheduler state; ensure it is running (`systemctl --user status`) and retry.",
          }));
        }
        return Effect.succeed({ timer, service });
      }),
    );
  const timerEnabled = (timer: Record<string, string>): boolean =>
    timer.LoadState === "loaded"
    && (timer.UnitFileState === "enabled" || timer.UnitFileState === "enabled-runtime");
  /** Undefined when logind cannot answer; linger is advisory, not a scheduler failure. */
  const lingering = (): Effect.Effect<boolean | undefined> =>
    runBoundedProcess({
      executable: linuxPath(loginctl),
      arguments: ["show-user", String(process.getuid?.() ?? ""), "--property=Linger"],
      timeoutMilliseconds: 5_000,
      maximumOutputBytes: 64 * 1024,
    }, environment).pipe(
      Effect.map((result) => {
        const value = /^Linger=(yes|no)$/mu.exec(Buffer.from(result.standardOutput).toString("utf8"))?.[1];
        return result.exitCode !== 0 || value === undefined ? undefined : value === "yes";
      }),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  const readUnit = (
    path: string,
  ): Effect.Effect<
    { readonly content: string; readonly mode: number } | undefined,
    MachineStateError
  > =>
    Effect.tryPromise({
      try: async () => {
        try {
          const [content, metadata] = await Promise.all([
            readFile(path, "utf8"),
            lstat(path),
          ]);
          return { content, mode: metadata.mode & 0o777 };
        } catch (cause) {
          if (errorCode(cause) === "ENOENT") return undefined;
          throw cause;
        }
      },
      catch: filesystemError("snapshot systemd user schedule", path),
    });
  return {
    inspect: (expected) =>
      Effect.gen(function*() {
        const path = paths(expected);
        const service = yield* readUnit(path.service);
        const timer = yield* readUnit(path.timer);
        if (service === undefined || timer === undefined) {
          return { installed: false, enabled: false, matches: false };
        }
        const units = yield* showUnits(
          path.timerName,
          expected.serviceName,
          "inspect the systemd user timer",
        );
        const overrides = (units.timer.DropInPaths ?? "").split(/\s+/u).filter((entry) => entry.length > 0);
        const calendars = [...(units.timer.TimersCalendar ?? "").matchAll(/OnCalendar=(.+?) ;/gu)]
          .map((match) => match[1]!);
        const exitedAt = units.service.ExecMainExitTimestamp;
        const ran = exitedAt !== undefined && exitedAt !== "" && exitedAt !== "n/a";
        return {
          installed: true,
          enabled: timerEnabled(units.timer),
          matches: service.content === expected.service && timer.content === expected.schedule,
          calendarMatches: timer.content === expected.schedule,
          active: units.timer.ActiveState === "active",
          overrides,
          effectiveCalendar: calendars.length === 0 ? undefined : calendars.join("; "),
          nextElapse: units.timer.NextElapseUSecRealtime || undefined,
          lastResult: ran
            ? {
              succeeded: units.service.Result === "success" && units.service.ExecMainStatus === "0",
              detail: `systemd service result ${units.service.Result ?? "unknown"}, exit status ${units.service.ExecMainStatus ?? "unknown"}`,
              at: exitedAt,
            }
            : undefined,
          lingering: yield* lingering(),
        };
      }),
    snapshot: (expected) =>
      Effect.gen(function*() {
        const path = paths(expected);
        const service = yield* readUnit(path.service);
        const timer = yield* readUnit(path.timer);
        if (service === undefined && timer === undefined) {
          return {
            state: "absent",
            platform: expected.platform,
            mechanism: expected.mechanism,
            serviceName: expected.serviceName,
          } satisfies SchedulerSnapshot;
        }
        const units = timer === undefined
          ? undefined
          : yield* showUnits(
            path.timerName,
            expected.serviceName,
            "capture the systemd user timer",
          );
        const enabled = units === undefined ? false : timerEnabled(units.timer);
        const active = units?.timer.ActiveState === "active";
        return {
          state: "present",
          platform: expected.platform,
          mechanism: expected.mechanism,
          serviceName: expected.serviceName,
          enabled,
          active,
          servicePresent: service !== undefined,
          schedulePresent: timer !== undefined,
          service: service?.content,
          schedule: timer?.content,
          serviceMode: service?.mode,
          scheduleMode: timer?.mode,
        } satisfies SchedulerSnapshot;
      }),
    install: (definition) =>
      Effect.gen(function*() {
        const path = paths(definition);
        yield* atomicWriteFile(path.service, new TextEncoder().encode(definition.service), 0o600);
        yield* atomicWriteFile(path.timer, new TextEncoder().encode(definition.schedule), 0o600);
        // Persistent=true catches up an elapse missed since the last trigger
        // when the timer starts. A calendar set to a time already passed today
        // would therefore run at once. Restart the timer with its stamp at
        // now, so only elapses after this install count; a later downtime is
        // still caught up.
        yield* runSystemctl(["stop", path.timerName]).pipe(Effect.ignore);
        const stamp = join(timerStampDirectory, `stamp-${path.timerName}`);
        yield* promiseEffect("reset the systemd timer stamp", stamp, async () => {
          await mkdir(timerStampDirectory, { recursive: true });
          await writeFile(stamp, "", { flag: "a" });
          const now = new Date(Date.now() - 1_000);
          await utimes(stamp, now, now);
        });
        yield* requireSuccess(["daemon-reload"], "reload the systemd user manager");
        yield* requireSuccess(
          ["enable", "--now", path.timerName],
          "enable the Canonfig systemd user timer",
        );
      }),
    remove: (definition) =>
      Effect.gen(function*() {
        const path = paths(definition);
        yield* runSystemctl(["disable", "--now", path.timerName]).pipe(Effect.ignore);
        yield* promiseEffect("remove systemd service", path.service, () =>
          rm(path.service, { force: true }));
        yield* promiseEffect("remove systemd timer", path.timer, () =>
          rm(path.timer, { force: true }));
        yield* requireSuccess(["daemon-reload"], "reload the systemd user manager");
      }),
    restore: (expected, snapshot) =>
      Effect.gen(function*() {
        const path = paths(expected);
        yield* runSystemctl(["disable", "--now", path.timerName]).pipe(Effect.ignore);
        if (snapshot.state === "absent") {
          yield* promiseEffect("remove systemd service", path.service, () =>
            rm(path.service, { force: true }));
          yield* promiseEffect("remove systemd timer", path.timer, () =>
            rm(path.timer, { force: true }));
          yield* requireSuccess(["daemon-reload"], "reload the systemd user manager");
          return;
        }
        if (snapshot.servicePresent) {
          if (snapshot.service === undefined) {
            return yield* new HumanActionRequiredError({
              action: "restore the Canonfig systemd service",
              recovery: "The captured systemd service contents were incomplete; inspect the user unit manually.",
            });
          }
          yield* atomicWriteFile(
            path.service,
            new TextEncoder().encode(snapshot.service),
            snapshot.serviceMode ?? defaultFileMode,
          );
        } else {
          yield* promiseEffect("remove systemd service", path.service, () =>
            rm(path.service, { force: true }));
        }
        if (snapshot.schedulePresent) {
          if (snapshot.schedule === undefined) {
            return yield* new HumanActionRequiredError({
              action: "restore the Canonfig systemd timer",
              recovery: "The captured systemd timer contents were incomplete; inspect the user unit manually.",
            });
          }
          yield* atomicWriteFile(
            path.timer,
            new TextEncoder().encode(snapshot.schedule),
            snapshot.scheduleMode ?? defaultFileMode,
          );
        } else {
          yield* promiseEffect("remove systemd timer", path.timer, () =>
            rm(path.timer, { force: true }));
        }
        yield* requireSuccess(["daemon-reload"], "reload the systemd user manager");
        if (!snapshot.schedulePresent) return;
        yield* requireSuccess(
          [snapshot.enabled ? "enable" : "disable", path.timerName],
          snapshot.enabled
            ? "enable the restored Canonfig systemd user timer"
            : "disable the restored Canonfig systemd user timer",
        );
        const active = snapshot.active ?? snapshot.enabled;
        yield* requireSuccess(
          [active ? "start" : "stop", path.timerName],
          active
            ? "start the restored Canonfig systemd user timer"
            : "stop the restored Canonfig systemd user timer",
        );
      }),
  };
};

const localCredentialPath = (
  reference: CredentialReferenceType,
  root: string,
): Effect.Effect<string, CredentialStorageError> => {
  const prefix = "local-file:";
  const value = String(reference);
  if (!value.startsWith(prefix)) {
    return Effect.fail(new CredentialStorageError({
      operation: "resolve credential reference",
      reference: value,
      message: "credential reference is not owned by the local-file provider",
    }));
  }
  const path = resolve(value.slice(prefix.length));
  if (dirname(path) !== root) {
    return Effect.fail(new CredentialStorageError({
      operation: "resolve credential reference",
      reference: value,
      message: "credential reference is outside the configured credential directory",
    }));
  }
  return Effect.succeed(path);
};

const discoverSecretTool = (
  environment: ReadonlyArray<ProcessEnvironmentEntry>,
): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    const directories = (environmentValue(environment, "PATH") ?? "")
      .split(":")
      .filter((entry) => entry.length > 0);
    for (const directory of directories) {
      const candidate = join(directory, "secret-tool");
      try {
        await access(candidate, filesystemConstants.X_OK);
        return candidate;
      } catch {
        // Continue through the declared executable search path.
      }
    }
    return undefined;
  });

/**
 * One Canonfig credential in the Secret Service. `secret-tool store` reads at
 * most 8192 bytes from a pipe, prints "password is too long" and still exits
 * 0 after storing the truncated prefix, so a credential is kept as one or
 * more items of at most `secretServicePartBytes` each. Part 0 carries
 * `canonfig-key=<key>` (the only form earlier releases wrote); part N carries
 * `canonfig-key=<key>.N`. The reference records the part count:
 * `secret-service:<key>` for one part, `secret-service:<key>:<parts>` for more.
 */
interface SecretServiceItem {
  readonly key: string;
  readonly parts: number;
}

const secretServicePartBytes = 8000;

const secretServicePartKey = (key: string, part: number): string =>
  part === 0 ? key : `${key}.${part}`;

const secretServiceItem = (
  reference: CredentialReferenceType,
): Effect.Effect<SecretServiceItem, CredentialStorageError> => {
  const prefix = "secret-service:";
  const value = String(reference);
  const body = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  const multipart = /^([^:]+):([2-9]|[1-9][0-9]+)$/u.exec(body);
  if (body.length === 0 || (multipart === null && body.includes(":"))) {
    return Effect.fail(new CredentialStorageError({
      operation: "resolve credential reference",
      reference: value,
      message: "credential reference is not owned by the Secret Service provider",
    }));
  }
  return Effect.succeed(multipart === null
    ? { key: body, parts: 1 }
    : { key: multipart[1]!, parts: Number(multipart[2]) });
};

/**
 * Split credential bytes into Secret Service parts without breaking a UTF-8
 * sequence: `secret-tool lookup` refuses to print a part that is not valid
 * text when the provider drops the stored content type.
 */
const secretServiceParts = (bytes: Uint8Array): ReadonlyArray<Uint8Array> => {
  if (bytes.byteLength <= secretServicePartBytes) return [bytes];
  const parts: Array<Uint8Array> = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(start + secretServicePartBytes, bytes.byteLength);
    while (end < bytes.byteLength && end > start + 1 && (bytes[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
    parts.push(bytes.subarray(start, end));
    start = end;
  }
  return parts;
};

/** The user D-Bus session bus that secret-tool talks to. */
export type LinuxSessionBus =
  | { readonly kind: "environment"; readonly address: string }
  | { readonly kind: "runtime-directory"; readonly address: string }
  | { readonly kind: "missing"; readonly runtimeDirectory: string | undefined };

const dbusAddressValue = (path: string): string =>
  [...Buffer.from(path, "utf8")]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return /[-0-9A-Za-z_/.\\*]/u.test(character)
        ? character
        : `%${byte.toString(16).padStart(2, "0")}`;
    })
    .join("");

/**
 * DBUS_SESSION_BUS_ADDRESS when set; otherwise the systemd user bus socket at
 * $XDG_RUNTIME_DIR/bus, which is what libsecret itself falls back to. A
 * background run (a timer, cron with XDG_RUNTIME_DIR, `ssh host cmd`) often
 * lacks the variable while the user bus is present.
 */
export const resolveLinuxSessionBus = (
  environment: ReadonlyArray<ProcessEnvironmentEntry> = processEnvironmentEntries(),
): LinuxSessionBus => {
  const address = environmentValue(environment, "DBUS_SESSION_BUS_ADDRESS");
  if (address !== undefined && address.trim().length > 0) {
    return { kind: "environment", address };
  }
  const runtimeDirectory = environmentValue(environment, "XDG_RUNTIME_DIR");
  if (runtimeDirectory !== undefined && isAbsolute(runtimeDirectory)) {
    const socket = join(runtimeDirectory, "bus");
    try {
      if (statSync(socket).isSocket()) {
        return { kind: "runtime-directory", address: `unix:path=${dbusAddressValue(socket)}` };
      }
    } catch {
      // No user bus socket in this runtime directory.
    }
  }
  return { kind: "missing", runtimeDirectory };
};

const currentUserName = (): string => {
  try {
    return userInfo().username;
  } catch {
    return "$USER";
  }
};

/**
 * What to run when no user session bus is reachable. dbus-run-session is not
 * a remedy: its private bus activates a second, empty keyring that asks a
 * graphical prompter for a new password and never reaches the login keyring.
 */
export const linuxSessionBusRecovery = (
  bus: Extract<LinuxSessionBus, { readonly kind: "missing" }>,
): string => {
  const uid = process.getuid?.() ?? 0;
  const expected = `/run/user/${uid}/bus`;
  const cause = bus.runtimeDirectory === undefined
    ? "DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR are both unset, so no user D-Bus session bus is reachable"
    : `DBUS_SESSION_BUS_ADDRESS is unset and ${join(bus.runtimeDirectory, "bus")} is not a D-Bus socket`;
  return [
    `${cause}.`,
    `Point canonfig at your user session bus with \`export XDG_RUNTIME_DIR=/run/user/${uid}\` (canonfig then uses ${expected}), then retry.`,
    `If ${expected} does not exist, the systemd user manager is not running: keep it running without a login session with \`sudo loginctl enable-linger ${currentUserName()}\`, and make sure the login keyring is unlocked (it unlocks when you log in with your password).`,
    "Do not use dbus-run-session: its private bus cannot reach the login keyring.",
    "Alternatively, explicitly select the local-file credential policy.",
  ].join(" ");
};

export const linuxMachineStateLayer = (
  options: LinuxMachineStateOptions = {},
): Layer.Layer<MachineState> =>
  Layer.sync(
    MachineState,
    () => {
      const environment = options.environment ?? processEnvironmentEntries();
      const home = environmentValue(environment, "HOME") ?? homedir();
      const credentialPolicy = options.credentialPolicy ?? { kind: "secure-store" };
      const scheduler = options.schedulerBackend ?? systemdBackend(home, environment);
      const localCredentialRoot = credentialPolicy.kind === "local-file"
        ? resolve(credentialPolicy.path)
        : undefined;
      const sessionBus: LinuxSessionBus = credentialPolicy.kind === "secure-store"
        ? resolveLinuxSessionBus(environment)
        : { kind: "missing", runtimeDirectory: undefined };
      // secret-tool gets the resolved bus explicitly, so the item it reaches
      // is the one the capability check examined.
      const busEnvironment: ReadonlyArray<ProcessEnvironmentEntry> =
        sessionBus.kind === "runtime-directory"
          ? [{ name: "DBUS_SESSION_BUS_ADDRESS", value: sessionBus.address }]
          : [];
      const busName = sessionBus.kind === "missing" ? "no session bus" : sessionBus.address;
      const secretToolMissing =
        `secret-tool is not on PATH (${environmentValue(environment, "PATH") ?? "PATH is unset"}). Install the Secret Service client (Debian and Ubuntu: libsecret-tools; Fedora and RHEL: libsecret; Arch: libsecret) and a provider such as gnome-keyring, or explicitly select the local-file credential policy.`;

      const normalizePath = Effect.fn("MachineState.normalizePath")(
        function*(input: NormalizePathInput): Effect.fn.Return<MachinePath, MachineStateError> {
          return yield* normalizedInputPath(input, home);
        },
      );

      const userDirectories = Effect.fn("MachineState.userDirectories")(
        (): Effect.Effect<UserDirectories, MachineStateError> =>
          Effect.succeed({
            home: linuxPath(home),
            config: linuxPath(environmentValue(environment, "XDG_CONFIG_HOME") ?? join(home, ".config")),
            data: linuxPath(environmentValue(environment, "XDG_DATA_HOME") ?? join(home, ".local", "share")),
            cache: linuxPath(environmentValue(environment, "XDG_CACHE_HOME") ?? join(home, ".cache")),
          }),
      );

      const ensureDirectory = Effect.fn("MachineState.ensureDirectory")(
        function*(input: EnsureDirectoryInput): Effect.fn.Return<void, MachineStateError> {
          const path = yield* checkLinuxPath(input.path);
          yield* promiseEffect(
            "ensure directory",
            path,
            () => mkdir(path, { recursive: true, mode: input.mode ?? defaultDirectoryMode }).then(() => undefined),
          );
        },
      );

      const atomicWrite = Effect.fn("MachineState.atomicWrite")(
        function*(input: AtomicWriteInput): Effect.fn.Return<void, MachineStateError> {
          const path = yield* checkLinuxPath(input.path);
          yield* atomicWriteFile(path, input.content, input.permissions?.mode ?? input.mode ?? defaultFileMode);
        },
      );

      const replaceSymlink = Effect.fn("MachineState.replaceSymlink")(
        function*(input: SymlinkInput): Effect.fn.Return<void, MachineStateError> {
          const path = yield* checkLinuxPath(input.path);
          if (input.target.length === 0 || input.target.includes("\0")) {
            return yield* new InvalidMachinePathError({
              path: input.target,
              message: "symlink target must not be empty or contain NUL bytes",
            });
          }
          yield* promiseEffect("replace symlink", path, async () => {
            await mkdir(dirname(path), { recursive: true, mode: defaultDirectoryMode });
            const temporary = makeTemporarySibling(path);
            try {
              await symlink(input.target, temporary);
              await prepareManagedLeafKind(path, "non-directory");
              await rename(temporary, path);
            } finally {
              await unlink(temporary).catch(() => undefined);
            }
          });
        },
      );

      const removeFile = Effect.fn("MachineState.removeFile")(
        function*(input: RemoveFileInput): Effect.fn.Return<void, MachineStateError> {
          const path = yield* checkLinuxPath(input.path);
          yield* promiseEffect("remove file", path, () => rm(path, { force: true }));
        },
      );

      const removeEmptyDirectory = Effect.fn("MachineState.removeEmptyDirectory")(
        function*(input: RemoveEmptyDirectoryInput): Effect.fn.Return<void, MachineStateError> {
          const path = yield* checkLinuxPath(input.path);
          yield* promiseEffect("remove empty directory", path, () => rmdir(path));
        },
      );

      const removeTemporaryEntries = Effect.fn("MachineState.removeTemporaryEntries")(
        function*(
          input: RemoveTemporaryEntriesInput,
        ): Effect.fn.Return<ReadonlyArray<string>, MachineStateError> {
          const directory = yield* checkLinuxPath(input.directory);
          return yield* promiseEffect(
            "remove temporary entries",
            directory,
            () => removeTemporaryEntriesAt(directory, input.recursive, posix),
          );
        },
      );

      const validatePathWithinRoot = Effect.fn("MachineState.validatePathWithinRoot")(
        function*(
          input: ValidatePathWithinRootInput,
        ): Effect.fn.Return<void, MachineStateError> {
          const root = yield* checkLinuxPath(input.root);
          const path = yield* checkLinuxPath(input.path);
          if (!isWithin(root, path) || path === root) {
            return yield* new MachineFilesystemError({
              operation: "validate managed path containment",
              path,
              message: `path is not a descendant of managed root ${root}`,
            });
          }
          yield* promiseEffect("validate managed path containment", path, async () => {
            const rootBefore = await lstat(root);
            const actualRoot = await realpath(root);
            const rootAfter = await lstat(root);
            if (!sameFilesystemIdentity(rootBefore, rootAfter)) {
              throw new Error("managed root identity changed during validation");
            }

            const ancestors: Array<string> = [];
            for (let ancestor = dirname(path);; ancestor = dirname(ancestor)) {
              ancestors.push(ancestor);
              if (ancestor === root) break;
              if (ancestor === dirname(ancestor)) {
                throw new Error(`managed path ancestry did not reach root ${root}`);
              }
            }
            ancestors.reverse();
            for (const ancestor of ancestors) {
              let before: Awaited<ReturnType<typeof lstat>>;
              try {
                before = await lstat(ancestor);
              } catch (cause) {
                if (errorCode(cause) === "ENOENT") break;
                throw cause;
              }
              const actualAncestor = await realpath(ancestor);
              const after = await lstat(ancestor);
              if (!sameFilesystemIdentity(before, after)) {
                throw new Error(`ancestor identity changed during validation: ${ancestor}`);
              }
              if (!isWithin(actualRoot, actualAncestor)) {
                throw new Error(
                  `ancestor resolves outside managed root ${root}: ${ancestor}`,
                );
              }
            }
          });
        },
      );

      const mutateWithinRoot = Effect.fn("MachineState.mutateWithinRoot")(
        function*(
          input: SafeRootMutationInput,
        ): Effect.fn.Return<void, MachineStateError> {
          yield* safeRootMutation(
            input,
            options.beforeSafeRootMutation,
            options.safeRootMutationStrategy,
          );
        },
      );

      const readSymlink = Effect.fn("MachineState.readSymlink")(
        function*(machinePath: MachinePath): Effect.fn.Return<string, MachineStateError> {
          const path = yield* checkLinuxPath(machinePath);
          return yield* promiseEffect("read symlink", path, () => readlink(path));
        },
      );

      const inspectPath = Effect.fn("MachineState.inspectPath")(
        function*(machinePath: MachinePath): Effect.fn.Return<MachineObject, MachineStateError> {
          const path = yield* checkLinuxPath(machinePath);
          const metadata = yield* promiseEffect("inspect path", path, () => lstat(path));
          return { kind: objectKind(metadata) };
        },
      );

      /**
       * Every entry beneath a managed directory, relative to it and deepest
       * last.
       *
       * A symlinked subdirectory is reported and never descended into, so a
       * link cannot walk the listing out of the managed root. An absent root
       * lists nothing rather than failing, because a caller asking what is
       * inside a directory that does not exist wants "nothing", not an error.
       */
      const listDirectory = Effect.fn("MachineState.listDirectory")(
        function*(
          machinePath: MachinePath,
        ): Effect.fn.Return<ReadonlyArray<MachineDirectoryEntry>, MachineStateError> {
          const root = yield* checkLinuxPath(machinePath);
          const entries: Array<MachineDirectoryEntry> = [];
          const walk = Effect.fn("MachineState.listDirectory.walk")(
            function*(
              absolute: string,
              relative: string,
            ): Effect.fn.Return<void, MachineStateError> {
              const found = yield* promiseEffect(
                "list directory",
                absolute,
                () => readdir(absolute, { withFileTypes: true }),
              ).pipe(
                Effect.catchTag("MachineFilesystemError", (error) =>
                  error.message.includes("ENOENT")
                    ? Effect.succeed([])
                    : Effect.fail(error)
                ),
              );
              const ordered = [...found].sort((left, right) =>
                left.name.localeCompare(right.name)
              );
              for (const entry of ordered) {
                const childRelative = relative === ""
                  ? entry.name
                  : `${relative}/${entry.name}`;
                const childAbsolute = join(absolute, entry.name);
                const metadata = yield* promiseEffect(
                  "inspect path",
                  childAbsolute,
                  () => lstat(childAbsolute),
                );
                const kind = objectKind(metadata);
                entries.push({ path: childRelative, kind });
                // Descending into a symlinked directory would leave the
                // managed root, so a link is reported and left alone.
                if (kind === "directory") {
                  yield* walk(childAbsolute, childRelative);
                }
              }
            },
          );
          yield* walk(root, "");
          return entries;
        },
      );

      const setPermissions = Effect.fn("MachineState.setPermissions")(
        function*(input: SetPermissionsInput): Effect.fn.Return<void, MachineStateError> {
          const path = yield* checkLinuxPath(input.path);
          const mode = input.permissions === undefined ? input.mode : input.permissions.mode;
          yield* promiseEffect("set permissions", path, () => chmod(path, mode));
        },
      );

      const permissions = Effect.fn("MachineState.permissions")(
        function*(machinePath: MachinePath): Effect.fn.Return<FilePermissions, MachineStateError> {
          const path = yield* checkLinuxPath(machinePath);
          const metadata = yield* promiseEffect("read permissions", path, () => lstat(path));
          const mode = metadata.mode & 0o7777;
          return { mode, executableByOwner: (mode & 0o100) !== 0 };
        },
      );

      const findExecutable = Effect.fn("MachineState.findExecutable")(
        function*(query: ExecutableQuery): Effect.fn.Return<DiscoveredExecutable, MachineStateError> {
          if (
            query.name.length === 0
            || query.name.includes("/")
            || query.name.includes("\0")
          ) {
            return yield* new ExecutableNotFoundError({ executable: query.name, searched: [] });
          }
          const search = [
            ...installDestinationDirectories({
              platform: "linux",
              home,
              environment: (name) => environmentValue(environment, name),
              methods: query.installMethods ?? [],
            }).map(linuxPath),
            ...(query.searchPath ?? (environmentValue(environment, "PATH") ?? "").split(":")
              .filter((entry) => entry.length > 0)
              .map(linuxPath)),
          ];
          for (const directory of search) {
            const directoryPath = yield* checkLinuxPath(directory);
            const candidate = join(directoryPath, query.name);
            const available = yield* Effect.promise(() =>
              access(candidate, filesystemConstants.X_OK)
                .then(() => true)
                .catch(() => false)
            );
            if (available) {
              return { name: query.name, path: linuxPath(candidate) };
            }
          }
          return yield* new ExecutableNotFoundError({
            executable: query.name,
            searched: [...new Set(search.map((directory) => directory.absolute))],
          });
        },
      );

      const credentialCapability = Effect.fn("MachineState.credentialCapability")(
        function*(): Effect.fn.Return<CredentialStorageCapability, MachineStateError> {
          if (localCredentialRoot !== undefined) {
            return { kind: "local-file", path: linuxPath(localCredentialRoot) };
          }
          if (sessionBus.kind === "missing") {
            return {
              kind: "unavailable",
              recovery: `The Secret Service bus is unavailable: ${linuxSessionBusRecovery(sessionBus)}`,
            };
          }
          const secretTool = yield* discoverSecretTool(environment);
          return secretTool === undefined
            ? { kind: "unavailable", recovery: secretToolMissing }
            : {
              kind: "secure-noninteractive",
              provider: "secret-service",
              verification: "provider-presence",
            };
        },
      );

      const requireSecretTool = Effect.fn("MachineState.requireSecretTool")(
        function*(): Effect.fn.Return<string, HumanActionRequiredError> {
          if (sessionBus.kind === "missing") {
            return yield* new HumanActionRequiredError({
              action: "reach the Secret Service bus",
              recovery: linuxSessionBusRecovery(sessionBus),
            });
          }
          const secretTool = yield* discoverSecretTool(environment);
          if (secretTool !== undefined) return secretTool;
          return yield* new HumanActionRequiredError({
            action: "install secret-tool",
            recovery: secretToolMissing,
          });
        },
      );

      const unlockRecovery =
        "Make sure the Secret Service provider is running and the login keyring is unlocked for this user (it unlocks when you log in with your password, or from the desktop session), then retry.";

      const clearSecretServiceParts = (
        secretTool: string,
        key: string,
        parts: number,
      ): Effect.Effect<ReadonlyArray<string>, HumanActionRequiredError> =>
        Effect.gen(function*() {
          const failed: Array<string> = [];
          for (let part = 0; part < parts; part += 1) {
            const partKey = secretServicePartKey(key, part);
            const result = yield* runCredentialCommand(
              secretTool,
              ["clear", "canonfig-key", partKey],
              environment,
              busEnvironment,
            );
            if (result.exitCode !== 0) failed.push(partKey);
          }
          return failed;
        });

      const storeCredential = Effect.fn("MachineState.storeCredential")(
        function*(input: StoreCredentialInput): Effect.fn.Return<CredentialReferenceType, MachineStateError> {
          if (input.name.trim().length === 0) {
            return yield* new CredentialStorageError({
              operation: "store credential",
              reference: "local-file",
              message: "credential name must not be empty",
            });
          }
          const name = createHash("sha256").update(input.name).digest("hex");
          const bytes = new TextEncoder().encode(Redacted.value(input.value));
          if (localCredentialRoot !== undefined) {
            const path = join(localCredentialRoot, `${name}.credential`);
            yield* atomicWriteFile(path, bytes, defaultFileMode);
            return decode(CredentialReference)(`local-file:${path}`);
          }
          const secretTool = yield* requireSecretTool();
          const parts = secretServiceParts(bytes);
          for (let part = 0; part < parts.length; part += 1) {
            const label = parts.length === 1
              ? "Canonfig credential"
              : `Canonfig credential (part ${part + 1} of ${parts.length})`;
            const result = yield* runCredentialCommand(
              secretTool,
              ["store", `--label=${label}`, "canonfig-key", secretServicePartKey(name, part)],
              environment,
              busEnvironment,
              parts[part],
            ).pipe(
              Effect.tapError(() => clearSecretServiceParts(secretTool, name, part).pipe(Effect.ignore)),
            );
            // secret-tool exits 0 after truncating oversized input; its
            // "too long" diagnostic is a failure even with a zero status.
            if (result.exitCode !== 0 || /too long/iu.test(result.diagnostic)) {
              yield* clearSecretServiceParts(secretTool, name, part + 1).pipe(Effect.ignore);
              return yield* new HumanActionRequiredError({
                action: "unlock Linux credential storage",
                recovery: `secret-tool could not store the credential on ${busName}${
                  result.diagnostic === "" ? ` (exit ${result.exitCode ?? "signal"})` : `: ${result.diagnostic}`
                }. ${unlockRecovery}`,
              });
            }
          }
          return decode(CredentialReference)(
            parts.length === 1 ? `secret-service:${name}` : `secret-service:${name}:${parts.length}`,
          );
        },
      );

      const loadCredential = Effect.fn("MachineState.loadCredential")(
        function*(input: LoadCredentialInput): Effect.fn.Return<Redacted.Redacted<string>, MachineStateError> {
          if (localCredentialRoot !== undefined) {
            const path = yield* localCredentialPath(input.reference, localCredentialRoot);
            const content = yield* readBounded({
              path: linuxPath(path),
              maximumBytes: 1024 * 1024,
            });
            return Redacted.make(new TextDecoder("utf-8", { ignoreBOM: true }).decode(content));
          }
          const item = yield* secretServiceItem(input.reference);
          const secretTool = yield* requireSecretTool();
          const parts: Array<Buffer> = [];
          for (let part = 0; part < item.parts; part += 1) {
            const partKey = secretServicePartKey(item.key, part);
            const result = yield* runCredentialCommand(
              secretTool,
              ["lookup", "canonfig-key", partKey],
              environment,
              busEnvironment,
            );
            if (result.exitCode !== 0) {
              return yield* new HumanActionRequiredError({
                action: "provide local credential",
                recovery: result.diagnostic === ""
                  ? `the Secret Service on ${busName} returned no item with canonfig-key=${partKey}: the login keyring is locked or the item was removed outside Canonfig. ${unlockRecovery} If the item is gone, store the credential again.`
                  : `secret-tool could not read canonfig-key=${partKey} on ${busName}: ${result.diagnostic}. ${unlockRecovery}`,
              });
            }
            parts.push(result.standardOutput);
          }
          // Byte-exact: secret-tool adds a newline only when stdout is a
          // terminal, and this pipe never is, so nothing is trimmed.
          return Redacted.make(new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.concat(parts)));
        },
      );

      const removeCredential = Effect.fn("MachineState.removeCredential")(
        function*(reference: CredentialReferenceType): Effect.fn.Return<void, MachineStateError> {
          if (localCredentialRoot !== undefined) {
            const path = yield* localCredentialPath(reference, localCredentialRoot);
            yield* promiseEffect("remove credential", path, () => unlink(path));
            return;
          }
          const item = yield* secretServiceItem(reference);
          const secretTool = yield* requireSecretTool();
          const failed = yield* clearSecretServiceParts(secretTool, item.key, item.parts);
          if (failed.length > 0) {
            return yield* new CredentialStorageError({
              operation: "remove credential",
              reference: String(reference),
              message: `the Secret Service on ${busName} did not remove canonfig-key=${failed.join(", ")}`,
            });
          }
        },
      );

      return MachineState.of({
        normalizePath,
        userDirectories,
        ensureDirectory,
        atomicWrite,
        readFile: Effect.fn("MachineState.readFile")(readBounded),
        removeFile,
        removeEmptyDirectory,
        removeTemporaryEntries,
        validatePathWithinRoot,
        mutateWithinRoot,
        replaceSymlink,
        readSymlink,
        inspectPath,
        listDirectory,
        setPermissions,
        permissions,
        snapshotPermissions: Effect.fn("MachineState.snapshotPermissions")((path: MachinePath) =>
          permissions(path).pipe(Effect.map(({ mode }) => ({ platform: "posix" as const, mode })))
        ),
        findExecutable,
        runProcess: Effect.fn("MachineState.runProcess")(
          (invocation: ProcessInvocation) =>
            runBoundedProcess(invocation, environment),
        ),
        digestFile: Effect.fn("MachineState.digestFile")(digest),
        credentialCapability,
        storeCredential,
        loadCredential,
        removeCredential,
        renderSchedulerJob: Effect.fn("MachineState.renderSchedulerJob")(renderSystemdJob),
        inspectSchedulerJob: Effect.fn("MachineState.inspectSchedulerJob")(scheduler.inspect),
        snapshotSchedulerJob: Effect.fn("MachineState.snapshotSchedulerJob")(scheduler.snapshot),
        installSchedulerJob: Effect.fn("MachineState.installSchedulerJob")(scheduler.install),
        removeSchedulerJob: Effect.fn("MachineState.removeSchedulerJob")(scheduler.remove),
        restoreSchedulerJob: Effect.fn("MachineState.restoreSchedulerJob")(scheduler.restore),
      });
    },
  );
