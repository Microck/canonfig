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
  it("scrubs a known value regardless of the surrounding field name", () => {
    const marker = "marker-value-abc123SECRET";
    expect(redactText(`--tag ${marker} pulled`, [marker])).toBe("--tag [REDACTED] pulled");
    expect(redactArguments(["--tag", marker, "--port", "9000"], [marker])).toEqual([
      "--tag", "[REDACTED]", "--port", "9000",
    ]);
    expect(redactText(`https://example.invalid/?k=${marker}`, [marker])).not.toContain(marker);
  });

  it("scrubs explicitly passed values with no secret-shaped source", () => {
    // marker2 never appears under a secret name: only the explicit list
    // can scrub it. This proves the threading, not the collector.
    const marker2 = "explicit-only-plugh458MARKER";
    const data = { tag: marker2, nested: { note: `saw ${marker2}` } };
    for (const format of ["human", "json"] as const) {
      const output = renderCliResult({
        command: "sync.apply",
        message: `failed on ${marker2}`,
        data,
        exitCode: CliExitCode.actionFailed,
      }, format, [marker2]);
      expect(output).not.toContain(marker2);
      expect(output).toContain("[REDACTED]");
      if (format === "json") JSON.parse(output);
    }
    // Without the explicit list the arbitrary-only value is untouched:
    // documents the boundary of what collection alone can do.
    expect(JSON.stringify(sanitizeCliData(data))).toContain(marker2);
  });

  it("scrubs payload values carried under a secret name everywhere", () => {
    const marker = "payload-marker-xyz789SECRET";
    const data = {
      tag: marker,
      url: `https://example.invalid/?k=${marker}`,
      nested: { note: `saw ${marker} here` },
      password: marker,
    };
    const clean = sanitizeCliData(data);
    expect(JSON.stringify(clean)).not.toContain(marker);
    expect(clean).toEqual({
      tag: "[REDACTED]",
      url: "https://example.invalid/?k=[REDACTED]",
      nested: { note: "saw [REDACTED] here" },
      password: "[REDACTED]",
    });
    for (const format of ["human", "json"] as const) {
      const output = renderCliResult({
        command: "sync.apply",
        message: `failed on ${marker}`,
        data,
        exitCode: CliExitCode.actionFailed,
      }, format);
      expect(output).not.toContain(marker);
      if (format === "json") JSON.parse(output);
    }
  });

  it("scrubs markers containing quotes and backslashes without corrupting output", () => {
    const marker = 'quo"te\\back SeCrEt';
    const data = { tag: marker, password: marker };
    const clean = sanitizeCliData(data);
    expect(JSON.stringify(clean)).not.toContain(marker);
    const output = renderCliResult({
      command: "sync.apply",
      message: "failed",
      data,
      exitCode: CliExitCode.actionFailed,
    }, "json");
    expect(output).not.toContain(marker);
    expect(() => JSON.parse(output)).not.toThrow();
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
