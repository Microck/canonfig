import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

import { Effect, Option, Schema, Semaphore } from "effect";

import { terminateProcessTree } from "./linux.layer.ts";
import { ProcessStartError, ProcessTimeoutError } from "./machine-state.errors.ts";

// Set native security directly: SetAccessControl recalculates inheritance from
// the temporary guard parent and propagates changes to children. BackupWrite
// also reassigns an unchanged owner, which can require restore privileges.
// Keep the full descriptor but request owner/group assignment only when changed.
const nativePermissionRestore = `
using System;
using System.ComponentModel;
using System.Security.AccessControl;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CanonfigPermissionRestore {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern SafeFileHandle ReOpenFile(SafeFileHandle file, uint access, uint share, uint flags);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool GetKernelObjectSecurity(SafeFileHandle file, uint information, byte[] descriptor, uint length, out uint needed);
  [DllImport("ntdll.dll")]
  static extern int NtSetSecurityObject(SafeFileHandle file, uint information, byte[] descriptor);
  [DllImport("ntdll.dll")]
  static extern uint RtlNtStatusToDosError(int status);
  public static void Restore(string path, byte[] descriptor) {
    // READ_CONTROL | WRITE_DAC does not request content access or WRITE_OWNER.
    // No privileges are enabled. Share read/write/delete; OPEN_EXISTING;
    // BACKUP_SEMANTICS (directories) | OPEN_REPARSE_POINT.
    using (var handle = CreateFileW(path, 0x00060000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint needed;
      if (!GetKernelObjectSecurity(handle, 3, null, 0, out needed) && Marshal.GetLastWin32Error() != 122)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      var currentBytes = new byte[needed];
      if (!GetKernelObjectSecurity(handle, 3, currentBytes, needed, out needed))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      var current = new RawSecurityDescriptor(currentBytes, 0);
      var expected = new RawSecurityDescriptor(descriptor, 0);
      // NtSetSecurityObject retains AUTO_INHERITED only when inheritance is
      // explicitly requested. Unlike SetAccessControl, it does not walk children.
      if ((expected.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0) {
        expected.SetFlags(expected.ControlFlags | ControlFlags.DiscretionaryAclAutoInheritRequired);
        expected.GetBinaryForm(descriptor, 0);
      }
      // Protection is an update flag, not inferred from the supplied descriptor.
      uint information = 4 | ((expected.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0
        ? 0x80000000u : 0x20000000u); // DACL | PROTECTED_DACL or UNPROTECTED_DACL.
      if (!Object.Equals(current.Owner, expected.Owner)) information |= 1;
      if (!Object.Equals(current.Group, expected.Group)) information |= 2;
      SafeFileHandle ownerHandle = null;
      try {
        if ((information & 3) != 0) {
          // Reopen the same object, not its path: a rename cannot redirect the
          // owner update. READ_CONTROL | WRITE_DAC | WRITE_OWNER, no content access.
          ownerHandle = ReOpenFile(handle, 0x000e0000, 7, 0x02200000);
          if (ownerHandle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        int status = NtSetSecurityObject(ownerHandle ?? handle, information, descriptor);
        if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
      } finally {
        if (ownerHandle != null) ownerHandle.Dispose();
      }
    }
  }
}
`;

/**
 * The cached restore helper's file name, named after its source so a change to
 * the C# above lands in a new file instead of loading a stale build.
 */
export const windowsPermissionRestoreAssemblyName = `CanonfigPermissionRestore-${
  createHash("sha256").update(nativePermissionRestore).digest("hex").slice(0, 16)
}.dll`;

/** A single-quoted PowerShell string: only `'` needs escaping, by doubling. */
export const powershellLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

/**
 * The PowerShell program behind the ACL worker. It reads one JSON request per
 * line from standard input and writes one JSON reply per line to standard
 * output, until standard input closes. Paths and descriptors arrive only as
 * JSON data, never as script text, so quotes, `$`, spaces and Unicode in a
 * path cannot change what runs. Both streams are explicit UTF-8: the console
 * code page would garble non-ASCII paths.
 *
 * A request is `{"id":1,"op":"snapshot"|"restore","path":"...","directory":false}`
 * plus `"descriptor"` (SDDL) for a restore. The reply is
 * `{"id":1,"ok":true,"descriptor":"<SDDL read back>"}` or
 * `{"id":1,"ok":false,"error":"..."}`. A per-path failure is a reply, not an
 * exit, so one denied path does not cost the next path a new process.
 *
 * Windows PowerShell uses the .NET Framework static ACL methods; PowerShell
 * Core exposes the same operations through FileSystemAclExtensions.
 *
 * The first restore compiles the native helper into `assembly` unless an
 * earlier run already did, then loads it once for the rest of the worker's
 * life. Assembly.LoadFrom is the loader on purpose: measured on an idle
 * Windows 11 VM it added 25-100ms where Add-Type -LiteralPath added
 * 170-290ms and the compile 250-350ms. The compile goes to a random sibling
 * that is renamed into place, so a concurrent canonfig never loads a
 * half-written file; losing that race means the winner's identical build is
 * already there. A corrupt cached file fails each restore with the file named
 * in the error; deleting it is the recovery.
 */
export const windowsAclWorkerScript = (assembly: string): string => [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "$utf8=New-Object Text.UTF8Encoding $false",
  "$reader=New-Object IO.StreamReader([Console]::OpenStandardInput(),$utf8)",
  "$writer=New-Object IO.StreamWriter([Console]::OpenStandardOutput(),$utf8)",
  "$writer.AutoFlush=$true",
  "$sections=[Security.AccessControl.AccessControlSections]'Access,Owner,Group'",
  "$core=$PSVersionTable.PSEdition -eq 'Core'",
  `$assembly=${powershellLiteral(assembly)}`,
  "$restoreLoaded=$false",
  "while($null -ne ($line=$reader.ReadLine())){",
  "$request=ConvertFrom-Json $line",
  "$reply=[ordered]@{id=$request.id}",
  "try{",
  "$path=[string]$request.path",
  "if($request.op -eq 'restore'){",
  "if(-not $restoreLoaded){",
  "if(-not (Test-Path -LiteralPath $assembly)){",
  "$directory=Split-Path -Parent $assembly",
  "$null=New-Item -ItemType Directory -Force -Path $directory",
  "$staging=Join-Path $directory ([IO.Path]::GetRandomFileName()+'.dll')",
  `Add-Type -TypeDefinition ${powershellLiteral(nativePermissionRestore)} -OutputAssembly $staging`,
  "try{Move-Item -LiteralPath $staging -Destination $assembly}",
  "catch{Remove-Item -LiteralPath $staging -Force;if(-not (Test-Path -LiteralPath $assembly)){throw}}",
  "}",
  "$null=[Reflection.Assembly]::LoadFrom($assembly)",
  "$restoreLoaded=$true",
  "}",
  "$security=New-Object Security.AccessControl.RawSecurityDescriptor([string]$request.descriptor)",
  "$binary=New-Object byte[] $security.BinaryLength",
  "$security.GetBinaryForm($binary,0)",
  "[CanonfigPermissionRestore]::Restore($path,$binary)",
  "}",
  "$acl=if($request.directory){",
  "if($core){[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($path),$sections)}",
  "else{[IO.Directory]::GetAccessControl($path,$sections)}",
  "}else{",
  "if($core){[IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]::new($path),$sections)}",
  "else{[IO.File]::GetAccessControl($path,$sections)}",
  "}",
  "$actual=$acl.GetSecurityDescriptorSddlForm($sections)",
  "if($request.op -eq 'restore' -and $actual -cne [string]$request.descriptor){",
  "throw 'Restored owner, group or access rules differ from the permission snapshot'",
  "}",
  "$reply.ok=$true",
  "$reply.descriptor=$actual",
  "}catch{",
  "$reply.ok=$false",
  "$reply.error=$_.Exception.Message",
  "}",
  "$writer.WriteLine((ConvertTo-Json $reply -Compress))",
  "}",
].join("\n");

export type WindowsAclRequest =
  | { readonly op: "snapshot"; readonly path: string; readonly directory: boolean }
  | {
    readonly op: "restore";
    readonly path: string;
    readonly directory: boolean;
    readonly descriptor: string;
  };

/**
 * What the worker said about one path. `descriptor` is the SDDL it read back
 * after the operation. A failure here concerns that path only; the caller
 * names the operation and path in its own error.
 */
export type WindowsAclReply =
  | { readonly ok: true; readonly descriptor: string }
  | { readonly ok: false; readonly error: string };

export interface WindowsAclWorker {
  readonly request: (
    request: WindowsAclRequest,
  ) => Effect.Effect<WindowsAclReply, ProcessStartError | ProcessTimeoutError>;
}

export interface WindowsAclWorkerOptions {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  /** Bounds each request, including the worker's startup on the first one. */
  readonly timeoutMilliseconds: number;
}

type Outcome =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "start-failed"; readonly message: string }
  | { readonly kind: "exited"; readonly detail: string };

interface RunningWorker {
  readonly child: ChildProcessWithoutNullStreams;
  /** Settles once the process is gone, or never started. */
  readonly closed: Promise<void>;
  pending: ((outcome: Outcome) => void) | undefined;
  stderr: string;
  exited: boolean;
}

// Long enough for a worker to leave its loop after standard input closes.
const gracefulExitMilliseconds = 2_000;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Runs native ACL snapshots and restores through one long-lived process
 * instead of one `powershell.exe` per path. PowerShell startup cost 0.3-1s
 * per path: mirroring about 200 skills into five harnesses took 25-30
 * minutes to sync and 20-25 more to roll back, close to Task Scheduler's
 * one-hour limit for a scheduled run.
 *
 * The worker starts on the first request, so a run that touches no native
 * permissions starts nothing. Requests run one at a time: the protocol has one
 * reply per request in order, and the ids only confirm that. The worker is
 * stopped when the enclosing scope closes, whether the run succeeded, failed
 * or was interrupted. A request that times out, is interrupted, or gets an
 * answer outside the protocol stops the worker at once, since its state is no
 * longer known; the next request starts a fresh one. The worker also exits on
 * its own when standard input closes, so a crashed canonfig does not leave it
 * behind.
 */
export const makeWindowsAclWorker = (
  options: WindowsAclWorkerOptions,
) => Effect.gen(function*() {
  const lock = yield* Semaphore.make(1);
  let current: RunningWorker | undefined;
  let nextId = 0;

  const settle = (running: RunningWorker, outcome: Outcome): void => {
    const pending = running.pending;
    running.pending = undefined;
    if (pending !== undefined) {
      pending(outcome);
    } else if (outcome.kind === "line") {
      // A reply nobody asked for means the stream is out of step.
      void stop(running, false);
    }
  };

  const start = (): RunningWorker => {
    const child = spawn(options.executable, [...options.arguments], {
      env: options.environment,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
      // A process group on POSIX lets terminateProcessTree stop descendants.
      detached: process.platform !== "win32",
    });
    let markClosed: () => void = () => undefined;
    const running: RunningWorker = {
      child,
      closed: new Promise<void>((resolve) => {
        markClosed = resolve;
      }),
      pending: undefined,
      stderr: "",
      exited: false,
    };
    child.stdout.setEncoding("utf8");
    createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on("line", (line) => settle(running, { kind: "line", line }));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      running.stderr = (running.stderr + chunk).slice(-4096);
    });
    // Writing to a worker that already exited fails with EPIPE; the close
    // event reports that exit to the waiting request.
    child.stdin.on("error", () => undefined);
    child.once("error", (cause) => {
      // A failed spawn may emit no close event; nothing is running.
      running.exited = true;
      markClosed();
      settle(running, { kind: "start-failed", message: messageOf(cause) });
    });
    child.once("close", (code, signal) => {
      running.exited = true;
      markClosed();
      if (current === running) current = undefined;
      const status = signal === null ? `exit ${code}` : `signal ${signal}`;
      const detail = running.stderr.trim();
      settle(running, {
        kind: "exited",
        detail: `the PowerShell ACL worker stopped (${status})${detail.length > 0 ? `: ${detail}` : ""}`,
      });
    });
    return running;
  };

  // Closing standard input asks the worker to finish; `graceful: false` or a
  // worker that does not leave in time is killed with its process tree.
  // Either way this waits until the process is gone.
  const stop = async (running: RunningWorker, graceful: boolean): Promise<void> => {
    if (current === running) current = undefined;
    if (!running.exited) {
      running.child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exitedInTime = graceful && await Promise.race([
        running.closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), gracefulExitMilliseconds);
        }),
      ]);
      clearTimeout(timer);
      if (!exitedInTime && !running.exited) terminateProcessTree(running.child);
    }
    await running.closed;
  };

  // Synchronous when no worker ever started, so a layer that touched no native
  // permissions still closes under Effect.runSync.
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const running = current;
      return running === undefined ? Effect.void : Effect.promise(() => stop(running, true));
    })
  );

  const exchange = (request: WindowsAclRequest) =>
    Effect.callback<WindowsAclReply, ProcessStartError | ProcessTimeoutError>((resume) => {
      let running: RunningWorker;
      try {
        if (current === undefined || current.exited) current = start();
        running = current;
      } catch (cause) {
        resume(Effect.fail(new ProcessStartError({ executable: options.executable, message: messageOf(cause) })));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        running.pending = undefined;
        void stop(running, false).then(() =>
          resume(Effect.fail(new ProcessTimeoutError({
            executable: options.executable,
            timeoutMilliseconds: options.timeoutMilliseconds,
          })))
        );
      }, options.timeoutMilliseconds);
      running.pending = (outcome) => {
        clearTimeout(timer);
        if (outcome.kind === "start-failed") {
          resume(Effect.fail(new ProcessStartError({ executable: options.executable, message: outcome.message })));
          return;
        }
        if (outcome.kind === "exited") {
          resume(Effect.succeed({ ok: false, error: outcome.detail }));
          return;
        }
        const reply = parseReply(outcome.line, id);
        if (reply === undefined) {
          void stop(running, false);
          resume(Effect.succeed({
            ok: false,
            error: `the PowerShell ACL worker answered outside its protocol: ${outcome.line.slice(0, 300)}`,
          }));
          return;
        }
        resume(Effect.succeed(reply));
      };
      running.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
      // Interrupted while waiting: a late reply would answer the next request.
      return Effect.promise(() => {
        clearTimeout(timer);
        if (running.pending === undefined) return Promise.resolve();
        running.pending = undefined;
        return stop(running, false);
      });
    });

  return {
    request: (request: WindowsAclRequest) => lock.withPermits(1)(exchange(request)),
  } satisfies WindowsAclWorker;
});

// One reply line. The id must match the request it answers; anything else is
// outside the protocol and stops the worker.
const ReplyLine = Schema.fromJsonString(Schema.Union([
  Schema.Struct({ id: Schema.Number, ok: Schema.Literal(true), descriptor: Schema.String }),
  Schema.Struct({ id: Schema.Number, ok: Schema.Literal(false), error: Schema.String }),
]));
const decodeReplyLine = Schema.decodeUnknownOption(ReplyLine);

const parseReply = (line: string, id: number): WindowsAclReply | undefined => {
  const decoded = decodeReplyLine(line);
  if (Option.isNone(decoded) || decoded.value.id !== id) return undefined;
  const reply = decoded.value;
  return reply.ok ? { ok: true, descriptor: reply.descriptor } : { ok: false, error: reply.error };
};
