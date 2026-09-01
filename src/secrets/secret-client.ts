import { createHash, X509Certificate } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

import { Effect, Redacted, Schema } from "effect";

import {
  CertificateFingerprint,
  type CredentialReference,
} from "../domain/brand.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import {
  applyTransferredSecrets,
  SecretTransferError,
  TransferredSecretsSchema,
  type TransferredSecrets,
} from "./secret-store.ts";

const defaultTimeoutMilliseconds = 10_000;
const maximumResponseBytes = 1024 * 1024;

interface PinnedCertificate {
  readonly pem: string;
  readonly fingerprint: typeof CertificateFingerprint.Type;
}

interface SecretResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export interface FetchSharedSecretsInput {
  readonly endpoint: string;
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
  readonly credentialReference: CredentialReference;
  readonly timeoutMilliseconds?: number | undefined;
}

export type FetchSharedSecretsResult =
  | { readonly status: "not-shared" }
  | { readonly status: "shared"; readonly payload: TransferredSecrets };

export type SecretSynchronizationResult =
  | { readonly status: "not-enrolled"; readonly secrets: ReadonlyArray<string> }
  | { readonly status: "not-shared"; readonly secrets: ReadonlyArray<string> }
  | { readonly status: "synchronized"; readonly secrets: ReadonlyArray<string> };

const failure = (
  category: SecretTransferError["category"],
  operation: string,
  message: string,
): SecretTransferError => new SecretTransferError({ category, operation, message });

const checkedEndpoint = (
  endpoint: string,
): Effect.Effect<URL, SecretTransferError> =>
  Effect.try({
    try: () => {
      const url = new URL(endpoint);
      const loopback = url.hostname === "127.0.0.1"
        || url.hostname === "[::1]"
        || url.hostname === "::1";
      if (url.protocol !== "https:" || !loopback) {
        throw new Error("not loopback HTTPS");
      }
      return url;
    },
    catch: () =>
      failure(
        "transport",
        "validate secret source",
        "the secret source must use pinned loopback HTTPS",
      ),
  });

const inspectCertificate = (
  endpoint: URL,
  timeoutMilliseconds: number,
): Effect.Effect<PinnedCertificate, SecretTransferError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<PinnedCertificate>((resolveCertificate, rejectCertificate) => {
        const socket = tlsConnect({
          host: endpoint.hostname.replaceAll("[", "").replaceAll("]", ""),
          port: Number(endpoint.port),
          rejectUnauthorized: false,
          minVersion: "TLSv1.2",
        });
        socket.setTimeout(timeoutMilliseconds);
        socket.once("secureConnect", () => {
          try {
            const peer = socket.getPeerCertificate();
            if (peer.raw === undefined) {
              throw new Error("source did not provide a certificate");
            }
            const fingerprint = Schema.decodeUnknownSync(CertificateFingerprint)(
              createHash("sha256").update(peer.raw).digest("hex"),
            );
            const pem = new X509Certificate(peer.raw).toString();
            socket.end();
            resolveCertificate({ pem, fingerprint });
          } catch (cause) {
            socket.destroy();
            rejectCertificate(cause);
          }
        });
        socket.once("timeout", () => {
          socket.destroy(new Error("TLS connection timed out"));
        });
        socket.once("error", rejectCertificate);
      }),
    catch: () =>
      failure(
        "transport",
        "inspect secret source",
        "the secret source certificate could not be inspected",
      ),
  });

const requestSecrets = (
  endpoint: URL,
  certificate: PinnedCertificate,
  credential: Redacted.Redacted<string>,
  timeoutMilliseconds: number,
): Effect.Effect<SecretResponse, SecretTransferError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<SecretResponse>((resolveResponse, rejectResponse) => {
        const headers: OutgoingHttpHeaders = {
          accept: "application/json",
          authorization: `Bearer ${Redacted.value(credential)}`,
        };
        const request = httpsRequest({
          protocol: "https:",
          hostname: endpoint.hostname.replaceAll("[", "").replaceAll("]", ""),
          port: endpoint.port,
          path: "/v1/transport/secrets",
          method: "GET",
          ca: certificate.pem,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          headers,
        }, (response) => {
          const chunks: Array<Buffer> = [];
          let bytes = 0;
          let exceeded = false;
          response.on("data", (chunk: Buffer) => {
            if (exceeded) return;
            bytes += chunk.byteLength;
            if (bytes > maximumResponseBytes) {
              exceeded = true;
              request.destroy(new Error("secret response exceeds the size limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (exceeded) return;
            resolveResponse({
              status: response.statusCode ?? 500,
              body: Buffer.concat(chunks),
            });
          });
        });
        request.setTimeout(timeoutMilliseconds, () => {
          request.destroy(new Error("secret request timed out"));
        });
        request.once("error", rejectResponse);
        request.end();
      }),
    catch: () =>
      failure(
        "transport",
        "fetch shared secrets",
        "the secret source could not be reached",
      ),
  });

export const fetchSharedSecrets = (
  input: FetchSharedSecretsInput,
): Effect.Effect<FetchSharedSecretsResult, SecretTransferError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const endpoint = yield* checkedEndpoint(input.endpoint);
    const timeoutMilliseconds = input.timeoutMilliseconds
      ?? defaultTimeoutMilliseconds;
    const certificate = yield* inspectCertificate(endpoint, timeoutMilliseconds);
    if (certificate.fingerprint !== input.tlsFingerprint) {
      return yield* failure(
        "transport",
        "verify secret source",
        "the secret source TLS fingerprint does not match the pinned fingerprint",
      );
    }
    const credential = yield* machine.loadCredential({
      reference: input.credentialReference,
    }).pipe(
      Effect.mapError(() =>
        failure(
          "authentication",
          "authenticate secret transfer",
          "the follower credential is unavailable",
        )
      ),
    );
    const response = yield* requestSecrets(
      endpoint,
      certificate,
      credential,
      timeoutMilliseconds,
    );
    if (response.status === 404) return { status: "not-shared" };
    if (response.status === 401 || response.status === 403) {
      return yield* failure(
        "authentication",
        "authenticate secret transfer",
        "the source rejected the follower credential",
      );
    }
    if (response.status !== 200) {
      return yield* failure(
        "transport",
        "fetch shared secrets",
        `the source returned HTTP ${response.status}`,
      );
    }
    const payload = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(TransferredSecretsSchema)(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)),
        ),
      catch: () =>
        failure(
          "transport",
          "decode shared secrets",
          "the source returned invalid secret data",
        ),
    });
    return { status: "shared", payload };
  });

export const synchronizeSharedSecrets = (): Effect.Effect<
  SecretSynchronizationResult,
  SecretTransferError,
  MachineState | StateRepository
> =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const configuration = yield* repository
      .getFollowerSynchronizationConfiguration()
      .pipe(
        Effect.mapError(() =>
          failure(
            "state",
            "load follower configuration",
            "the follower synchronization configuration is unavailable",
          )
        ),
      );
    if (configuration === undefined) {
      return { status: "not-enrolled", secrets: [] };
    }
    const fetched = yield* fetchSharedSecrets({
      endpoint: configuration.source.endpoint,
      tlsFingerprint: configuration.source.tlsFingerprint,
      credentialReference: configuration.credentialReference,
      timeoutMilliseconds: configuration.scheduledInvocation.timeoutMilliseconds,
    });
    if (fetched.status === "not-shared") {
      return { status: "not-shared", secrets: [] };
    }
    const secrets = yield* applyTransferredSecrets(fetched.payload);
    return { status: "synchronized", secrets };
  });
