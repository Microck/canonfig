import fs from "node:fs/promises";
import path from "node:path";

export async function readOptionalFile(filePath: string): Promise<Uint8Array | undefined> {
  try { return await fs.readFile(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(path.relative(root, absolute));
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

export async function atomicWrite(filePath: string, content: string | Uint8Array, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await fs.chmod(temporary, mode);
    await fs.rename(temporary, filePath);
  } catch (error) {
    try { await fs.rm(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

export async function removeFileAndEmptyParents(filePath: string, stopAt: string): Promise<void> {
  try { await fs.unlink(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let current = path.dirname(filePath);
  const stop = path.resolve(stopAt);
  while (current !== stop) {
    const relative = path.relative(stop, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) break;
    try { await fs.rmdir(current); }
    catch { break; }
    current = path.dirname(current);
  }
}
