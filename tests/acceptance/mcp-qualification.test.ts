import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProfileRevisionId, ResourceId } from "../../src/domain/brand.ts";
import {
  installerRecipeProvenance,
  mcpQualificationReady,
  type McpQualificationStageEvidence,
  unresolvedMcpIntegrations,
} from "../../src/domain/mcp-qualification.ts";
import type { ResourcePlanningContext } from "../../src/synchronization/synchronization.types.ts";
import { planResource } from "../../src/synchronization/resource-plans.ts";

const stage = (
  name: McpQualificationStageEvidence["stage"],
  status: McpQualificationStageEvidence["status"] = "passed",
): McpQualificationStageEvidence => ({
  stage: name,
  status,
  method: "fixture",
  operation: "harmless fixture operation",
});

const qualification = {
  method: "mcp-qualification" as const,
  target: "codex",
  compatibility: "mcp-2025-11-25",
  launches: { command: ["/opt/example/bin/example-mcp", "--version"], operation: "read version" },
  protocolCompatible: { command: ["/opt/example/bin/example-mcp", "protocol-version"], operation: "negotiate protocol" },
  authenticated: { command: ["/opt/example/bin/example-mcp", "whoami"], operation: "read current identity" },
  functional: { command: ["/opt/example/bin/example-mcp", "tools-list"], operation: "list tools" },
  clientLoaded: { command: ["/opt/codex/bin/codex", "mcp", "get", "example"], operation: "read client registration" },
};

const recipe = {
  platform: "linux" as const,
  method: "npm" as const,
  package: "example-mcp",
  version: "1.2.3",
  upstream: "https://registry.npmjs.org/example-mcp",
  architecture: process.arch,
  artifactDigest: "sha512-ZXhhbXBsZQ==",
  entrypoint: "/opt/example/bin/example-mcp",
  dependencyPolicy: "scripts-disabled",
  executionContext: "follower-local",
};

const provenance = installerRecipeProvenance({
  ...recipe,
  compatibility: qualification.compatibility,
  target: qualification.target,
});

const context = (applied: ResourcePlanningContext["applied"]): ResourcePlanningContext => ({
  resource: {
    id: Schema.decodeUnknownSync(ResourceId)("example-mcp"),
    kind: "tool",
    policy: "ensure",
    target: "example-mcp",
    dependsOn: [],
    blobs: [],
  },
  desired: {
    kind: "tool",
    toolId: "example-mcp",
    recipes: [recipe],
    loginRequired: false,
    qualification,
  },
  observed: {
    state: "present",
    digest: "a".repeat(64),
    executable: true,
  },
  overlayKeys: [],
  applied,
  platform: "linux",
});

describe("MCP qualification", () => {
  it("keeps startup, authentication, functionality, client loading, and ownership separate", () => {
    const startupOnly = [
      stage("installed"),
      stage("launches"),
      stage("protocol-compatible"),
      stage("authenticated", "unresolved"),
      stage("functional", "not-run"),
      stage("client-loaded", "not-run"),
      stage("canonfig-managed"),
    ];
    expect(mcpQualificationReady(startupOnly)).toBe(false);
    expect(mcpQualificationReady([
      stage("installed"),
      stage("launches"),
      stage("protocol-compatible"),
      stage("authenticated"),
      stage("functional"),
      stage("client-loaded"),
      stage("canonfig-managed"),
    ])).toBe(true);
    expect(unresolvedMcpIntegrations.map(({ integration, disposition }) => ({
      integration,
      disposition,
    }))).toEqual([
      { integration: "Iris", disposition: "unresolved" },
      { integration: "Oracle", disposition: "unresolved" },
      { integration: "IDA", disposition: "unresolved" },
      { integration: "Parkour", disposition: "unresolved" },
      { integration: "Ghidra-headless", disposition: "unresolved" },
    ]);
  });

  it("does not let a stale PATH hit replace a qualified pinned recipe", () => {
    expect(planResource(context(undefined))[0]).toMatchObject({
      kind: "install-tool",
      detail: { provenance: { fingerprint: provenance.fingerprint } },
    });
    expect(planResource(context({
      resource: Schema.decodeUnknownSync(ResourceId)("example-mcp"),
      revision: Schema.decodeUnknownSync(ProfileRevisionId)("revision-1"),
      digest: provenance.fingerprint,
      appliedAt: "2026-09-12T00:00:00Z",
      kind: "tool",
      policy: "ensure",
      target: "example-mcp",
      installerRecipe: provenance,
    }))[0]).toMatchObject({
      kind: "no-op",
      detail: { provenance: { fingerprint: provenance.fingerprint } },
    });
  });

  it("invalidates reuse when the target compatibility changes", () => {
    const changed = context({
      resource: Schema.decodeUnknownSync(ResourceId)("example-mcp"),
      revision: Schema.decodeUnknownSync(ProfileRevisionId)("revision-1"),
      digest: provenance.fingerprint,
      appliedAt: "2026-09-12T00:00:00Z",
      kind: "tool",
      policy: "ensure",
      target: "example-mcp",
      installerRecipe: provenance,
    });
    const desired = changed.desired.kind === "tool"
      ? { ...changed.desired, qualification: { ...qualification, compatibility: "mcp-next" } }
      : changed.desired;
    expect(planResource({ ...changed, desired })[0]?.kind).toBe("install-tool");
  });
});
