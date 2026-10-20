import { homedir } from "node:os";
import { join } from "node:path";

import { Layer } from "effect";

import { linuxMachineStateLayer } from "../machine/linux.layer.ts";
import { macosMachineStateLayer } from "../machine/macos.layer.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { windowsMachineStateLayer } from "../machine/windows.layer.ts";
import { runtimeStateLayer } from "../runtime/state-layer.ts";
import { nativeSecretStoreLayer } from "./native-secret-store.ts";

export interface SecretRuntimeLayerOptions {
  readonly statePath?: string | undefined;
}

const machineLayer = (): Layer.Layer<MachineState> => {
  switch (process.platform) {
    case "darwin":
      return macosMachineStateLayer();
    case "win32":
      return windowsMachineStateLayer();
    default:
      return linuxMachineStateLayer();
  }
};

export const secretRuntimeLayer = (
  options: SecretRuntimeLayerOptions = {},
) => {
  const statePath = options.statePath
    ?? join(homedir(), ".canonfig", "state.sqlite");
  const state = runtimeStateLayer(statePath);
  return Layer.merge(state, nativeSecretStoreLayer(machineLayer()));
};
