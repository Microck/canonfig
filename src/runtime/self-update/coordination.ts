import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";

export const updateDirectory = (root: string) => join(dirname(root), ".canonfig-self-update");
export function regular(path: string): void {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error(`Expected a regular file: ${path}`);
}
export function acquireGate(directory: string): () => void {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Invalid self-update directory");
  const gate = join(directory, "gate");
  try { mkdirSync(gate, { mode: 0o700 }); }
  catch { throw new Error(`Self-update coordination is busy or interrupted: ${gate}. Never clear it while a worker is active.`); }
  return () => rmSync(gate, { recursive: true });
}
/** Only installations explicitly opted in pay for a lease. Never reclaim a stale lease automatically. */
export function commandLease(root: string): (() => void) | undefined {
  const directory = updateDirectory(root);
  const settings = join(directory, "settings.json");
  if (!existsSync(settings)) return;
  regular(settings);
  const release = acquireGate(directory);
  try {
    if (existsSync(join(directory, "pending.json"))) throw new Error("Interrupted self-update: restore the retained package before running Canonfig commands.");
    const readers = join(directory, "readers");
    mkdirSync(readers, { recursive: true, mode: 0o700 });
    const path = join(readers, `${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    return () => rmSync(path, { force: true });
  } finally { release(); }
}
export function readersActive(directory: string): boolean {
  const readers = join(directory, "readers");
  if (!existsSync(readers)) return false;
  if (!lstatSync(readers).isDirectory() || lstatSync(readers).isSymbolicLink()) throw new Error("Invalid self-update readers directory");
  return readdirSync(readers).length > 0;
}
