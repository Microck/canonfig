/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { screensForRole } from "../live-app";
import { overviewPath, sessionScreens } from "./session";

const paths = {
  source: [
    "/source/overview",
    "/source/profile",
    "/source/profile/harnesses",
    "/source/profile/groups",
    "/source/profile/defaults",
    "/source/revisions",
    "/source/secrets",
    "/source/machines",
    "/source/machines/list",
    "/source/settings/service",
    "/source/settings/agent",
    "/source/settings/installers",
    "/source/settings/setup",
    "/source/settings/health",
    "/source/settings/version",
  ],
  follower: [
    "/follower/overview",
    "/follower/machines",
    "/follower/machines/list",
    "/follower/enrollment/join",
    "/follower/sync",
    "/follower/schedule",
    "/follower/local-settings",
    "/follower/backups",
    "/follower/secrets",
    "/follower/settings/tunnel",
    "/follower/settings/enrollment",
    "/follower/settings/agent",
    "/follower/settings/installers",
    "/follower/settings/setup",
    "/follower/settings/health",
    "/follower/settings/version",
  ],
  unconfigured: ["/setup"],
};

describe("live workspace navigation", () => {
  for (const role of ["source", "follower", "unconfigured"] as const) {
    it(`lists only registered ${role} screens in the sidebar`, () => {
      const screens = screensForRole(role);
      assert.deepEqual(screens.map((screen) => screen.href), paths[role]);
      assert.equal(new Set(screens.map((screen) => screen.href)).size, screens.length);
      for (const screen of screens) {
        assert.equal(screen.path(role), screen.href);
        assert.equal(typeof screen.render, "function");
      }
      assert.ok(screens.some((screen) => screen.href === overviewPath(role)));
    });
  }

  it("keeps the unconfigured Overview out of the registry without a title exception", () => {
    assert.equal(sessionScreens[0]!.path("unconfigured"), undefined);
    assert.equal(overviewPath("unconfigured"), "/setup");
  });
});
