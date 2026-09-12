import { Effect, Redacted } from "effect";

import type { ProcessEnvironmentEntry } from "../machine/machine-state.types.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  findSecretReference,
  SecretTransferError,
} from "./secret-store.ts";

/** Bind one process environment or header name to a shared secret by name. */
export interface SecretProcessBinding {
  readonly name: string;
  readonly secret: string;
}

const bindingError = (message: string): SecretTransferError =>
  new SecretTransferError({
    category: "usage",
    operation: "resolve secret bindings",
    message,
  });

/**
 * Resolve symbolic secret bindings to process environment entries.
 *
 * Names resolve through the shared-secret manifest at launch time, so rotating
 * a native reference behind a name does not break the launcher: the next
 * resolution picks up the new reference. Only the requested names load; there
 * is no wildcard, so unrelated names stay inaccessible.
 *
 * Values travel in memory to the spawning process only. Errors name the
 * binding, never the value, so failures stay safe for profiles and logs.
 */
export const resolveSecretBindings = (
  bindings: ReadonlyArray<SecretProcessBinding>,
): Effect.Effect<
  ReadonlyArray<ProcessEnvironmentEntry>,
  SecretTransferError,
  MachineState
> =>
  Effect.gen(function*() {
    const names = new Set<string>();
    for (const binding of bindings) {
      if (binding.name.trim().length === 0 || binding.secret.trim().length === 0) {
        return yield* bindingError("secret bindings must name a process variable and a secret");
      }
      if (names.has(binding.name)) {
        return yield* bindingError(`secret bindings list ${binding.name} more than once`);
      }
      names.add(binding.name);
    }
    const machine = yield* MachineState;
    return yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function*() {
        const reference = yield* findSecretReference(binding.secret);
        if (reference === undefined) {
          return yield* bindingError(`unknown secret for binding ${binding.name}: ${binding.secret}`);
        }
        const value = yield* machine.loadCredential({ reference }).pipe(
          Effect.mapError(() =>
            bindingError(`the shared credential for binding ${binding.name} is unavailable`)
          ),
        );
        return { name: binding.name, value: Redacted.value(value) };
      }));
  });
