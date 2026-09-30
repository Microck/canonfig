import { Schema } from "effect";

import { configPathSegments } from "../domain/config-path.ts";
import type { ConfigValue } from "../domain/resource.ts";
import type { ProfileResourceInput } from "../domain/profile.ts";
import { redactText } from "../cli/redaction.ts";
import {
  containsLiteralCredential,
  isEnvironmentReference,
  isSecretField,
} from "../secrets/credential-policy.ts";
import { jsonPathText } from "./profile-codec.ts";

const isString = Schema.is(Schema.String);
const isScalar = Schema.is(Schema.Union([Schema.Number, Schema.Boolean]));
const isArray = (value: ConfigValue): value is ReadonlyArray<ConfigValue> => Array.isArray(value);

const literalCredentialPath = (
  value: ConfigValue,
  path: Array<string | number>,
  credentialField = false,
): ReadonlyArray<string | number> | undefined => {
  if (isString(value)) {
    if (value.length === 0 || isEnvironmentReference(value)) return undefined;
    return credentialField || containsLiteralCredential(value) ? path.slice() : undefined;
  }
  if (isScalar(value)) return credentialField ? path.slice() : undefined;
  if (isArray(value)) {
    let credentialArgument = false;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index]!;
      if (isString(entry)) {
        const flag = /^--([A-Za-z][A-Za-z0-9_-]*)(?:=(.*))?$/u.exec(entry);
        if (flag !== null && isSecretField(flag[1]!)) {
          if (flag[2] !== undefined) {
            credentialArgument = false;
            if (flag[2].length > 0 && !isEnvironmentReference(flag[2])) return [...path, index];
          } else {
            credentialArgument = true;
          }
          continue;
        }
      }
      path.push(index);
      const issue = literalCredentialPath(entry, path, credentialField || credentialArgument);
      path.pop();
      if (issue !== undefined) return issue;
      credentialArgument = false;
    }
    return undefined;
  }
  const record = value;
  // Harness configuration supports { fromEnv: "NAME" } without storing its value.
  if (
    isString(record.fromEnv)
    && Object.keys(record).length === 1
    && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(record.fromEnv)
  ) return undefined;
  const namedCredential = isString(record.name) && isSecretField(record.name);
  for (const [name, entry] of Object.entries(record)) {
    // SecretProcessBinding stores a shared-secret name, not credential material.
    if (
      name === "secret"
      && path.at(-2) === "secretBindings"
      && isString(record.name)
      && record.name.trim().length > 0
      && isString(entry)
      && entry.trim().length > 0
      && Object.keys(record).every((key) => key === "name" || key === "secret")
    ) continue;
    path.push(name);
    const issue = literalCredentialPath(
      entry,
      path,
      credentialField || isSecretField(name) || (namedCredential && name === "value"),
    );
    path.pop();
    if (issue !== undefined) return issue;
  }
  return undefined;
};

/** Publication rejects credentials; it never redacts or changes accepted bytes. */
export const publicationCredentialIssue = (
  resources: ReadonlyArray<ProfileResourceInput>,
): string | undefined => {
  for (const resource of resources) {
    if (resource.spec.kind !== "config") continue;
    for (const key of resource.spec.keys) {
      const segments = configPathSegments(key.path);
      const issue = literalCredentialPath(
        key.value,
        [...segments],
        segments.some(isSecretField),
      );
      if (issue !== undefined) {
        return `config resource ${redactText(resource.id)} at ${redactText(jsonPathText("keys", issue))} contains a literal credential [REDACTED]; remove the value and use a symbolic environment reference or named shared-secret binding, store shared values with canonfig secrets set, then review and publish again`;
      }
    }
  }
  return undefined;
};
