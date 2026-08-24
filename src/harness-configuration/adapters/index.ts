export { codexAdapter } from "./codex.ts";
export { claudeAdapter } from "./claude.ts";
export { ampAdapter } from "./amp.ts";
export { ompAdapter } from "./omp.ts";
export { piAdapter } from "./pi.ts";
export { droidAdapter } from "./droid.ts";
export { cursorAdapter } from "./cursor.ts";
export { devinAdapter } from "./devin.ts";
export { opencodeAdapter } from "./opencode.ts";
export { grokAdapter } from "./grok.ts";
export { antigravityAdapter } from "./antigravity.ts";
export { copilotAdapter } from "./copilot.ts";

import type { HarnessAdapter } from "../core/types.ts";
import { codexAdapter } from "./codex.ts";
import { claudeAdapter } from "./claude.ts";
import { ampAdapter } from "./amp.ts";
import { ompAdapter } from "./omp.ts";
import { piAdapter } from "./pi.ts";
import { droidAdapter } from "./droid.ts";
import { cursorAdapter } from "./cursor.ts";
import { devinAdapter } from "./devin.ts";
import { opencodeAdapter } from "./opencode.ts";
import { grokAdapter } from "./grok.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { copilotAdapter } from "./copilot.ts";

export const BUILTIN_ADAPTERS: readonly HarnessAdapter[] = [
  codexAdapter,
  claudeAdapter,
  ampAdapter,
  ompAdapter,
  piAdapter,
  droidAdapter,
  cursorAdapter,
  devinAdapter,
  opencodeAdapter,
  grokAdapter,
  antigravityAdapter,
  copilotAdapter,
];
