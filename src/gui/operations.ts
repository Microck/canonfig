import { randomUUID } from "node:crypto";
import { Context, Effect, Schema, Scope } from "effect";
import { CliCommandFailure } from "../cli/source-commands.ts";
import { GuiOperation, type GuiOperationTicket } from "./contract.ts";
import { failureBody, type GuiRoute } from "./routing.ts";

export class GuiOperations extends Context.Service<GuiOperations, {
  readonly start: (
    operation: Effect.Effect<Schema.Json, CliCommandFailure>,
    journal: () => Effect.Effect<Schema.Json, CliCommandFailure>,
    onDelivered?: () => void,
  ) => Effect.Effect<GuiOperationTicket, CliCommandFailure>;
}>()("canonfig/gui/GuiOperations") {}

interface OperationRecord {
  snapshot: GuiOperation;
  readonly journal: () => Effect.Effect<Schema.Json, CliCommandFailure>;
  readonly onDelivered?: () => void;
}

/** HTTP disconnection does not cancel an apply. The GUI scope still owns its lifetime. */
export const makeGuiOperations = Effect.gen(function*() {
  // Register one child-scope finalizer before the HTTP listener is acquired.
  // Shutdown closes the listener first, then waits for non-cancellable work.
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit));
  const operations = new Map<string, OperationRecord>();
  const start = Effect.fn("GuiOperations.start")(function*(
    operation: Effect.Effect<Schema.Json, CliCommandFailure>,
    journal: () => Effect.Effect<Schema.Json, CliCommandFailure>,
    onDelivered?: () => void,
  ) {
    // Retain completed results until the server closes; never evict a ticket somebody is polling.
    if (operations.size >= 64) return yield* Effect.fail(new CliCommandFailure({
      category: "usage-or-configuration", message: "This GUI session has reached 64 operations. Restart canonfig ui before starting another operation.",
    }));
    const id = randomUUID();
    const entry: OperationRecord = { snapshot: { id, state: "running", journal: null }, journal, onDelivered };
    operations.set(id, entry);
    yield* operation.pipe(
      Effect.match({
        onSuccess: (result) => { entry.snapshot = { id, state: "succeeded", journal: null, result }; },
        onFailure: (error) => { entry.snapshot = { id, state: "failed", journal: null, failure: failureBody(error.category, error.message) }; },
      }),
      Effect.catchCause(() => Effect.sync(() => {
        entry.snapshot = { id, state: "failed", journal: null, failure: failureBody("internal", "The operation stopped unexpectedly. Inspect its journal before retrying.") };
      })),
      Effect.forkIn(scope),
    );
    return { id } satisfies GuiOperationTicket;
  });
  const route: GuiRoute = {
    method: "GET",
    matches: (pathname) => /^\/api\/operations\/[^/]+$/u.test(pathname),
    handle: (_request, url) => Effect.gen(function*() {
      const id = decodeURIComponent(url.pathname.slice("/api/operations/".length));
      const entry = operations.get(id);
      if (entry === undefined) return yield* Effect.fail(new CliCommandFailure({
        category: "usage-or-configuration", message: "Unknown operation. Tickets belong to the running GUI session.",
      }));
      const journal = yield* entry.journal();
      return { ...entry.snapshot, journal };
    }),
    afterResponse: (body) => {
      if (Schema.is(GuiOperation)(body) && body.state === "succeeded") {
        operations.get(body.id)?.onDelivered?.();
      }
    },
  };
  return { start, route, running: () => [...operations.values()].some((entry) => entry.snapshot.state === "running") };
});
