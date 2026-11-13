import { HARNESS_NAMES, type HarnessId } from "@/shared/metadata";

export const states = {
  current: { label: "Up to date", kind: "ok", text: "text-ok", reason: "Managed files match revision 8. Independent read-back verification passed." },
  drift: { label: "Drift detected", kind: "warn", text: "text-warn", reason: "Managed files differ from the applied revision. Review local changes before replacing them." },
  failed: { label: "Apply failed", kind: "bad", text: "text-bad", reason: "The last run could not write managed files. Resolve the write permission on this machine and run synchronization again." },
  action: { label: "Needs action", kind: "act", text: "text-act", reason: "A required credential is missing on this machine. Add it locally before synchronizing." },
  behind: { label: "Revision 7", kind: "warn", text: "text-warn", reason: "Revision 7 passed verification. Revision 8 has not been applied yet." },
  unverified: { label: "Not verified", kind: "off", text: "text-muted-foreground", reason: "Files were written, but no independent per-harness verification is available." },
  excluded: { label: "Excluded", kind: "off", text: "text-muted-foreground", reason: "This harness is excluded on this machine. Canonfig does not manage it." },
  absent: { label: "Not installed", kind: "off", text: "text-muted-foreground", reason: "Detection did not find this harness installed on this machine." },
  unsupported: { label: "Not supported", kind: "off", text: "text-muted-foreground", reason: "Gemini is a design example only. The researched Canonfig revision has no Gemini adapter." },
} as const;
export type Harness = { id: string; name: string; logo?: string; state: keyof typeof states };
export type Machine = { id: string; name: string; platform: string; purpose: string; source?: boolean; report: "fresh" | "stale" | "missing"; harnesses: Harness[] };
export type Mode = "film" | "focus" | "rail";
export const scenarios = [
  { id: "film", name: "Film · 3 followers" },
  { id: "M0", name: "M0 · no followers" },
  { id: "M40", name: "M40 · 40 followers" },
  { id: "M320", name: "M320 · 320px width" },
  { id: "F320", name: "F320 · 320 followers" },
  { id: "worst", name: "Long names · all states" },
  { id: "empty", name: "Zero harnesses · no report" },
];
const logos: Partial<Record<HarnessId, string>> = { codex: "codex", "claude-code": "claude", "oh-my-pi": "omp", cursor: "cursor", opencode: "opencode", "copilot-cli": "copilot", "factory-droid": "droid", "grok-build": "grok", amp: "amp", pi: "pi", kimi: "kimi", qwen: "qwen" };
function harness(id: HarnessId, state: Harness["state"] = "current"): Harness {
  return { id, name: HARNESS_NAMES[id], logo: logos[id], state };
}
const source: Machine = { id: "atlas", name: "atlas", platform: "Linux", purpose: "Main desktop", source: true, report: "fresh", harnesses: [harness("codex"), harness("claude-code"), harness("oh-my-pi")] };
const film: Machine[] = [source,
  { id: "laptop", name: "laptop", platform: "macOS", purpose: "Work laptop", report: "fresh", harnesses: [harness("cursor"), harness("opencode")] },
  { id: "studio", name: "studio", platform: "macOS", purpose: "Design studio", report: "fresh", harnesses: [harness("copilot-cli"), harness("factory-droid")] },
  { id: "build-box", name: "build-box", platform: "Linux", purpose: "Build server", report: "fresh", harnesses: [harness("grok-build", "behind"), harness("amp", "behind")] },
];
const inventory = Object.keys(logos) as HarnessId[];
const mixedStates: Harness["state"][] = ["current", "drift", "failed", "action", "behind", "unverified", "excluded", "absent"];
export function makeMachines(scenario: string): Machine[] {
  if (scenario === "film") return film;
  if (scenario === "M0") return [source];
  if (scenario === "empty") return [source,
    { ...film[1], id: "empty", name: "new-laptop", harnesses: [] },
    { ...film[2], id: "missing", name: "never-reported", report: "missing", harnesses: [] },
    { ...film[3], id: "stale", name: "last-seen-three-days-ago", report: "stale" },
  ];
  const count = scenario === "M40" ? 40 : scenario === "F320" ? 320 : scenario === "M320" ? 4 : 6;
  return [source, ...Array.from({ length: count }, (_, index): Machine => ({
    id: `follower-${index + 1}`,
    name: scenario === "worst" && index === 0 ? "buildhost".repeat(18) : `workstation-${String(index + 1).padStart(3, "0")}`,
    platform: ["Linux", "macOS", "Windows"][index % 3], purpose: "Development", report: index % 11 === 10 ? "missing" : index % 7 === 6 ? "stale" : "fresh",
    harnesses: index % 11 === 10 || index % 9 === 8 ? [] : [...inventory.map((id, n) => ({ ...harness(id, mixedStates[(n + index) % mixedStates.length]), name: scenario === "worst" && n === 0 ? "OpenAI Codex configured for the distributed infrastructure team" : HARNESS_NAMES[id] })), { id: "gemini", name: "Gemini CLI", state: "unsupported" }],
  }))];
}
export function summary(machine: Machine) {
  if (machine.report === "missing") return { label: "Not reported", kind: "off" as const, current: false };
  if (machine.report === "stale") return { label: "Last report · 3 days ago", kind: "offline" as const, current: false };
  if (machine.harnesses.length === 0) return { label: "No harnesses detected", kind: "off" as const, current: false };
  const included = machine.harnesses.filter(h => !["excluded", "absent", "unsupported"].includes(h.state));
  const current = included.filter(h => h.state === "current").length;
  if (!included.length) return { label: "No included harnesses", kind: "off" as const, current: false };
  return { label: `${current} of ${included.length} up to date`, kind: current === included.length ? "ok" as const : "warn" as const, current: current === included.length };
}
export function expandedSize(machine: Machine) {
  return { width: machine.harnesses.length > 2 ? 580 : 406, height: (machine.source ? 342 : 308) + Math.max(0, Math.ceil(machine.harnesses.length / 3) - 1) * 82 };
}
