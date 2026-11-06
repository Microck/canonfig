import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";

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
/** Only installations explicitly opted in pay for a lease. */
export function commandLease(root: string): (() => void) | undefined {
  const directory = updateDirectory(root);
  const settings = join(directory, "settings.json");
  if (!entry(settings)) {
    if(entry(join(directory,"pending.json")))throw new Error("Interrupted self-update: pending transaction exists without settings");
    return;
  }
  regular(settings);
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

/** A capability for this command's lease, never for another process's reader files. */
export function managedCommandLease(root: string): ManagedCommandLease {
  let release = commandLease(root);
  let suspended = false;
  let closed = false;
  return {
    get suspended() { return suspended; },
    close() {
      closed = true;
      release?.();
      release = undefined;
    },
    async selfUpdate<A>(operation: () => Promise<A>, keepsRunning: (result: A) => boolean): Promise<A> {
      if (closed || suspended) throw new Error("This command is already stopping or performing a self-update operation");
      suspended = true;
      release?.();
      release = undefined;
      let resume: boolean;
      let result: A;
      try {
        result = await operation();
        resume = keepsRunning(result);
      } catch (error) {
        try {
          if (!closed) release = commandLease(root);
          suspended = false;
        } catch {
          // Preserve the operation's CLI error if its pending journal prevents
          // re-entry. Stay suspended so the GUI cannot start more commands.
        }
        throw error;
      }
      // Re-enter through the ordinary gate, never bypassing a pending transaction.
      if (resume && !closed) release = commandLease(root);
      suspended = !resume;
      return result;
    },
  };
}
