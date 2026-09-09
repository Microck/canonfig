import { describe, expect, it } from "vitest";

import { CliExitCode } from "../src/cli/exit-codes.ts";
import { renderCliResult, renderUsageFailure, sanitizeCliData } from "../src/cli/render.ts";
import { redactDiagnosticText } from "../src/logging/diagnostic-redaction.ts";

const secret = "disposable-redaction-fixture";

describe("installation diagnostic redaction", () => {
  it.each([
    `--password=${secret}`,
    `--password ${secret}`,
    `--api-key '${secret} with spaces'`,
    `GITHUB_TOKEN=${secret}`,
    `https://user:${secret}@example.invalid/path`,
    `https://user:${secret}@mail@example.invalid/path`,
    `https://example.invalid/path?api_key=${secret}&limit=1`,
    `Authorization: Bearer ${secret}`,
    `Proxy-Authorization: Basic ${secret}`,
    `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
  ])("redacts text and remains idempotent: %s", (input) => {
    const result = redactDiagnosticText(input);
    expect(result).not.toContain(secret);
    expect(result).toContain("[REDACTED]");
    expect(redactDiagnosticText(result)).toBe(result);
  });

  it("redacts separate argv values and nested environment/header fields without mutation", () => {
    const value = {
      args: ["--password", secret, "--timeout", "5"],
      env: { GITHUB_TOKEN: secret, PATH: "/usr/bin" },
      headers: { Authorization: `Bearer ${secret}` },
      credentialReference: "keychain:fixture",
      maximumSecretBytes: 16384,
    };
    expect(sanitizeCliData(value)).toEqual({
      args: ["--password", "[REDACTED]", "--timeout", "5"],
      env: { GITHUB_TOKEN: "[REDACTED]", PATH: "/usr/bin" },
      headers: { Authorization: "[REDACTED]" },
      credentialReference: "keychain:fixture",
      maximumSecretBytes: 16384,
    });
    expect(value.args[1]).toBe(secret);
    expect(value.env.GITHUB_TOKEN).toBe(secret);
  });

  it.each(["human", "json"] as const)("redacts errors before %s rendering", (format) => {
    const result = renderCliResult({
      command: "doctor",
      message: `failed --password=${secret}`,
      exitCode: CliExitCode.usageOrConfiguration,
      data: { stderr: `Authorization: Bearer ${secret}` },
    }, format);
    expect(result).not.toContain(secret);
    expect(renderUsageFailure(`Unknown argument: --password=${secret}`, format)).not.toContain(secret);
  });

  it("preserves non-secret reference and capability diagnostics", () => {
    const input = "credentialReference=keychain:fixture maximumSecretBytes=16384";
    expect(redactDiagnosticText(input)).toBe(input);
  });
});
