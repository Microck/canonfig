import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync, lstatSync } from "node:fs";
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
/** Only installations explicitly opted in pay for a lease. Never reclaim a stale lease automatically. */
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
    const path = join(readers, `${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    return () => rmSync(path, { force: true });
  } finally { release(); }
}
export function readersActive(directory: string): boolean {
  const readers = join(directory, "readers");
  if (!entry(readers)) return false;
  if (!lstatSync(readers).isDirectory() || lstatSync(readers).isSymbolicLink()) throw new Error("Invalid self-update readers directory");
  return readdirSync(readers).length > 0;
}
