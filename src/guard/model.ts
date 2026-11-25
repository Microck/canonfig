import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";

import { CanonfigError } from "../skills/errors.ts";
import { withRunLock } from "../synchronization/run-lock.ts";

/**
 * The local Skill Update 396M model behind the `skill-update` Guard checker.
 *
 * Canonfig downloads one pinned Hugging Face revision into the user cache, never
 * into ~/.canonfig, so backups, archives and history never carry 1.6 GB of weights.
 * `uv` provides the Python runtime the bundled skill-update-checker.py declares.
 * Any process that needs a verdict (CLI, skills worker, GUI) starts the checker on
 * demand; it listens on loopback and exits after 15 idle minutes, so there is no
 * service to start or stop.
 */
export const guardModel = {
  id: "skill-update-396m",
  name: "Skill Update 396M",
  repository: "Microck/canonfig-guard-skill-update-396m",
  revision: "b31fcada5034b1e01661ffcb3d72cfe306ea99c8",
  // Every file the checker loads, pinned by digest. The weights digest also matches checkpoint/settings.json,
  // which encoder_scan.py verifies again at load time.
  files: [
    { path: "encoder_scan.py", sha256: "de700cd844803e38530a2d241466fd889d589ef2a8cb009dac53fccc26d813c9", bytes: 1525 },
    { path: "fmt.py", sha256: "529c03ed207144d7724a8457afdf647b65dba8fea1bab4262a1457af4d863ef3", bytes: 1668 },
    { path: "apache-license.txt", sha256: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4", bytes: 11357 },
    { path: "canonfig-license.txt", sha256: "b1efb4fe8116bfa12d6169d225921f12dff67ecae4628061559ddf0d8565eb67", bytes: 1064 },
    { path: "checkpoint/config.json", sha256: "c4d5876be1e172a575841640cfd744d14159361a59ed3609c6b1b20a5dde2f75", bytes: 2063 },
    { path: "checkpoint/settings.json", sha256: "b7e6dd84ee5b68766557d5d77b024217c286c787d7ca56aff97a32f1b0a45b7c", bytes: 510 },
    { path: "checkpoint/tokenizer.json", sha256: "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30", bytes: 3583228 },
    { path: "checkpoint/tokenizer_config.json", sha256: "fb54f027372062b2ca52282efb04d178a8b57167a00cd8f4e816515823a2c016", bytes: 380 },
    { path: "checkpoint/model.safetensors", sha256: "ddf08308fb0de7de36e85f0be3a1e07d1abdf24d5fdc25d17b939ae9882ea671", bytes: 1583351632 },
  ],
} as const;
export const guardModelDownloadBytes = guardModel.files.reduce((total, file) => total + file.bytes, 0);

/** Where the model lives and how to reach the internet and uv. Tests pass their own. */
export interface GuardModelEnvironment {
  readonly directory: string;
  readonly baseUrl: string;
  readonly uv: () => Promise<string | undefined>;
}

/**
 * The per-OS user cache: XDG_CACHE_HOME or ~/.cache, ~/Library/Caches, %LOCALAPPDATA%.
 * CANONFIG_GUARD_MODEL_DIR moves the model elsewhere, for example to a larger disk.
 */
export function defaultGuardModelEnvironment(): GuardModelEnvironment {
  const home = homedir();
  const env = (name: string) => process.env[name] || undefined;
  const override = env("CANONFIG_GUARD_MODEL_DIR");
  if (override !== undefined) return { directory: override, baseUrl: "https://huggingface.co", uv: findUv };
  const cache = process.platform === "win32" ? join(env("LOCALAPPDATA") ?? join(home, "AppData", "Local"), "canonfig", "cache")
    : process.platform === "darwin" ? join(home, "Library", "Caches", "canonfig")
    : join(env("XDG_CACHE_HOME") ?? join(home, ".cache"), "canonfig");
  return { directory: join(cache, "guard", guardModel.id), baseUrl: "https://huggingface.co", uv: findUv };
}

/** uv on PATH, or in ~/.local/bin where uv's own installer puts it (often missing from a service's PATH). */
async function findUv(): Promise<string | undefined> {
  const name = process.platform === "win32" ? "uv.exe" : "uv";
  const directories = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin")];
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return undefined;
}

const InstalledMarker = Schema.Struct({ revision: Schema.String });
const ServerRecord = Schema.Struct({ port: Schema.Number, pid: Schema.Number });
const Ready = Schema.Struct({ ready: Schema.Literal(true), port: Schema.Number });
const Health = Schema.Struct({ model: Schema.String });

const checkerScript = fileURLToPath(new URL("./skill-update-checker.py", import.meta.url));
const markerPath = (environment: GuardModelEnvironment) => join(environment.directory, "installed.json");
const serverPath = (environment: GuardModelEnvironment) => join(environment.directory, "server.json");
const filesDirectory = (environment: GuardModelEnvironment) => join(environment.directory, guardModel.revision);

async function installed(environment: GuardModelEnvironment): Promise<boolean> {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(InstalledMarker))(await readFile(markerPath(environment), "utf8")).revision === guardModel.revision;
  } catch { return false; }
}

/** GET the checker's health route. Anything else listening on the recorded port is not the model. */
function healthy(port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const outgoing = request({ host: "127.0.0.1", port, path: "/v1/health", method: "GET", agent: false, timeout }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { if (chunks.length < 4) chunks.push(chunk); });
      response.on("end", () => {
        try { resolve(response.statusCode === 200 && Schema.decodeUnknownSync(Schema.fromJsonString(Health))(Buffer.concat(chunks).toString("utf8")).model === guardModel.id); }
        catch { resolve(false); }
      });
    });
    outgoing.on("timeout", () => outgoing.destroy());
    outgoing.on("error", () => resolve(false));
    outgoing.end();
  });
}

async function recordedServer(environment: GuardModelEnvironment): Promise<{ port: number; pid: number } | undefined> {
  try {
    const server = Schema.decodeUnknownSync(Schema.fromJsonString(ServerRecord))(await readFile(serverPath(environment), "utf8"));
    return await healthy(server.port, 1000) ? server : undefined;
  } catch { return undefined; }
}

export async function guardModelStatus(environment = defaultGuardModelEnvironment()) {
  const isInstalled = await installed(environment);
  return {
    installed: isInstalled,
    running: isInstalled && await recordedServer(environment) !== undefined,
    uv: await environment.uv() !== undefined,
    downloadBytes: guardModelDownloadBytes,
  };
}

const needsUv = () => new CanonfigError("GUARD_MODEL_UV_MISSING",
  "Skill Update 396M runs with uv. Install uv from https://docs.astral.sh/uv/, then install the model again.");

/** Run the checker once (`--check`) so uv resolves its dependencies and the weights load before the first real check. */
function prepareRuntime(uv: string, environment: GuardModelEnvironment, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(uv, ["run", "--quiet", "--script", checkerScript, "--model-dir", filesDirectory(environment), "--check"], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal,
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString("utf8")).slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && output.includes('"ready": true')) resolve();
      else reject(new CanonfigError("GUARD_MODEL_RUNTIME_FAILED",
        `Skill Update 396M could not start. Check your connection and free disk space, then install it again.${errors ? ` Last output: ${errors.trim().split("\n").at(-1)}` : ""}`));
    });
  });
}

async function verifiedFile(path: string, sha256: string): Promise<boolean> {
  try {
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    return hash.digest("hex") === sha256;
  } catch { return false; }
}

/**
 * Download the pinned files, verify each digest, prepare the runtime, then write the
 * installed marker last. A file that already verifies is kept, so a cancelled or
 * failed install resumes at the file that failed.
 */
export async function installGuardModel(
  onProgress: (progress: { stage: "download" | "runtime"; received: number; total: number }) => void,
  signal: AbortSignal,
  environment = defaultGuardModelEnvironment(),
  prepare: (uv: string, environment: GuardModelEnvironment, signal: AbortSignal) => Promise<void> = prepareRuntime,
): Promise<void> {
  const uv = await environment.uv();
  if (uv === undefined) throw needsUv();
  let received = 0;
  const report = () => onProgress({ stage: "download", received, total: guardModelDownloadBytes });
  report();
  for (const file of guardModel.files) {
    const target = join(filesDirectory(environment), file.path);
    if (await verifiedFile(target, file.sha256)) {
      received += file.bytes;
      report();
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const url = `${environment.baseUrl}/${guardModel.repository}/resolve/${guardModel.revision}/${file.path}`;
    let response: Response;
    try { response = await fetch(url, { signal }); }
    catch (error) {
      signal.throwIfAborted();
      throw new CanonfigError("GUARD_MODEL_DOWNLOAD_FAILED", `Couldn't download Skill Update 396M. Check your connection and try again. (${String(error)})`);
    }
    if (!response.ok || response.body === null) {
      throw new CanonfigError("GUARD_MODEL_DOWNLOAD_FAILED", `Couldn't download Skill Update 396M (HTTP ${response.status}). Try again later.`);
    }
    const partial = `${target}.part`;
    const hash = createHash("sha256");
    const start = received;
    const sink = createWriteStream(partial, { mode: 0o600 });
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        received += chunk.byteLength;
        if (received - start > file.bytes) throw new Error("Unexpected download size");
        if (!sink.write(chunk)) await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
        report();
      }
      await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => error ? reject(error) : resolve()));
    } catch (error) {
      sink.destroy();
      await rm(partial, { force: true });
      signal.throwIfAborted();
      throw new CanonfigError("GUARD_MODEL_DOWNLOAD_FAILED", `Couldn't download Skill Update 396M. Check your connection and try again. (${String(error)})`);
    }
    if (hash.digest("hex") !== file.sha256) {
      await rm(partial, { force: true });
      throw new CanonfigError("GUARD_MODEL_DOWNLOAD_FAILED", `A downloaded Skill Update 396M file did not match its expected digest: ${file.path}. Try again.`);
    }
    await rename(partial, target);
  }
  onProgress({ stage: "runtime", received, total: guardModelDownloadBytes });
  await prepare(uv, environment, signal);
  await writeFile(markerPath(environment), `${JSON.stringify({ revision: guardModel.revision })}\n`, { mode: 0o600 });
}

/** Stop a running checker and delete the downloaded files. */
export async function removeGuardModel(environment = defaultGuardModelEnvironment()): Promise<void> {
  const server = await recordedServer(environment);
  if (server !== undefined) {
    try { process.kill(server.pid); } catch { /* already gone */ }
  }
  await rm(environment.directory, { recursive: true, force: true });
}

const startTimeout = 180_000;

/** Read the one `{"ready": true, "port": N}` line the checker prints once the weights are loaded. */
function spawnChecker(uv: string, environment: GuardModelEnvironment, signal: AbortSignal): Promise<{ port: number; pid: number }> {
  return new Promise((resolve, reject) => {
    // Detached so it outlives a short CLI run; it exits on its own after 15 idle minutes.
    const child = spawn(uv, ["run", "--quiet", "--script", checkerScript, "--model-dir", filesDirectory(environment), "--idle-seconds", "900"], {
      detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    const fail = (error: Error) => {
      try { child.kill(); } catch { /* already gone */ }
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Skill Update 396M did not start in time")), startTimeout);
    const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n")[0];
      if (!buffer.includes("\n") || line === undefined) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.unref();
      try {
        const { port } = Schema.decodeUnknownSync(Schema.fromJsonString(Ready))(line);
        if (child.pid === undefined) throw new Error("The checker has no process ID");
        resolve({ port, pid: child.pid });
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", () => { clearTimeout(timer); reject(new Error("Skill Update 396M exited before it was ready")); });
  });
}

/**
 * The loopback endpoint of a running checker, starting one if needed. One process
 * starts it under a lock; another that finds the lock held waits for server.json.
 */
export async function guardModelEndpoint(signal: AbortSignal, environment = defaultGuardModelEnvironment()): Promise<string> {
  const endpoint = (port: number) => `http://127.0.0.1:${port}/v1/guard`;
  const running = await recordedServer(environment);
  if (running !== undefined) return endpoint(running.port);
  if (!await installed(environment)) throw new Error("Skill Update 396M is not installed");
  const uv = await environment.uv();
  if (uv === undefined) throw needsUv();
  const start = Effect.tryPromise(async () => {
    const again = await recordedServer(environment);
    if (again !== undefined) return again;
    const server = await spawnChecker(uv, environment, signal);
    await writeFile(serverPath(environment), `${JSON.stringify(server)}\n`, { mode: 0o600 });
    return server;
  });
  const deadline = Date.now() + startTimeout;
  while (true) {
    const started = await Effect.runPromise(withRunLock(join(environment.directory, "server"), "start Skill Update 396M", start).pipe(
      Effect.catchTag("RunLockHeldError", () => Effect.succeed(undefined)),
      Effect.catchTag("UnknownError", (error) => Effect.fail(error.cause)),
    ));
    if (started !== undefined) return endpoint(started.port);
    // Another process is starting it.
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new Error("Skill Update 396M did not start in time");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const ready = await recordedServer(environment);
    if (ready !== undefined) return endpoint(ready.port);
  }
}

