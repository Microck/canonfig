/** Redact recognizable credential syntax before text crosses a CLI output boundary. */

/** Trailing words that mark an identifier as credential-bearing. */
const credentialWords =
  "password|passwd|pwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|signing[-_]?key|tls[-_]?key|authorization|cookie|credential";
/** Whole identifiers whose credential word is not preceded by a separator. */
const credentialIdentifiers =
  "credentialValue|privateKey|signingKey|tlsKey|accessToken|refreshToken|apiKey|clientSecret|setCookie|proxyAuthorization";
/** Identifiers that name a credential symbolically, so their value stays visible. */
const referenceIdentifiers = "(?:credential|secret|signingKey|tlsKey)(?:Reference|References|Ref|Name|Names)";

/**
 * Source for an identifier that holds a credential. `end` closes the
 * identifier: "$" when testing a whole name, a negative lookahead when the
 * pattern is embedded in a scan over free text. Both callers share this source
 * so a name recognized as a field is also recognized inside a message.
 */
const credentialName = (end: string): string =>
  `(?!${referenceIdentifiers}${end})`
  + `(?:(?:[A-Za-z0-9_-]*[-_])?(?:${credentialWords})|${credentialIdentifiers})`;

const secretName = new RegExp(`^(?:${credentialName("$")})$`, "iu");

export const isSecretField = (name: string): boolean => secretName.test(name);

const replacement = "[REDACTED]";

/**
 * The name in an assignment must be a credential name for the pattern to match
 * at all. Matching every `name=value` pair and then deciding would let a
 * harmless pair such as "argument: " consume the credential that follows it,
 * because `String.replace` resumes scanning after the whole match.
 */
const embeddedName = credentialName("(?![A-Za-z0-9_-])");
const quotedValue = "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'";
const assignedCredential = new RegExp(
  `(?<![A-Za-z0-9_-])(--)?(${embeddedName})(\\s*[=:]\\s*)`
  + `(?:\\[REDACTED\\]|${quotedValue}|[^\\s&,;\\]}]+)`,
  "giu",
);
const quotedCredentialKey = new RegExp(
  `("(?:${embeddedName})")(\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|true|false|null|-?\\d+(?:\\.\\d+)?)`,
  "giu",
);
const spacedCredentialFlag = new RegExp(
  `(--(?:${embeddedName}))(\\s+)(?:${quotedValue}|\\S+)`,
  "giu",
);

/**
 * This is a presentation safeguard, not a parser for arbitrary shell programs.
 * Callers must still avoid collecting raw authentication files or process output.
 */
export const redactText = (text: string): string => text
  .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu, replacement)
  .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@/giu, "$1[REDACTED]@")
  .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"',;}\]]+/giu, "$1[REDACTED]")
  .replace(assignedCredential, `$1$2$3${replacement}`)
  .replace(quotedCredentialKey, `$1$2"${replacement}"`)
  .replace(spacedCredentialFlag, `$1$2${replacement}`);

/** Preserve argv structure while recognizing both --name=value and --name value. */
export const redactArguments = (values: ReadonlyArray<string>): Array<string> => {
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
    return redactText(value);
  });
};
