import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { win32 } from "node:path";

import { expect } from "vitest";

import { windowsMachineStateLayer } from "../src/machine/windows.layer.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

// Windows adapter paths must stay Windows-shaped while still addressing real
// host storage. Each contract test supplies its own temporary root; keep a
// stable per-root Windows drive mapping so repeated calls for one root agree,
// which is what the adapter's path normalization and the contract's expected
// values both require.
const windowsRoots = new Map<string, string>();

const windowsRoot = (root: string): string => {
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
