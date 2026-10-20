import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { publicNpmContext, verifyPublishedRelease, waitForPublishedVersion } from "../../tools/release/verify-published.mjs";

it("waits through registry processing instead of republishing", async () => {
  let time = 0, calls = 0;
  await waitForPublishedVersion("4.0.1", {
    query: async () => ++calls < 4 ? undefined : "4.0.1",
    sleep: async (milliseconds: number) => { time += milliseconds; },
    now: () => time, timeoutMilliseconds: 60000, intervalMilliseconds: 10000,
  });
  expect(calls).toBe(4); expect(time).toBe(30000);
});

it("times out with verification-only recovery guidance", async () => {
  let time = 0;
  await expect(waitForPublishedVersion("4.0.1", {
    query: async () => "4.0.0",
    sleep: async (milliseconds: number) => { time += milliseconds; },
    now: () => time, timeoutMilliseconds: 25000, intervalMilliseconds: 10000,
  })).rejects.toThrow("Do not republish; retry verification only");
  expect(time).toBe(25000);
});

it.each(["", "latest", "4.0.1;echo wrong", "4.0.1-beta", "01.0.0"])("rejects non-release input %s before querying npm", async (version) => {
  let called = false;
  await expect(waitForPublishedVersion(version, { query: () => { called = true; } })).rejects.toThrow("exact stable");
  expect(called).toBe(false);
});

it("keeps publication out of the independently rerunnable verification job", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");
  const verification = source.split("\n  verify:\n")[1]!;
  expect(verification).toContain("needs: publish");
  expect(verification).toContain("contents: read");
  expect(verification).toContain("verify-published.mjs");
  expect(verification).not.toContain("npm publish");
  expect(verification).not.toContain("gh release create");
  expect(verification).not.toContain("id-token: write");
});

it("isolates inherited scoped registries and global configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-public-registry-test-"));
  try {
    const poison = join(root, "inherited.npmrc");
    writeFileSync(poison, "@microck:registry=https://not-the-public-registry.invalid\n");
    const context = publicNpmContext(root, {
      ...process.env, NPM_CONFIG_GLOBALCONFIG: poison, npm_config_userconfig: poison,
      "NPM_CONFIG_@MICROCK:REGISTRY": "https://also-not-public.invalid",
      npm_config_registry: "https://not-public.invalid", NPM_TOKEN: "not-a-real-token",
      NODE_AUTH_TOKEN: "not-a-real-token", npm_config_global: "true",
    });
    expect(context.env.NPM_CONFIG_GLOBALCONFIG).toBeUndefined();
    expect(context.env["NPM_CONFIG_@MICROCK:REGISTRY"]).toBeUndefined();
    expect(context.env.npm_config_registry).toBeUndefined();
    expect(context.env.NPM_TOKEN).toBeUndefined();
    expect(context.env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(readFileSync(context.env.npm_config_globalconfig, "utf8")).toBe("");
    expect(readFileSync(context.env.npm_config_userconfig, "utf8")).toBe("");
    const actual = spawnSync("npm", ["config", "get", "@microck:registry"], { ...context, encoding: "utf8" });
    expect(actual.status, actual.stderr).toBe(0);
    expect(actual.stdout.trim()).toBe("undefined");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("uses the same isolated public-registry context for polling and installation", async () => {
  const calls: Array<{ args: string[]; options: ReturnType<typeof publicNpmContext> & { timeout: number } }> = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await verifyPublishedRelease("4.0.1", { run: (_command: string, args: string[], options: ReturnType<typeof publicNpmContext> & { timeout: number }) => {
      calls.push({ args, options });
      return { status: 0, stdout: args[0] === "view" ? '"4.0.1"' : args.includes("--version") ? "4.0.1\n" : "", stderr: "" };
    } });
    expect(calls).toHaveLength(3);
    for (const call of calls.slice(0, 2)) {
      expect(call.args).toContain("--registry=https://registry.npmjs.org");
      expect(call.args).toContain("--@microck:registry=https://registry.npmjs.org");
      expect(call.options.cwd).toBe(calls[0]!.options.cwd);
      expect(call.options.env).toBe(calls[0]!.options.env);
      expect(call.options.env.npm_config_globalconfig).toBeTruthy();
      expect(call.options.env.npm_config_userconfig).toBeTruthy();
    }
  } finally { stdout.mockRestore(); }
});
