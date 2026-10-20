import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "linux")("reports explicit local-file bootstrap accurately without allowing shared-secret storage", () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-bootstrap-policy-"));
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"),
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), DBUS_SESSION_BUS_ADDRESS: "" };
  const command = ["--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts")];
  try {
    const result = spawnSync(process.execPath, [...command, "secrets", "bootstrap", "--json"], { env, encoding: "utf8", timeout: 20000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: "canonfig.cli/v1", command: "secrets.bootstrap", exitCode: 0,
      data: { provider: "local-file", selectedPolicy: "local-file", backupEncryption: "unencrypted" } });
    const refused = spawnSync(process.execPath, [...command, "secrets", "set", "fixture-name", "--json"], { env, encoding: "utf8", input: "synthetic-fixture-value", timeout: 20000 });
    expect(refused.status, refused.stdout + refused.stderr).toBe(3);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).not.toContain("synthetic-fixture-value");
    expect(JSON.parse(refused.stderr).message).toContain("local-file");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 45000);
