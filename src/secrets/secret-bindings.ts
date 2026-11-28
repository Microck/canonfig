import { Effect, Redacted } from "effect";

import { credentialFailureDetail } from "../machine/machine-state.errors.ts";
import type { ProcessEnvironmentEntry } from "../machine/machine-state.types.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  findSecretReference,
  SecretTransferError,
} from "./secret-store.ts";

/**
 * Load one shared secret by name, or undefined when this machine has no
 * secret of that name. Any read failure is a `storage` error that names the
 * secret, never its value.
 *
 * Rotation publishes the new native reference before removing the old one,
 * so a failed read resolves the name again and retries once with a changed
 * reference. A locked or unchanged credential gets only one native read.
 */
export const loadNamedSecret = (
  name: string,
): Effect.Effect<Redacted.Redacted<string> | undefined, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const unreadable = new SecretTransferError({
      category: "storage",
      operation: "load shared secret",
      message: `shared secret ${name} could not be read from secure credential storage`,
    });
    const reference = yield* findSecretReference(name);
    if (reference === undefined) return undefined;
    return yield* machine.loadCredential({ reference }).pipe(Effect.catch(() =>
      findSecretReference(name).pipe(Effect.flatMap((current) =>
        current === undefined
          ? Effect.succeed(undefined)
          : current === reference
          ? Effect.fail(unreadable)
          : machine.loadCredential({ reference: current }).pipe(Effect.mapError(() => unreadable))
      ))
    ));
  });

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
          Effect.mapError((error) =>
            new SecretTransferError({
              category: "storage",
              operation: "resolve secret bindings",
              message: `the shared credential for binding ${binding.name} could not be loaded from secure credential storage: ${credentialFailureDetail(error)}`,
            })
          ),
        );
        return { name: binding.name, value: Redacted.value(value) };
      }));
  });
