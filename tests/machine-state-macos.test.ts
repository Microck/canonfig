import { dirname, join } from "node:path";

import { expect } from "vitest";

import { macosMachineStateLayer } from "../src/machine/macos.layer.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

const executableDirectory = dirname(process.execPath);

const environment = (root: string) => [
  { name: "HOME", value: join(root, "home") },
  { name: "XDG_CONFIG_HOME", value: join(root, "config") },
  { name: "XDG_DATA_HOME", value: join(root, "data") },
  { name: "XDG_CACHE_HOME", value: join(root, "cache") },
  { name: "PATH", value: executableDirectory },
];

machineStateContract("macOS", {
  platform: "macos",
  executable: process.execPath,
  nativeOperations: process.platform === "darwin",
  localFileLayer: (root) =>
    macosMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      environment: environment(root),
    }),
  secureStoreLayer: (root) =>
    macosMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      credentialStoreAccess: "unavailable",
      environment: environment(root),
    }),
  schedulerAssertions: (rendered) => {
    expect(rendered.service).toContain("<key>ProgramArguments</key>");
    expect(rendered.service).toContain("<string>a value</string>");
    expect(rendered.schedule).toContain("<key>StartCalendarInterval</key>");
    expect(rendered.schedule).toContain("<key>Hour</key><integer>0</integer>");
  },
});
