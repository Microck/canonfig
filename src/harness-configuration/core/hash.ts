import { createHash } from "node:crypto";
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Git checkout newline conversion is not an edit to generated text. */
export const textHash = (value: string): string => sha256(value.replace(/\r\n/gu, "\n"));

export const matchesArtifactHash = (value: string | Uint8Array, hash: string, normalizedTextHash?: string): boolean => {
  if (sha256(value) === hash) return true;
  if (typeof value === "string") return textHash(value) === (normalizedTextHash ?? hash);
  // Only a recorded text artifact may be decoded during retired-file cleanup.
  // Binary artifacts and legacy binary receipts retain exact-byte comparison.
  if (normalizedTextHash === undefined) return false;
  try { return textHash(new TextDecoder("utf-8", { fatal: true }).decode(value)) === normalizedTextHash; }
  catch { return false; }
};
