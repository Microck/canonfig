import { describe, expect, it } from "vitest";

import { CliExitCode } from "../../src/cli/exit-codes.ts";
import { isSecretField, redactArguments, redactText } from "../../src/cli/redaction.ts";
import { renderCliResult, renderUsageFailure, sanitizeCliData } from "../../src/cli/render.ts";

describe("credential-safe CLI output", () => {
  it("redacts equals-style and separate argv values without changing other arguments", () => {
    expect(redactArguments([
      "node", "server.js", "--password", "test-only two words", "--token=test-only-token", "--port", "9000",
    ])).toEqual([
      "node", "server.js", "--password", "[REDACTED]", "--token=[REDACTED]", "--port", "9000",
    ]);
  });

  it("recognizes environment names and preserves explicit credential references", () => {
    expect(isSecretField("SERVICE_API_KEY")).toBe(true);
    expect(isSecretField("clientSecret")).toBe(true);
    expect(isSecretField("credentialReference")).toBe(false);
    expect(sanitizeCliData({
      credentialReference: "keychain:reference-only",
      env: { SERVICE_API_KEY: "test-only-key", PATH: "/usr/bin" },
      environment: [{ name: "SERVICE_TOKEN", value: "test-only-value" }],
      headers: { Authorization: "Bearer test-only-bearer" },
    })).toEqual({
      credentialReference: "keychain:reference-only",
      env: { SERVICE_API_KEY: "[REDACTED]", PATH: "/usr/bin" },
      environment: [{ name: "SERVICE_TOKEN", value: "[REDACTED]" }],
      headers: { Authorization: "[REDACTED]" },
    });
  });

  it("redacts quoted values and URL credentials in free text", () => {
    const text = 'failed --password "test-only two words" https://user:pass@example.test/?api_key=test-only-key&port=9000';
    expect(redactText(text)).toBe('failed --password [REDACTED] https://[REDACTED]@example.test/?api_key=[REDACTED]&port=9000');
    expect(redactText('{"password":"test-only-json","port":9000}'))
      .toBe('{"password":"[REDACTED]","port":9000}');
  });

  it("redacts nested commands and discovery excerpts", () => {
    expect(sanitizeCliData({
      resources: [{ args: ["--password=test-only-argument"] }],
      evidence: [{ excerpt: "server --password=test-only-excerpt" }],
    })).toEqual({
      resources: [{ args: ["--password=[REDACTED]"] }],
      evidence: [{ excerpt: "server --password=[REDACTED]" }],
    });
  });

  it.each(["human", "json"] as const)("redacts %s result and usage messages", (format) => {
    const message = "Unknown argument: --password=test-only-message";
    const output = renderCliResult({
      command: "usage", message, exitCode: CliExitCode.usageOrConfiguration,
    }, format);
    expect(output).not.toContain("test-only-message");
    expect(output).toContain("[REDACTED]");
    expect(renderUsageFailure(message, format)).not.toContain("test-only-message");
  });

  it("does not mutate caller data and is idempotent", () => {
    const input = { args: ["--password=test-only-input"], credentialReference: "secret-service:reference" };
    const first = sanitizeCliData(input);
    expect(sanitizeCliData(first)).toEqual(first);
    expect(input.args).toEqual(["--password=test-only-input"]);
    const text = "password=[REDACTED] https://[REDACTED]@example.test/";
    expect(redactText(text)).toBe(text);
  });
});
