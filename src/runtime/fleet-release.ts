import { createHash, createPublicKey, verify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { verify as verifyBundle } from "sigstore";
import { bundleFromJSON, bundleToJSON } from "@sigstore/bundle";
import { FleetIntegrity, FleetVersion } from "../domain/fleet-update.ts";

const registry = "https://registry.npmjs.org";
const packageName = "@microck/canonfig";
const provenanceType = "https://slsa.dev/provenance/v1";
const publisher = "https://github.com/Microck/canonfig/.github/workflows/release.yml@refs/heads/main";
const Metadata = Schema.Struct({
  name: Schema.Literal(packageName), version: FleetVersion,
  dist: Schema.Struct({ integrity: FleetIntegrity, tarball: Schema.String,
    signatures: Schema.Array(Schema.Struct({ keyid: Schema.String, sig: Schema.String })) }),
});
const RegistryKeys = Schema.Struct({ keys: Schema.Array(Schema.Struct({
  keyid: Schema.String, key: Schema.String, expires: Schema.NullOr(Schema.String),
})) });
const Attestations = Schema.Struct({ attestations: Schema.Array(Schema.Struct({
  predicateType: Schema.String, bundle: Schema.Json,
})) });
const Envelope = Schema.Struct({ dsseEnvelope: Schema.Struct({ payload: Schema.String }) });
const Statement = Schema.Struct({
  _type: Schema.Literal("https://in-toto.io/Statement/v1"),
  predicateType: Schema.Literal(provenanceType),
  subject: Schema.Array(Schema.Struct({ name: Schema.String, digest: Schema.Struct({ sha512: Schema.String }) })),
  predicate: Schema.Struct({ buildDefinition: Schema.Struct({ externalParameters: Schema.Struct({ workflow: Schema.Struct({
    repository: Schema.Literal("https://github.com/Microck/canonfig"),
    ref: Schema.Literal("refs/heads/main"), path: Schema.Literal(".github/workflows/release.yml"),
  }) }) }) }),
});

/** No registry, artifact URL or publisher is supplied by the Source Machine. */
async function download(url: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "error", signal: signal === undefined ? AbortSignal.timeout(60_000)
      : AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!response.ok || response.body === null) throw new Error(`Official release download failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error("Official release exceeds the download limit");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, size);
}
export interface VerifiedFleetRelease { readonly version: string; readonly integrity: string; readonly tarball: string }
export type FleetReleaseVerifier = (version: string, cache: string, signal?: AbortSignal) => Promise<VerifiedFleetRelease>;

export const verifyFleetRelease: FleetReleaseVerifier = async (version, cache, signal) => {
  Schema.decodeUnknownSync(FleetVersion)(version);
  const metadata = Schema.decodeUnknownSync(Schema.fromJsonString(Metadata))(
    (await download(`${registry}/@microck%2fcanonfig/${version}`, 4_194_304, signal)).toString());
  const tarball = `${registry}/@microck/canonfig/-/canonfig-${version}.tgz`;
  if (metadata.version !== version || metadata.dist.tarball !== tarball) throw new Error("Official release identity mismatch");
  const keys = Schema.decodeUnknownSync(Schema.fromJsonString(RegistryKeys))(
    (await download(`${registry}/-/npm/v1/keys`, 65_536, signal)).toString());
  const signed = `${packageName}@${version}:${metadata.dist.integrity}`;
  if (!metadata.dist.signatures.some((signature) => keys.keys.some((key) =>
    key.keyid === signature.keyid && (key.expires === null || Date.parse(key.expires) > Date.now())
    && verify("sha256", Buffer.from(signed), createPublicKey({ key: Buffer.from(key.key, "base64"), format: "der", type: "spki" }), Buffer.from(signature.sig, "base64"))))) {
    throw new Error("Official npm registry signature verification failed");
  }
  const attestations = Schema.decodeUnknownSync(Schema.fromJsonString(Attestations))(
    (await download(`${registry}/-/npm/v1/attestations/@microck%2fcanonfig@${version}`, 8_388_608, signal)).toString());
  const provenance = attestations.attestations.find((attestation) => attestation.predicateType === provenanceType);
  if (provenance === undefined) throw new Error("Official release has no publisher provenance");
  await verifyBundle(bundleToJSON(bundleFromJSON(provenance.bundle)), {
    certificateIssuer: "https://token.actions.githubusercontent.com", certificateIdentityURI: publisher,
    tufCachePath: cache, timeout: 30_000, retry: 0,
  });
  const envelope = Schema.decodeUnknownSync(Envelope)(provenance.bundle);
  const statement = Schema.decodeUnknownSync(Schema.fromJsonString(Statement))(
    Buffer.from(envelope.dsseEnvelope.payload, "base64").toString());
  const digest = Buffer.from(metadata.dist.integrity.slice("sha512-".length), "base64").toString("hex");
  if (statement.subject.length !== 1 || statement.subject[0]?.name !== `pkg:npm/%40microck/canonfig@${version}`
    || statement.subject[0].digest.sha512 !== digest) throw new Error("Publisher provenance does not bind this exact package and integrity");
  return { version, integrity: metadata.dist.integrity, tarball };
};

export async function downloadFleetRelease(release: VerifiedFleetRelease, directory: string, signal?: AbortSignal): Promise<string> {
  const bytes = await download(release.tarball, 33_554_432, signal);
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== release.integrity) throw new Error("Fleet release tarball integrity mismatch");
  const path = join(directory, `canonfig-${release.version}.tgz`);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}
