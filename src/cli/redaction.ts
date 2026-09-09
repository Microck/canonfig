/** Redact recognizable credential syntax before text crosses a CLI output boundary. */
const sensitiveName = /(?:^|[-_])(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|signing[-_]?key|tls[-_]?key|authorization|cookie|credential)$/iu;
const exactSensitiveName = /^(?:credentialValue|privateKey|signingKey|tlsKey|accessToken|refreshToken|apiKey|clientSecret|setCookie|proxyAuthorization)$/iu;
const referenceName = /^(?:credential|secret|signingKey|tlsKey)(?:Reference|References|Ref|Name|Names)$/iu;
const replacement = "[REDACTED]";

export const isSecretField = (name: string): boolean =>
  !referenceName.test(name) && (sensitiveName.test(name) || exactSensitiveName.test(name));

/**
 * This is a presentation safeguard, not a parser for arbitrary shell programs.
 * Callers must still avoid collecting raw authentication files or process output.
 */
export const redactText = (text: string): string => text
  .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu, replacement)
  .replace(/\b(https?:\/\/)[^\s/]*@/giu, "$1[REDACTED]@")
  .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"',;}\]]+/giu, "$1[REDACTED]")
  .replace(
    /((?:--)?[A-Za-z_][A-Za-z0-9_-]*)(\s*[=:]\s*)(\[REDACTED\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;\]}]+)/gu,
    (match: string, name: string, separator: string) =>
      isSecretField(name) ? `${name}${separator}${replacement}` : match,
  )
  .replace(
    /("[A-Za-z_][A-Za-z0-9_-]*")(\s*:\s*)("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?)/gu,
    (match: string, name: string, separator: string) =>
      isSecretField(name.slice(1, -1)) ? `${name}${separator}"${replacement}"` : match,
  )
  .replace(
    /(--[A-Za-z][A-Za-z0-9_-]*)(\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gu,
    (match: string, flag: string, separator: string) =>
      isSecretField(flag.slice(2)) ? `${flag}${separator}${replacement}` : match,
  );

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
