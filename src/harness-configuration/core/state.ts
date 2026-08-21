import fs from "node:fs/promises";
import path from "node:path";
import { CANONFIG_DIR, STATE_FILENAME } from "./config.ts";
import type { CanonfigState } from "./types.ts";
import { CanonfigError } from "./errors.ts";
import { assertNoSymlinkPathComponents, atomicWrite } from "./filesystem.ts";

export const HARNESS_CONFIGURATION_VERSION = "1";

export function emptyState(): CanonfigState {
  return { version: 1, generatedAt: new Date(0).toISOString(), canonfigVersion: HARNESS_CONFIGURATION_VERSION, artifacts: {} };
}

export async function loadState(root: string): Promise<CanonfigState> {
  const statePath = path.join(root, CANONFIG_DIR, STATE_FILENAME);
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CanonfigState>;
    if (parsed.version !== 1 || !parsed.artifacts || typeof parsed.artifacts !== "object") {
      throw new CanonfigError("STATE_INVALID", `Unsupported state file: ${path.relative(root, statePath)}`);
    }
    return parsed as CanonfigState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    if (error instanceof CanonfigError) throw error;
    throw new CanonfigError("STATE_INVALID", `Could not read ${path.relative(root, statePath)}: ${String(error)}`, error);
  }
}

export async function writeState(root: string, state: CanonfigState): Promise<void> {
  const statePath = path.join(root, CANONFIG_DIR, STATE_FILENAME);
  if (Object.keys(state.artifacts).length === 0) {
    await assertNoSymlinkPathComponents(root, path.dirname(statePath));
    try { await fs.unlink(statePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return;
  }
  await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600, root);
}
