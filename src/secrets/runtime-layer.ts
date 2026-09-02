import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";

import { linuxMachineStateLayer } from "../machine/linux.layer.ts";
import { macosMachineStateLayer } from "../machine/macos.layer.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { CredentialPolicy } from "../machine/machine-state.types.ts";
import { windowsMachineStateLayer } from "../machine/windows.layer.ts";
import { stateRepositoryLayer } from "../state/state-repository.layer.ts";

export interface SecretRuntimeLayerOptions {
  readonly statePath?: string | undefined;
}

const credentialPolicyFromEnvironment = (): CredentialPolicy | undefined => {
  const root = process.env.CANONFIG_LOCAL_CREDENTIAL_ROOT;
  return root === undefined
    ? undefined
    : { kind: "local-file", path: root };
};

const machineLayer = (): Layer.Layer<MachineState> => {
  // Enrollment credentials must be loaded from the provider that created them.
  // Secret values remain protected by the secure-store checks in secret-store.
  const credentialPolicy = credentialPolicyFromEnvironment();
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
  const state = Layer.unwrap(
    Effect.promise(() =>
      mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
    ).pipe(
      Effect.as(stateRepositoryLayer(statePath)),
    ),
  );
  return Layer.merge(state, machineLayer());
};
