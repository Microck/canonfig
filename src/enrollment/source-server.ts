import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { isIP } from "node:net";
import type { AddressInfo } from "node:net";

import { Effect, Redacted, Schema } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";
import type { CertificateFingerprint } from "../domain/brand.ts";
import type { SourceIdentity } from "../domain/identity.ts";
import {
  loadSharedSecrets,
  SECRET_SHARE_GROUP,
  type TransferredSecrets,
} from "../secrets/secret-store.ts";
import {
  DuplicateFollowerIdentityError,
  EnrollmentConfigurationError,
  EnrollmentFingerprintMismatchError,
  EnrollmentSourceMismatchError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationReplayError,
  InvalidFollowerCredentialError,
  MalformedEnrollmentRequestError,
  RevokedFollowerCredentialError,
  SourceNotInitializedError,
  TransportIntegrityError,
  TransportResourceNotFoundError,
  TransportSizeLimitError,
  TransportUnauthorizedError,
  type EnrollmentError,
} from "./enrollment.errors.ts";
import { Enrollment } from "./enrollment.service.ts";
import {
  type AuthenticatedFollower,
  type EnrollFollowerRequest,
  type EnrollFollowerResponse,
  EnrollFollowerRequestSchema,
  type RevisionList,
  type RevisionMetadata,
  type SourceServerHandle,
  type StartSourceServerInput,
} from "./enrollment.types.ts";

const maximumRequestBytes = 64 * 1024;
const defaultMaximumMetadataBytes = 1024 * 1024;
const defaultMaximumBlobBytes = 8 * 1024 * 1024;
const AddressInfoSchema = Schema.Struct({
  address: Schema.String,
  family: Schema.String,
  port: Schema.Number,
});

interface SourceDescriptor {
  readonly source: SourceIdentity;
  readonly tlsFingerprint: CertificateFingerprint;
}

interface ErrorResponse {
  readonly error: string;
  readonly message: string;
}

type SourceServerResponse =
  | SourceDescriptor
  | EnrollFollowerResponse
  | AuthenticatedFollower
  | RevisionList
  | RevisionMetadata
  | TransferredSecrets
  | { readonly ok: true }
  | ErrorResponse;

/**
 * Convert only unambiguous loopback host spellings to the host passed to
 * `listen`. DNS names, wildcard addresses, encoded values, and IPv6 zone
 * identifiers are deliberately excluded from this boundary.
 */
export const canonicalLoopbackHostname = (
  value: string,
): string | undefined => {
  if (value.length === 0 || value.trim() !== value) {
    return undefined;
  }
  if (value.toLowerCase() === "localhost") return "127.0.0.1";
  if (isIP(value) === 4 && value.startsWith("127.")) {
    return value;
  }
  if (isIP(value) !== 6) return undefined;
  try {
    const canonical = new URL(`https://[${value}]`).hostname;
    return canonical === "[::1]" ? "::1" : undefined;
  } catch {
    return undefined;
  }
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: SourceServerResponse,
): void => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
};

const errorStatus = (error: EnrollmentError): number => {
  if (error instanceof MalformedEnrollmentRequestError) return 400;
  if (
    error instanceof EnrollmentSourceMismatchError
    || error instanceof EnrollmentFingerprintMismatchError
  ) return 409;
  if (
    error instanceof InvitationNotFoundError
    || error instanceof InvalidFollowerCredentialError
  ) return 401;
  if (
    error instanceof InvitationExpiredError
    || error instanceof InvitationReplayError
    || error instanceof DuplicateFollowerIdentityError
  ) return 410;
  if (error instanceof RevokedFollowerCredentialError) return 403;
  if (
    error instanceof TransportResourceNotFoundError
    || error instanceof TransportUnauthorizedError
  ) return 404;
  if (error instanceof TransportSizeLimitError) return 413;
  if (error instanceof TransportIntegrityError) return 422;
  return 500;
};

const bearerCredential = (authorization: string | undefined): string => {
  const match = /^Bearer ([A-Za-z0-9_-]{32,512})$/u.exec(authorization ?? "");
  if (match === null) {
    throw new InvalidFollowerCredentialError({
      message: "the follower credential is invalid",
    });
  }
  return match[1]!;
};

const readBody = (
  request: NodeJS.ReadableStream,
): Promise<EnrollFollowerRequest> =>
  new Promise((resolveBody, rejectBody) => {
    const chunks: Array<Buffer> = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maximumRequestBytes) {
        rejectBody(new Error("request body exceeds the size limit"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(
          Schema.decodeUnknownSync(EnrollFollowerRequestSchema)(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ),
        );
      } catch {
        rejectBody(new Error("request body is not valid JSON"));
      }
    });
    request.on("error", rejectBody);
  });

const runRequestEffect = async <Value>(
  effect: Effect.Effect<Value, EnrollmentError>,
): Promise<Value> => {
  const result = await Effect.runPromise(Effect.result(effect));
  if (result._tag === "Failure") throw result.failure;
  return result.success;
};

const asEnrollmentError = (error: Error): EnrollmentError => {
  if (
    error instanceof DuplicateFollowerIdentityError
    || error instanceof EnrollmentConfigurationError
    || error instanceof EnrollmentFingerprintMismatchError
    || error instanceof EnrollmentSourceMismatchError
    || error instanceof InvitationExpiredError
    || error instanceof InvitationNotFoundError
    || error instanceof InvitationReplayError
    || error instanceof InvalidFollowerCredentialError
    || error instanceof MalformedEnrollmentRequestError
    || error instanceof RevokedFollowerCredentialError
    || error instanceof SourceNotInitializedError
    || error instanceof TransportIntegrityError
    || error instanceof TransportResourceNotFoundError
    || error instanceof TransportSizeLimitError
    || error instanceof TransportUnauthorizedError
  ) return error;
  return new EnrollmentConfigurationError({
    operation: "serve enrollment request",
    message: "the enrollment request failed",
  });
};

export const startSourceServer = (
  input: StartSourceServerInput = {},
): Effect.Effect<
  SourceServerHandle,
  EnrollmentConfigurationError,
  Enrollment | MachineState
> =>
  Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    const machine = yield* MachineState;
    const source = yield* enrollment.source().pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "start enrollment server",
          message: "source enrollment identity is unavailable",
        })
      ),
    );
    const key = yield* machine.loadCredential({
      reference: source.tlsKeyReference,
    }).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "load source TLS key",
          message: "source TLS credentials are unavailable",
        })
      ),
    );
    const certificate = yield* machine.loadCredential({
      reference: source.tlsCertificateReference,
    }).pipe(
      Effect.mapError(() =>
        new EnrollmentConfigurationError({
          operation: "load source TLS certificate",
          message: "source TLS credentials are unavailable",
        })
      ),
    );
    const requestedHostname = input.hostname === undefined
      ? "127.0.0.1"
      : input.hostname;
    const decodedHostname = Schema.decodeUnknownOption(Schema.String)(requestedHostname);
    const hostname = decodedHostname._tag === "Some"
      ? canonicalLoopbackHostname(decodedHostname.value)
      : undefined;
    if (hostname === undefined) {
      return yield* new EnrollmentConfigurationError({
        operation: "start enrollment server",
        message: "the source server host must be an unambiguous loopback address",
      });
    }
    const maximumMetadataBytes = input.maximumMetadataBytes
      ?? defaultMaximumMetadataBytes;
    const maximumBlobBytes = input.maximumBlobBytes ?? defaultMaximumBlobBytes;
    let blobRequests = 0;
    const server = createServer(
      {
        key: Redacted.value(key),
        cert: Redacted.value(certificate),
        minVersion: "TLSv1.2",
      },
      (request, response) => {
        const route = async (): Promise<void> => {
          const requestUrl = new URL(request.url ?? "/", "https://loopback.invalid");
          if (request.method === "GET" && request.url === "/v1/enrollment/source") {
            sendJson(response, 200, {
              source: source.source,
              tlsFingerprint: source.tlsFingerprint,
            });
            return;
          }
          if (request.method === "POST" && request.url === "/v1/enrollment") {
            const body = await readBody(request).catch(() => {
              throw new MalformedEnrollmentRequestError({
                message: "the enrollment request is malformed",
              });
            });
            const enrolled = await runRequestEffect(
              enrollment.enrollFollower(body),
            );
            sendJson(response, 201, enrolled);
            return;
          }
          if (
            request.method === "POST"
            && request.url === "/v1/enrollment/finalize"
          ) {
            await runRequestEffect(
              enrollment.finalizeFollower(
                bearerCredential(request.headers.authorization),
              ),
            );
            sendJson(response, 200, { ok: true });
            return;
          }
          if (
            request.method === "POST"
            && request.url === "/v1/enrollment/cancel"
          ) {
            await runRequestEffect(
              enrollment.cancelPendingEnrollment(
                bearerCredential(request.headers.authorization),
              ),
            );
            sendJson(response, 200, { ok: true });
            return;
          }
          if (
            request.method === "POST"
            && request.url === "/v1/enrollment/revoke"
          ) {
            await runRequestEffect(
              enrollment.revokeAuthenticatedFollower(
                bearerCredential(request.headers.authorization),
              ),
            );
            sendJson(response, 200, { ok: true });
            return;
          }
          if (
            request.method === "GET"
            && request.url === "/v1/enrollment/authenticate"
          ) {
            const authenticated = await runRequestEffect(
              enrollment.authenticate(
                bearerCredential(request.headers.authorization),
              ),
            );
            sendJson(response, 200, authenticated);
            return;
          }
          if (
            request.method === "GET"
            && requestUrl.pathname === "/v1/transport/secrets"
          ) {
            const authenticated = await runRequestEffect(
              enrollment.authenticate(
                bearerCredential(request.headers.authorization),
              ),
            );
            if (
              !authenticated.follower.groups.some((group) =>
                group === SECRET_SHARE_GROUP
              )
            ) {
              throw new TransportUnauthorizedError({
                resource: "shared-secrets",
              });
            }
            const secrets = await runRequestEffect(
              loadSharedSecrets().pipe(
                Effect.provideService(MachineState, machine),
                Effect.mapError(() =>
                  new EnrollmentConfigurationError({
                    operation: "load shared secrets",
                    message: "shared secrets are unavailable",
                  })
                ),
              ),
            );
            if (Buffer.byteLength(JSON.stringify(secrets)) > maximumMetadataBytes) {
              throw new TransportSizeLimitError({
                artifact: "shared-secrets",
                limit: maximumMetadataBytes,
              });
            }
            sendJson(response, 200, secrets);
            return;
          }
          if (
            request.method === "GET"
            && requestUrl.pathname === "/v1/transport/revisions"
          ) {
            const revisions = await runRequestEffect(
              enrollment.listAuthorizedRevisions(
                bearerCredential(request.headers.authorization),
              ),
            );
            if (Buffer.byteLength(JSON.stringify(revisions)) > maximumMetadataBytes) {
              throw new TransportSizeLimitError({
                artifact: "revision-list",
                limit: maximumMetadataBytes,
              });
            }
            sendJson(response, 200, revisions);
            return;
          }
          const revisionMatch = /^\/v1\/transport\/revisions\/([^/]+)$/u.exec(
            requestUrl.pathname,
          );
          if (request.method === "GET" && revisionMatch !== null) {
            const metadata = await runRequestEffect(
              enrollment.getAuthorizedRevision(
                bearerCredential(request.headers.authorization),
                decodeURIComponent(revisionMatch[1]!),
              ),
            );
            if (Buffer.byteLength(JSON.stringify(metadata)) > maximumMetadataBytes) {
              throw new TransportSizeLimitError({
                artifact: "revision-metadata",
                limit: maximumMetadataBytes,
              });
            }
            sendJson(response, 200, metadata);
            return;
          }
          const blobMatch = /^\/v1\/transport\/blobs\/([a-f0-9]{64})$/u.exec(
            requestUrl.pathname,
          );
          if (request.method === "GET" && blobMatch !== null) {
            blobRequests += 1;
            const blob = await runRequestEffect(
              enrollment.getAuthorizedBlob(
                bearerCredential(request.headers.authorization),
                blobMatch[1]!,
              ),
            );
            if (blob.byteLength > maximumBlobBytes) {
              throw new TransportSizeLimitError({
                artifact: "blob",
                limit: maximumBlobBytes,
              });
            }
            response.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-length": blob.byteLength,
              "cache-control": "no-store",
            });
            response.end(blob);
            return;
          }
          sendJson(response, 404, {
            error: "NotFound",
            message: "the enrollment endpoint does not exist",
          });
        };
        route().catch((cause: unknown) => {
          const error = cause instanceof Error
            ? cause
            : new EnrollmentConfigurationError({
              operation: "serve enrollment request",
              message: "the enrollment request failed",
            });
          const enrollmentError = asEnrollmentError(error);
          sendJson(response, errorStatus(enrollmentError), {
            error: enrollmentError._tag ?? "EnrollmentConfigurationError",
            message: "message" in enrollmentError
              && String(enrollmentError.message).length > 0
              ? String(enrollmentError.message)
              : "the transport request failed",
          });
        });
      },
    );
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1_000;

    const address = yield* Effect.tryPromise({
      try: () =>
        new Promise<AddressInfo>((resolveAddress, rejectAddress) => {
          const onError = (cause: Error): void => rejectAddress(cause);
          server.once("error", onError);
          server.listen(input.port ?? 0, hostname, () => {
            server.off("error", onError);
            const bound = Schema.decodeUnknownSync(AddressInfoSchema)(
              server.address(),
            );
            resolveAddress(bound);
          });
        }),
      catch: () =>
        new EnrollmentConfigurationError({
          operation: "start enrollment server",
          message: "the loopback HTTPS server could not start",
        }),
    });
    const host = address.family === "IPv6"
      ? `[${address.address}]`
      : address.address;
    return {
      endpoint: `https://${host}:${address.port}`,
      fingerprint: source.tlsFingerprint,
      blobRequests: () => blobRequests,
      close: () =>
        new Promise<void>((resolveClose, rejectClose) => {
          server.close((cause) => {
            if (cause === undefined) resolveClose();
            else rejectClose(cause);
          });
        }),
    };
  });