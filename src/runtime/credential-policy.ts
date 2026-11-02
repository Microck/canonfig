import { DatabaseSync } from "node:sqlite";
import { Option, Schema } from "effect";
import type { CredentialPolicy } from "../machine/machine-state.types.ts";

const credentialPolicyFromEnvironment = (): CredentialPolicy | undefined => {
  const root = process.env.CANONFIG_LOCAL_CREDENTIAL_ROOT;
  return root === undefined
    ? undefined
    : { kind: "local-file", path: root };
};

/**
 * The credential policy this follower enrolled under, read from its own state.
 *
 * The policy used to be selected only by `CANONFIG_LOCAL_CREDENTIAL_ROOT` in
 * the environment, and a native scheduled job carries no environment, so a
 * follower enrolled under the local-file policy had no credential during a
 * scheduled run and every fire failed. The enrolled configuration is the
 * authority; the environment variable is enrollment input, not a runtime one.
 *
 * Read directly rather than through StateRepository because the machine layer
 * is built before that service exists, and this is one row of one table.
 */
const enrolledCredentialPolicy = (
  statePath: string,
): CredentialPolicy | undefined => {
  try {
    const database = new DatabaseSync(statePath, { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT configuration_json FROM follower_sync_configuration WHERE singleton = 1",
        )
        .get();
      const parsedRow = Schema.decodeUnknownOption(
        Schema.Struct({ configuration_json: Schema.String }),
      )(row);
      if (Option.isNone(parsedRow)) return undefined;
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({
          credentialPolicy: Schema.optional(Schema.Union([
            Schema.Struct({ kind: Schema.Literal("secure-store") }),
            Schema.Struct({
              kind: Schema.Literal("local-file"),
              path: Schema.NonEmptyString,
            }),
          ])),
        }),
      )(JSON.parse(parsedRow.value.configuration_json));
      return Option.isNone(decoded) ? undefined : decoded.value.credentialPolicy;
    } finally {
      database.close();
    }
  } catch {
    // No state yet, an unreadable database, or a schema older than the field.
    // Enrollment is what records the policy, so an unenrolled machine falls
    // back to the environment below.
    return undefined;
  }
};

/** The enrolled policy is authoritative; the environment is enrollment input. */
export const runtimeCredentialPolicy = (statePath: string): CredentialPolicy | undefined =>
  enrolledCredentialPolicy(statePath) ?? credentialPolicyFromEnvironment();
