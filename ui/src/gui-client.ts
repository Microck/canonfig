import * as Schema from "effect/Schema";
import { GuiError, GuiSession, GuiStatus, guiEndpoints } from "../../src/gui/contract";

export type { GuiSession, GuiStatus } from "../../src/gui/contract";


export class GuiRequestError extends Error {
  readonly failure: GuiError;
  readonly httpStatus: number | undefined;

  constructor(failure: GuiError, httpStatus?: number) {
    super(failure.message);
    this.name = "GuiRequestError";
    this.failure = failure;
    this.httpStatus = httpStatus;
  }
}

/** Decode only at the HTTP boundary. The browser never imports command services or demo state. */
async function get<T>(url: string, schema: Schema.Codec<T>, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new GuiRequestError({
      category: "transport",
      exitCode: 6,
      message: "Cannot reach Canonfig. Keep canonfig ui running in your terminal, then reload.",
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new GuiRequestError({
      category: "internal",
      exitCode: 1,
      message: `${url} did not return readable JSON. Restart canonfig ui and open its new browser URL.`,
    }, response.status);
  }

  if (!response.ok) {
    const failure = Schema.decodeUnknownResult(GuiError)(body);
    if (failure._tag === "Success") throw new GuiRequestError(failure.success, response.status);
    throw new GuiRequestError({
      category: "internal",
      exitCode: 1,
      message: `${url} returned HTTP ${response.status} without a valid Canonfig error. Restart canonfig ui and open its new browser URL.`,
    }, response.status);
  }

  const decoded = Schema.decodeUnknownResult(schema)(body);
  if (decoded._tag === "Failure") {
    throw new GuiRequestError({
      category: "internal",
      exitCode: 1,
      message: `${url} returned data that does not match this GUI version. Restart canonfig ui and open its new browser URL.`,
    }, response.status);
  }
  return decoded.success;
}

export const httpBackend = {
  session: (signal: AbortSignal) => get(guiEndpoints.session, GuiSession, signal),
  status: (signal: AbortSignal) => get(guiEndpoints.status, GuiStatus, signal),
};
