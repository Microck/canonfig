import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const registry = "https://registry.npmjs.org";
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

// Ignore inherited npm settings, including scoped registries, credentials and global config.
// Use an empty working directory too: --registry alone does not override .npmrc scopes.
export const publicNpmContext = (root, inherited = process.env) => {
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
  const home = join(root, "home"); mkdirSync(home, { recursive: true });
  const userConfig = join(root, "user.npmrc"), globalConfig = join(root, "global.npmrc");
  writeFileSync(userConfig, ""); writeFileSync(globalConfig, "");
  const environment = Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    !/^npm_config_/iu.test(name) && !/^(?:NODE_AUTH_TOKEN|NPM_TOKEN)$/iu.test(name)));
  Object.assign(environment, { HOME: home, USERPROFILE: home,
    npm_config_cache: join(root, "cache"), npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig, CANONFIG_LOG: "off",
    XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_STATE_HOME: join(root, "xdg-state") });
  return { cwd: root, env: environment, encoding: "utf8" };
};

const publicRegistryArguments = [`--registry=${registry}`, `--@microck:registry=${registry}`];
const queryPublishedVersion = (version, context, run = spawnSync) => {
  const result = run("npm", ["view", `@microck/canonfig@${version}`, "version", "--json", "--prefer-online", ...publicRegistryArguments], {
    ...context, timeout: 30000,
  });
  if (result.status !== 0) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
};

/** npm may accept publication before its read endpoints expose the package. */
export const waitForPublishedVersion = async (version, {
  query,
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
  if (query === undefined) {
    const root = mkdtempSync(join(tmpdir(), "canonfig-registry-"));
    try {
      const context = publicNpmContext(root);
      return await waitForPublishedVersion(version, {
        query: () => queryPublishedVersion(version, context), sleep, now,
        timeoutMilliseconds, intervalMilliseconds,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
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

export const verifyPublishedRelease = async (version, { run = spawnSync } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-published-"));
  try {
    const context = publicNpmContext(root);
    await waitForPublishedVersion(version, { query: () => queryPublishedVersion(version, context, run) });
    const installed = run("npm", ["install", "--prefix", root, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", ...publicRegistryArguments, `@microck/canonfig@${version}`], {
      ...context, timeout: 120000,
    });
    if (installed.status !== 0) throw new Error("Fresh public-package installation failed; retry verification only, not publication");
    const entry = join(root, "node_modules", "@microck", "canonfig", "dist", "runtime", "main.js");
    const actual = run(process.execPath, [entry, "--version"], { ...context, timeout: 30000 });
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
