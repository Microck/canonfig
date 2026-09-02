import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";

import { linuxMachineStateLayer } from "../machine/linux.layer.ts";
import { macosMachineStateLayer } from "../machine/macos.layer.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { windowsMachineStateLayer } from "../machine/windows.layer.ts";
import { stateRepositoryLayer } from "../state/state-repository.layer.ts";

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
  const state = Layer.unwrap(
    Effect.promise(() =>
      mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
    ).pipe(
      Effect.as(stateRepositoryLayer(statePath)),
    ),
  );
  return Layer.merge(state, machineLayer());
};
