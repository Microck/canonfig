import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { Schema } from "effect";
import { TaggedError } from "../../domain/tagged-error.ts";

export const updateDirectory = (root: string) => join(dirname(root), ".canonfig-self-update");
export function entry(path: string) {
  try { return lstatSync(path); }
  catch(error) { if(error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
export function regular(path: string): void {
  const info=entry(path);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Expected a regular file: ${path}`);
}
export function assertPrivateDirectory(directory: string): void {
  const info=lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid self-update directory");
  if(process.getuid && (info.uid!==process.getuid() || (info.mode&0o022)!==0))throw new Error("Self-update directory must be user-owned and not writable by other users");
}
/**
 * How long a starting command waits for the gate. Commands hold it only for the
 * few filesystem calls that register a reader, so contention between commands
 * clears in milliseconds; harnesses start every `canonfig mcp run` server at
 * once, and failing on the first collision made those servers fail at random.
 * An updater holds the gate only while it swaps the package, which can outlast
 * this wait; a command that starts then fails and is retried by its caller.
 */
export const commandGateWaitMilliseconds = 1000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (milliseconds: number): void => {
  // The lease is taken synchronously before any command runs, so it cannot await.
  Atomics.wait(sleepCell, 0, 0, milliseconds);
};
/**
 * Take a lock directory, retrying for up to `waitMilliseconds` while another
 * process holds it. `gate` admits commands and the activation that replaces the
 * package; `updater` keeps updaters apart for a whole check, download and
 * install without blocking commands meanwhile.
 */
export function acquireGate(directory: string, waitMilliseconds = 0, name: "gate" | "updater" = "gate"): () => void {
  assertPrivateDirectory(directory);
  const gate = join(directory, name);
  const deadline = Date.now() + waitMilliseconds;
  for (;;) {
    try { mkdirSync(gate, { mode: 0o700 }); break; }
    catch (error) {
      const held = error instanceof Error && "code" in error && error.code === "EEXIST";
      if (!held || Date.now() >= deadline) {
        throw new Error(`Self-update coordination is busy or interrupted: ${gate}. Never clear it while a worker is active.`);
      }
      // Jitter keeps commands that collided once from retrying in lockstep.
      sleepSync(5 + Math.random() * 10);
    }
  }
  return () => rmSync(gate, { recursive: true });
}
/** Coordinate installed commands independently of standalone self-update consent. */
export function commandLease(root: string, home = homedir()): (() => void) | undefined {
  const directory = updateDirectory(root);
  if (!entry(directory)) {
    const path = resolve(root);
    const fromHome = relative(home, path);
    const packagePath = join(...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@microck", "canonfig");
    if (!path.endsWith(`${sep}${packagePath}`) || fromHome === "" || isAbsolute(fromHome)
      || fromHome === ".." || fromHome.startsWith(`..${sep}`) || entry(join(path, "src")) || entry(join(path, ".git"))) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  regular(join(directory, "settings.json"));
  const release = acquireGate(directory, commandGateWaitMilliseconds);
  try {
    if (entry(join(directory, "pending.json"))) throw new Error("Interrupted self-update: restore the retained package before running Canonfig commands.");
    const readers = join(directory, "readers");
    mkdirSync(readers, { recursive: true, mode: 0o700 });
    readersActive(directory);
    const path = join(readers, `${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    return () => rmSync(path, { force: true });
  } finally { release(); }
}

const readerPid = (path: string, name: string): number | undefined => {
  regular(path);
  let record: unknown;
  try { record = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return;
    throw error;
  }
  if (!(record instanceof Object) || !("pid" in record) || !Number.isSafeInteger(record.pid)) return;
  const pid = Number(record.pid);
  if (pid <= 0 || !name.startsWith(`${pid}-`)) return;
  return pid;
};

/** Called under the gate: retain live, reused and unknown PIDs; reclaim only ESRCH. */
export function readersActive(directory: string): boolean {
  const readers = join(directory, "readers");
  const info = entry(readers);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid self-update readers directory");
  let active = false;
  for (const name of readdirSync(readers)) {
    const path = join(readers, name);
    const pid = readerPid(path, name);
    if (pid !== undefined) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
          rmSync(path, { force: true });
          continue;
        }
      }
    }
    active = true;
  }
  return active;
}

export interface ManagedCommandLease {
  readonly suspended: boolean;
  readonly close: () => void;
  readonly selfUpdate: <A>(operation: () => Promise<A>, keepsRunning: (result: A) => boolean) => Promise<A>;
  /**
   * For long-running servers, once startup has loaded their code: drop the
   * startup lease and hold one only inside `hold()`. `onReplaced` runs when
   * `hold()` finds that an update replaced the package while the server was
   * idle; the server must then exit with `residentRestartExitCode`.
   */
  readonly becomeResident: (onReplaced: (installed: string) => void) => void;
  /**
   * Hold the lease for one unit of resident work and return its release. Before
   * `becomeResident`, and while a self-update operation runs, the startup lease
   * already covers the work. Throws `ResidentReplacedError` once the package
   * was replaced, and the coordination error while an update holds the gate.
   */
  readonly hold: () => () => void;
}

/**
 * A resident exits with this status after an update replaced its package, so a
 * supervisor (systemd Restart=on-failure, launchd SuccessfulExit=false, the
 * Windows task's RestartOnFailure) starts it again on the new release.
 * EX_TEMPFAIL: the same command succeeds when run again.
 */
export const residentRestartExitCode = 75;

/** The usual `onReplaced`: say why on stderr, then exit for the supervisor to restart the server. */
export const exitForReplacement = (writeStderr: (text: string) => void) => (installed: string): never => {
  writeStderr(`An update to ${installed} replaced the Canonfig release this server loaded. Exiting with status ${residentRestartExitCode} so it restarts on the new release.\n`);
  process.exit(residentRestartExitCode);
};

export class ResidentReplacedError extends TaggedError<ResidentReplacedError>()(
  "ResidentReplacedError", { message: Schema.String },
) {}

const InstalledManifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const installedVersion = (root: string): string | undefined => {
  let text: string;
  try { text = readFileSync(join(root, "package.json"), "utf8"); }
  catch { return undefined; }
  const manifest = Schema.decodeUnknownOption(InstalledManifest)(text);
  return manifest._tag === "Some" ? manifest.value.version : undefined;
};

/** The reader a resident's in-flight work shares, and how many units of work hold it. */
interface ResidentReader {
  release: (() => void) | undefined;
  holders: number;
}

type LeaseState =
  | { readonly _tag: "Active"; readonly release: () => void }
  | { readonly _tag: "Uncoordinated" }
  // Holds a reader only while work taken through `hold` runs.
  | { readonly _tag: "Resident"; readonly coordinated: boolean; readonly onReplaced: (installed: string) => void }
  | { readonly _tag: "Suspended" }
  | { readonly _tag: "Blocked" }
  | { readonly _tag: "RestartRequired" }
  | { readonly _tag: "Closed" };
export class LeaseTransitionError extends TaggedError<LeaseTransitionError>()(
  "LeaseTransitionError", { message: Schema.String },
) {}
/** A capability for this command's lease, never for another process's reader files. */
export function managedCommandLease(root: string, home = homedir()): ManagedCommandLease {
  const acquire = (): LeaseState => {
    const release = commandLease(root, home);
    return release === undefined ? { _tag: "Uncoordinated" } : { _tag: "Active", release };
  };
  // The version this process loaded. A resident compares it with the package on
  // disk each time it takes a fresh reader: idle, it held none, so an update may
  // have replaced the files its lazy imports would read.
  const loaded = installedVersion(root);
  let state = acquire();
  // Resident bookkeeping: the reader shared by in-flight work, and how much work holds it.
  let resident: ResidentReader = { release: undefined, holders: 0 };
  const transition = (next: LeaseState): void => {
    const running = state._tag === "Active" || state._tag === "Uncoordinated";
    const legal = next._tag === "Closed"
      || ((running || state._tag === "Resident") && next._tag === "Suspended")
      || (running && next._tag === "Resident")
      || (state._tag === "Resident" && next._tag === "RestartRequired")
      || (state._tag === "Suspended" && ["Active", "Uncoordinated", "Resident", "Blocked", "RestartRequired"].includes(next._tag));
    if (!legal) throw new LeaseTransitionError({ message: "This command is already stopping or performing a self-update operation" });
    state = next;
  };
  const closed = () => state._tag === "Closed";
  const dropResidentReader = () => {
    const release = resident.release;
    resident.release = undefined;
    release?.();
  };
  return {
    get suspended() { return state._tag !== "Active" && state._tag !== "Uncoordinated" && state._tag !== "Resident"; },
    close() {
      if (state._tag === "Active") state.release();
      if (state._tag === "Resident") dropResidentReader();
      transition({ _tag: "Closed" });
    },
    becomeResident(onReplaced) {
      const release = state._tag === "Active" ? state.release : undefined;
      transition({ _tag: "Resident", coordinated: state._tag === "Active", onReplaced });
      resident = { release: undefined, holders: 0 };
      release?.();
    },
    hold() {
      if (closed()) throw new LeaseTransitionError({ message: "This command is already stopping" });
      if (state._tag !== "Resident") return () => undefined;
      const current = state;
      if (current.coordinated && resident.release === undefined) {
        // The reader is registered before the check, so an updater sees it and
        // cannot activate between this check and the work it admits.
        resident.release = commandLease(root, home);
        const installed = installedVersion(root);
        if (installed !== loaded) {
          dropResidentReader();
          transition({ _tag: "RestartRequired" });
          current.onReplaced(installed ?? "an unknown version");
          throw new ResidentReplacedError({
            message: `Canonfig ${loaded ?? ""} was replaced by ${installed ?? "another installation"}; this server is restarting on the new release.`,
          });
        }
      }
      resident.holders += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        resident.holders -= 1;
        if (resident.holders === 0 && state._tag === "Resident") dropResidentReader();
      };
    },
    async selfUpdate<A>(operation: () => Promise<A>, keepsRunning: (result: A) => boolean): Promise<A> {
      if (state._tag !== "Active" && state._tag !== "Uncoordinated" && state._tag !== "Resident") throw new LeaseTransitionError({ message: "This command is already stopping or performing a self-update operation" });
      const returnTo = state._tag === "Resident" ? state : undefined;
      const release = state._tag === "Active" ? state.release : undefined;
      transition({ _tag: "Suspended" });
      release?.();
      if (returnTo !== undefined) dropResidentReader();
      // A resident takes its next reader lazily, through `hold`. A pending
      // journal left by a failed activation then refuses each unit of work with
      // its recovery message, and admits work again once it is resolved.
      const resume = (): LeaseState => returnTo ?? acquire();
      let result: A;
      try {
        result = await operation();
      } catch (error) {
        if (!closed()) {
          try { transition(resume()); }
          catch { transition({ _tag: "Blocked" }); }
        }
        throw error;
      }
      if (!closed()) {
        if (!keepsRunning(result)) transition({ _tag: "RestartRequired" });
        else {
          try { transition(resume()); }
          catch (error) { transition({ _tag: "Blocked" }); throw error; }
        }
      }
      return result;
    },
  };
}
