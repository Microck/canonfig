import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { enrolledFollowerRow, runtimeCredentialPolicy } from "../../src/runtime/credential-policy.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["secure-store", "local-file"] as const)("uses the enrolled %s policy before conflicting environment input", (kind) => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-policy-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const database = new DatabaseSync(path);
  const policy = kind === "secure-store" ? { kind } : { kind, path: join(root, "enrolled-credentials") };
  database.exec("CREATE TABLE follower_sync_configuration(singleton INTEGER, configuration_json TEXT)");
  database.prepare("INSERT INTO follower_sync_configuration VALUES (1, ?)").run(JSON.stringify({ credentialPolicy: policy }));
  database.close();
  vi.stubEnv("CANONFIG_LOCAL_CREDENTIAL_ROOT", join(root, "different-credentials"));
  expect(runtimeCredentialPolicy(path)).toEqual(policy);
});

it("uses explicit environment selection before enrollment", () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-policy-"));
  roots.push(root);
  const path = join(root, "credentials");
  vi.stubEnv("CANONFIG_LOCAL_CREDENTIAL_ROOT", path);
  expect(runtimeCredentialPolicy(join(root, "missing.sqlite"))).toEqual({ kind: "local-file", path });
});

it("rejects existing state that SQLite cannot open and accepts pre-enrollment state", () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-policy-"));
  roots.push(root);
  const state = join(root, "state.sqlite");
  expect(enrolledFollowerRow(state)).toBeUndefined();
  symlinkSync(join(root, "missing-target"), state, "file");
  expect(() => enrolledFollowerRow(state)).toThrow("unable to open database file");
  rmSync(state);
  new DatabaseSync(state).close();
  expect(enrolledFollowerRow(state)).toBeUndefined();
});
