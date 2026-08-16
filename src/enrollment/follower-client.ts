import {
  createHash,
  createPublicKey,
  randomUUID,
  verify,
  X509Certificate,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { Effect, Redacted, Schema } from "effect";

import { BlobId, CertificateFingerprint } from "../domain/brand.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  DuplicateFollowerIdentityError,
  EnrollmentFingerprintMismatchError,
  EnrollmentSourceMismatchError,
  EnrollmentTransportError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationReplayError,
  InvalidFollowerCredentialError,
  MalformedEnrollmentRequestError,
  RevokedFollowerCredentialError,
  TransportIntegrityError,
  TransportInterruptedError,
  TransportMalformedResponseError,
  TransportResourceNotFoundError,
  TransportSizeLimitError,
  TransportUnauthorizedError,
  type EnrollmentError,
} from "./enrollment.errors.ts";
import {
  AuthenticatedFollowerSchema,
  EnrollFollowerResponseSchema,
  RevisionListSchema,
  RevisionMetadataSchema,
  WireEnrollmentErrorSchema,
  type BlobRetrievalInput,
  type CachedBlob,
  type FetchRevisionInput,
  type FetchedRevision,
  type FollowerTransportInput,
  type FollowerAuthenticationInput,
  type FollowerEnrollment,
  type FollowerEnrollmentInput,
  type EnrollFollowerRequest,
  type RevisionList,
  type RevisionMetadata,
  type RevisionMetadataInput,
} from "./enrollment.types.ts";
import {
  canonicalJson,
  digestOf,
  sha256BytesHex,
  type JsonValue,
} from "../profile/profile-codec.ts";

const decode = Schema.decodeUnknownSync;
const maximumResponseBytes = 64 * 1024;
const defaultMaximumMetadataBytes = 1024 * 1024;
const defaultMaximumBlobBytes = 8 * 1024 * 1024;
const defaultTimeoutMilliseconds = 10_000;

interface PinnedCertificate {
  readonly pem: string;
  readonly fingerprint: typeof CertificateFingerprint.Type;
}

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

interface BinaryResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly errorBody?: unknown | undefined;
}

const checkedEndpoint = (
  endpoint: string,
): Effect.Effect<URL, EnrollmentTransportError> =>
  Effect.try({
    try: () => {
      const url = new URL(endpoint);
      const loopback = url.hostname === "127.0.0.1"
        || url.hostname === "[::1]"
        || url.hostname === "::1";
      if (url.protocol !== "https:" || !loopback) {
        throw new Error("not a loopback HTTPS URL");
      }
      return url;
    },
    catch: () =>
      new EnrollmentTransportError({
        operation: "validate source endpoint",
        message: "the source endpoint must use loopback HTTPS",
      }),
  });

const inspectCertificate = (
  endpoint: URL,
): Effect.Effect<PinnedCertificate, EnrollmentTransportError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<PinnedCertificate>((resolveCertificate, rejectCertificate) => {
        const socket = tlsConnect({
          host: endpoint.hostname.replaceAll("[", "").replaceAll("]", ""),
          port: Number(endpoint.port),
          rejectUnauthorized: false,
          minVersion: "TLSv1.2",
        });
        socket.setTimeout(10_000);
        socket.once("secureConnect", () => {
          const peer = socket.getPeerCertificate();
          if (peer.raw === undefined) {
            socket.destroy();
            rejectCertificate(new Error("source did not provide a certificate"));
            return;
          }
          const raw = peer.raw;
          const fingerprint = decode(CertificateFingerprint)(
            createHash("sha256").update(raw).digest("hex"),
          );
          const pem = new X509Certificate(raw).toString();
          socket.end();
          resolveCertificate({ pem, fingerprint });
        });
        socket.once("timeout", () => {
          socket.destroy(new Error("TLS connection timed out"));
        });
        socket.once("error", rejectCertificate);
      }),
    catch: () =>
      new EnrollmentTransportError({
        operation: "inspect source certificate",
        message: "the source TLS certificate could not be inspected",
      }),
  });

const requestJson = (
  method: "GET" | "POST",
  endpoint: URL,
  path: string,
  certificate: PinnedCertificate,
  body?: EnrollFollowerRequest | undefined,
  authorization?: Redacted.Redacted<string> | undefined,
): Effect.Effect<JsonResponse, EnrollmentTransportError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<JsonResponse>((resolveResponse, rejectResponse) => {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        const headers: OutgoingHttpHeaders = { accept: "application/json" };
        if (encoded !== undefined) {
          headers["content-type"] = "application/json";
          headers["content-length"] = Buffer.byteLength(encoded);
        }
        if (authorization !== undefined) {
          headers.authorization = `Bearer ${Redacted.value(authorization)}`;
        }
        const request = httpsRequest({
          protocol: "https:",
          hostname: endpoint.hostname.replaceAll("[", "").replaceAll("]", ""),
          port: endpoint.port,
          path,
          method,
          ca: certificate.pem,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          headers,
        }, (response) => {
          const chunks: Array<Buffer> = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > maximumResponseBytes) {
              request.destroy(new Error("response exceeds the size limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              resolveResponse({
                status: response.statusCode ?? 500,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch {
              rejectResponse(new Error("source returned malformed JSON"));
            }
          });
        });
        request.setTimeout(10_000, () => {
          request.destroy(new Error("source request timed out"));
        });
        request.once("error", rejectResponse);
        request.end(encoded);
      }),
    catch: () =>
      new EnrollmentTransportError({
        operation: "request source enrollment endpoint",
        message: "the source enrollment endpoint could not be reached",
      }),
  });

const wireError = (
  response: JsonResponse,
): Effect.Effect<never, EnrollmentError> =>
  Schema.decodeUnknownEffect(WireEnrollmentErrorSchema)(response.body).pipe(
    Effect.mapError(() =>
      new EnrollmentTransportError({
        operation: "decode enrollment failure",
        message: "the source returned an invalid enrollment failure",
      })
    ),
    Effect.flatMap((error) => {
      let enrollmentError: EnrollmentError;
      switch (error.error) {
        case "InvitationNotFoundError":
          enrollmentError = new InvitationNotFoundError({ message: error.message });
          break;
        case "InvitationExpiredError":
          enrollmentError = new InvitationExpiredError({ message: error.message });
          break;
        case "InvitationReplayError":
          enrollmentError = new InvitationReplayError({ message: error.message });
          break;
        case "EnrollmentSourceMismatchError":
          enrollmentError = new EnrollmentSourceMismatchError({ message: error.message });
          break;
        case "EnrollmentFingerprintMismatchError":
          enrollmentError = new EnrollmentFingerprintMismatchError({
            message: error.message,
          });
          break;
        case "MalformedEnrollmentRequestError":
          enrollmentError = new MalformedEnrollmentRequestError({ message: error.message });
          break;
        case "DuplicateFollowerIdentityError":
          enrollmentError = new DuplicateFollowerIdentityError({ message: error.message });
          break;
        case "InvalidFollowerCredentialError":
          enrollmentError = new InvalidFollowerCredentialError({ message: error.message });
          break;
        case "RevokedFollowerCredentialError":
          enrollmentError = new RevokedFollowerCredentialError({ message: error.message });
          break;
        case "TransportResourceNotFoundError":
          enrollmentError = new TransportResourceNotFoundError({
            resource: "transport-resource",
          });
          break;
        case "TransportUnauthorizedError":
          enrollmentError = new TransportUnauthorizedError({
            resource: "transport-resource",
          });
          break;
        case "TransportSizeLimitError":
          enrollmentError = new TransportSizeLimitError({
            artifact: "transport-response",
            limit: 0,
          });
          break;
        case "TransportIntegrityError":
          enrollmentError = new TransportIntegrityError({
            artifact: "source",
            message: error.message,
          });
          break;
        default:
          enrollmentError = new EnrollmentTransportError({
            operation: "source enrollment request",
            message: `the source rejected the enrollment request (${error.error})`,
          });
      }
      return Effect.fail(enrollmentError);
    }),
  );

export const enrollFollower = (
  input: FollowerEnrollmentInput,
): Effect.Effect<FollowerEnrollment, EnrollmentError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const endpoint = yield* checkedEndpoint(input.invitation.endpoint);
    const certificate = yield* inspectCertificate(endpoint);
    if (certificate.fingerprint !== input.invitation.tlsFingerprint) {
      return yield* new EnrollmentFingerprintMismatchError({
        message: "the source TLS fingerprint does not match the invitation",
      });
    }
    const response = yield* requestJson(
      "POST",
      endpoint,
      "/v1/enrollment",
      certificate,
      {
        code: input.invitation.code,
        nonce: input.invitation.nonce,
        sourceFingerprint: input.invitation.sourceFingerprint,
        tlsFingerprint: input.invitation.tlsFingerprint,
        followerName: input.followerName,
      },
    );
    if (response.status !== 201) return yield* wireError(response);
    const enrolled = yield* Schema.decodeUnknownEffect(EnrollFollowerResponseSchema)(
      response.body,
    ).pipe(
      Effect.mapError(() =>
        new EnrollmentTransportError({
          operation: "decode enrollment response",
          message: "the source returned an invalid enrollment response",
        })
      ),
    );
    if (enrolled.source.publicKeyFingerprint !== input.invitation.sourceFingerprint) {
      return yield* new EnrollmentSourceMismatchError({
        message: "the enrolled source identity does not match the invitation",
      });
    }
    if (enrolled.tlsFingerprint !== input.invitation.tlsFingerprint) {
      return yield* new EnrollmentFingerprintMismatchError({
        message: "the enrolled TLS fingerprint does not match the invitation",
      });
    }
    const credentialReference = yield* machine.storeCredential({
      name: `canonfig-follower-${enrolled.follower.id}-${enrolled.source.publicKeyFingerprint}`,
      value: Redacted.make(enrolled.credential),
    }).pipe(
      Effect.mapError(() =>
        new EnrollmentTransportError({
          operation: "store follower credential",
          message: "secure follower credential storage is unavailable",
        })
      ),
    );
    return {
      follower: enrolled.follower,
      credentialReference,
      source: enrolled.source,
      tlsFingerprint: enrolled.tlsFingerprint,
    };
  });

export const authenticateFollower = (
  input: FollowerAuthenticationInput,
): Effect.Effect<typeof AuthenticatedFollowerSchema.Type, EnrollmentError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const endpoint = yield* checkedEndpoint(input.endpoint);
    const certificate = yield* inspectCertificate(endpoint);
    if (certificate.fingerprint !== input.tlsFingerprint) {
      return yield* new EnrollmentFingerprintMismatchError({
        message: "the source TLS fingerprint does not match the pinned fingerprint",
      });
    }
    const credential = yield* machine.loadCredential({
      reference: input.credentialReference,
    }).pipe(
      Effect.mapError(() =>
        new InvalidFollowerCredentialError({
          message: "the follower credential is unavailable",
        })
      ),
    );
    const response = yield* requestJson(
      "GET",
      endpoint,
      "/v1/enrollment/authenticate",
      certificate,
      undefined,
      credential,
    );
    if (response.status !== 200) return yield* wireError(response);
    return yield* Schema.decodeUnknownEffect(AuthenticatedFollowerSchema)(response.body).pipe(
      Effect.mapError(() =>
        new EnrollmentTransportError({
          operation: "decode authentication response",
          message: "the source returned an invalid authentication response",
        })
      ),
    );
  });

const asJson = <Value>(value: Value): JsonValue =>
  decode(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

const transportRequest = (
  endpoint: URL,
  path: string,
  certificate: PinnedCertificate,
  credential: Redacted.Redacted<string>,
  maximumBytes: number,
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
): Effect.Effect<BinaryResponse, EnrollmentError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<BinaryResponse>((resolveResponse, rejectResponse) => {
        let settled = false;
        const resolveOnce = (response: BinaryResponse): void => {
          if (settled) return;
          settled = true;
          resolveResponse(response);
        };
        const rejectOnce = (cause: Error): void => {
          if (settled) return;
          settled = true;
          rejectResponse(cause);
        };
        if (signal?.aborted === true) {
          rejectOnce(new TransportInterruptedError({
            operation: "request source transport endpoint",
          }));
          return;
        }
        const request = httpsRequest({
          protocol: "https:",
          hostname: endpoint.hostname.replaceAll("[", "").replaceAll("]", ""),
          port: endpoint.port,
          path,
          method: "GET",
          ca: certificate.pem,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          headers: {
            authorization: `Bearer ${Redacted.value(credential)}`,
            accept: "application/json, application/octet-stream",
          },
        }, (response) => {
          const chunks: Array<Buffer> = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > maximumBytes) {
              rejectOnce(new TransportSizeLimitError({
                artifact: path,
                limit: maximumBytes,
              }));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            const body = Buffer.concat(chunks);
            if ((response.statusCode ?? 500) >= 400) {
              try {
                resolveOnce({
                  status: response.statusCode ?? 500,
                  body,
                  errorBody: JSON.parse(body.toString("utf8")),
                });
              } catch {
                rejectOnce(new TransportMalformedResponseError({
                  operation: "decode transport failure",
                  message: "the source returned an invalid failure",
                }));
              }
              return;
            }
            resolveOnce({
              status: response.statusCode ?? 500,
              body,
            });
          });
        });
        const abort = (): void => {
          request.destroy(new TransportInterruptedError({
            operation: "request source transport endpoint",
          }));
        };
        signal?.addEventListener("abort", abort, { once: true });
        request.setTimeout(timeoutMilliseconds, () => {
          request.destroy(new TransportInterruptedError({
            operation: "request source transport endpoint",
          }));
        });
        request.once("error", rejectOnce);
        request.once("close", () => signal?.removeEventListener("abort", abort));
        request.end();
      }),
    catch: (cause) => {
      if (
        cause instanceof TransportInterruptedError
        || cause instanceof TransportMalformedResponseError
        || cause instanceof TransportSizeLimitError
      ) return cause;
      return new EnrollmentTransportError({
        operation: "request source transport endpoint",
        message: "the source transport endpoint could not be reached",
      });
    },
  });

const transportContext = (
  input: FollowerTransportInput,
): Effect.Effect<{
  readonly endpoint: URL;
  readonly certificate: PinnedCertificate;
  readonly credential: Redacted.Redacted<string>;
}, EnrollmentError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const endpoint = yield* checkedEndpoint(input.endpoint);
    const certificate = yield* inspectCertificate(endpoint);
    if (certificate.fingerprint !== input.tlsFingerprint) {
      return yield* new EnrollmentFingerprintMismatchError({
        message: "the source TLS fingerprint does not match the pinned fingerprint",
      });
    }
    const credential = yield* machine.loadCredential({
      reference: input.credentialReference,
    }).pipe(
      Effect.mapError(() =>
        new InvalidFollowerCredentialError({
          message: "the follower credential is unavailable",
        })
      ),
    );
    return { endpoint, certificate, credential };
  });

const transportFailure = (
  response: BinaryResponse,
): Effect.Effect<never, EnrollmentError> =>
  wireError({ status: response.status, body: response.errorBody });

const decodeJsonBody = <
  SchemaValue extends Schema.ConstraintDecoder<unknown, never>,
>(
  schema: SchemaValue,
  response: BinaryResponse,
  operation: string,
): Effect.Effect<SchemaValue["Type"], TransportMalformedResponseError> =>
  Effect.try({
    try: () => decode(schema)(JSON.parse(Buffer.from(response.body).toString("utf8"))),
    catch: () =>
      new TransportMalformedResponseError({
        operation,
        message: "the source returned malformed transport metadata",
      }),
  });

const verifyMetadata = (
  metadata: RevisionMetadata,
  sourceFingerprint: string,
): Effect.Effect<RevisionMetadata, TransportIntegrityError> =>
  Effect.try({
    try: () => {
      const publicKey = createPublicKey(metadata.signingPublicKey);
      const fingerprint = createHash("sha256").update(publicKey.export({
        type: "spki",
        format: "der",
      })).digest("hex");
      if (
        fingerprint !== sourceFingerprint
        || metadata.signingKeyId !== `ed25519:${sourceFingerprint}`
      ) {
        throw new Error("source signing identity mismatch");
      }
      const unsigned = {
        id: metadata.id,
        profileId: metadata.profileId,
        sequence: metadata.sequence,
        digest: metadata.digest,
        publishedAt: metadata.publishedAt,
        resources: metadata.resources,
        signingKeyId: metadata.signingKeyId,
        signingPublicKey: metadata.signingPublicKey,
        sourceSignature: metadata.sourceSignature,
      };
      if (digestOf(asJson(unsigned)) !== metadata.metadataDigest) {
        throw new Error("revision metadata digest mismatch");
      }
      const payload = canonicalJson(asJson({
        ...unsigned,
        metadataDigest: metadata.metadataDigest,
      }));
      if (
        !metadata.signature.startsWith("ed25519:")
        || !verify(
          null,
          Buffer.from(payload),
          publicKey,
          Buffer.from(metadata.signature.slice("ed25519:".length), "base64url"),
        )
      ) {
        throw new Error("revision metadata signature mismatch");
      }
      return metadata;
    },
    catch: (cause) =>
      new TransportIntegrityError({
        artifact: "revision-metadata",
        message: cause instanceof Error
          ? cause.message
          : "revision metadata verification failed",
      }),
  });

export const listRevisions = (
  input: FollowerTransportInput,
): Effect.Effect<RevisionList, EnrollmentError, MachineState> =>
  Effect.gen(function*() {
    const context = yield* transportContext(input);
    const response = yield* transportRequest(
      context.endpoint,
      "/v1/transport/revisions",
      context.certificate,
      context.credential,
      defaultMaximumMetadataBytes,
      input.timeoutMilliseconds ?? defaultTimeoutMilliseconds,
      input.signal,
    );
    if (response.status !== 200) return yield* transportFailure(response);
    return yield* decodeJsonBody(
      RevisionListSchema,
      response,
      "decode revision list",
    );
  });

export const getRevisionMetadata = (
  input: RevisionMetadataInput,
): Effect.Effect<RevisionMetadata, EnrollmentError, MachineState> =>
  Effect.gen(function*() {
    const context = yield* transportContext(input);
    const response = yield* transportRequest(
      context.endpoint,
      `/v1/transport/revisions/${encodeURIComponent(input.revisionId)}`,
      context.certificate,
      context.credential,
      input.maximumMetadataBytes ?? defaultMaximumMetadataBytes,
      input.timeoutMilliseconds ?? defaultTimeoutMilliseconds,
      input.signal,
    );
    if (response.status !== 200) return yield* transportFailure(response);
    const metadata = yield* decodeJsonBody(
      RevisionMetadataSchema,
      response,
      "decode revision metadata",
    );
    return yield* verifyMetadata(metadata, input.sourceFingerprint);
  });

export const retrieveBlob = (
  input: BlobRetrievalInput,
): Effect.Effect<Uint8Array, EnrollmentError, MachineState> =>
  Effect.gen(function*() {
    const context = yield* transportContext(input);
    const response = yield* transportRequest(
      context.endpoint,
      `/v1/transport/blobs/${input.blobId}`,
      context.certificate,
      context.credential,
      input.maximumBlobBytes ?? defaultMaximumBlobBytes,
      input.timeoutMilliseconds ?? defaultTimeoutMilliseconds,
      input.signal,
    );
    if (response.status !== 200) return yield* transportFailure(response);
    if (sha256BytesHex(response.body) !== input.blobId) {
      return yield* new TransportIntegrityError({
        artifact: input.blobId,
        message: "blob digest mismatch",
      });
    }
    return response.body;
  });

const atomicWrite = (
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  return writeFile(temporary, bytes, { flag: "wx" })
    .then(async () => {
      const file = await open(temporary, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    })
    .catch(async (cause) => {
      await unlink(temporary).catch(() => undefined);
      throw cause;
    });
};

const cachedBlob = async (
  directory: string,
  id: string,
): Promise<CachedBlob | undefined> => {
  const path = join(directory, id);
  try {
    const bytes = await readFile(path);
    if (sha256BytesHex(bytes) === id) return { id: decode(BlobId)(id), path };
    await unlink(path);
    return undefined;
  } catch {
    return undefined;
  }
};

export const fetchRevision = (
  input: FetchRevisionInput,
): Effect.Effect<FetchedRevision, EnrollmentError, MachineState> =>
  Effect.gen(function*() {
    const metadata = yield* getRevisionMetadata(input);
    const blobDirectory = join(input.cacheDirectory, "blobs");
    const revisionDirectory = join(input.cacheDirectory, "revisions");
    yield* Effect.tryPromise({
      try: () => Promise.all([
        mkdir(blobDirectory, { recursive: true }),
        mkdir(revisionDirectory, { recursive: true }),
      ]),
      catch: () =>
        new EnrollmentTransportError({
          operation: "create follower transport cache",
          message: "the follower transport cache is unavailable",
        }),
    });
    const ids = [...new Set(
      metadata.resources.flatMap((resource) => resource.blobs),
    )];
    const blobs: Array<CachedBlob> = [];
    let downloadedBlobs = 0;
    let reusedBlobs = 0;
    for (const id of ids) {
      const existing = yield* Effect.promise(() => cachedBlob(blobDirectory, id));
      if (existing !== undefined) {
        blobs.push(existing);
        reusedBlobs += 1;
        continue;
      }
      const bytes = yield* retrieveBlob({
        endpoint: input.endpoint,
        tlsFingerprint: input.tlsFingerprint,
        credentialReference: input.credentialReference,
        sourceFingerprint: input.sourceFingerprint,
        blobId: id,
        timeoutMilliseconds: input.timeoutMilliseconds,
        maximumBlobBytes: input.maximumBlobBytes,
        signal: input.signal,
      });
      const path = join(blobDirectory, id);
      yield* Effect.tryPromise({
        try: () => atomicWrite(path, bytes),
        catch: () =>
          new EnrollmentTransportError({
            operation: "cache verified blob",
            message: "the follower transport cache is unavailable",
          }),
      });
      blobs.push({ id, path });
      downloadedBlobs += 1;
    }
    const metadataPath = join(
      revisionDirectory,
      `${createHash("sha256").update(metadata.id).digest("hex")}.json`,
    );
    yield* Effect.tryPromise({
      try: () => atomicWrite(
        metadataPath,
        Buffer.from(JSON.stringify(metadata)),
      ),
      catch: () =>
        new EnrollmentTransportError({
          operation: "cache verified revision metadata",
          message: "the follower transport cache is unavailable",
        }),
    });
    return { metadata, blobs, downloadedBlobs, reusedBlobs };
  });
