import { describe, expect, it } from "vitest";

import { CliExitCode } from "../../src/cli/exit-codes.ts";
import { redactArguments, redactText } from "../../src/cli/redaction.ts";
import { isSecretField } from "../../src/secrets/credential-policy.ts";
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
    expect(sanitizeCliData({ env: { API_KEY: "${env:API_KEY}" } }))
      .toEqual({ env: { API_KEY: "${env:API_KEY}" } });
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

  it("shows a value that only names an environment variable, and still redacts literals", () => {
    expect(sanitizeCliData({
      headers: { Authorization: "Bearer ${API_TOKEN}", "X-Api-Key": "{env:SERVICE_KEY}" },
      env: { GITHUB_TOKEN: "$GITHUB_TOKEN", OTHER_TOKEN: "Bearer ${API_TOKEN}-suffix" },
    })).toEqual({
      env: { GITHUB_TOKEN: "$GITHUB_TOKEN", OTHER_TOKEN: "[REDACTED]" },
      headers: { Authorization: "Bearer ${API_TOKEN}", "X-Api-Key": "{env:SERVICE_KEY}" },
    });
  });

  it("redacts quoted values and URL credentials in free text", () => {
    const text = 'failed --password "test-only two words" https://user:pass@example.test/?api_key=test-only-key&port=9000';
    // The URL password is literally 'pass': do not exempt its occurrence in
    // an apparent flag name from known-secret masking. Native argv is untouched.
    expect(redactText(text)).toBe('failed --[REDACTED]word [REDACTED] https://[REDACTED]@example.test/?api_key=[REDACTED]&port=9000');
    expect(redactText(text)).not.toContain('pass');
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
  it.each(["foo[REDACTED]bar", "[REDACTED]suffix", "prefix[REDACTED]"])("scrubs credentials containing marker text: %s", (value) => {
    expect(redactText(JSON.stringify({ token: value, arbitrary: value }))).toBe(JSON.stringify({ token: "[REDACTED]", arbitrary: "[REDACTED]" }));
    expect(redactText(`arbitrary=${value}`, [value])).toBe("arbitrary=[REDACTED]");
  });

  it.each([
    ["ED]foo", "[REDACTED]foo"],
    ["foo[RED", "foo[REDACTED]"],
    ["]x[", "[REDACTED]x[REDACTED]"],
  ])("scrubs credentials crossing marker boundaries: %s", (value, note) => {
    expect(redactText(JSON.stringify({ password: value, note }))).toBe(JSON.stringify({ password: "[REDACTED]", note: "[REDACTED]" }));
  });

  it("scrubs a known credential crossing an assignment prefix", () => {
    const output = redactText(JSON.stringify({ password: "foo password", note: "foo password=x" }));
    expect(output).not.toContain("foo password");
  });

  it("collects repeated credentials from malformed URL userinfo", () => {
    const secret = "sec\\ret";
    const output = redactText(`https://user:${secret}@host args: ["${secret}"]`);
    expect(output).not.toContain(secret);
  });

  it("redacts whole credentials before rewriting their embedded syntax", () => {
    const value = "prefix password=x suffix";
    const output = redactText(JSON.stringify({ token: value, note: value }));
    expect(output).toBe(JSON.stringify({ token: "[REDACTED]", note: "[REDACTED]" }));
  });

  it("coalesces repeated short credentials without expanding output", () => {
    const output = redactText(JSON.stringify({ password: "a", note: "a".repeat(256 * 1024) }));
    expect(output.length).toBeLessThan(100);
    expect(output).toContain('"note":"[REDACTED]"');
  });

  it("redacts a literal even when it equals an assignment prefix", () => {
    expect(redactText("token: password=\nnote: password=x")).not.toContain("password=");
  });

  it("handles many repeated assignments without expanding their values", () => {
    const output = redactText("password=a\n".repeat(5000));
    expect(output.length).toBeLessThan(200000);
    expect(output).not.toContain("=a");
  });

  it.each([
    '{"password":"secret","note":"se\\u0063ret"}',
    '{"password":"se\\u0063ret","note":"secret"}',
    '{"password":"secret","note":"prefix se\\u0063ret suffix"}',
  ])("redacts equivalent JSON string spellings: %s", (input) => {
    const output = JSON.parse(redactText(input));
    expect(output.password).toBe("[REDACTED]");
    expect(output.note).toBe("[REDACTED]");
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


describe("symbolic credential references", () => {
  it.each([
    '"API_KEY": "${TEST_API_KEY}"',
    'Authorization: Bearer ${DOCS_TOKEN}',
    "GITHUB_TOKEN='$GITHUB_TOKEN'",
    '--api-key "{env:SERVICE_KEY}"',
    'https://${API_TOKEN}@example.test',
    'https://${API_USER}:${API_TOKEN}@example.test',
    'https://%24%7BAPI_TOKEN%7D@example.test',
  ])("preserves a symbolic credential binding in human text: %s", (value) => {
    expect(redactText(value)).toBe(value);
  });
  it("still redacts literal suffixes beside environment syntax", () => {
    expect(redactText('"API_KEY": "${TEST_API_KEY}-literal-secret"')).not.toContain("literal-secret");
  });
});


describe("recognized literals across free-text output", () => {
  it("scrubs a discovered credential from non-secret-shaped fields too", () => {
    const text = JSON.stringify({ API_KEY: "synthetic-reused-value", args: ["synthetic-reused-value"], plain: "keep-me" });
    const result = redactText(text);
    expect(result).not.toContain("synthetic-reused-value");
    expect(result).toContain("keep-me");
  });
  it("scrubs escaped and header-token repetitions", () => {
    const value = 'synthetic-quote"slash\\value';
    const text = JSON.stringify({ API_KEY: value, args: [value], Authorization: "Bearer synthetic-header-token", echo: "synthetic-header-token" });
    const result = redactText(text);
    expect(result).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(result).not.toContain("synthetic-header-token");
  });
});


it("does not re-expand redaction markers for short recognized values", () => {
  const once = redactText("password=R echo R");
  expect(once).toBe("password=[REDACTED] echo [REDACTED]");
  expect(redactText(once, ["R"])).toBe(once);
});

it("scrubs repeated credentials from hostless URL userinfo", () => {
  expect(redactText('https://user:synthetic-url-secret@ args: ["synthetic-url-secret"]'))
    .not.toContain("synthetic-url-secret");
});

it("redacts large private keys without compiling an unbounded regex", () => {
  const key = `${keyBlockMarker("BEGIN")}\n${"aB3d".repeat(12000)}\n${keyBlockMarker("END")}`;
  expect(redactText(key)).toBe("[REDACTED]");
  expect(redactText(`key-copy: ${key}`, [key])).toBe("key-copy: [REDACTED]");
});

it("collects escaped JSON credential keys before masking repeated values", () => {
  const text = String.raw`{"pass\u0077ord":"synthetic-escaped-key","note":"synthetic-escaped-key","other":"synthetic-escaped-\u006bey"}`;
  const output = redactText(text);
  expect(output).not.toContain("synthetic-escaped");
  expect(JSON.parse(output).note).toBe("[REDACTED]");
});

it("preserves symbolic values and ordinary escaped JSON keys", () => {
  const text = '{"API_\\u004bEY":"${TEST_API_KEY}","na\\u006de":"ordinary-value"}' ;
  expect(redactText(text)).toBe(text);
});

it.each(["${X}", "${env:X}", "{env:X}"])("redacts unquoted symbolic-prefix credentials with literal suffixes: %s", (reference) => {
  const value = `${reference}synthetic-literal-suffix`;
  for (const text of [`API_KEY=${value}`, `Authorization: Bearer ${value}`, `password=${value} args: [${JSON.stringify(value)}]`]) {
    const output = redactText(text);
    expect(output).not.toContain("synthetic-literal-suffix");
    expect(output).toContain("[REDACTED]");
  }
  expect(redactText(`API_KEY=${reference}`)).toBe(`API_KEY=${reference}`);
});


it.each(["true", "false", "null", "0", "1", "1234", "-12.5e+3"])("does not promote JSON scalar %s into an output-wide secret", (scalar) => {
  const output = redactText(`{"api_key":${scalar},"ordinary":${scalar},"path":"/opt/${scalar}view"}`);
  expect(JSON.parse(output).api_key).toBe("[REDACTED]");
  expect(output).toContain(`"ordinary":${scalar}`);
  expect(output).toContain(`"path":"/opt/${scalar}view"`);
});

it("still masks quoted numeric credentials and unquoted PIN-like values everywhere", () => {
  expect(redactText('{"api_key":"1234","echo":"1234"}')).not.toContain("1234");
  expect(redactText("PASSWORD=1234 echo 1234")).not.toContain("1234");
});


it("masks non-string JSON values under escaped credential keys without breaking JSON", () => {
  const output = redactText(String.raw`{"api_\u006bey":1234,"ordinary":1234,"enabled":true}`);
  expect(JSON.parse(output)).toEqual({ api_key: "[REDACTED]", ordinary: 1234, enabled: true });
});


it.each(["agent.harness.get", "agent.harness.set"])("preserves public binding names only in %s", (command) => {
  const data = {
    executable: "/usr/bin/npm", allowedPaths: ["/home/me/npm-cache"], allowedExecutables: ["npm"],
    secretBindings: [{ name: "NPM_TOKEN", secret: "npm" }, { name: "MCP_TOKEN", secret: "shared-mcp-token" }],
    nested: { secret: "test-only-sensitive-value" },
  };
  for (const format of ["human", "json"] as const) {
    const output = renderCliResult({ command, message: "Configured npm", exitCode: 0, data }, format);
    expect(output).toContain("/usr/bin/npm");
    expect(output).toContain("/home/me/npm-cache");
    expect(output).toContain("shared-mcp-token");
    expect(output).not.toContain("test-only-sensitive-value");
    if (format === "json") expect(JSON.parse(output).data.secretBindings).toEqual(data.secretBindings);
    else expect(output).toContain("secret: npm");
  }
});

it("does not exempt unrelated, nested, or explicitly known secrets", () => {
  const data = { secretBindings: [{ name: "MCP_TOKEN", secret: "test-only-bound-name", nested: { secret: "test-only-nested" } }] };
  const unrelated = renderCliResult({ command: "status", message: "status", exitCode: 0, data }, "json");
  expect(unrelated).not.toContain("test-only-bound-name");
  const harness = renderCliResult({ command: "agent.harness.get", message: "harness", exitCode: 0, data }, "json", ["test-only-bound-name"]);
  expect(harness).not.toContain("test-only-bound-name");
  expect(harness).not.toContain("test-only-nested");
  expect(sanitizeCliData(data)).toMatchObject({ secretBindings: [{ secret: "[REDACTED]" }] });
});
