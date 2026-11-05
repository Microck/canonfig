import { openCodeFamilyAdapter } from "./open-code-family.ts";
import { xdgCacheHome, xdgConfigHome, xdgDataHome } from "./shared.ts";

export const opencodeAdapter = openCodeFamilyAdapter({
  id: "opencode",
  descriptor: {
    id: "opencode",
    name: "OpenCode",
    executables: ["opencode"],
    docs: [
      "https://opencode.ai/docs/config/",
      "https://opencode.ai/docs/plugins/",
      "https://opencode.ai/docs/troubleshooting/",
    ],
    notes: [
      "Rules are linked from AGENTS.md.",
      "Tool hooks compile into an OpenCode plugin; other lifecycle events are not emitted.",
    ],
  },
  root: (context) => context.join(xdgConfigHome(context), "opencode"),
  config: "opencode.json",
  alternative: "opencode.jsonc",
  agents: "agents",
  plugins: "plugins",
  // auth.json and opencode.db live in the data directory.
  state: (context) => [
    context.join(xdgDataHome(context), "opencode"),
    context.join(xdgCacheHome(context), "opencode"),
  ],
});
