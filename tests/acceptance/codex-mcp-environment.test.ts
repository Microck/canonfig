import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkMcpEntries, readHarnessMcpEntries } from "../../src/runtime/mcp-check.ts";

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Codex Windows MCP startup environment", () => {
  it("launches with only Codex defaults and explicitly configured variables", async () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-codex-windows-env-"));
    homes.push(home);
    const script = join(home, "windows-env.cjs");
    const certificatePath = String.raw`\\?\C:\certs\sub\..\root.pem`;
    const relativeCertificate = "relative-ca.pem";
    writeFileSync(script, `
const assert = require("node:assert/strict");
const keys = Object.keys(process.env);
assert.equal(process.env.PATHEXT, ".EXE;.CMD");
assert.equal(process.env.FIXTURE_API_TOKEN, "literal-override");
assert.equal(process.env.OPENAI_IDENTITY_TOKEN_FILE, undefined);
assert.equal(process.env.PARENT_ONLY, undefined);
assert.equal(process.env.REQUESTS_CA_BUNDLE, ${JSON.stringify(certificatePath)});
assert.equal(process.env.PIP_CERT, ${JSON.stringify(win32.resolve(home, relativeCertificate))});
assert.equal(process.env.LOGONSERVER, undefined);
assert.equal(process.env.NODE_V8_COVERAGE, undefined);
assert.equal(process.env.FORWARDED_ONLY, "forwarded-value");
assert.equal(keys.filter((key) => /^fixture_api_token$/i.test(key)).length, 1);
// Windows keeps a process's working directory locked until it leaves.
process.chdir(require("node:path").dirname(process.execPath));
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  if (message.method === "tools/list") reply(message.id, { tools: [{ name: "one" }, { name: "two" }] });
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), `
[mcp_servers.windows]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(script)}]
env_vars = [{name = "Fixture_Api_Token", source = "local"}, "forwarded_only", "OpenAI_Identity_Token_File"]
[mcp_servers.windows.env]
fixture_api_token = "literal-override"
OPENAI_IDENTITY_TOKEN_FILE = "blocked-explicit-value"
`);
    const entries = await readHarnessMcpEntries({
      context: { platform: "windows", home, appData: join(home, "AppData"), environment: () => undefined, join },
      folder: join(home, ".canonfig"),
      harnesses: ["codex"],
      cwd: home,
      environment: {
        PathExt: ".EXE;.CMD",
        FIXTURE_API_TOKEN: "parent-value",
        OPENAI_IDENTITY_TOKEN_FILE: "blocked-parent-value",
        PARENT_ONLY: "unrelated-value",
        Requests_CA_Bundle: certificatePath,
        pip_cert: relativeCertificate,
        FORWARDED_ONLY: "forwarded-value",
      },
    });
    expect(entries[0]?.launch).toMatchObject({
      kind: "stdio",
      env: { PATHEXT: ".EXE;.CMD", FIXTURE_API_TOKEN: "literal-override" },
      secrets: expect.arrayContaining(["literal-override"]),
    });
    expect(JSON.stringify(entries)).not.toMatch(/parent-value|explicit-value|unrelated-value/u);
    const parent = { LOGONSERVER: "canonfig-test-logon", NODE_V8_COVERAGE: join(home, "coverage") };
    const original = Object.fromEntries(Object.keys(parent).map((name) => [name, process.env[name]]));
    try {
      Object.assign(process.env, parent);
      const results = await checkMcpEntries(entries, 10_000);
      expect(results, JSON.stringify(results)).toMatchObject([{ status: "pass", tools: 2 }]);
      expect(process.env).toMatchObject(parent);
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
