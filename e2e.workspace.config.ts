import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

export default {
  tests: "tests/browser/workspace/**/*.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  targets: [{
    name: "chromium",
    engine: web({ reducedMotion: "reduce" }),
    app: {
      url: "http://127.0.0.1:4175",
      command: { executable: "node", args: ["ui/scripts/serve-browser-fixture.mjs"] },
    },
  }],
} satisfies E2EConfig;
