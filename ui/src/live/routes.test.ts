/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRouteForRole, navigationForRole, navItem } from "../workspace/nav";
import { parseRoute, workspaceHref } from "../workspace/routes";

const source = ["overview", "profile", "machines", "revisions", "secrets", "service", "agent", "installers", "setup", "doctor", "version"];
const follower = ["overview", "machines", "sync", "schedule", "local", "backups", "secrets", "tunnel", "agent", "doctor", "machine", "version", "installers", "setup"];

describe("shared live workspace navigation", () => {
  for (const [role, expected] of [["source", source], ["follower", follower]] as const) {
    it(`uses the polished navigation groups for ${role}`, () => {
      const navigation = navigationForRole(role, true);
      const entries = [...navigation.main, ...navigation.settings];
      assert.deepEqual(entries.map((entry) => entry.view), expected);
      const paths = entries.map((entry) => workspaceHref(role, entry.view));
      assert.equal(new Set(paths).size, entries.length);
      for (const entry of entries) assert.equal(navItem(role, entry.view)?.label, entry.label);
      assert.equal(navItem(role, "version")?.label, "Version");
      for (const href of paths) {
        assert.equal(isRouteForRole(parseRoute(href), role), true);
        assert.equal(isRouteForRole(parseRoute(href), role === "source" ? "follower" : "source"), false);
      }
    });
  }
  it("gates tabs by session role and keeps unknown routes unavailable", () => {
    for (const tab of ["harnesses", "groups", "defaults"]) {
      assert.equal(isRouteForRole(parseRoute(`/source/profile/${tab}`), "source"), true);
      assert.equal(isRouteForRole(parseRoute(`/source/profile/${tab}`), "follower"), false);
    }
    assert.equal(isRouteForRole(parseRoute("/source/backups"), "source"), false);
    assert.equal(isRouteForRole(parseRoute("/source/missing"), "source"), false);
    assert.equal(isRouteForRole(parseRoute("/follower/machines/list"), "follower"), true);
  });
  it("requires setup for an unconfigured session", () => {
    assert.equal(isRouteForRole(parseRoute("/setup"), "unconfigured"), true);
    assert.equal(isRouteForRole(parseRoute("/source/overview"), "unconfigured"), false);
    assert.equal(isRouteForRole(parseRoute("/setup"), "source"), false);
  });
  it("retains Source backups in demo navigation", () => {
    assert.equal(navigationForRole("source", false).main.some((entry) => entry.view === "backups"), true);
  });
});
