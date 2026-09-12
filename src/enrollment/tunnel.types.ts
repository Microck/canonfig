import { createHash } from "node:crypto";

import { Schema } from "effect";

import { CertificateFingerprint } from "../domain/brand.ts";

export const TunnelLoopbackHost = Schema.Literals(["127.0.0.1", "::1"]);
export type TunnelLoopbackHost = typeof TunnelLoopbackHost.Type;

const sshHostPattern = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/u;
const sshUserPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/u;
const sshKeyPattern =
  /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?:\s.*)?$/u;

export const TunnelStartInputSchema = Schema.Struct({
  sshHost: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    Schema.isPattern(sshHostPattern),
  ),
  sshPort: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(65_535),
  ),
  sshUser: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
    Schema.isPattern(sshUserPattern),
  ),
  /** The pinned SSH host public key: `<type> <base64>` with an optional comment. */
  sshHostKey: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8_192),
    Schema.isPattern(sshKeyPattern),
  ),
  localHost: TunnelLoopbackHost,
  localPort: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(65_535),
  ),
  remoteHost: TunnelLoopbackHost,
  remotePort: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(65_535),
  ),
  /** The Source Machine TLS certificate fingerprint pinned through the tunnel. */
  tlsFingerprint: CertificateFingerprint,
  /** The Source Machine signing identity pinned independently from TLS. */
  sourceFingerprint: CertificateFingerprint,
  /** Directory holding tunnel.json, the managed known_hosts file, and the log. */
  stateDirectory: Schema.NonEmptyString,
  sshExecutable: Schema.optional(Schema.NonEmptyString),
  sshArguments: Schema.optional(Schema.Array(Schema.String)),
  timeoutMilliseconds: Schema.optional(Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1_000),
    Schema.isLessThanOrEqualTo(300_000),
  )),
});

export type TunnelStartInput = typeof TunnelStartInputSchema.Type;

export const TunnelStateFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  ssh: Schema.Struct({
    host: Schema.NonEmptyString,
    port: Schema.Int,
    user: Schema.NonEmptyString,
    hostKeyType: Schema.NonEmptyString,
    hostKeyFingerprint: Schema.NonEmptyString,
  }),
  local: Schema.Struct({ host: TunnelLoopbackHost, port: Schema.Int }),
  remote: Schema.Struct({ host: TunnelLoopbackHost, port: Schema.Int }),
  tlsFingerprint: CertificateFingerprint,
  sourceFingerprint: CertificateFingerprint,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  processArgumentFingerprint: Schema.NonEmptyString,
  startedAt: Schema.NonEmptyString,
  logPath: Schema.NonEmptyString,
  knownHostsPath: Schema.NonEmptyString,
});

export type TunnelStateFile = typeof TunnelStateFileSchema.Type;

export type TunnelLifecycle = "running" | "down" | "not-configured";

export interface TunnelIdentityEvidence {
  /** OpenSSH-style `SHA256:` fingerprint of the pinned SSH host key. */
  readonly sshHostKeyFingerprint: string;
  readonly tlsPinnedFingerprint: string;
  readonly tlsObservedFingerprint?: string | undefined;
  readonly tlsMatch?: boolean | undefined;
  readonly sourcePinnedFingerprint: string;
  readonly sourceObservedFingerprint?: string | undefined;
  readonly sourceMatch?: boolean | undefined;
}

export interface TunnelStatusReport {
  readonly lifecycle: TunnelLifecycle;
  readonly pid?: number | undefined;
  readonly startedAt?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly reconnected?: boolean | undefined;
  readonly identity: TunnelIdentityEvidence | undefined;
  readonly detail: string;
}

/** OpenSSH-style fingerprint for a pinned `type base64` host key. */
export const sshHostKeyFingerprint = (hostKey: string): string => {
  const match = sshKeyPattern.exec(hostKey.trim());
  if (match?.[2] === undefined) throw new Error("invalid SSH host key");
  const fingerprint = createHash("sha256")
    .update(Buffer.from(match[2], "base64"))
    .digest("base64")
    .replaceAll("=", "");
  return `SHA256:${fingerprint}`;
};

export const sshHostKeyType = (hostKey: string): string => {
  const match = sshKeyPattern.exec(hostKey.trim());
  if (match?.[1] === undefined) throw new Error("invalid SSH host key");
  return match[1];
};
