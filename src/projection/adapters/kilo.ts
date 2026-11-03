import { openCodeFamilyAdapter } from "./open-code-family.ts";
import { xdgCacheHome, xdgConfigHome, xdgDataHome, xdgStateHome } from "./shared.ts";

export const kiloAdapter = openCodeFamilyAdapter({
  id: "kilo",
  descriptor: {
    id: "kilo",
    name: "Kilo Code CLI",
    executables: ["kilo"],
    docs: [
      "https://kilo.ai/docs/getting-started/settings",
      "https://kilo.ai/docs/customize/skills",
      "https://kilo.ai/docs/contributing/architecture/cli-runtime",
      "https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/kilocode/skills/kilo-config.md",
    ],
    notes: [
      "Kilo is an OpenCode fork; this adapter shares the OpenCode compiler.",
      "Rules are linked from AGENTS.md; skills go to the shared ~/.agents/skills/.",
    ],
  },
  // Kilo also loads `$KILO_CONFIG_DIR` and globs both `{agent,agents}/` and
  // `{plugin,plugins}/` (kilo-config.md); the ADR pins the singular names.
  root: (context) => context.environment("KILO_CONFIG_DIR") ?? context.join(xdgConfigHome(context), "kilo"),
  config: "kilo.jsonc",
  alternative: "kilo.json",
  agents: "agent",
  plugins: "plugin",
  // auth.json and kilo.db live in the data directory; daemon.json holds the
  // daemon credential in the state directory.
  state: (context) => [
    context.join(xdgDataHome(context), "kilo"),
    context.join(xdgStateHome(context), "kilo", "daemon.json"),
    context.join(xdgCacheHome(context), "kilo"),
  ],
});
