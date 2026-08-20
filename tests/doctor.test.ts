import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { doctorProbeNames } from "../src/runtime/doctor.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeEntrypoint = resolve(projectRoot, "src/runtime/main.ts");

const executeDoctor = (
  home: string,
  arguments_: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = {},
) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", runtimeEntrypoint, "doctor", ...arguments_],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, ...environment, HOME: home },
      timeout: 60_000,
    },
  );

describe("doctor probes", () => {
  it("reports every typed probe deterministically without prompting", () => {
    const home = mkdtempSync(resolve(tmpdir(), "canonfig-doctor-"));
    const result = executeDoctor(
      home,
      ["--json", "--no-input", "--timeout-ms", "2000"],
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "doctor",
      status: "success",
      exitCode: 0,
      data: {
        schema: "canonfig.doctor/v1",
        noInput: true,
        timeoutMilliseconds: 2000,
      },
    });
    expect(envelope.data.probes.map((probe: { name: string }) => probe.name))
      .toEqual(doctorProbeNames);
    expect(envelope.data.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "state",
        status: "pass",
        details: expect.objectContaining({
          header: "valid",
          migrations: "current",
          readWrite: true,
        }),
      }),
      expect.objectContaining({ name: "credentials" }),
      expect.objectContaining({ name: "source" }),
      expect.objectContaining({ name: "scheduler" }),
      expect.objectContaining({ name: "package-managers" }),
      expect.objectContaining({ name: "agent-adapter" }),
    ]));
  });

  it("isolates a bounded source failure and reports remaining probes", () => {
    const home = mkdtempSync(resolve(tmpdir(), "canonfig-doctor-failure-"));
    const secret = "must-not-leak-doctor-secret";
    const result = executeDoctor(
      home,
      ["--json", "--no-input", "--timeout-ms", "2000"],
      {
        CANONFIG_SOURCE_ENDPOINT: "https://127.0.0.1:9",
        CANONFIG_SOURCE_TLS_FINGERPRINT: "configured-fingerprint",
        CANONFIG_SOURCE_CREDENTIAL_REFERENCE: secret,
      },
    );
    expect(result.status).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(secret);
    const envelope = JSON.parse(result.stderr);
    expect(envelope).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "doctor",
      status: "error",
      exitCode: 5,
      data: {
        schema: "canonfig.doctor/v1",
        status: "unhealthy",
      },
    });
    expect(envelope.data.probes).toHaveLength(doctorProbeNames.length);
    expect(envelope.data.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "source",
        status: "fail",
        category: "authentication-or-revocation",
      }),
      expect.objectContaining({ name: "agent-adapter" }),
    ]));
  });

  it("rejects invalid timeouts before constructing runtime layers", () => {
    const home = mkdtempSync(resolve(tmpdir(), "canonfig-doctor-invalid-"));
    const result = executeDoctor(home, ["--timeout-ms", "0"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid doctor timeout: 0");
  });
});
