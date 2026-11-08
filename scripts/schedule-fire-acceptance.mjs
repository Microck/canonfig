import { createServer } from "node:net";
import { once } from "node:events";
// Real-fire acceptance for the native scheduler: installs the follower job,
// triggers one fire through the scheduler's own run-now mechanism, and waits
// for the invocation receipt the scheduled command writes. Exit 0 only when the
// evidence landed.
//
// The scheduled apply itself is expected to fail fast on this scratch machine
// (its fixture Source is deliberately stopped after enrollment); the receipt records that outcome, and
// the recorded failure still proves the scheduler fired the job with the
// minimal environment the unit pins.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();
const main = join(repoRoot, "dist", "runtime", "main.js");
const stateDir = join(homedir(), ".canonfig");
const statePath = join(stateDir, "state.sqlite");
const jobName = "canonfig-sync";
const platform = process.platform;
const followerCredentials = mkdtempSync(join(tmpdir(), "canonfig-fire-credentials-"));
process.once("exit", () => rmSync(followerCredentials, { recursive: true, force: true }));

const run = (command, arguments_, options = {}) => {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    timeout: 60_000,
    ...options,
  });
  return result;
};

const waitUntil = async (predicate) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
};

if (!existsSync(main)) {
  console.error(`missing built CLI: ${main}`);
  process.exit(1);
}

// Establish an actual finalized follower through the production invitation flow.
// The fixture Source is then stopped so the scheduled apply fails fast; the
// native-fire assertion intentionally verifies startup, not successful sync.
const prepareFollower = async () => {
  const sourceHome = mkdtempSync(join(tmpdir(), "canonfig-fire-source-"));
  const sourceEnvironment = { ...process.env, HOME: sourceHome, USERPROFILE: sourceHome,
    APPDATA: join(sourceHome, "AppData", "Roaming"), LOCALAPPDATA: join(sourceHome, "AppData", "Local"),
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(sourceHome, "credentials"), NODE_NO_WARNINGS: "1" };
  let child;
  const requireSuccess = (result, label) => {
    if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr}`);
    return result;
  };
  try {
    requireSuccess(run(process.execPath, [main, "source", "init", "--json"], { env: sourceEnvironment }), "fixture Source initialization");
    // The smallest publishable Canonical Folder: a profile, no harnesses, one instructions file.
    const folder = join(sourceHome, ".canonfig");
    writeFileSync(join(folder, "canonfig.jsonc"), JSON.stringify({ version: 1,
      profile: { id: "scheduler-fire-fixture", name: "Scheduler fire fixture" }, harnesses: [] }));
    writeFileSync(join(folder, "AGENTS.md"), "Scheduler fire fixture.\n");
    requireSuccess(run(process.execPath, [main, "source", "publish",
      "--reviewer", "scheduler-fire-fixture", "--json"], { env: sourceEnvironment }), "fixture profile publication");
    const listener = createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("fixture port unavailable");
    const port = address.port;
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    child = spawn(process.execPath, [main, "source", "serve", "--host", "127.0.0.1", "--port", String(port), "--json"],
      { env: sourceEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = await new Promise((resolve, reject) => {
      let output = "", errors = "";
      const timer = setTimeout(() => reject(new Error(`fixture Source startup timed out: ${errors}`)), 60_000);
      child.stderr.on("data", (data) => { errors = (errors + data.toString()).slice(-4096); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`fixture Source exited ${code}: ${errors}`)); });
      child.stdout.on("data", (data) => {
        output += data.toString();
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        child.stdout.removeAllListeners("data");
        child.stdout.resume();
        try { resolve(JSON.parse(output.slice(0, newline)).data.endpoint); }
        catch (error) { reject(new Error(`fixture Source startup output invalid: ${error instanceof Error ? error.message : String(error)}; ${errors}`)); }
      });
    });
    const invitation = join(sourceHome, "invitation.txt");
    requireSuccess(run(process.execPath, [main, "source", "invite", "--endpoint", endpoint,
      "--expires", "5m", "--output", invitation, "--json"], { env: sourceEnvironment }), "fixture invitation");
    requireSuccess(run(process.execPath, [main, "follower", "enroll", "--stdin", "--name", "scheduler-fire-fixture",
      "--json"], {
      input: readFileSync(invitation, "utf8"),
      env: { ...process.env, CANONFIG_LOCAL_CREDENTIAL_ROOT: followerCredentials, NODE_NO_WARNINGS: "1" },
    }), "fixture follower enrollment");
  } finally {
    if (child !== undefined && child.pid !== undefined && child.exitCode === null) {
      const stopped = once(child, "exit"); child.kill(); await stopped;
    }
    rmSync(sourceHome, { recursive: true, force: true });
  }
};
await prepareFollower();
if (process.argv.includes("--prepare-only")) {
  console.log("SCHEDULER_ENROLLMENT_OK");
  process.exit(0);
}

const setSchedule = run(process.execPath, [main, "schedule", "set", "daily@00:00", "--json"]);
if (setSchedule.status !== 0) {
  console.error(`schedule set failed: ${setSchedule.stderr}`);
  process.exit(1);
}

const installed = JSON.parse(setSchedule.stdout).data.status;
if (!installed?.generation || !installed.installedAt) throw new Error("native installation identity is unavailable");

const uid = process.getuid?.() ?? 0;
let trigger;
if (platform === "linux") {
  // User timers need a user session; linger keeps it available on runners.
  run("sudo", ["loginctl", "enable-linger", process.env.USER ?? "runner"]);
  trigger = run("systemctl", ["--user", "start", `${jobName}.service`]);
} else if (platform === "darwin") {
  trigger = run("/bin/launchctl", ["kickstart", `-k`, `gui/${uid}/dev.canonfig.${jobName}`]);
} else {
  // canonfig registers under the Canonfig task folder: name is folder-qualified.
  trigger = run("schtasks", ["/run", "/tn", `Canonfig\\${jobName}`]);
}
// A nonzero trigger exit does not mean the scheduler failed to start the
// job: the scheduled invocation itself is expected to fail fast on this
// scratch machine (fixture Source stopped), and the receipt below is the evidence.
if (trigger.status !== 0) {
  console.error(`scheduler trigger exited ${trigger.status}: ${String(trigger.stderr).trim().slice(0, 300)}`);
}

const readInvocation = () => {
  // The scheduled command writes this database while the poll reads it; wait out its write lock instead of failing.
  const database = new DatabaseSync(statePath, { readOnly: true, timeout: 10_000 });
  try {
    return database.prepare("SELECT invocation_json FROM scheduled_invocations WHERE started_at > ? ORDER BY started_at DESC")
      .all(installed.installedAt)
      .map((row) => JSON.parse(row.invocation_json))
      .find((invocation) => invocation.generation === installed.generation);
  } finally { database.close(); }
};
const fired = await waitUntil(() => readInvocation() !== undefined);
if (!fired) {
  console.error("the native scheduler never recorded an invocation");
  process.exit(1);
}
const started = readInvocation();
if (started === undefined) throw new Error("the invocation receipt disappeared");
console.log(`scheduler fire recorded at ${started.startedAt}; evidence: ${statePath}, invocation ${started.id}`);
console.log("SCHEDULER_FIRE_OK");
