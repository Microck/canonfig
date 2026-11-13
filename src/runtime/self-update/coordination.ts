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
export function acquireGate(directory: string): () => void {
  assertPrivateDirectory(directory);
  const gate = join(directory, "gate");
  try { mkdirSync(gate, { mode: 0o700 }); }
  catch { throw new Error(`Self-update coordination is busy or interrupted: ${gate}. Never clear it while a worker is active.`); }
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
  const release = acquireGate(directory);
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
}

type LeaseState =
  | { readonly _tag: "Active"; readonly release: () => void }
  | { readonly _tag: "Uncoordinated" }
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
  let state = acquire();
  const transition = (next: LeaseState): void => {
    const legal = next._tag === "Closed"
      || ((state._tag === "Active" || state._tag === "Uncoordinated") && next._tag === "Suspended")
      || (state._tag === "Suspended" && ["Active", "Uncoordinated", "Blocked", "RestartRequired"].includes(next._tag));
    if (!legal) throw new LeaseTransitionError({ message: "This command is already stopping or performing a self-update operation" });
    state = next;
  };
  const closed = () => state._tag === "Closed";
  return {
    get suspended() { return state._tag !== "Active" && state._tag !== "Uncoordinated"; },
    close() {
      if (state._tag === "Active") state.release();
      transition({ _tag: "Closed" });
    },
    async selfUpdate<A>(operation: () => Promise<A>, keepsRunning: (result: A) => boolean): Promise<A> {
      if (state._tag !== "Active" && state._tag !== "Uncoordinated") throw new LeaseTransitionError({ message: "This command is already stopping or performing a self-update operation" });
      const release = state._tag === "Active" ? state.release : undefined;
      transition({ _tag: "Suspended" });
      release?.();
      let result: A;
      try {
        result = await operation();
      } catch (error) {
        if (!closed()) {
          try { transition(acquire()); }
          catch { transition({ _tag: "Blocked" }); }
        }
        throw error;
      }
      if (!closed()) {
        if (!keepsRunning(result)) transition({ _tag: "RestartRequired" });
        else {
          try { transition(acquire()); }
          catch (error) { transition({ _tag: "Blocked" }); throw error; }
        }
      }
      return result;
    },
  };
}
