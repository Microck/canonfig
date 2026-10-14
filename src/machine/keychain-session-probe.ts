import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import type { MachineStateError } from "./machine-state.errors.ts";
import type { ProcessResult } from "./machine-state.types.ts";

/**
 * Whether the login Keychain is writable from the CURRENT process context.
 *
 * Presence of `/usr/bin/security` only proves the provider is installed: an
 * SSH or other background session starts with the login Keychain locked, and
 * a locked Keychain refuses noninteractive access (`security` exit code 36,
 * "User interaction is not allowed"). The only honest check is a disposable
 * add/read-back/delete lifecycle of a non-secret sentinel in a unique
 * Canonfig-owned namespace, run right here.
 *
 * The sentinel is a fixed, non-secret constant passed on argv as
 * `security add-generic-password ... -w <sentinel>`; nothing travels over
 * standard input.
 *
 * Existing credentials are never read, modified, or deleted: the probe item
 * lives under its own account and a per-run unique service name.
 */

/**
 * What to do when the login Keychain refuses access from this session.
 *
 * macOS unlocks the login Keychain per security session: an unlock in one SSH
 * session works for that session only, and launchd starts scheduled runs in
 * the logged-in desktop session's `gui/<uid>` domain.
 */
export const keychainSessionGuidance = (uid: number): string =>
  "The login Keychain is locked in this SSH or background session. "
  + "To continue in this session, run `security unlock-keychain ~/Library/Keychains/login.keychain-db` and retry; "
  + "the unlock lasts only for this session and does not carry over to new SSH sessions, the desktop session, or scheduled runs. "
  + `Scheduled runs need the logged-in desktop session (launchd domain gui/${uid}).`;

/** Plain-language meaning of a `/usr/bin/security` exit code, when known. */
export const securityExitMeaning = (exitCode: number | null): string | undefined => {
  switch (exitCode) {
    case 36: return "user interaction is not allowed: the login Keychain is locked in this session";
    case 44: return "the Keychain item does not exist";
    default: return undefined;
  }
};

export interface KeychainProbeInvocation {
  readonly arguments: ReadonlyArray<string>;
  readonly standardInput: Uint8Array;
}

/** Seam for tests: runs one probe command and reports the process result. */
export type SecurityRunner = (
  invocation: KeychainProbeInvocation,
) => Effect.Effect<ProcessResult, MachineStateError>;

export type KeychainSessionProbeResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    /** Which lifecycle step failed; "cleanup" means a probe item may remain. */
    readonly stage: "add" | "read-back" | "cleanup" | "error";
    readonly exitCode: number | null;
    /** Set when the probe infrastructure itself failed (stage "error"). */
    readonly detail?: string | undefined;
  };

const probeAccount = "canonfig-session-probe";
/** Non-secret: it is passed on argv (`-w <sentinel>`), never over stdin. */
const probeSentinel = "canonfig-session-probe write check";
export const probeServicePrefix = "dev.canonfig.session-probe.";

type ProbeOperation = "probe-add" | "probe-load" | "probe-delete";

const probeInvocation = (
  operation: ProbeOperation,
  service: string,
): KeychainProbeInvocation => {
  const identity = ["-a", probeAccount, "-s", service];
  const arguments_ = operation === "probe-add"
    ? ["add-generic-password", "-U", ...identity, "-w", probeSentinel]
    : operation === "probe-load"
    ? ["find-generic-password", ...identity, "-w"]
    : ["delete-generic-password", ...identity];
  return {
    arguments: arguments_,
    standardInput: new Uint8Array(),
  };
};

export const keychainSessionProbe = (
  run: SecurityRunner,
): Effect.Effect<KeychainSessionProbeResult, MachineStateError> =>
  Effect.gen(function*() {
    const service = `${probeServicePrefix}${randomUUID()}`;
    const invocation = (operation: ProbeOperation) =>
      probeInvocation(operation, service);
    const cleanup = () => run(invocation("probe-delete"));
    const added = yield* run(invocation("probe-add"));
    if (added.exitCode !== 0) {
      yield* cleanup();
      return { ok: false, stage: "add", exitCode: added.exitCode };
    }
    const loaded = yield* run(invocation("probe-load"));
    const readBack = loaded.exitCode === 0
      ? new TextDecoder().decode(loaded.standardOutput).trim()
      : undefined;
    if (loaded.exitCode !== 0 || readBack !== probeSentinel) {
      yield* cleanup();
      return { ok: false, stage: "read-back", exitCode: loaded.exitCode };
    }
    const removed = yield* cleanup();
    if (removed.exitCode !== 0) {
      return { ok: false, stage: "cleanup", exitCode: removed.exitCode };
    }
    return { ok: true };
  });
