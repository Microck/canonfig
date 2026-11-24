import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

const browserOptions: Parameters<typeof web>[0] = { reducedMotion: "reduce" };
const cdpEndpoint = process.env.E2E_CDP_ENDPOINT;
if (cdpEndpoint) browserOptions.connect = { cdpEndpoint: async () => cdpEndpoint };

export default {
  tests: "tests/browser/*.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  targets: [{
    name: "chromium",
    engine: web(browserOptions),
    app: {
      url: "http://127.0.0.1:4174",
      command: { executable: "npm", args: ["run", "start", "--workspace", "@canonfig/website", "--", "--directory", "../_site", "--hostname", "127.0.0.1", "--port", "4174"] },
    },
  }],
} satisfies E2EConfig;
