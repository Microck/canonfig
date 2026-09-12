// Real-fire acceptance for the native scheduler: installs the follower job,
// triggers one fire through the scheduler's own run-now mechanism, and waits
// for the fire marker the scheduled invocation writes. Exit 0 only when the
// evidence landed.
//
// The scheduled apply itself is expected to fail fast on this scratch machine
// (it is not enrolled against a source); the marker records that outcome, and
// the recorded failure still proves the scheduler fired the job with the
// minimal environment the unit pins.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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

const deadline = Date.now() + 120_000;
const waitUntil = async (predicate) => {
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

// Remove stale evidence so this run's marker is the one being asserted.
rmSync(markerPath, { force: true });

const setSchedule = run(process.execPath, [main, "schedule", "set", "daily@00:00"]);
if (setSchedule.status !== 0) {
  console.error(`schedule set failed: ${setSchedule.stderr}`);
  process.exit(1);
}

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
// scratch machine (not enrolled), and the fire marker below is the evidence.
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
console.log(`scheduler fire recorded at ${started.at}; evidence: ${markerPath}`);
console.log("SCHEDULER_FIRE_OK");
