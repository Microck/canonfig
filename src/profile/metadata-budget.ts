import { Buffer } from "node:buffer";
import { defaultMaximumMetadataBytes } from "../domain/transport-limits.ts";
import type { PublishedResource, ScheduleDefault } from "../domain/profile.ts";

export class ProfileMetadataBudgetError extends Error {
  readonly name = "ProfileMetadataBudgetError";
  constructor(readonly bytes: number) {
    super(`Revision metadata requires ${bytes} bytes including signing-envelope reserve, exceeding the ${defaultMaximumMetadataBytes}-byte transport limit. Split large resources across separate profiles before publishing.`);
  }
}

interface MetadataInput {
  readonly profileId: string;
  readonly resources: ReadonlyArray<PublishedResource>;
  readonly scheduleDefault?: ScheduleDefault | undefined;
  readonly id?: string | undefined;
  readonly sequence?: number | undefined;
  readonly publishedAt?: string | undefined;
  readonly signingKeyId?: string | undefined;
  readonly sourceSignature?: string | undefined;
}

/**
 * Budget the full unfiltered projection: authorization can only remove resources.
 * Reserve bounded Ed25519 transport-key/signature space, and substitute actual
 * publication fields before storage so unusually long caller fields cannot slip
 * through the preliminary compiler/digest check.
 */
export const assertProfileMetadataBudget = (input: MetadataInput): void => {
  const bytes = Buffer.byteLength(JSON.stringify({
    id: input.id ?? `${input.profileId}:${"0".repeat(64)}:${Number.MAX_SAFE_INTEGER}`,
    profileId: input.profileId,
    sequence: input.sequence ?? Number.MAX_SAFE_INTEGER,
    digest: "0".repeat(64),
    publishedAt: input.publishedAt ?? "0".repeat(128),
    resources: input.resources,
    scheduleDefault: input.scheduleDefault,
    signingKeyId: input.signingKeyId ?? "0".repeat(512),
    signingPublicKey: "0".repeat(512),
    sourceSignature: input.sourceSignature ?? "0".repeat(256),
    metadataDigest: "0".repeat(64),
    signature: "0".repeat(256),
  }));
  if (bytes > defaultMaximumMetadataBytes) throw new ProfileMetadataBudgetError(bytes);
};
