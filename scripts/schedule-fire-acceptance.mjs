import { createServer } from "node:net";
import { once } from "node:events";
// Real-fire acceptance for the native scheduler: installs the follower job,
// triggers one fire through the scheduler's own run-now mechanism, and waits
// for the fire marker the scheduled invocation writes. Exit 0 only when the
// evidence landed.
//
// The scheduled apply itself is expected to fail fast on this scratch machine
// (its fixture Source is deliberately stopped after enrollment); the marker records that outcome, and
// the recorded failure still proves the scheduler fired the job with the
// minimal environment the unit pins.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const main = join(repoRoot, "dist", "runtime", "main.js");
const stateDir = join(homedir(), ".canonfig");
const markerPath = join(stateDir, "schedule-fires.json");
const jobName = "canonfig-sync";
const platform = process.platform;

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
    const profile = join(sourceHome, "profile.json");
    writeFileSync(profile, JSON.stringify({ id: "scheduler-fire-fixture", version: 2,
      name: "Scheduler fire fixture", groups: [], resources: [] }));
    requireSuccess(run(process.execPath, [main, "source", "publish", "--profile-file", profile,
      "--reviewer", "scheduler-fire-fixture", "--allow-empty", "--json"], { env: sourceEnvironment }), "fixture profile publication");
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
        try { resolve(JSON.parse(output.slice(0, newline)).data.endpoint); } catch (error) { reject(error); }
      });
    });
    const invitation = join(sourceHome, "invitation.txt");
    requireSuccess(run(process.execPath, [main, "source", "invite", "--endpoint", endpoint,
      "--expires", "5m", "--output", invitation, "--json"], { env: sourceEnvironment }), "fixture invitation");
    requireSuccess(run(process.execPath, [main, "follower", "enroll", "--stdin", "--name", "scheduler-fire-fixture",
      "--profile", "scheduler-fire-fixture", "--json"], {
      input: readFileSync(invitation, "utf8"),
      env: { ...process.env, CANONFIG_LOCAL_CREDENTIAL_ROOT: join(stateDir, "fire-fixture-credentials"), NODE_NO_WARNINGS: "1" },
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

// Remove stale evidence so this run's marker is the one being asserted.
rmSync(markerPath, { force: true });

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
// scratch machine (fixture Source stopped), and the fire marker below is the evidence.
if (trigger.status !== 0) {
  console.error(`scheduler trigger exited ${trigger.status}: ${String(trigger.stderr).trim().slice(0, 300)}`);
}

const fired = await waitUntil(() => existsSync(markerPath));
if (!fired) {
  console.error("the native scheduler never wrote the fire marker");
  process.exit(1);
}

const marker = JSON.parse(readFileSync(markerPath, "utf8"));
const fires = Array.isArray(marker.fires) ? marker.fires : [];
const started = fires.find((fire) => fire.outcome === "started");
if (started === undefined) {
  console.error(`fire marker has no started entry: ${markerPath}`);
  process.exit(1);
}
if (started.generation !== installed.generation || !(Date.parse(started.startedAt) > Date.parse(installed.installedAt))) {
  throw new Error("fire evidence does not belong to this native installation");
}
console.log(`scheduler fire recorded at ${started.at}; evidence: ${markerPath}`);
console.log("SCHEDULER_FIRE_OK");
