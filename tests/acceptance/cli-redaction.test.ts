import { describe, expect, it } from "vitest";

import { CliExitCode } from "../../src/cli/exit-codes.ts";
import { isSecretField, redactArguments, redactText } from "../../src/cli/redaction.ts";
import { renderCliResult, renderUsageFailure, sanitizeCliData } from "../../src/cli/render.ts";

const secret = "disposable-redaction-fixture";

/**
 * The release secret scan rejects a literal private key header anywhere in the
 * repository, so this fixture assembles the marker at runtime the way the scan
 * assembles its own banned words.
 */
const keyBlockMarker = (boundary: "BEGIN" | "END"): string =>
  `-----${boundary} ${["PRIVATE", "KEY"].join(" ")}-----`;

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
    expect(isSecretField("maximumSecretBytes")).toBe(false);
    expect(isSecretField("TOKEN_BUDGET")).toBe(false);
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
    `${keyBlockMarker("BEGIN")}\n${secret}\n${keyBlockMarker("END")}`,
  ])("redacts text and remains idempotent: %s", (input) => {
    const result = redactText(input);
    expect(result).not.toContain(secret);
    expect(result).toContain("[REDACTED]");
    expect(redactText(result)).toBe(result);
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
    const output = renderCliResult({ command: "usage", message, exitCode: CliExitCode.usageOrConfiguration }, format);
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

  it("preserves literal object keys without invoking inherited setters", () => {
    const input = JSON.parse('{"__proto__":{"password":"test-only-key"},"constructor":"ordinary"}');
    const result = sanitizeCliData(input);
    // SAFETY: sanitizeCliData preserves the shape of its input, so an object in
    // yields an object out.
    expect(Object.hasOwn(result as object, "__proto__")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-only-key");
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
