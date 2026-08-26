import { createOpenCodeFamilyAdapter } from "./open-code-family.ts";

export const kiloAdapter = createOpenCodeFamilyAdapter({
  id: "kilo",
  name: "Kilo Code CLI",
  executables: ["kilo"],
  docs: [
    "https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/customize/agents-md.md",
    "https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/customize/skills.md",
    "https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/kilocode/docs/migration.md",
  ],
  schemaUrl: "https://app.kilo.ai/config.json",
  configPath: "kilo.json",
  resourceRoot: ".kilo",
  notes: [
    "Kilo's CLI is an OpenCode-derived harness; this adapter shares the OpenCode compiler and changes only native paths, schema, identity, and documentation.",
    "Tool hooks compile into a Kilo TypeScript plugin; non-tool lifecycle events are not emitted.",
  ],
});
