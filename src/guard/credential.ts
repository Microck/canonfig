import { Redacted } from "effect";
import { redactText } from "../cli/redaction.ts";

const key = "CANONFIG_GUARD_API_KEY";
let entrypointCredential: Redacted.Redacted<string> | undefined;

const environmentCredential = () => {
  const value = process.env[key];
  return value === undefined ? undefined : Redacted.make(value);
};

/** The executable calls this before it loads any child-process code. */
export function captureGuardCredential(): void {
  entrypointCredential = environmentCredential();
  delete process.env[key];
}

// Library callers and adapter tests may supply a process-local value directly.
export const guardCredential = () => environmentCredential() ?? entrypointCredential;

export const guardCredentialAvailable = (bearer: ReturnType<typeof guardCredential>): boolean =>
  bearer !== undefined && Redacted.value(bearer).trim() !== "";

export function containsGuardCredential(value: string, bearer: ReturnType<typeof guardCredential>): boolean {
  const literal = bearer === undefined ? "" : Redacted.value(bearer);
  return (literal !== "" && value.includes(literal)) || redactText(value, [literal]) !== value;
}
