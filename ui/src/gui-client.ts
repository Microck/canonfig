import * as Schema from "effect/Schema";
import { GuiError, GuiSession, GuiStatus, GuiOperation, guiEndpoints, guiMutationHeader, guiMutationValue, operationPath } from "../../src/gui/contract";

export type { GuiSession, GuiStatus, GuiOperation } from "../../src/gui/contract";


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
export async function request<T>(url: string, schema: Schema.Codec<T>, signal: AbortSignal, mutation?: {
  method: "POST" | "PUT" | "DELETE"; body: unknown;
}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: mutation?.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: mutation === undefined ? { Accept: "application/json" } : {
        Accept: "application/json", "Content-Type": "application/json", [guiMutationHeader]: guiMutationValue,
      },
      ...(mutation === undefined ? {} : { body: JSON.stringify(mutation.body) }),
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

/** Screens receive this interface as a prop; production never imports the demo store. */
export interface WorkspaceBackend {
  readonly session: (signal: AbortSignal) => Promise<GuiSession>;
  readonly status: (signal: AbortSignal) => Promise<GuiStatus>;
  readonly request: typeof request;
  readonly operation: (id: string, signal: AbortSignal) => Promise<GuiOperation>;
}

export const httpBackend: WorkspaceBackend = {
  session: (signal) => request(guiEndpoints.session, GuiSession, signal),
  status: (signal) => request(guiEndpoints.status, GuiStatus, signal),
  request,
  operation: (id, signal) => request(operationPath(id), GuiOperation, signal),
};
