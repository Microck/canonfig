import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const registry = "https://registry.npmjs.org";
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

/** npm may accept publication before its read endpoints expose the package. */
export const waitForPublishedVersion = async (version, {
  query = () => {
    const result = spawnSync("npm", ["view", `@microck/canonfig@${version}`, "version", "--json", "--prefer-online", `--registry=${registry}`], {
      encoding: "utf8", timeout: 30000,
    });
    if (result.status !== 0) return undefined;
    try { return JSON.parse(result.stdout); } catch { return undefined; }
  },
  sleep = delay,
  now = Date.now,
  timeoutMilliseconds = 10 * 60 * 1000,
  intervalMilliseconds = 10000,
} = {}) => {
  if (!versionPattern.test(version ?? "")) throw new Error("An exact stable package version is required");
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0
    || !Number.isFinite(intervalMilliseconds) || intervalMilliseconds <= 0) {
    throw new Error("Verification timing must be positive and finite");
  }
  const deadline = now() + timeoutMilliseconds;
  for (;;) {
    if (await query() === version) return;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`@microck/canonfig@${version} is not visible yet. Publication may already have been accepted. Do not republish; retry verification only.`);
    }
    await sleep(Math.min(intervalMilliseconds, remaining));
  }
};

export const verifyPublishedRelease = async (version) => {
  await waitForPublishedVersion(version);
  const root = mkdtempSync(join(tmpdir(), "canonfig-published-"));
  try {
    const home = join(root, "home"); mkdirSync(home);
    const userConfig = join(root, "npmrc"); writeFileSync(userConfig, "");
    const environment = { ...process.env, HOME: home, USERPROFILE: home,
      npm_config_cache: join(root, "cache"), npm_config_userconfig: userConfig,
      CANONFIG_LOG: "off", XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_STATE_HOME: join(root, "xdg-state") };
    delete environment.NODE_AUTH_TOKEN; delete environment.NPM_TOKEN;
    const installed = spawnSync("npm", ["install", "--prefix", root, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`, `@microck/canonfig@${version}`], {
      encoding: "utf8", timeout: 120000, env: environment,
    });
    if (installed.status !== 0) throw new Error("Fresh public-package installation failed; retry verification only, not publication");
    const entry = join(root, "node_modules", "@microck", "canonfig", "dist", "runtime", "main.js");
    const actual = spawnSync(process.execPath, [entry, "--version"], { encoding: "utf8", timeout: 30000, env: environment });
    if (actual.status !== 0 || actual.stdout.trim() !== version || actual.stderr !== "") {
      throw new Error("Installed package did not report the expected version; do not republish this version");
    }
    process.stdout.write(`Verified fresh public install of @microck/canonfig@${version}.\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node tools/release/verify-published.mjs <version>");
    await verifyPublishedRelease(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release verification failed"}\n`);
    process.exitCode = 1;
  }
}
