import { Schema } from "effect";

const isString = Schema.is(Schema.String);

/** Credential syntax shared by publication validation and CLI presentation. */
const credentialWords =
  "password|passwd|pwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|signing[-_]?key|tls[-_]?key|authorization|cookie|credential";
const credentialIdentifiers =
  "credentialValue|privateKey|signingKey|tlsKey|accessToken|refreshToken|apiKey|clientSecret|setCookie|proxyAuthorization";
const referenceIdentifiers = "(?:credential|secret|signingKey|tlsKey)(?:Reference|References|Ref|Name|Names)";

const credentialName = (end: string): string =>
  `(?!${referenceIdentifiers}${end})`
  + `(?:(?:[A-Za-z0-9_-]*[-_])?(?:${credentialWords})|${credentialIdentifiers})`;
const secretName = new RegExp(`^(?:${credentialName("$")})$`, "iu");
export const isSecretField = (name: string): boolean => secretName.test(name);

const environmentName = "[A-Za-z_][A-Za-z0-9_]*";
const environmentSymbol = `(?:\\$\\{${environmentName}\\}|\\$${environmentName}|\\{env:${environmentName}\\})`;
const environmentReference = new RegExp(
  `^(?:(?:Bearer|Basic|Token)\\s+)?${environmentSymbol}$`,
  "u",
);
/** A symbolic reference carries no credential material. */
export const isEnvironmentReference = (value: string): boolean => environmentReference.test(value);
const embeddedEnvironmentReference = `(?:(?:Bearer|Basic|Token)\\s+)?${environmentSymbol}(?=$|[\\s&,;\\]}"'])`;

const embeddedName = credentialName("(?![A-Za-z0-9_-])");
const quotedValue = "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'";
export const assignedCredential = new RegExp(
  `(?<![A-Za-z0-9_-])(--)?(${embeddedName})(\\s*[=:]\\s*)`
  + `(\\[REDACTED\\]|${quotedValue}|${embeddedEnvironmentReference}|[^\\s&,;\\]}]+)`,
  "giu",
);
export const quotedCredentialKey = new RegExp(
  `("(?:${embeddedName})")(\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|true|false|null|-?\\d+(?:\\.\\d+)?)`,
  "giu",
);
export const spacedCredentialFlag = new RegExp(
  `(--(?:${embeddedName}))(\\s+)(${quotedValue}|${embeddedEnvironmentReference}|\\S+)`,
  "giu",
);
export const privateKeyBlock = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu;
export const urlUserInformation = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@/giu;
export const authorizationCredential = new RegExp(
  `(\\b(?:authorization|proxy-authorization)\\s*[:=]\\s*)((?:Bearer|Basic)\\s+(?:${environmentSymbol}(?=$|[\\s"',;}\\]])|[^\\s"',;}\\]]+))`,
  "giu",
);
const credentialAssignments = [
  [assignedCredential, 4],
  [quotedCredentialKey, 3],
  [spacedCredentialFlag, 3],
  [authorizationCredential, 2],
] as const;
const embeddedUrl = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gu;

const unquote = (value: string): string => {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isString(parsed)) return parsed;
    } catch {
      return value;
    }
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
};

/** Detect recognizable literal credentials without rewriting reviewed bytes. */
export const containsLiteralCredential = (text: string): boolean => {
  if (text.matchAll(privateKeyBlock).next().done === false) return true;
  for (const [pattern, valueGroup] of credentialAssignments) {
    for (const match of text.matchAll(pattern)) {
      const value = unquote(match[valueGroup]!);
      if (value.length > 0 && !isEnvironmentReference(value)) return true;
    }
  }
  for (const match of text.matchAll(embeddedUrl)) {
    try {
      const url = new URL(match[0]);
      if (url.username.length > 0 && !isEnvironmentReference(decodeURIComponent(url.username))) return true;
      if (url.password.length > 0 && !isEnvironmentReference(decodeURIComponent(url.password))) return true;
      for (const [name, value] of url.searchParams) {
        if (isSecretField(name) && value.length > 0 && !isEnvironmentReference(value)) return true;
      }
    } catch {
      // Malformed URLs with user information still carry recognizable credentials.
      if (match[0].matchAll(urlUserInformation).next().done === false) return true;
    }
  }
  return false;
};
