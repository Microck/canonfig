// Main's first import: the compile cache must be enabled before the rest of
// the CLI graph loads, so that the effect graph and every command module
// compile into the cache and subsequent runs skip their parse cost.
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// An explicit per-user directory: with no argument enableCompileCache()
// would fall back next to the node executable, which global installs cannot
// write to. Any failure here must never block startup.
try {
  const cacheHome = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  enableCompileCache(join(cacheHome, "canonfig", "compile-cache"));
} catch {
  // Startup proceeds without the cache: slower, never broken.
}
