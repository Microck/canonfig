import { Effect } from "effect";
import type { RunId } from "../domain/brand.ts";
import { InvalidRunTransitionError } from "./state-repository.errors.ts";
import type { ActionJournalRecord, ActionLifecycle } from "./state-repository.types.ts";

type ActionEvent = Pick<ActionJournalRecord, "action" | "state" | "attempt" | "verification" | "rollbackReference">;

/** Decode the normalized SQL variant without inventing missing evidence. */
export const actionLifecycle = (run: RunId, event: ActionEvent): Effect.Effect<ActionLifecycle, InvalidRunTransitionError> => Effect.gen(function*() {
  const invalid = () => new InvalidRunTransitionError({ run, message: `action ${event.action} lacks evidence required by ${event.state}` });
  switch (event.state) {
    case "pending":
      if (event.attempt !== 0) return yield* invalid();
      return { _tag: "Pending", attempt: 0 };
    case "running": return { _tag: "Running", attempt: event.attempt, rollbackReference: event.rollbackReference };
    case "succeeded":
      if (event.verification?.status !== "passed") return yield* invalid();
      return { _tag: "Succeeded", attempt: event.attempt, verification: event.verification };
    case "failed":
      if (event.verification === undefined) return yield* invalid();
      return { _tag: "Failed", attempt: event.attempt, verification: event.verification };
    case "blocked": return { _tag: "Blocked", attempt: event.attempt };
    case "interrupted": return { _tag: "Interrupted", attempt: event.attempt, rollbackReference: event.rollbackReference };
    case "rolled-back": return { _tag: "RolledBack", attempt: event.attempt };
  }
});

/** Validate the same durable event sequence before a write and during replay. */
export const transitionAction = (
  run: RunId,
  previous: ActionLifecycle | undefined,
  event: ActionEvent,
): Effect.Effect<ActionLifecycle, InvalidRunTransitionError> => Effect.gen(function*() {
  const invalid = (message: string) => new InvalidRunTransitionError({ run, message: `action ${event.action}: ${message}` });
  if (event.state === "pending") {
    if (previous !== undefined || event.attempt !== 0) return yield* invalid("pending must be the first event at attempt zero");
    return { _tag: "Pending", attempt: 0 };
  }
  if (previous === undefined || !Number.isInteger(event.attempt) || event.attempt < 1 || event.attempt < previous.attempt) {
    return yield* invalid("invalid attempt ordering");
  }
  const sameAttempt = event.attempt === previous.attempt;
  if (sameAttempt && previous._tag !== "Running" && !(["Succeeded", "Failed", "Interrupted"].includes(previous._tag) && event.state === "rolled-back")) {
    return yield* invalid(`cannot transition ${previous._tag} to ${event.state} within the same attempt`);
  }
  if (event.attempt > previous.attempt && previous._tag === "Running") {
    // Recovery may restart an attempt interrupted before its final event.
    if (event.state !== "running" && event.state !== "interrupted" && event.state !== "blocked" && event.state !== "succeeded") {
      return yield* invalid("an uncertain attempt must be inspected before retrying");
    }
  }
  switch (event.state) {
    case "running": return { _tag: "Running", attempt: event.attempt, rollbackReference: event.rollbackReference };
    case "succeeded":
      if (event.verification?.status !== "passed") return yield* invalid("success requires passed verification evidence");
      if (previous._tag !== "Running" && previous._tag !== "Succeeded" && previous._tag !== "Interrupted" && previous._tag !== "Blocked") return yield* invalid("success requires a running or inspected attempt");
      return { _tag: "Succeeded", attempt: event.attempt, verification: event.verification };
    case "failed":
      if (event.verification === undefined) return yield* invalid("failure requires verification evidence");
      return { _tag: "Failed", attempt: event.attempt, verification: event.verification };
    case "blocked": return { _tag: "Blocked", attempt: event.attempt };
    case "interrupted": return { _tag: "Interrupted", attempt: event.attempt, rollbackReference: event.rollbackReference };
    case "rolled-back":
      if (previous._tag !== "Succeeded" && previous._tag !== "Failed" && previous._tag !== "Interrupted") return yield* invalid("rollback requires an executed attempt");
      return { _tag: "RolledBack", attempt: event.attempt };
  }
});
