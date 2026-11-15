// Run after build:cli in a disposable Linux workspace. Never uses an operator HOME.
// The packed fixture changes only its version and release-verifier module. The
// production downloader, updater, CLI, TLS enrollment, sync and health path run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.umask(0o022);
const project = resolve(import.meta.dirname, "../../..");
const output = join(import.meta.dirname, "proof-automatic-output.txt");
const home = mkdtempSync(join(tmpdir(), "canonfig-fleet-proof-"));
const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
const previous = manifest.version;
const parts = previous.split(".").map(Number);
const next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const npmCli = realpathSync(join(dirname(process.execPath), "npm"));
const children = new Set();
const transcript = [];
const log = (message) => { transcript.push(message); console.log(message); writeFileSync(output, transcript.join("\n") + "\n"); };
const privateEnv = (directory) => {
  const env = { ...process.env, HOME: directory, USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"),
    XDG_RUNTIME_DIR: join(directory, "runtime"), DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/runtime/bus`,
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(directory, "credentials"), CANONFIG_LOG: "off", NODE_NO_WARNINGS: "1" };
  for (const key of Object.keys(env)) if (/^npm_config_/iu.test(key) || ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NODE_OPTIONS"].includes(key.toUpperCase())) delete env[key];
  return env;
};
const processRun = (executable, args, options = {}) => {
  const child = spawn(executable, args, { cwd: project, env: privateEnv(home), ...options, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  const completion = new Promise((resolveRun, reject) => {
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => { children.delete(child); resolveRun({ code, signal, stdout, stderr }); });
  });
  child.stdin.end(options.input ?? "");
  return { child, completion };
};
const checked = async (executable, args, options) => {
  const result = await processRun(executable, args, options).completion;
  assert.equal(result.code, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const npm = (args, env = privateEnv(home), cwd = project) => checked(process.execPath, [npmCli, ...args,
  "--userconfig", join(home, "empty-user.npmrc"), "--globalconfig", join(home, "empty-global.npmrc"),
  "--cache", join(home, "npm-cache")], { env, cwd });
writeFileSync(join(home, "empty-user.npmrc"), "");
writeFileSync(join(home, "empty-global.npmrc"), "");
const tarballs = new Map();
const registry = createServer((request, response) => {
  const bytes = tarballs.get(request.url);
  response.writeHead(bytes ? 200 : 404);
  response.end(bytes ?? "not found");
});
registry.listen(0, "127.0.0.1");
await once(registry, "listening");
const registryOrigin = `http://127.0.0.1:${registry.address().port}`;
const key = generateKeyPairSync("ed25519");
const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
const fixtureVerifier = `import { readFileSync } from "node:fs";
import { verify } from "node:crypto";
export { downloadFleetRelease } from "./fleet-release-official.js";
export async function verifyFleetRelease(version) {
  const signed = JSON.parse(readFileSync(${JSON.stringify(join(home, "releases.json"))}, "utf8"));
  if (!verify(null, Buffer.from(signed.payload), ${JSON.stringify(publicKey)}, Buffer.from(signed.signature, "base64"))) throw new Error("Fixture publisher signature invalid");
  const release = JSON.parse(signed.payload)[version];
  if (!release || release.version !== version) throw new Error("Unpublished fixture version");
  return release;
}
`;
const artifacts = new Map();
let sourceServer;
let paused;
try {
  const releases = {};
  for (const version of [previous, next]) {
    const folder = join(home, `release-${version}`);
    mkdirSync(folder);
    cpSync(join(project, "dist"), join(folder, "dist"), { recursive: true });
    const runtime = join(folder, "dist", "runtime");
    cpSync(join(runtime, "fleet-release.js"), join(runtime, "fleet-release-official.js"));
    writeFileSync(join(runtime, "fleet-release.js"), fixtureVerifier);
    for (const versionPath of [join(runtime, "build-identity.js"), join(folder, "dist/cli/help.js")]) {
      const compiled = readFileSync(versionPath, "utf8");
      assert(compiled.includes(JSON.stringify(previous)), "built version declaration must match the package");
      writeFileSync(versionPath, compiled.replaceAll(JSON.stringify(previous), JSON.stringify(version)));
    }
    writeFileSync(join(folder, "package.json"), JSON.stringify({ ...manifest, version, scripts: {}, workspaces: undefined, devDependencies: undefined }));
    const packed = JSON.parse(await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", home], privateEnv(home), folder));
    const artifact = join(home, packed[0].filename);
    artifacts.set(version, artifact);
    const bytes = readFileSync(artifact);
    tarballs.set(`/${version}.tgz`, bytes);
    releases[version] = { version, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, tarball: `${registryOrigin}/${version}.tgz` };
  }
  const payload = JSON.stringify(releases);
  writeFileSync(join(home, "releases.json"), JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString("base64") }), { mode: 0o600 });
  log(`Fixture releases: ${previous} -> ${next}; real npm tarballs, local signed publisher metadata, production SHA-512 downloader.`);
  const machines = [];
  for (const name of ["source", "canary", "failing", "queued"]) {
    const directory = join(home, name);
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, "runtime"), { mode: 0o700 });
    const prefix = join(directory, "prefix");
    const env = privateEnv(directory);
    const root = join(prefix, "lib/node_modules/@microck/canonfig");
    const entry = join(root, "dist/runtime/main.js");
    await npm(["install", "--global", "--prefix", prefix, "--install-strategy=nested", "--ignore-scripts", "--no-audit", "--no-fund", artifacts.get(previous)], env);
    machines.push({ name, home: directory, prefix, root, entry, env, state: join(directory, ".canonfig/state.sqlite") });
  }
  const [source, canary, failing, queued] = machines;
  const cli = async (machine, args, { input, code = 0, record = false } = {}) => {
    const result = await processRun(process.execPath, [machine.entry, ...args], { env: machine.env, input }).completion;
    if (record) log(`[${machine.name}] canonfig ${args.join(" ")}\nexit=${result.code}\n${result.stdout.trim()}${result.stderr ? `\n${result.stderr.trim()}` : ""}`);
    assert.equal(result.code, code, `${machine.name}: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return args.includes("--json") ? JSON.parse(result.code === 0 ? result.stdout : result.stderr).data : result.stdout.trim();
  };
  await cli(source, ["source", "init", "--json"]);
  writeFileSync(join(source.home, ".canonfig/canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "fleet-proof", name: "Fleet proof" }, harnesses: [] }));
  writeFileSync(join(source.home, ".canonfig/AGENTS.md"), "Disposable fleet proof instructions.\n");
  await cli(source, ["source", "publish", "--reviewer", "agent-proof", "--json"]);
  const startSource = async () => {
    const running = processRun(process.execPath, [source.entry, "source", "serve", "--port", "41371", "--json"], { env: source.env });
    let text = "";
    const ready = new Promise((resolveReady, reject) => {
      running.child.stdout.on("data", (chunk) => { text += chunk; try { const response = JSON.parse(text); if (response.data?.endpoint) resolveReady(response.data.endpoint); } catch {} });
      running.completion.then((result) => reject(new Error(`Source ended before readiness: ${result.stderr}${result.stdout}`)));
    });
    sourceServer = running;
    return ready;
  };
  const endpoint = await startSource();
  for (const follower of [canary, failing, queued]) {
    const invitation = join(source.home, `invite-${follower.name}`);
    await cli(source, ["source", "invite", "--endpoint", endpoint, "--output", invitation, "--json"]);
    const enrolled = await cli(follower, ["follower", "enroll", "--stdin", "--name", follower.name, "--json"], { input: readFileSync(invitation) });
    follower.id = enrolled.follower.id;
    assert.equal(existsSync(join(dirname(follower.root), ".canonfig-self-update/settings.json")), false);
    const updates = await cli(follower, ["self-update", "status", "--json"], { record: true });
    assert.equal(updates.enabled, false);
    await cli(follower, ["sync", "--apply", "--no-input", "--json"]);
  }
  await cli(canary, ["--version"], { record: true });
  sourceServer.child.kill("SIGTERM");
  await sourceServer.completion;
  await npm(["install", "--global", "--prefix", source.prefix, "--install-strategy=nested", "--ignore-scripts", "--no-audit", "--no-fund", artifacts.get(next)], source.env);
  log(`[source] npm install --global --prefix <source-prefix> --install-strategy=nested --ignore-scripts <canonfig-${next}.tgz>\nexit=0`);
  assert.equal(await cli(source, ["--version"], { record: true }), next);
  await startSource();

  // Pause a real sync only after it owns the real, fully written run lock.
  let watcher;
  const locked = new Promise((resolveLocked, reject) => {
    watcher = watch(dirname(canary.state), () => {
      try {
        const lock = JSON.parse(readFileSync(`${canary.state}.run-lock`, "utf8"));
        if (lock.pid === paused?.child.pid) { paused.child.kill("SIGSTOP"); watcher.close(); resolveLocked(); }
      } catch {}
    });
    paused = processRun(process.execPath, [canary.entry, "sync", "--apply", "--no-input", "--json"], { env: canary.env });
    paused.completion.then(() => reject(new Error("sync ended before it could be paused under its run lock")));
  });
  await locked;
  await cli(source, ["source", "update", "--canary", canary.id, "--apply", "--json"], { record: true });
  await cli(canary, ["sync", "--apply", "--no-input", "--json"], { code: 3, record: true });
  assert.equal(await cli(canary, ["--version"]), previous);
  const deferred = await cli(source, ["source", "update", "status", "--json"], { record: true });
  assert.equal(deferred.followers[0].status, "deferred");
  paused.child.kill("SIGCONT");
  assert.equal((await paused.completion).code, 0);
  paused = undefined;
  await cli(canary, ["sync", "--apply", "--no-input", "--json"], { record: true });
  assert.equal(await cli(canary, ["--version"], { record: true }), next);
  const status = await cli(canary, ["status", "--json"], { record: true });
  assert(JSON.stringify(status).includes("Converged"));
  const verified = await cli(source, ["source", "update", "status", "--json"], { record: true });
  assert.equal(verified.followers[0].status, "healthy");
  assert.equal(existsSync(join(dirname(canary.root), ".canonfig-self-update/settings.json")), false);
  assert.equal((await cli(canary, ["self-update", "status", "--json"], { record: true })).enabled, false);

  const { verifyFleetDirective } = await import(pathToFileURL(join(canary.root, "dist/enrollment/fleet-update.js")));
  const { signed } = JSON.parse(readFileSync(`${canary.state}.fleet-follower.json`, "utf8"));
  for (const [label, bad] of [["unsigned", { ...signed, signature: "" }], ["tampered", { ...signed, directive: { ...signed.directive, version: "99.0.0" } }]]) {
    assert.throws(() => verifyFleetDirective(bad, canary.id, signed.directive.source), /signature or enrollment identity is invalid/u);
    log(`[${label} directive] production verifyFleetDirective refused: Fleet Update directive signature or enrollment identity is invalid`);
  }
  // The remaining follower order is by identity, not by its display name.
  const unhealthy = machines.find((machine) => machine.id === verified.followers[1].id);
  const notAdmitted = machines.find((machine) => machine.id === verified.followers[2].id);
  writeFileSync(join(unhealthy.home, ".canonfig/AGENTS.md"), "A local edit creates real mirror drift.\n");
  await cli(unhealthy, ["sync", "--apply", "--no-input", "--json"], { code: 4, record: true });
  assert.equal(await cli(unhealthy, ["--version"], { record: true }), next);
  const halted = await cli(source, ["source", "update", "status", "--json"], { record: true });
  assert.equal(halted.status, "halted");
  assert.equal(halted.followers[1].status, "failed");
  assert.equal(halted.followers[2].status, "queued");
  await cli(notAdmitted, ["sync", "--apply", "--no-input", "--json"]);
  assert.equal(await cli(notAdmitted, ["--version"], { record: true }), previous);
  log("PASS: no follower opt-in or settings; standalone updates remain disabled; source upgrade, canary activation and Convergence, active-run deferral, signature rejection, failed health halts the rollout and leaves the remaining follower on N.");
} finally {
  paused?.child.kill("SIGCONT");
  for (const child of children) child.kill("SIGTERM");
  await Promise.all([...children].map((child) => once(child, "close")));
  registry.closeAllConnections();
  await new Promise((resolveClose) => registry.close(resolveClose));
  rmSync(home, { recursive: true, force: true });
  log("Disposable processes stopped and machine HOMEs removed.");
}
