/**
 * Redact credential-shaped diagnostic data before it crosses an output boundary.
 * This is defense in depth, not a way to make arbitrary secret-bearing files safe
 * to publish. Credential references and capability metadata remain inspectable.
 */
const secretName = /^(?:credential(?:value)?|password|passwd|secret|privatekey|signingkey|tlskey|accesstoken|refreshtoken|apikey|authorization|proxyauthorization|cookie|setcookie|token|clientsecret)$/u;
const secretSuffix = /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization|cookie)$/iu;

export const isSecretDiagnosticField = (name: string): boolean =>
  secretName.test(name.replace(/[-_.]/gu, "").toLowerCase()) || secretSuffix.test(name);

const credentialName = String.raw`(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:credential(?:[_-]?value)?|password|passwd|secret|private[_-]?key|signing[_-]?key|tls[_-]?key|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|token|client[_-]?secret)`;
const quotedOrBare = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s&;,]+)`;
const assignment = new RegExp(
  String.raw`((?<![\w.-])(?:--)?${credentialName}\s*[=:]\s*)${quotedOrBare}`,
  "giu",
);
const argument = new RegExp(
  String.raw`((?<![\w.-])--${credentialName}\s+)${quotedOrBare}`,
  "giu",
);

export const redactDiagnosticText = (text: string): string => text
  .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu, "[REDACTED]")
  .replace(/(https?:\/\/)[^\s/]*@/giu, "$1[REDACTED]@")
  .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"',;}\]]+/giu, "$1[REDACTED]")
  .replace(assignment, "$1[REDACTED]")
  .replace(argument, "$1[REDACTED]");

/** True only for a complete, separate long option whose next token is a secret. */
export const isSecretDiagnosticOption = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const match = /^--([A-Za-z][A-Za-z0-9_-]*)$/u.exec(value);
  return match !== null && isSecretDiagnosticField(match[1]!);
};
