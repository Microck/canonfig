import { createHash } from "node:crypto";
import type { PeerCertificate } from "node:tls";

/** A Source is identified by its pinned certificate, not its mutable transport name. */
export const checkSourceServerIdentity = (fingerprint: string) =>
  (_hostname: string, certificate: PeerCertificate): Error | undefined =>
    createHash("sha256").update(certificate.raw).digest("hex") === fingerprint
      ? undefined
      : new Error("the Source TLS certificate does not match its pinned fingerprint");
