import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionLabel, SettingRow, settingsGroup } from "./kit";
import { record, strings } from "./live/follower";
import type { FollowerLive } from "./follower-types";

export interface PreservationPreferences {
  excludeSkills: string[];
  preserveMcp: boolean;
}

/** A save always carries the digest of the snapshot displayed here, never a freshly fetched digest. */
export function LocalPreservationControls({ live, sharedSkills, preferences, saveDemo }: {
  live?: Pick<FollowerLive, "local" | "action" | "savePreferences">;
  sharedSkills: boolean;
  preferences: PreservationPreferences;
  saveDemo: (next: PreservationPreferences) => void;
}) {
  const [skill, setSkill] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const snapshot = live?.local;
  const current = live ? {
    excludeSkills: strings(snapshot?.config.excludeSkills),
    preserveMcp: snapshot?.config.preserveMcp === true,
  } : preferences;
  const allowed = live ? strings(record(snapshot?.canonicalConfig.local).appendLocal).includes("skills") : sharedSkills;
  const busy = saving || live?.action.loading || (live !== undefined && !snapshot);
  const valid = /^[a-z0-9][a-z0-9-]*$/u.test(skill);
  const save = async (key: "excludeSkills" | "preserveMcp", next: PreservationPreferences) => {
    setSaving(true);
    setError(null);
    try {
      if (live) {
        const saved = await live.savePreferences({
          expectedDigest: snapshot?.items.find((item) => item.path === "local.jsonc")?.digest ?? null,
          edits: [{ path: [key], value: next[key] }],
        });
        if (!saved) { setError("Preferences were not saved. Reload and review the current settings before trying again."); return; }
      } else saveDemo(next);
      setSkill("");
    } finally { setSaving(false); }
  };
  return <div className="px-4 pt-8 sm:px-[18px]">
    <SectionLabel>Kept on this machine</SectionLabel>
    <p className="pb-2 text-sm text-pretty text-muted-foreground">These choices stay in ~/.canonfig/local/local.jsonc and never change the Source.</p>
    <div className={settingsGroup}>
      <SettingRow title="Keep native MCP on this machine" description={current.preserveMcp
        ? "Preserved, not disabled: Canonfig leaves native MCP maps alone. Server startup, authentication and connectivity are not verified."
        : "Native MCP follows the Source. Turning preservation off does not adopt conflicting local configuration."}>
        <Switch aria-label="Keep native MCP on this machine" checked={current.preserveMcp} disabled={busy} onCheckedChange={(preserveMcp) => { void save("preserveMcp", { ...current, preserveMcp }); }} />
      </SettingRow>
      <div className="px-4 py-3">
        <p className="text-sm font-medium">Kept-local skills</p>
        <p className="pb-2 text-sm text-muted-foreground">Named skills stay outside projection in every skill directory. Removing a name does not adopt or overwrite its local copy.</p>
        {!allowed && <p role="note" className="pb-2 text-sm">The Source must include skills in local.appendLocal before you can change this list.</p>}
        {current.excludeSkills.length === 0 && <p className="pb-2 text-sm text-muted-foreground">No skills kept local by name.</p>}
        <ul>{current.excludeSkills.map((name) => <li key={name} className="flex items-center justify-between gap-3 py-1">
          <span className="font-mono text-sm">{name}</span>
          <Button variant="outline" size="xs" disabled={busy || !allowed} aria-label={`Remove kept-local skill ${name}`} onClick={() => { void save("excludeSkills", { ...current, excludeSkills: current.excludeSkills.filter((entry) => entry !== name) }); }}>Remove</Button>
        </li>)}</ul>
        <form className="flex flex-wrap gap-2 pt-2" onSubmit={(event) => {
          event.preventDefault();
          if (!valid || !allowed || busy) return;
          void save("excludeSkills", { ...current, excludeSkills: [...new Set([...current.excludeSkills, skill])].sort() });
        }}>
          <Input aria-label="Skill name to keep local" value={skill} disabled={busy || !allowed} placeholder="my-skill" onChange={(event) => setSkill(event.target.value)} />
          <Button type="submit" variant="outline" size="sm" disabled={busy || !allowed || !valid || current.excludeSkills.includes(skill)}>Keep skill local</Button>
        </form>
        {skill && !valid && <p role="alert" className="pt-2 text-sm">Use lowercase letters, digits and hyphens, starting with a letter or digit.</p>}
        {error && <p role="alert" className="pt-2 text-sm">{error}</p>}
      </div>
    </div>
  </div>;
}
