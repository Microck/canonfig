import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decodeWindowsTaskXml,
  windowsMachineStateLayer,
  windowsAccountPrincipal,
  windowsPrivateAclArguments,
  windowsRecurrenceIntervalMatches,
  windowsTaskQueryReportsAbsence,
  windowsTaskProbeReportsAbsence,
  windowsTaskTriggerEnabled,
  windowsWeekdaysMatch,
} from "../src/machine/windows.layer.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

// Windows adapter paths must stay Windows-shaped while still addressing real
// host storage. Each contract test supplies its own temporary root; keep a
// stable per-root Windows drive mapping so repeated calls for one root agree,
// which is what the adapter's path normalization and the contract's expected
// values both require.
const windowsRoots = new Map<string, string>();

const windowsRoot = (root: string): string => {
  for (const mapped of windowsRoots.values()) {
    const remainder = win32.relative(mapped, root);
    if (
      remainder === ""
      || (!remainder.startsWith(`..${win32.sep}`)
        && remainder !== ".."
        && !win32.isAbsolute(remainder))
    ) {
      return root;
    }
  }
  const existing = windowsRoots.get(root);
  if (existing !== undefined) return existing;
  const created = win32.join(
    mkdtempSync(join(root, "canonfig-windows-drive-")).replaceAll("/", "\\"),
    "root",
  );
  windowsRoots.set(root, created);
  return created;
};

const environment = (root: string) => {
  const nativeRoot = windowsRoot(root);
  return [
    { name: "USERPROFILE", value: win32.join(nativeRoot, "home") },
    { name: "APPDATA", value: win32.join(nativeRoot, "config") },
    { name: "LOCALAPPDATA", value: win32.join(nativeRoot, "data") },
    { name: "PATH", value: dirname(process.execPath) },
    { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
    { name: "SystemRoot", value: process.env.SystemRoot ?? "C:\\Windows" },
  ];
};

describe("Windows ACL command rendering", () => {
  it("renders shell-free current-user-only ACL arguments", () => {
    expect(windowsPrivateAclArguments(
      "C:\\Users\\operator\\secret & echo exposed",
      "DOMAIN\\operator",
      false,
    )).toEqual([
      "C:\\Users\\operator\\secret & echo exposed",
      "/inheritance:r",
      "/grant:r",
      "DOMAIN\\operator:(F)",
      "/remove:g",
      "*S-1-1-0",
      "*S-1-5-11",
      "*S-1-5-32-545",
    ]);
    expect(windowsPrivateAclArguments(
      "C:\\Users\\operator\\.canonfig",
      "DOMAIN\\operator",
      true,
    )).toEqual([
      "C:\\Users\\operator\\.canonfig",
      "/inheritance:r",
      "/grant:r",
      "DOMAIN\\operator:(OI)(CI)(F)",
      "/remove:g",
      "*S-1-1-0",
      "*S-1-5-11",
      "*S-1-5-32-545",
    ]);
  });

  it("uses the computer account namespace for local OpenSSH users", () => {
    expect(windowsAccountPrincipal([
      { name: "USERNAME", value: "crabbox" },
      { name: "USERDOMAIN", value: "WORKGROUP" },
      { name: "COMPUTERNAME", value: "CANONFIG-ARM64" },
    ], "C:\\Users\\crabbox")).toBe("CANONFIG-ARM64\\crabbox");

    expect(windowsAccountPrincipal([
      { name: "USERNAME", value: "operator" },
      { name: "USERDOMAIN", value: "MICR" },
      { name: "USERDNSDOMAIN", value: "micr.example" },
      { name: "COMPUTERNAME", value: "WORKSTATION" },
    ], "C:\\Users\\operator")).toBe("MICR\\operator");
  });
});

describe("Windows Task Scheduler inspection", () => {
  it("decodes UTF-16LE task exports with a byte-order mark", () => {
    const xml = "<?xml version=\"1.0\"?><Task><Enabled>true</Enabled></Task>";
    const encoded = Buffer.from(`\ufeff${xml}`, "utf16le");
    expect(decodeWindowsTaskXml(encoded)).toBe(xml);
    expect(decodeWindowsTaskXml(Buffer.from(xml, "utf8"))).toBe(xml);
  });

  it("requires the installed weekly trigger to have the exact day set", () => {
    const exact = "<DaysOfWeek><Friday /><Monday /></DaysOfWeek>";
    const extra = "<DaysOfWeek><Monday /><Friday /><Sunday /></DaysOfWeek>";
    expect(windowsWeekdaysMatch(exact, ["Mon", "Fri"])).toBe(true);
    expect(windowsWeekdaysMatch(extra, ["Mon", "Fri"])).toBe(false);
  });

  it("requires daily and weekly recurrence intervals of one", () => {
    expect(windowsRecurrenceIntervalMatches("<DaysInterval>1</DaysInterval>", "daily")).toBe(true);
    expect(windowsRecurrenceIntervalMatches("<DaysInterval>2</DaysInterval>", "daily")).toBe(false);
    expect(windowsRecurrenceIntervalMatches("<WeeksInterval>1</WeeksInterval>", "weekly")).toBe(true);
    expect(windowsRecurrenceIntervalMatches("<WeeksInterval>2</WeeksInterval>", "weekly")).toBe(false);
  });

  it("requires the calendar trigger itself to be enabled", () => {
    expect(windowsTaskTriggerEnabled("<Enabled>true</Enabled>")).toBe(true);
    expect(windowsTaskTriggerEnabled("<Enabled>false</Enabled>")).toBe(false);
    expect(windowsTaskTriggerEnabled("<StartBoundary>2000-01-01T00:00:00</StartBoundary>"))
      .toBe(true);
  });

  it("distinguishes a missing task from scheduler query failures", () => {
    const query = (exitCode: number, standardError: string) => ({
      exitCode,
      standardOutput: new Uint8Array(),
      standardError: Buffer.from(standardError),
    });
    expect(windowsTaskQueryReportsAbsence(
      query(1, "ERROR: 0x80070002"),
    )).toBe(true);
    expect(windowsTaskQueryReportsAbsence(
      query(1, "FEHLER: Das System kann die angegebene Datei nicht finden."),
    )).toBe(false);
    expect(windowsTaskQueryReportsAbsence(
      query(1, "ERROR: Access is denied."),
    )).toBe(false);
    expect(windowsTaskQueryReportsAbsence(query(0, ""))).toBe(false);
    expect(windowsTaskProbeReportsAbsence(query(3, ""))).toBe(true);
    expect(windowsTaskProbeReportsAbsence(query(2, ""))).toBe(false);
  });
});

machineStateContract("Windows", {
  platform: "windows",
  executable: process.execPath,
  nativeOperations: process.platform === "win32",
  pathJoin: (first, ...parts) => win32.join(windowsRoot(first), ...parts),
  expectedUserDirectories: (root) => {
    const nativeRoot = windowsRoot(root);
    return {
      home: win32.join(nativeRoot, "home"),
      config: win32.join(nativeRoot, "config"),
      data: win32.join(nativeRoot, "data"),
      cache: win32.join(nativeRoot, "data"),
    };
  },
  localFileLayer: (root) => {
    const nativeRoot = windowsRoot(root);
    return windowsMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: win32.join(nativeRoot, "credentials"),
      },
      environment: environment(root),
    });
  },
  secureStoreLayer: (root) =>
    windowsMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      credentialStoreAccess: "unavailable",
      environment: environment(root),
    }),
  schedulerAssertions: (rendered) => {
    expect(rendered.service).toContain("New-ScheduledTaskAction");
    expect(rendered.service).toContain("\"a value\"");
    expect(rendered.schedule).toContain("New-ScheduledTaskTrigger -Daily -At '00:00'");
    expect(rendered.schedule).toContain("Register-ScheduledTask");
  },
});
