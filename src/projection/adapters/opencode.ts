import { createOpenCodeFamilyAdapter } from "./open-code-family.ts";

export const opencodeAdapter = createOpenCodeFamilyAdapter({
  id: "opencode",
  name: "OpenCode",
  executables: ["opencode"],
  docs: [
    "https://opencode.ai/docs/config/",
    "https://opencode.ai/docs/agents/",
    "https://opencode.ai/docs/skills/",
    "https://opencode.ai/docs/plugins/",
  ],
  schemaUrl: "https://opencode.ai/config.json",
  configPath: "opencode.json",
  resourceRoot: ".opencode",
  notes: [
    "Tool hooks compile into an OpenCode TypeScript plugin; non-tool lifecycle events are not emitted.",
  ],
});
