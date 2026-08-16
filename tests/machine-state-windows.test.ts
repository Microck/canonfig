import { win32 } from "node:path";

import { expect } from "vitest";

import { windowsMachineStateLayer } from "../src/machine/windows.layer.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

const windowsRoot = (root: string): string =>
  win32.join("C:\\canonfig-tests", root.replaceAll("/", "-"));

const environment = (root: string) => {
  const nativeRoot = windowsRoot(root);
  return [
    { name: "USERPROFILE", value: win32.join(nativeRoot, "home") },
    { name: "APPDATA", value: win32.join(nativeRoot, "config") },
    { name: "LOCALAPPDATA", value: win32.join(nativeRoot, "data") },
    { name: "PATH", value: "C:\\Program Files\\nodejs" },
    { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
    { name: "SystemRoot", value: "C:\\Windows" },
  ];
};

machineStateContract("Windows", {
  platform: "windows",
  executable: "C:\\Program Files\\nodejs\\node.exe",
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
