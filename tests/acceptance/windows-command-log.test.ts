import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCommandLog } from "../../src/logging/command-log.ts";

it.runIf(process.platform === "win32")("uses bundled Windows modules and retains a private command log", () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-windows-log-"));
  try {
    const modules = join(root, "modules");
    const shadow = join(modules, "Microsoft.PowerShell.Security");
    mkdirSync(shadow, { recursive: true });
    writeFileSync(join(shadow, "Microsoft.PowerShell.Security.psm1"), "throw 'Foreign security module must not be loaded'");
    const path = join(root, "command.log");
    const log = createCommandLog(["secrets", "list"], {
      environment: { ...process.env, CANONFIG_LOG: "on", CANONFIG_LOG_FILE: path, PSModulePath: modules },
    });
    log.complete(0);
    const entries = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.event)).toEqual(["command.started", "command.completed"]);
    expect(entries.every((entry) => entry.command === "secrets.list")).toBe(true);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$env:PSModulePath = "$PSHOME\\Modules"',
      "$acl = Get-Acl -LiteralPath $env:CANONFIG_LOG_ACL_PATH",
      "$rules = @($acl.Access)",
      "if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IsInherited) { throw 'Unprotected log ACL' }",
      "$actual = $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
      "$expected = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "if ($actual -ne $expected) { throw 'Unexpected log reader' }",
    ].join("; ");
    const inspected = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 15000, env: { ...process.env, CANONFIG_LOG_ACL_PATH: path },
    });
    expect(inspected.status, inspected.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
