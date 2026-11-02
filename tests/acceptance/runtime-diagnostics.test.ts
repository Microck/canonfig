import { Cause } from "effect";
import { expect, it } from "vitest";
import { renderCliResult } from "../../src/cli/render.ts";
import { runtimeFailureResult } from "../../src/runtime/failure-output.ts";
import { StateInitializationError } from "../../src/runtime/state-initialization.errors.ts";

it("keeps unexpected causes private by default and exposes redacted opt-in diagnostics in one envelope", () => {
  const cause = Cause.die(new Error("fixture defect password=synthetic-debug-credential"));
  const quiet = renderCliResult(runtimeFailureResult(cause, "status", false), "json");
  expect(quiet).not.toContain("fixture defect");
  expect(JSON.parse(quiet)).toMatchObject({ command: "status", exitCode: 1 });
  const verbose = renderCliResult(runtimeFailureResult(cause, "status", true), "json");
  expect(JSON.parse(verbose).data.diagnostic).toContain("fixture defect");
  expect(verbose).not.toContain("synthetic-debug-credential");
  expect(verbose).toContain("[REDACTED]");
  expect(verbose.trim().split("\n")).toHaveLength(1);
});

it("keeps actionable state failures unchanged even with diagnostics enabled", () => {
  const cause = Cause.fail(new StateInitializationError({ path: "/fixture/state", message: "Keep the state and repair permissions." }));
  expect(runtimeFailureResult(cause, "status", true)).toEqual(runtimeFailureResult(cause, "status", false));
});
