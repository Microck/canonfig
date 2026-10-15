// Demo profiles a follower can select (`canonfig profile list`) and what each sends to this machine.
// Separate from follower.tsx so the store can seed a plan for the profile chosen at enrollment
// without importing a screen module.
import { profile, resources } from "@/shared/data";
import type { PlanItem } from "./store";

export interface FollowerProfile {
  id: string;
  name: string;
  /** Items this profile sends to this machine. */
  sends: string[];
  /** Items in the profile that this machine's groups don't get. */
  notSent: number;
}

/** cuda-toolkit is for the gpu group, which this machine isn't in. */
const GPU_ONLY = ["cuda-toolkit"];

export const FOLLOWER_PROFILES: FollowerProfile[] = [
  { id: profile.id, name: profile.name, sends: resources.filter((r) => !GPU_ONLY.includes(r.id)).map((r) => r.id), notSent: GPU_ONLY.length },
  { id: "minimal", name: "Minimal", sends: ["claude-instructions", "codex-agents", "claude-settings"], notSent: 0 },
];

export function followerProfile(id: string): FollowerProfile {
  const p = FOLLOWER_PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown profile ${id}`);
  return p;
}

/** The plan for a profile: the steps of `base` (the Workstation plan) for items that profile sends here. */
export function profilePlan(base: PlanItem[], id: string): PlanItem[] {
  const { sends } = followerProfile(id);
  return base.filter((p) => sends.includes(p.resource));
}
