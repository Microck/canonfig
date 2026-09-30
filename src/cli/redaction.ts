/** Redact recognizable credential syntax before text crosses a CLI output boundary. */

import {
  assignedCredential,
  authorizationCredential,
  isSecretField,
  privateKeyBlock,
  quotedCredentialKey,
  spacedCredentialFlag,
  urlUserInformation,
} from "../secrets/credential-policy.ts";

const replacement = "[REDACTED]";

/**
 * Scrub caller-supplied secret values wherever they appear, regardless of
 * the surrounding field name. Longest first so overlapping values redact
 * once. Callers pass values already in scope (never a store dump); empty
 * values are skipped because they would match everywhere.
 */
export const redactKnownValues = (
  text: string,
  secrets: ReadonlyArray<string>,
): string => {
  let redacted = text;
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) redacted = redacted.replaceAll(secret, replacement);
  return redacted;
};


/**
 * This is a presentation safeguard, not a parser for arbitrary shell programs.
 * Callers must still avoid collecting raw authentication files or process output.
 */
export const redactText = (
  text: string,
  secrets: ReadonlyArray<string> = [],
): string =>
  redactKnownValues(text
    .replace(privateKeyBlock, replacement)
    .replace(urlUserInformation, "$1[REDACTED]@")
    .replace(authorizationCredential, "$1[REDACTED]")
    .replace(assignedCredential, `$1$2$3${replacement}`)
    .replace(quotedCredentialKey, `$1$2"${replacement}"`)
    .replace(spacedCredentialFlag, `$1$2${replacement}`), secrets);

/** Preserve argv structure while recognizing both --name=value and --name value. */
export const redactArguments = (
  values: ReadonlyArray<string>,
  secrets: ReadonlyArray<string> = [],
): Array<string> => {
  let redactNext = false;
  return values.map((value) => {
    if (redactNext) {
      redactNext = false;
      return replacement;
    }
    const flag = /^--([A-Za-z][A-Za-z0-9_-]*)(?:=(.*))?$/u.exec(value);
    if (flag !== null && isSecretField(flag[1]!)) {
      if (flag[2] !== undefined) return `--${flag[1]}=${replacement}`;
      redactNext = true;
      return value;
    }
    return redactText(value, secrets);
  });
};
