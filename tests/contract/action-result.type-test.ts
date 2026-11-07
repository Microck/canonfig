import type { ActionResult } from "../../src/synchronization/executor.ts";

declare const acceptResult: (result: ActionResult) => void;

// These calls are checked by TypeScript only, never executed.
// @ts-expect-error a failed action requires its reason and rollback state
acceptResult({ kind: "failed" });
// @ts-expect-error a human blocker requires its actionable payload
acceptResult({ kind: "human" });
// @ts-expect-error a drift blocker requires its conflict evidence
acceptResult({ kind: "drift" });
// @ts-expect-error a verified action cannot smuggle in a failure reason
acceptResult({ kind: "verified", reason: "stopped" });

acceptResult({ kind: "verified" });
acceptResult({ kind: "failed", reason: "preparation refused", rollbackState: { _tag: "NotRequired" } });
acceptResult({ kind: "human", human: { reason: "login required", instructions: "Sign in and retry." } });
