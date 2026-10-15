/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRoute, roleHref, workspaceHref, type WorkspaceRole } from "./routes.ts";
import type { View } from "./store";

const pages: [WorkspaceRole, View, string][] = [
  ["source", "overview", "overview"],
  ["source", "profile", "profile"],
  ["source", "machines", "machines"],
  ["source", "revisions", "revisions"],
  ["source", "secrets", "secrets"],
  ["source", "service", "settings/service"],
  ["source", "agent", "settings/agent"],
  ["source", "harness", "settings/harness"],
  ["source", "installers", "settings/installers"],
  ["source", "setup", "settings/setup"],
  ["source", "doctor", "settings/health"],
  ["follower", "overview", "overview"],
  ["follower", "machines", "machines"],
  ["follower", "sync", "sync"],
  ["follower", "schedule", "schedule"],
  ["follower", "overlays", "local-settings"],
  ["follower", "secrets", "secrets"],
  ["follower", "tunnel", "settings/tunnel"],
  ["follower", "agent", "settings/agent"],
  ["follower", "harness", "settings/harness"],
  ["follower", "doctor", "settings/health"],
  ["follower", "machine", "settings/enrollment"],
];

describe("canonical workspace routes", () => {
  for (const [role, view, segment] of pages) {
    it(`round-trips /${role}/${segment}`, () => {
      const href = `/${role}/${segment}`;
      assert.equal(workspaceHref(role, view), href);
      assert.deepEqual(parseRoute(href), {
        kind: "workspace", role, view, profileTab: "resources", machinesMode: "map", focus: null,
      });
    });
  }

  it("round-trips profile tabs and both machine list routes", () => {
    for (const profileTab of ["groups", "defaults"] as const) {
      const href = workspaceHref("source", "profile", { profileTab });
      assert.equal(href, `/source/profile/${profileTab}`);
      assert.deepEqual(parseRoute(href), {
        kind: "workspace", role: "source", view: "profile", profileTab, machinesMode: "map", focus: null,
      });
    }
    for (const role of ["source", "follower"] as const) {
      const href = workspaceHref(role, "machines", { machinesMode: "list" });
      assert.equal(href, `/${role}/machines/list`);
      assert.deepEqual(parseRoute(href), {
        kind: "workspace", role, view: "machines", profileTab: "resources", machinesMode: "list", focus: null,
      });
    }
  });

  it("encodes focused rows without treating their IDs as URL syntax", () => {
    const focus = "machine/a?b=c & #日本語";
    const href = workspaceHref("source", "machines", { machinesMode: "list", focus });
    const route = parseRoute(href);
    assert.equal(route.kind, "workspace");
    if (route.kind !== "workspace") throw new Error("Expected a workspace route");
    assert.equal(route.focus, focus);
    assert.equal(route.machinesMode, "list");
    assert.equal(new URL(href, "http://canonfig.local").hash, "");
  });

  it("keeps explicit empty focus distinct from the default selection", () => {
    const route = parseRoute(workspaceHref("follower", "sync", { focus: "" }));
    assert.equal(route.kind, "workspace");
    if (route.kind !== "workspace") throw new Error("Expected a workspace route");
    assert.equal(route.focus, "");
  });

  it("does not reinterpret role or variant query parameters", () => {
    assert.deepEqual(parseRoute("/source/profile?role=follower&variant=b"), parseRoute("/source/profile"));
    assert.deepEqual(parseRoute("/setup?role=source"), { kind: "setup" });
  });

  it("rejects unknown pages and pages belonging to the other role", () => {
    for (const href of [
      "/source/sync", "/source/settings/tunnel", "/source/settings/enrollment", "/source/profile/items",
      "/source/machines/map", "/source/doctor", "/source/profile/", "/source", "/source/no-such-page",
      "/follower/profile", "/follower/profile/groups", "/follower/revisions", "/follower/settings/service",
      "/follower/settings/setup", "/follower/settings/installers", "/follower/overlays", "/follower/machine",
    ]) {
      const route = parseRoute(href);
      assert.equal(route.kind, "workspace", href);
      if (route.kind !== "workspace") throw new Error("Expected a namespaced route");
      assert.equal(route.view, "not-found", href);
    }
    for (const href of ["/no-such-page", "/settings/agent", "/setup/extra", "/unconfigured", "/Source/overview"]) {
      assert.deepEqual(parseRoute(href), { kind: "not-found" }, href);
    }
    assert.throws(() => workspaceHref("follower", "profile"), /No follower route/);
    assert.throws(() => workspaceHref("source", "sync"), /No source route/);
  });

  it("gives the demo switcher canonical role entry points", () => {
    assert.equal(roleHref("source"), "/source/overview");
    assert.equal(roleHref("follower"), "/follower/overview");
    assert.equal(roleHref("unconfigured"), "/setup");
    assert.deepEqual(parseRoute("/setup"), { kind: "setup" });
  });
});
