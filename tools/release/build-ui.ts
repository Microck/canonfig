import { cp, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const source = resolve(root, "ui/dist");
const target = resolve(root, "dist/ui");
if (!(await stat(resolve(source, "index.html"))).isFile()) {
  throw new Error("Build the production browser application before packaging Canonfig");
}
// Vite hashes its assets; remove old builds so stale chunks never enter the package.
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
