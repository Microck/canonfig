import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { programVersion } from "../../src/cli/help.ts";
import { updateDirectory } from "../../src/runtime/self-update/coordination.ts";

const project = resolve(import.meta.dirname, "../..");
const PackResult = Schema.Array(Schema.Struct({ filename: Schema.String }));
const Manifest = Schema.Struct({ version: Schema.String });
export const previous = programVersion;
const parts = previous.split(".");
export const candidate = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;

/** Stop any children using this installation before calling cleanup. */
export interface GuiSelfUpdateFixture {
  readonly home: string;
  readonly root: string;
  readonly entry: string;
  readonly env: NodeJS.ProcessEnv;
  readonly npmCli: string;
  readonly downloadStarted: Promise<void>;
  readonly allowDownload: () => void;
  readonly registryRequests: () => number;
  readonly version: () => string;
  readonly readers: () => string[];
  readonly invoke: (args: string[]) => SpawnSyncReturns<string>;
  readonly cleanup: () => Promise<void>;
}

export async function createGuiSelfUpdateFixture(options: { holdDownload?: boolean } = {}): Promise<GuiSelfUpdateFixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "canonfig-gui-update-")));
  let registry: Server | undefined;
  const cleanup = async () => {
    if (registry?.listening) {
      const closed = once(registry, "close");
      registry.close();
      registry.closeAllConnections();
      await closed;
    }
    rmSync(home, { recursive: true, force: true });
  };
  try {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".state"), XDG_RUNTIME_DIR: join(home, "runtime"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "runtime", "bus")}`,
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off" };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/iu.test(key) || ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NODE_OPTIONS"].includes(key.toUpperCase())) delete env[key];
  }
  mkdirSync(join(home, "runtime"), { mode: 0o700 });
  const officialNpm = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : realpathSync(join(dirname(process.execPath), "npm"));
  const npm = (args: string[], cwd = home) => {
    const result = spawnSync(process.execPath, [officialNpm, ...args,
      "--userconfig", join(home, "empty-user.npmrc"), "--globalconfig", join(home, "empty-global.npmrc"),
      "--cache", join(home, "npm-cache")], { cwd, env, encoding: "utf8", timeout: 60_000 });
    if (result.status !== 0) throw new Error(`npm ${args[0]} failed: ${result.error?.message ?? ""}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  writeFileSync(join(home, "empty-user.npmrc"), "");
  writeFileSync(join(home, "empty-global.npmrc"), "");
  const manifest = (version: string) => ({ name: "@microck/canonfig", version, type: "module",
    bin: { canonfig: "dist/runtime/main.js" }, dependencies: {}, files: ["dist"] });
  const pack = (directory: string) => {
    const packed = Schema.decodeUnknownSync(PackResult)(JSON.parse(npm([
      "pack", "--ignore-scripts", "--json", "--pack-destination", home,
    ], directory)));
    const filename = packed[0]?.filename;
    if (filename === undefined) throw new Error("npm pack returned no package");
    return join(home, filename);
  };

  // The starting process runs the actual built application. Dependency lookup
  // uses the existing checkout without installing or changing its packages.
  const initial = join(home, "initial");
  mkdirSync(initial);
  cpSync(join(project, "dist"), join(initial, "dist"), { recursive: true });
  writeFileSync(join(initial, "package.json"), JSON.stringify(manifest(previous)));
  const prefix = join(home, "prefix");
  npm(["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", pack(initial)]);
  const root = join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@microck", "canonfig");
  symlinkSync(join(project, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  // This local release fixture has a real executable and no dependencies. npm
  // installs its packed bytes; the updater executes both required CLI smokes.
  const release = join(home, "release");
  mkdirSync(join(release, "dist", "runtime"), { recursive: true });
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest(candidate)));
  writeFileSync(join(release, "dist", "runtime", "main.js"), `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args.length === 1 && args[0] === "--version") console.log(${JSON.stringify(candidate)});\nelse if (args.join(" ") === "self-update --help") console.log("Local patch fixture: self-update help");\nelse process.exitCode = 2;\n`, { mode: 0o755 });
  const tarball = readFileSync(pack(release));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const downloadStarted = Promise.withResolvers<void>();
  const allowDownload = Promise.withResolvers<void>();
  if (!options.holdDownload) allowDownload.resolve();
  let registryOrigin = "";
  let requests = 0;
  registry = createServer((request, response) => {
    requests += 1;
    if (request.url === "/candidate.tgz") {
      downloadStarted.resolve();
      void allowDownload.promise.then(() => {
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": tarball.length });
        response.end(tarball);
      });
      return;
    }
    if (decodeURIComponent(request.url ?? "") !== "/@microck/canonfig") {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ name: "@microck/canonfig", "dist-tags": { latest: candidate }, versions: {
      [previous]: manifest(previous),
      [candidate]: { ...manifest(candidate), dist: { tarball: `${registryOrigin}/candidate.tgz`, integrity } },
    } }));
  });
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  const address = registry.address();
  if (address === null || typeof address === "string") throw new Error("Missing local registry address");
  registryOrigin = `http://127.0.0.1:${address.port}`;

  // Only this test npm entrypoint redirects the updater's fixed registry flags.
  // All npm output, packing, metadata parsing and installation are real npm.
  const npmCli = join(home, "npm", "bin", "npm-cli.js");
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, `const { spawn } = require("node:child_process");\nprocess.umask(0o022);\nconst args = process.argv.slice(2).map(arg => arg.startsWith("--registry=") ? "--registry=" + ${JSON.stringify(registryOrigin)} : arg.startsWith("--@microck:registry=") ? "--@microck:registry=" + ${JSON.stringify(registryOrigin)} : arg);\nconst child = spawn(process.execPath, [${JSON.stringify(officialNpm)}, ...args], { stdio: "inherit" });\nchild.on("error", error => { console.error(error.message); process.exitCode = 1; });\nchild.on("exit", (code, signal) => { process.exitCode = code ?? 1; });\nprocess.on("SIGTERM", () => child.kill("SIGTERM"));\n`);
  const entry = join(root, "dist", "runtime", "main.js");
  return { home, root, entry, env, npmCli, cleanup, downloadStarted: downloadStarted.promise,
    allowDownload: allowDownload.resolve, registryRequests: () => requests,
    version: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version,
    readers: () => readdirSync(join(updateDirectory(root), "readers")),
    invoke: (args: string[]) => spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8", timeout: 30_000 }),
  };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
