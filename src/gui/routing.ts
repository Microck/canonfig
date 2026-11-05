import type { IncomingMessage } from "node:http";
import { Effect, Schema } from "effect";
import { exitCodeForFailure, type CliFailureCategory } from "../cli/exit-codes.ts";
import { describeRuntimeError, type TaggedRuntimeError } from "../cli/failure-taxonomy.ts";
import { redactText } from "../cli/redaction.ts";
import { CliCommandFailure } from "../cli/source-commands.ts";
import type { GuiError } from "./contract.ts";

export const failureBody = (category: CliFailureCategory, message: string): GuiError => ({
  category, message: redactText(message), exitCode: exitCodeForFailure(category),
});

/** Reuse CLI classification for authoring and other domain errors at route boundaries. */
export const commandFailure = (error: TaggedRuntimeError): CliCommandFailure =>
  error instanceof CliCommandFailure ? error : new CliCommandFailure(describeRuntimeError(error));

export interface GuiRoute {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** Exact pathname or a matcher returning decoded, schema-validated parameters in the handler. */
  readonly matches: (pathname: string) => boolean;
  readonly handle: (request: IncomingMessage, url: URL) => Effect.Effect<Schema.Json, CliCommandFailure>;
  readonly status?: number;
}

export const queryRoute = <A extends Schema.Json>(path: string, query: () => Effect.Effect<A, CliCommandFailure>): GuiRoute => ({
  method: "GET", matches: (pathname) => pathname === path, handle: query,
});

const requestBody = (request: IncomingMessage) => Effect.tryPromise({
  try: async () => {
    const chunks: Array<Buffer> = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 1024 * 1024) throw new Error("Request body exceeds 1 MiB.");
      chunks.push(bytes);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body;
  },
  catch: (cause) => new CliCommandFailure({
    category: "usage-or-configuration",
    message: cause instanceof Error ? `Invalid JSON request: ${cause.message}` : "Invalid JSON request.",
  }),
});

/** The server enforces session, same origin, custom header and JSON before dispatch. */
export const mutationRoute = <A, B extends Schema.Json>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  schema: Schema.Codec<A>,
  operation: (input: A) => Effect.Effect<B, CliCommandFailure>,
  status = 200,
): GuiRoute => ({
  method, matches: (pathname) => pathname === path, status,
  handle: (request) => requestBody(request).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error" })),
    Effect.mapError((error) => error instanceof CliCommandFailure ? error : new CliCommandFailure({
      category: "usage-or-configuration", message: `Invalid request: ${error.message}`,
    })),
    Effect.flatMap(operation),
  ),
});
