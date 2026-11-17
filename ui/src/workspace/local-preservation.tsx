import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { HARNESS_NAMES } from "@/shared/metadata";
import { preservedMcpConfig, preservedMcpHarnesses, TARGET_IDS, type TargetId } from "../../../src/projection/model";
import { Chip, ChipAdd, ChipRow } from "./kit";
import { record, strings } from "./live/follower";
import type { FollowerLive } from "./follower-types";

export interface PreservationPreferences {
  excludeSkills: string[];
  preserveMcp: boolean | TargetId[];
}

/**
 * The kept-skills and native MCP rows of Local settings' "Kept on this machine" group; the caller
 * supplies the group. A save always carries the digest of the snapshot displayed here, never a
 * freshly fetched digest.
 */
export function LocalPreservationControls({ live, sharedSkills, preferences, saveDemo }: {
  live?: Pick<FollowerLive, "local" | "action" | "savePreferences">;
  sharedSkills: boolean;
  preferences: PreservationPreferences;
  saveDemo: (next: PreservationPreferences) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const snapshot = live?.local;
  const selectedMcp = strings(snapshot?.config.preserveMcp);
  const current = live ? {
    excludeSkills: strings(snapshot?.config.excludeSkills),
    preserveMcp: snapshot?.config.preserveMcp === true ? true : TARGET_IDS.filter((id) => selectedMcp.includes(id)),
  } : preferences;
  const preserved = preservedMcpHarnesses(current.preserveMcp);
  const allowed = live ? strings(record(snapshot?.canonicalConfig.local).appendLocal).includes("skills") : sharedSkills;
  const busy = saving || live?.action.loading || (live !== undefined && !snapshot);
  /** Saves one preference; false when the server refused it (the error alert below then says why). */
  const save = async (key: "excludeSkills" | "preserveMcp", next: PreservationPreferences): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      if (live) {
        const saved = await live.savePreferences({
          expectedDigest: snapshot?.items.find((item) => item.path === "local.jsonc")?.digest ?? null,
          edits: [{ path: [key], value: next[key] }],
        });
        if (!saved) { setError("Preferences were not saved. Reload and review the current settings before trying again."); return false; }
      } else saveDemo(next);
      return true;
    } finally { setSaving(false); }
  };
  return <>
    <ChipRow label="Kept skills">
      {current.excludeSkills.map((name) => <Chip key={name} name={name} kind="ok" note="Canonfig leaves this skill alone in every skill folder. Removing it here doesn't adopt or overwrite your copy."
        removeLabel={`Remove kept-local skill ${name}`} busy={busy || !allowed} onRemove={() => { void save("excludeSkills", { ...current, excludeSkills: current.excludeSkills.filter((entry) => entry !== name) }); }} />)}
      {allowed
        ? <ChipAdd label="Skill name to keep local" placeholder="my-skill" busy={busy}
          validate={(name) => /^[a-z0-9][a-z0-9-]*$/u.test(name) ? current.excludeSkills.includes(name) ? "Already kept." : null : "Use lowercase letters, digits and hyphens, starting with a letter or digit."}
          // A refused save keeps the typed name in the field; the group's alert says why.
          onAdd={async (name) => ((await save("excludeSkills", { ...current, excludeSkills: [...new Set([...current.excludeSkills, name])].sort() })) ? null : "Not saved.")} />
        : <span className="text-sm text-faint">The Source must share skills folders (local.appendLocal) first.</span>}
    </ChipRow>
    <ChipRow label="Native MCP">
      <Switch aria-label="Keep native MCP on this machine" checked={preserved.size === TARGET_IDS.length} disabled={busy} onCheckedChange={(preserveMcp) => { void save("preserveMcp", { ...current, preserveMcp }); }} />
      {/* Preserved is not disabled or verified: say so while it is on. */}
      <span className="text-sm text-muted-foreground">{preserved.size > 0 ? "Kept as is. Canonfig doesn't check that the servers start." : "Follows the Source"}</span>
      <details className="w-full text-sm">
        <summary className="cursor-pointer py-2">Choose harnesses ({preserved.size} kept)</summary>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {TARGET_IDS.map((id) => <label key={id} className="flex min-h-10 items-center gap-3 pointer-coarse:min-h-11">
            <Checkbox aria-label={`Keep native MCP for ${HARNESS_NAMES[id]}`} checked={preserved.has(id)} disabled={busy} onCheckedChange={(checked) => {
              const next = new Set(preserved);
              if (checked === true) next.add(id);
              else next.delete(id);
              void save("preserveMcp", { ...current, preserveMcp: preservedMcpConfig(next) });
            }} />
            {HARNESS_NAMES[id]}
          </label>)}
        </div>
      </details>
    </ChipRow>
    {error && <p role="alert" className="px-[16px] py-2 text-sm text-bad">{error}</p>}
  </>;
}
