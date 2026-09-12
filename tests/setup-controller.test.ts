import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { runSetupPreflight } from "../src/setup/setup.controller.ts";

import {
  nextEligibleSetupStage,
  setupItemVerdicts,
  setupPlanDigest,
} from "../src/setup/setup.plan.ts";
import type {
  SetupInventory,
  SetupJournal,
  SetupPlanItem,
} from "../src/setup/setup.types.ts";

const inventory: SetupInventory = {
  schema: "canonfig.setup-inventory/v1",
  platform: "linux",
  home: "/home/operator",
  account: "operator",
  osRelease: "Linux 6.8 arm64",
  nodeRuntime: "v24.0.0 (/usr/bin/node)",
  credentialStorage: {
    kind: "local-file",
    provider: "test",
    verification: "test fixture",
  },
  transport: {
    policy: "loopback",
    initialized: false,
  },
  tools: [],
  discoveryFiles: 0,
  discoveryEvidence: 0,
  discoveryDigest: "discovery-digest",
};

const items: ReadonlyArray<SetupPlanItem> = [
  {
    id: "optional-installer",
    kind: "recipe-install",
    scope: "optional-tool",
    optional: true,
    dependsOn: [],
    detail: {},
  },
  {
    id: "required-directory",
    kind: "ensure-directory",
    scope: "machine",
    optional: false,
    dependsOn: [],
    detail: { path: "/home/operator/.canonfig" },
  },
];

const digest = setupPlanDigest({
  role: "follower",
  intent: "prepare follower",
  exclusions: [],
  inventory,
  items,
});

const journal = (overrides: Partial<SetupJournal> = {}): SetupJournal => ({
  schema: "canonfig.setup/v1",
  role: "follower",
  planDigest: digest,
  intent: "prepare follower",
  inventory,
  items: [...items],
  decisions: [],
  exclusions: [],
  evidence: [],
  approvals: [{
    digest,
    approver: "operator",
    approvedAt: "2026-08-17T00:00:00.000Z",
  }],
  catalog: [],
  stages: ["role", "preflight", "inventory", "plan"].map((stage) => ({
    stage,
    digest,
    completedAt: "2026-08-17T00:00:00.000Z",
  })),
  records: [],
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  ...overrides,
});

describe("setup controller decisions", () => {
  it.runIf(process.platform === "linux")(
    "reports Source key-storage prerequisites before initialization",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "canonfig-setup-preflight-"));
      const home = join(root, "home");
      mkdirSync(home);
      try {
        const error = await Effect.runPromise(Effect.flip(
          runSetupPreflight("source").pipe(
            Effect.provide(linuxMachineStateLayer({
              environment: [
                { name: "HOME", value: home },
                { name: "PATH", value: "" },
              ],
              credentialPolicy: { kind: "secure-store" },
            })),
          ),
        ));
        expect(error).toMatchObject({
          _tag: "SetupError",
          category: "prerequisite",
        });
        expect(error.message).toContain("Source signing key");
        expect(error.message).toContain("TLS key");
        expect(error.message).toContain("before initialization");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("binds approval to declared intent, exclusions, inventory, and exact items", () => {
    expect(setupPlanDigest({
      role: "follower",
      intent: "prepare follower",
      exclusions: [],
      inventory,
      items,
    })).toBe(digest);
    expect(setupPlanDigest({
      role: "follower",
      intent: "prepare source instead",
      exclusions: [],
      inventory,
      items,
    })).not.toBe(digest);
    expect(setupPlanDigest({
      role: "follower",
      intent: "prepare follower",
      exclusions: ["skip unavailable integration"],
      inventory,
      items,
    })).not.toBe(digest);
  });

  it("resumes required work without blocking on an independent optional failure", () => {
    const records = [
      {
        id: "optional-installer",
        status: "failed" as const,
        evidence: "installer unavailable",
        updatedAt: "2026-08-17T00:01:00.000Z",
      },
      {
        id: "required-directory",
        status: "completed" as const,
        evidence: "/home/operator/.canonfig",
        updatedAt: "2026-08-17T00:01:00.000Z",
      },
    ];

    expect(setupItemVerdicts(items, records).get("required-directory"))
      .toBe("completed");
    expect(nextEligibleSetupStage(journal({ records }))).toBe("apply");
    expect(nextEligibleSetupStage(journal({
      records,
      stages: [
        ...journal().stages,
        {
          stage: "apply",
          digest,
          completedAt: "2026-08-17T00:02:00.000Z",
        },
      ],
    }))).toBe("complete");
  });
});
