import { homedir } from "node:os";
import { join } from "node:path";

import { Layer } from "effect";

import { linuxMachineStateLayer } from "../machine/linux.layer.ts";
import { macosMachineStateLayer } from "../machine/macos.layer.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { windowsMachineStateLayer } from "../machine/windows.layer.ts";
import { runtimeCredentialPolicy } from "../runtime/credential-policy.ts";
import { runtimeStateLayer } from "../runtime/state-layer.ts";
import { nativeSecretStoreLayer } from "./native-secret-store.ts";

export interface SecretRuntimeLayerOptions {
  readonly statePath?: string | undefined;
}

const machineLayer = (statePath: string): Layer.Layer<MachineState> => {
  const credentialPolicy = runtimeCredentialPolicy(statePath);
  switch (process.platform) {
    case "darwin":
      return macosMachineStateLayer({ credentialPolicy });
    case "win32":
      return windowsMachineStateLayer({ credentialPolicy });
    default:
      return linuxMachineStateLayer({ credentialPolicy });
  }
};

export const secretRuntimeLayer = (
  options: SecretRuntimeLayerOptions = {},
) => {
  const statePath = options.statePath
    ?? join(homedir(), ".canonfig", "state.sqlite");
  const state = runtimeStateLayer(statePath);
  return Layer.merge(state, nativeSecretStoreLayer(machineLayer(statePath)));
};
