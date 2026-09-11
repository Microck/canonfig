import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import type { MachineStateError } from "./machine-state.errors.ts";
import type { ProcessResult } from "./machine-state.types.ts";

/**
 * Whether the login Keychain is writable from the CURRENT process context.
 *
 * Presence of `/usr/bin/security` only proves the provider is installed: an
 * SSH or other background session cannot use the Keychain at all, and every
 * write fails with "User interaction is not allowed" no matter how the
 * Keychain is unlocked elsewhere. The only honest check is a disposable
 * add/read-back/delete lifecycle of a non-secret sentinel in a unique
 * Canonfig-owned namespace, run right here.
 *
 * The sentinel travels over stdin as hex (the same transport as the native
 * secret store) so no value is ever placed in argv. Existing credentials are
 * never read, modified, or deleted: the probe item lives under its own
 * account and a per-run unique service name.
 */

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
    readonly stage: "add" | "read-back" | "cleanup";
    readonly exitCode: number | null;
  };

// SecurityTool's interactive input is limited to 4 KiB and the CLI takes the
// password on argv or a prompt, never stdin: the native framework through
// osascript accepts the payload over stdin instead.
const probeArguments = ["-l", "JavaScript", "-e", [
  "ObjC.import('Foundation');",
  "ObjC.import('Security');",
  "function run() {",
  "  const bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;",
  "  const payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));",
  "  const query = $.NSMutableDictionary.dictionary;",
  "  query.setObjectForKey(ObjC.castRefToObject($.kSecClassGenericPassword), ObjC.castRefToObject($.kSecClass));",
  "  query.setObjectForKey($(payload.service), ObjC.castRefToObject($.kSecAttrService));",
  "  query.setObjectForKey($(payload.account), ObjC.castRefToObject($.kSecAttrAccount));",
  "  if (payload.operation === 'probe-add') {",
  "    const attributes = $.NSMutableDictionary.dictionary;",
  "    attributes.setObjectForKey($(payload.hexadecimal).dataUsingEncoding($.NSUTF8StringEncoding), ObjC.castRefToObject($.kSecValueData));",
  "    const status = $.SecItemAdd(query, null);",
  "    if (status !== 0) throw Error('Keychain probe add failed: ' + status);",
  "    return '';",
  "  }",
  "  if (payload.operation === 'probe-load') {",
  "    query.setObjectForKey($.NSNumber.numberWithBool(true), ObjC.castRefToObject($.kSecReturnData));",
  "    const output = Ref();",
  "    const status = $.SecItemCopyMatching(query, output);",
  "    if (status !== 0) throw Error('Keychain probe read failed: ' + status);",
  "    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(output[0]), $.NSUTF8StringEncoding));",
  "  }",
  "  const status = $.SecItemDelete(query);",
  "  if (status !== 0) throw Error('Keychain probe delete failed: ' + status);",
  "  return '';",
  "}",
].join("\n")];

const probeAccount = "canonfig-session-probe";
const probeSentinel = "canonfig-session-probe write check";
export const probeServicePrefix = "dev.canonfig.session-probe.";
const textEncoder = new TextEncoder();

const probeInput = (
  operation: string,
  service: string,
): Uint8Array =>
  textEncoder.encode(JSON.stringify({
    operation,
    service,
    account: probeAccount,
    hexadecimal: Buffer.from(probeSentinel, "utf8").toString("hex"),
  }));

export const keychainSessionProbe = (
  run: SecurityRunner,
): Effect.Effect<KeychainSessionProbeResult, MachineStateError> =>
  Effect.gen(function*() {
    const service = `${probeServicePrefix}${randomUUID()}`;
    const invocation = (operation: string) => ({
      arguments: probeArguments,
      standardInput: probeInput(operation, service),
    });
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
