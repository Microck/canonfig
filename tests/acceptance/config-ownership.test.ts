import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ActionId, ResourceId, RunId } from "../../src/domain/brand.ts";
import { configPathsOverlap } from "../../src/domain/config-path.ts";
import { decodeMachineProfileJsonc, encodeMachineProfile } from "../../src/domain/profile.ts";
import { ConfigValue } from "../../src/domain/resource.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { sha256BytesHex, sha256Hex } from "../../src/profile/profile-codec.ts";
import {
  editConfigText, getConfigPath, parseConfigDocument, removeConfigPath, serializeConfigDocument,
  setConfigPath, type ConfigDocument,
} from "../../src/synchronization/config-codec.ts";
import { defaultSynchronizationExecutionLimits } from "../../src/synchronization/executor.ts";
import { planResource } from "../../src/synchronization/resource-plans.ts";
import { prepareResourceAction, type ResourceExecutionContext } from "../../src/synchronization/resource-executors.ts";
import type { ResourcePlanningContext } from "../../src/synchronization/synchronization.types.ts";

const decode = Schema.decodeUnknownSync;
const resourceId = decode(ResourceId)("client-config");
const digest = sha256Hex("config-test");
const roots: Array<string> = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const profileWithKeys = (keys: ReadonlyArray<{ readonly path: string; readonly value: ConfigValue }>) =>
  decodeMachineProfileJsonc(JSON.stringify({
    id: "portable-config", name: "Portable config", resources: [{
      id: resourceId, kind: "config", target: "~/.example/settings.json",
      spec: { kind: "config", format: "json", keys },
      verify: { method: "digest", digest },
    }],
  }));

const planning = (
  desiredKeys: ReadonlyArray<string>, overlayKeys: ReadonlyArray<string>, oldKeys: ReadonlyArray<string> = [],
): ResourcePlanningContext => ({
  resource: { id: resourceId, kind: "config", policy: "merge", target: "~/.example/settings.json", dependsOn: [], blobs: [] },
  desired: { kind: "config", format: "json", digest, keys: desiredKeys },
  observed: { state: "present", digest, executable: false },
  overlayKeys, platform: "linux",
  applied: { resource: resourceId, revision: "previous", digest, appliedAt: "2026-01-01T00:00:00Z", ownedKeys: oldKeys },
});

const mcp = { command: "example-tool", args: ["--stdio"], env: { EXAMPLE_MODE: "read-only" }, enabled: true };
const hooks = [{ matcher: "Edit", hooks: [{ type: "command", command: "example-check", timeout: 30 }] }];

describe("portable recursive configuration", () => {
  it("shares nested values across authoring and published resource decoding without changing arrays", () => {
    const value = { server: mcp, hooks, values: [true, 2, "third", { nested: [1, false] }] };
    expect(decode(ConfigValue)(value)).toEqual(value);
    const profile = profileWithKeys([{ path: "settings", value }]);
    expect(decodeMachineProfileJsonc(encodeMachineProfile(profile))).toEqual(profile);
    expect(profile.resources[0]?.spec).toMatchObject({ keys: [{ path: "settings", value }] });
  });

  it.each(["json", "toml", "yaml"] as const)("round trips complete MCP entries and hook objects through %s", (format) => {
    const document: ConfigDocument = {};
    setConfigPath(document, "mcpServers.example", mcp);
    setConfigPath(document, "hooks.PreToolUse", hooks);
    const parsed = parseConfigDocument(format, serializeConfigDocument(format, document));
    expect(getConfigPath(parsed, "mcpServers.example")).toEqual(mcp);
    expect(getConfigPath(parsed, "hooks.PreToolUse")).toEqual(hooks);
  });

  it.each([null, Number.NaN, Infinity, -Infinity])("rejects unsupported values rather than coercing %s", (value) => {
    expect(() => decode(ConfigValue)(value)).toThrow();
    expect(() => decode(ConfigValue)({ nested: [value] })).toThrow();
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects reserved fields without silently dropping %s", (key) => {
    const value = JSON.parse(`{"${key}":{"polluted":true}}`);
    expect(() => decode(ConfigValue)(value)).toThrow();
    expect(() => decode(ConfigValue)({ nested: [value] })).toThrow();
  });

  it.each(["", "a..b", ".a", "a.", "a\0b", "__proto__.polluted", "constructor.prototype.polluted"])(
    "rejects invalid ownership and traversal paths: %s", (path) => {
      expect(() => profileWithKeys([{ path, value: true }])).toThrow();
      const document: ConfigDocument = {};
      expect(() => setConfigPath(document, path, true)).toThrow();
      expect(() => getConfigPath(document, path)).toThrow();
      expect(() => removeConfigPath(document, path)).toThrow();
      expect(document).toEqual({});
    },
  );

  it.each([["mcp.server", "mcp.server"], ["mcp.server", "mcp.server.command"]])(
    "rejects duplicate or overlapping authored keys %s and %s", (left, right) => {
      expect(() => profileWithKeys([{ path: left, value: mcp }, { path: right, value: "other" }])).toThrow();
    },
  );

  it("keeps distinct sibling names independent", () => {
    expect(configPathsOverlap("mcp.foo", "mcp.foobar")).toBe(false);
    expect(() => profileWithKeys([{ path: "mcp.foo", value: mcp }, { path: "mcp.foobar", value: mcp }])).not.toThrow();
  });

  it("preserves reviewed agent installation bounds when canonicalizing and signing a profile", () => {
    const profile = decodeMachineProfileJsonc(JSON.stringify({
      id: "bounded-tool", name: "Bounded tool", resources: [{
        id: "example", kind: "tool", target: "example",
        spec: { kind: "tool", toolId: "example", recipes: [], agentInstall: {
          paths: ["~/.local/bin", "~/.local/bin", "~/.cache/example"],
          origins: ["https://example.invalid", "https://example.invalid"],
        } },
        verify: { method: "executable-present", executable: "example" },
      }],
    }));
    expect(profile.resources[0]?.spec).toMatchObject({ agentInstall: {
      paths: ["~/.cache/example", "~/.local/bin"], origins: ["https://example.invalid"],
    } });
    expect(decodeMachineProfileJsonc(encodeMachineProfile(profile))).toEqual(profile);
  });
});

describe("Local Overlay subtree ownership", () => {
  it.each([["mcp.server", "mcp.server.command"], ["mcp.server.command", "mcp.server"]])(
    "blocks overlapping Source %s and Local Overlay %s", (source, local) => {
      expect(planResource(planning([source], [local]))).toMatchObject([{ kind: "human-action" }]);
    },
  );
  it("keeps an old parent containing a newly local child and names it in the plan", () => {
    const [action] = planResource(planning([], ["mcp.server.command"], ["mcp.server"]));
    expect(action).toMatchObject({ kind: "write-config", detail: { retains: ["mcp.server"] } });
    expect(action?.detail).not.toHaveProperty("removes");
    expect(action?.detail).toHaveProperty("retentionNotice", expect.stringContaining("mcp.server"));
  });
  it("prunes an unrelated old subtree while retaining Local Overlay ownership", () => {
    expect(planResource(planning([], ["mcp.server.command"], ["mcp.server", "mcp.other"]))).toMatchObject([
      { kind: "write-config", detail: { removes: ["mcp.other"], retains: ["mcp.server"] } },
    ]);
  });
  it("blocks only this resource when its follower file does not parse", () => {
    const context = planning(["mcp.server"], []);
    const [action] = planResource({
      ...context,
      observed: { state: "unverifiable", reason: "~/.example/settings.json is not valid JSON: expected a JSON value at line 3 column 8" },
    });
    expect(action).toMatchObject({ kind: "human-action", detail: { reason: expect.stringContaining("~/.example/settings.json") } });
  });
});

describe("in-place config edits", () => {
  const sets = (entries: Record<string, ConfigValue>) =>
    Object.entries(entries).map(([path, value]) => ({ path, value }));

  it("reads a commented JSON file as JSONC and keeps its comments when merging", () => {
    const text = [
      "{",
      "  // user comment: keep my theme",
      "  \"theme\": \"Dracula\", /* inline */",
      "  \"mcpServers\": {",
      "    \"local-only\": { \"command\": \"local\" },",
      "  },",
      "  \"ratio\": 1.0",
      "}",
      "",
    ].join("\n");
    expect(parseConfigDocument("json", text)).toEqual({ theme: "Dracula", mcpServers: { "local-only": { command: "local" } }, ratio: 1 });
    const edited = editConfigText("json", text, { sets: sets({ "mcpServers.docs": mcp }) });
    expect(edited).toContain("// user comment: keep my theme");
    expect(edited).toContain("/* inline */");
    expect(edited).toContain("\"ratio\": 1.0");
    expect(parseConfigDocument("json", edited)).toEqual({
      theme: "Dracula",
      mcpServers: { "local-only": { command: "local" }, docs: mcp },
      ratio: 1,
    });
    const removed = editConfigText("json", edited, { removes: ["mcpServers.docs"], sets: [] });
    expect(parseConfigDocument("json", removed)).toEqual(parseConfigDocument("json", text));
    expect(removed).toContain("// user comment: keep my theme");
  });

  it("reports the line and column of JSON it cannot parse", () => {
    expect(() => parseConfigDocument("json", "{\n  // comment\n  \"a\": }\n")).toThrow(/line 3 column 8/u);
  });

  it("keeps TOML comments, float literals and unrelated values byte-exact", () => {
    const text = [
      "# Local Codex settings - keep this comment",
      "model = \"local-model\"",
      "ratio = 1.0",
      "released = 1979-05-27T07:32:00Z",
      "",
      "[mcp_servers.local_only]",
      "command = \"local-mcp\" # keep",
      "",
      "[mcp_servers.docs]",
      "command = \"old\"",
      "",
    ].join("\n");
    const edited = editConfigText("toml", text, {
      sets: sets({ "mcp_servers.docs": { command: "npx", args: ["-y"] }, ratio: 2, "canonfig.hooks": hooks }),
    });
    expect(edited).toContain("# Local Codex settings - keep this comment");
    expect(edited).toContain("command = \"local-mcp\" # keep");
    expect(edited).toContain("released = 1979-05-27T07:32:00Z");
    expect(edited).toContain("ratio = 2.0");
    expect(getConfigPath(parseConfigDocument("toml", edited), "mcp_servers.docs")).toEqual({ command: "npx", args: ["-y"] });
    expect(getConfigPath(parseConfigDocument("toml", edited), "canonfig.hooks")).toEqual(hooks);
    const removed = editConfigText("toml", edited, { removes: ["mcp_servers.docs", "canonfig.hooks"], sets: [] });
    expect(removed).toContain("command = \"local-mcp\" # keep");
    expect(parseConfigDocument("toml", removed)).not.toHaveProperty("canonfig");
  });

  it("refuses to write null into TOML instead of dropping it", () => {
    expect(() => editConfigText("toml", "a = 1\n", { sets: [{ path: "b", value: null }] }))
      .toThrow(/TOML has no null value/u);
  });

  it("keeps YAML comments and anchors and quotes YAML 1.1 keywords it writes", () => {
    const text = [
      "# Hermes local config - keep this comment",
      "defaults: &defaults",
      "  timeout: 1.0 # inline",
      "server:",
      "  <<: *defaults",
      "  name: local",
      "other:",
      "  timeout: 1.0",
      "",
    ].join("\n");
    const edited = editConfigText("yaml", text, {
      sets: sets({ "hooks.flags": { yes: "yes", no_bool: "no", on: "on", date: "2001-12-14" }, "other.timeout": 3 }),
    });
    expect(edited).toContain("# Hermes local config - keep this comment");
    expect(edited).toContain("defaults: &defaults");
    expect(edited).toContain("<<: *defaults");
    expect(edited).toContain("timeout: 1.0 # inline");
    expect(edited).toContain("timeout: 3.0");
    expect(edited).toContain("\"yes\": \"yes\"");
    expect(edited).toContain("no_bool: \"no\"");
    expect(edited).toContain("\"on\": \"on\"");
    expect(edited).toContain("date: \"2001-12-14\"");
    expect(serializeConfigDocument("yaml", { off: "off" })).toBe("\"off\": \"off\"\n");
  });

  it("fails rather than change a YAML alias that shares an owned value", () => {
    const text = "defaults: &defaults\n  timeout: 1\nserver: *defaults\n";
    expect(() => editConfigText("yaml", text, { sets: sets({ "defaults.timeout": 2 }) }))
      .toThrow(/without changing values outside the owned keys/u);
  });

  it("addresses a literal dotted key with an escaped path", () => {
    const document: ConfigDocument = {};
    setConfigPath(document, "amp\\.mcpServers.docs", "x");
    expect(document).toEqual({ "amp.mcpServers": { docs: "x" } });
    expect(configPathsOverlap("amp\\.mcpServers", "amp.mcpServers")).toBe(false);
    expect(() => profileWithKeys([{ path: "amp\\mcpServers", value: true }])).toThrow();
    expect(parseConfigDocument("toml", editConfigText("toml", "", { sets: sets({ "amp\\.mcpServers.docs": "x" }) })))
      .toEqual({ "amp.mcpServers": { docs: "x" } });
  });
});

describe.runIf(process.platform === "linux")("native config ownership transitions", () => {
  it.each([
    { oldKey: "mcp.server.command", newKey: "mcp.server", newValue: mcp },
    { oldKey: "mcp.server", newKey: "mcp.server.command", newValue: "new-command" },
  ])("prunes $oldKey before writing $newKey and preserves rollback", async ({ oldKey, newKey, newValue }) => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-config-transition-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    const target = join(home, "settings.json");
    const original = JSON.stringify({ mcp: { server: { command: "old", obsolete: true }, local: { url: "local" } }, theme: "local-theme" });
    writeFileSync(target, original);
    const desired: ConfigDocument = {};
    setConfigPath(desired, newKey, newValue);
    const content = new TextEncoder().encode(serializeConfigDocument("json", desired));
    const artifactDigest = sha256BytesHex(content);
    const context: ResourceExecutionContext = {
      run: decode(RunId)("config-transition"),
      action: { id: decode(ActionId)("config-write"), resource: resourceId, kind: "write-config", before: [],
        detail: { kind: "write-config", target, keys: [newKey], removes: [oldKey] } },
      resource: { id: resourceId, kind: "config", policy: "merge", target, dependsOn: [], blobs: [] },
      desired: { kind: "config", format: "json", digest: artifactDigest, keys: [newKey] },
      verification: { method: "digest", digest: artifactDigest },
      artifacts: new Map([[artifactDigest, { digest: artifactDigest, content }]]),
      limits: defaultSynchronizationExecutionLimits,
    };
    const layer = linuxMachineStateLayer({ environment: [{ name: "HOME", value: home }], credentialPolicy: { kind: "local-file", path: join(root, "credentials") } });
    await Effect.runPromise(Effect.gen(function*() {
      const prepared = yield* prepareResourceAction(context);
      yield* prepared.execute;
      const result = parseConfigDocument("json", readFileSync(target, "utf8"));
      expect(getConfigPath(result, newKey)).toEqual(newValue);
      expect(getConfigPath(result, "mcp.local")).toEqual({ url: "local" });
      expect(result.theme).toBe("local-theme");
      const once = readFileSync(target, "utf8");
      const again = yield* prepareResourceAction({ ...context, run: decode(RunId)("config-transition-again"), action: { ...context.action, detail: { kind: "write-config", target, keys: [newKey] } } });
      yield* again.execute;
      expect(readFileSync(target, "utf8")).toBe(once);
      // The second run has a distinct rollback snapshot. The first run must
      // still restore the exact original file after that idempotent apply.
      if (prepared.rollback === undefined) throw new Error("expected captured rollback");
      yield* prepared.rollback;
    }).pipe(Effect.provide(layer)));
    expect(readFileSync(target, "utf8")).toBe(original);
  });
});
