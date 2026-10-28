import { Effect } from "effect";

/** Runtime interruption must wait for the command's asynchronous cleanup. */
export const runCancellablePromise = (run: (signal: AbortSignal) => Promise<void>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      return { controller, completed: run(controller.signal) };
    }),
    ({ completed }) => Effect.promise(() => completed),
    ({ controller, completed }) => Effect.promise(async () => {
      controller.abort();
      await completed;
    }),
  );
