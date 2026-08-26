import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

it("initializes a source from a clean packed install", () => {
  const root = mkdtempSync(resolve(tmpdir(), "canonfig-packed-diagnostic-"));
  const installRoot = resolve(root, "install");
  const home = resolve(root, "home");
  try {
    mkdirSync(installRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
    const commandOptions = {
      encoding: "utf8" as const,
      shell: process.platform === "win32",
      timeout: 180_000,
    };
    const packed = spawnSync(npmExecutable, [
      "pack",
      "--ignore-scripts=false",
      "--json",
      "--pack-destination",
      root,
    ], {
      ...commandOptions,
      cwd: projectRoot,
    });
    expect(packed.status, packed.stderr).toBe(0);
    const tarball = resolve(root, (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename);
    writeFileSync(resolve(installRoot, "package.json"), "{\"private\":true}\n");
    const installed = spawnSync(npmExecutable, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ], {
      ...commandOptions,
      cwd: installRoot,
    });
    expect(installed.status, installed.stderr).toBe(0);

    const dependencyTree = spawnSync(npmExecutable, [
      "ls",
      "selfsigned",
      "@peculiar/x509",
      "@peculiar/asn1-cms",
      "@peculiar/asn1-csr",
      "@peculiar/asn1-schema",
      "@peculiar/asn1-x509",
      "--all",
      "--json",
    ], {
      ...commandOptions,
      cwd: installRoot,
    });
    const entry = resolve(
      installRoot,
      "node_modules",
      "@microck",
      "canonfig",
      "dist",
      "runtime",
      "main.js",
    );
    const initialized = spawnSync(process.execPath, [entry, "source", "init", "--json"], {
      cwd: installRoot,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: resolve(home, "AppData", "Roaming"),
        LOCALAPPDATA: resolve(home, "AppData", "Local"),
        CANONFIG_LOCAL_CREDENTIAL_ROOT: resolve(home, ".canonfig-credentials"),
      },
    });
    const diagnostic = JSON.stringify({
      status: initialized.status,
      signal: initialized.signal,
      error: initialized.error?.message,
      stdout: initialized.stdout,
      stderr: initialized.stderr,
      dependencies: dependencyTree.stdout,
      dependencyErrors: dependencyTree.stderr,
      consumerLock: readFileSync(resolve(installRoot, "package-lock.json"), "utf8"),
    }, undefined, 2);
    expect(initialized.status, diagnostic).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
