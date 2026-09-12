import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";

import { CertificateFingerprint, GroupName, InvitationCode, Timestamp } from "../domain/brand.ts";
import {
  EnrollmentConfigurationError,
  type EnrollmentError,
} from "./enrollment.errors.ts";
import type { EnrollmentInvitationGrant } from "./enrollment.types.ts";

export const invitationEnvelopeEof = "CANONFIG-INVITE-EOF";
export const maximumEnvelopeBytes = 16 * 1024;

const InvitationEnvelopeSchema = Schema.Struct({
  code: InvitationCode,
  nonce: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  sourceFingerprint: CertificateFingerprint,
  tlsFingerprint: CertificateFingerprint,
  groups: Schema.Array(GroupName),
  expiresAt: Timestamp,
});

/** Secret-safe text form: one base64url line plus an explicit EOF marker. */
export const encodeInvitationEnvelope = (grant: EnrollmentInvitationGrant): string =>
  `${Buffer.from(JSON.stringify(grant), "utf8").toString("base64url")}\n${invitationEnvelopeEof}\n`;

const deliveryFailure = (
  operation: string,
  message: string,
): EnrollmentConfigurationError =>
  new EnrollmentConfigurationError({ operation, message });

export interface DeliverInvitationInput {
  readonly grant: EnrollmentInvitationGrant;
  readonly path: string;
  readonly timeoutMilliseconds?: number | undefined;
}

/**
 * Deliver an invitation envelope to a file without leaking its material.
 *
 * The write is atomic (temporary file plus rename), mode 0600, bounded in
 * size and time, and removes its temporary file when it fails or is
 * interrupted. Error messages never include invitation material.
 */
export const deliverInvitationEnvelope = (
  input: DeliverInvitationInput,
): Effect.Effect<string, EnrollmentError> => {
  const encoded = encodeInvitationEnvelope(input.grant);
  if (Buffer.byteLength(encoded, "utf8") > maximumEnvelopeBytes) {
    return Effect.fail(deliveryFailure(
      "deliver invitation",
      "the invitation envelope exceeds the delivery size limit",
    ));
  }
  const write = Effect.tryPromise({
    try: async () => {
      const temporary = join(dirname(input.path), `.invite-${randomUUID()}.part`);
      try {
        await mkdir(dirname(input.path), { recursive: true });
        await writeFile(temporary, encoded, { mode: 0o600 });
        await rename(temporary, input.path);
      } catch {
        await unlink(temporary).catch(() => undefined);
        throw new Error("invitation delivery failed");
      }
      return input.path;
    },
    catch: () => deliveryFailure("deliver invitation", "the invitation could not be delivered"),
  }).pipe(Effect.uninterruptible);
  return input.timeoutMilliseconds === undefined
    ? write
    : write.pipe(
      Effect.timeoutOption(input.timeoutMilliseconds),
      Effect.flatMap((option) =>
        option._tag === "Some"
          ? Effect.succeed(option.value)
          : Effect.fail(deliveryFailure(
            "deliver invitation",
            "invitation delivery timed out",
          ))
      ),
    );
};

export interface ReadInvitationInput {
  readonly path: string;
}

/**
 * Read an invitation envelope, requiring the explicit EOF marker.
 *
 * A truncated delivery (missing EOF, oversized, or malformed) fails without
 * changing enrollment state. Use `consumeInvitationEnvelope` to also remove
 * the file after a successful read so the material does not linger.
 */
export const readInvitationEnvelope = (
  input: ReadInvitationInput,
): Effect.Effect<EnrollmentInvitationGrant, EnrollmentError> =>
  Effect.tryPromise({
    try: async () => {
      const size = await stat(input.path).then(
        (entry) => entry.size,
        () => {
          throw new Error("invitation envelope is missing");
        },
      );
      if (size > maximumEnvelopeBytes) throw new Error("invitation envelope is too large");
      const text = await readFile(input.path, "utf8");
      const lines = text.split("\n");
      if (lines[lines.length - 1] !== "" || lines[lines.length - 2] !== invitationEnvelopeEof) {
        throw new Error("invitation envelope is incomplete");
      }
      const payload = Buffer.from(lines[0] ?? "", "base64url").toString("utf8");
      return Schema.decodeUnknownSync(InvitationEnvelopeSchema)(JSON.parse(payload));
    },
    catch: (cause) =>
      deliveryFailure(
        "read invitation",
        cause instanceof Error && cause.message === "invitation envelope is incomplete"
          ? "the invitation delivery is incomplete (missing EOF); request a fresh delivery"
          : "the invitation envelope is missing, oversized, or malformed",
      ),
  });

/** Read an invitation envelope and remove the file in one step. */
export const consumeInvitationEnvelope = (
  input: ReadInvitationInput,
): Effect.Effect<EnrollmentInvitationGrant, EnrollmentError> =>
  readInvitationEnvelope(input).pipe(
    Effect.tap(() =>
      Effect.promise(() => unlink(input.path).catch(() => undefined)).pipe(
        Effect.uninterruptible,
      )
    ),
  );
