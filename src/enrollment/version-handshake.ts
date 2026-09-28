import { Schema } from "effect";

import { buildIdentity } from "../runtime/build-identity.ts";
import { SourceVersionMismatchError } from "./enrollment.errors.ts";

/**
 * Every follower request and every Source response names the canonfig
 * release that produced it. A Source and its followers interoperate only
 * within one major.minor line: the revision transport and its signed
 * metadata change between minor releases, and a skewed pair used to fail
 * with digest errors that read like tampering.
 */
export const canonfigVersionHeader = "x-canonfig-version";

/** The version a peer reports when it predates this handshake. */
const unannounced = "before 3.2.1";

const releaseLine = (version: string | undefined): string | undefined => {
  const match = /^(\d+)\.(\d+)\.\d+/u.exec(version ?? "");
  return match === null ? undefined : `${match[1]}.${match[2]}`;
};

/** Whether a peer's announced version interoperates with this build. */
export const peerVersionCompatible = (peer: string | undefined): boolean => {
  const line = releaseLine(peer);
  return line !== undefined && line === releaseLine(buildIdentity.packageVersion);
};

/** The announced version of a peer, or how to name one that announced none. */
export const announcedVersion = (header: string | ReadonlyArray<string> | undefined): string | undefined =>
  Schema.is(Schema.NonEmptyString)(header) ? header : undefined;

export const versionMismatchMessage = (
  sourceVersion: string | undefined,
  followerVersion: string | undefined,
): string =>
  `source/follower version mismatch: source ${sourceVersion ?? unannounced} vs follower ${followerVersion ?? unannounced}. install the same major.minor canonfig release on the Source Machine and on every follower`;

/** The failure a follower raises when the Source answers from another line. */
export const sourceVersionMismatch = (
  sourceVersion: string | undefined,
): SourceVersionMismatchError =>
  new SourceVersionMismatchError({
    sourceVersion: sourceVersion ?? null,
    followerVersion: buildIdentity.packageVersion,
    message: versionMismatchMessage(sourceVersion, buildIdentity.packageVersion),
  });
