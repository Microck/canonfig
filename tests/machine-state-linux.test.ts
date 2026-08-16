import { dirname, join } from "node:path";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

const environment = (root: string) => [
  { name: "HOME", value: join(root, "home") },
  { name: "XDG_CONFIG_HOME", value: join(root, "config") },
  { name: "XDG_DATA_HOME", value: join(root, "data") },
  { name: "XDG_CACHE_HOME", value: join(root, "cache") },
  { name: "PATH", value: dirnameOfExecutable },
];

const dirnameOfExecutable = dirname(process.execPath);

machineStateContract("Linux", {
  platform: "linux",
  executable: process.execPath,
  localFileLayer: (root) =>
    linuxMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      environment: environment(root),
    }),
  secureStoreLayer: (root) =>
    linuxMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      environment: environment(root),
    }),
});
