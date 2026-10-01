import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

export const checkSourceServerIdentity = (
  hostname: string,
  certificate: PeerCertificate,
): Error | undefined => {
  if (isIP(hostname) !== 6) return checkServerIdentity(hostname, certificate);
  // Node's IDNA conversion can erase IPv6 names before checking IP SANs.
  // Check the actual peer DER instead; CA validation and Source pins still apply.
  return new X509Certificate(certificate.raw).checkIP(hostname) === undefined
    ? new Error("the Source TLS certificate does not cover its IPv6 endpoint")
    : undefined;
};
