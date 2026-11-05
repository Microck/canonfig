import type { HarnessAdapter } from "../harness.ts";
import { TARGET_IDS, type TargetId } from "../model.ts";
import { ampAdapter } from "./amp.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { copilotAdapter } from "./copilot.ts";
import { cursorAdapter } from "./cursor.ts";
import { devinAdapter } from "./devin.ts";
import { droidAdapter } from "./droid.ts";
import { grokAdapter } from "./grok.ts";
import { hermesAdapter } from "./hermes.ts";
import { kiloAdapter } from "./kilo.ts";
import { kimiAdapter } from "./kimi.ts";
import { ompAdapter } from "./omp.ts";
import { opencodeAdapter } from "./opencode.ts";
import { piAdapter } from "./pi.ts";
import { qwenAdapter } from "./qwen.ts";

export { hookCommand } from "./shared-hooks.ts";
export {
  ampAdapter,
  antigravityAdapter,
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  cursorAdapter,
  devinAdapter,
  droidAdapter,
  grokAdapter,
  hermesAdapter,
  kiloAdapter,
  kimiAdapter,
  ompAdapter,
  opencodeAdapter,
  piAdapter,
  qwenAdapter,
};

const ADAPTERS = {
  codex: codexAdapter,
  "claude-code": claudeAdapter,
  amp: ampAdapter,
  "oh-my-pi": ompAdapter,
  pi: piAdapter,
  "factory-droid": droidAdapter,
  cursor: cursorAdapter,
  devin: devinAdapter,
  opencode: opencodeAdapter,
  "grok-build": grokAdapter,
  antigravity: antigravityAdapter,
  "copilot-cli": copilotAdapter,
  kimi: kimiAdapter,
  kilo: kiloAdapter,
  hermes: hermesAdapter,
  qwen: qwenAdapter,
} satisfies Record<TargetId, HarnessAdapter>;

/** Every adapter, in TARGET_IDS order. */
export const BUILTIN_ADAPTERS: ReadonlyArray<HarnessAdapter> = TARGET_IDS.map((id) => ADAPTERS[id]);

export function adapterFor(id: TargetId): HarnessAdapter {
  return ADAPTERS[id];
}
