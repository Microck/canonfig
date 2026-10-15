// Profile resources grouped by kind, with an editor in the detail panel.
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { CaretRight, Plus, Sparkle, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { holdNavigation, workspaceHref } from "./routes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatedNumber, DitherProgress, Hint, Mono, Term } from "@/shared/shared";
import { KIND_LABEL, PLAIN, POLICY_HINT, POLICY_TITLE, SECRETS_GROUP, profile, type Resource, type ResourceKind } from "@/shared/data";
import { SCANNED_TOOLS, toolFromScan, useSharedState, useWorkspace } from "./store";
import { ScheduleFields, WEEK, scheduleError, scheduleSummary, type Schedule } from "./schedule";
import { shq } from "@/shared/shell";
import {
  AnimatedRow,
  Body,
  ChangeMark,
  Cli,
  DetailPanel,
  EmptyState,
  Field,
  GroupChips,
  GroupRow,
  KIND_ICON,
  ListHead,
  ListRow,
  PageHeader,
  Prop,
  PublishButton,
  RowPresence,
  SectionLabel,
  Toolbar,
  ToolbarTab,
  copy,
  useGroups,
  type Group,
} from "./kit";

const KINDS: ResourceKind[] = ["file", "config", "skill", "directory", "tool", "credential"];

const POLICIES_BY_KIND: Record<ResourceKind, string[]> = {
  file: ["replace", "replace-if-unmodified", "append-local"],
  directory: ["mirror-owned", "replace"],
  config: ["merge", "replace"],
  skill: ["replace-if-unmodified", "replace"],
  tool: ["ensure"],
  credential: ["require-local"],
};

const VERIFY: Record<string, string> = {
  digest: "Compare file contents with the published digest.",
  "executable-present": "Check the program is on PATH and starts.",
  "mcp-qualification": "Start the MCP server and list its tools.",
  "credential-present": "Check the credential exists, without reading it.",
};

const DEFAULT_DETAIL: Record<ResourceKind, Record<string, string>> = {
  file: { Source: "" },
  directory: { Source: "" },
  config: { Format: "JSON" },
  skill: { Name: "" },
  tool: { macOS: "", Linux: "", Windows: "" },
  credential: { Reference: "" },
};

const DEFAULT_VERIFY: Record<ResourceKind, string> = {
  file: "digest",
  directory: "digest",
  config: "digest",
  skill: "digest",
  tool: "executable-present",
  credential: "credential-present",
};

const TARGET: Record<ResourceKind, { label: string; placeholder: string; missing: string }> = {
  file: { label: "Where on each machine", placeholder: "~/.codex/AGENTS.md", missing: "Enter where the file goes on each machine." },
  directory: { label: "Where on each machine", placeholder: "~/.agents/skills", missing: "Enter where the folder goes on each machine." },
  config: { label: "Settings file on each machine", placeholder: "~/.claude/settings.json", missing: "Enter the settings file to set keys in." },
  skill: { label: "Where on each machine", placeholder: "~/.claude/skills/code-review", missing: "Enter where the skill goes on each machine." },
  tool: { label: "Command", placeholder: "gh", missing: "Enter the command the tool provides." },
  credential: { label: "Credential name", placeholder: "github-token", missing: "Enter the credential name." },
};

const FORMATS = ["JSON", "TOML", "YAML"];

/** Detail entries edited by their own controls (format, Advanced), so not listed as content fields. */
const EDITOR_FIELDS = ["Format", "Verify", "Mode", "DependsOn"];

interface KeyRow {
  id: number;
  name: string;
  value: string;
}

function keyRowsOf(r: Resource): KeyRow[] {
  return Object.entries(r.keys ?? {}).map(([name, value], i) => ({ id: i, name, value }));
}

function blankResource(): Resource {
  return { id: "", kind: "file", target: "", policy: "replace", groups: [], summary: "", detail: { ...DEFAULT_DETAIL.file, Verify: "digest" } };
}

/** `r` without its Depends on choice, marked as an unpublished edit; for dependents of a removed item. */
function withoutDependency(r: Resource): Resource {
  return { ...r, detail: Object.fromEntries(Object.entries(r.detail).filter(([k]) => k !== "DependsOn")), change: r.change ?? "modified" };
}

/** A config value as the profile stores it: valid JSON text keeps its type (`42`, `false`, `"zed"`); anything else is written as a string. */
function jsonValue(text: string) {
  const t = text.trim();
  try {
    JSON.parse(t);
    return t;
  } catch {
    return JSON.stringify(text);
  }
}

function jsonc(r: Resource) {
  // "Nothing" in Depends on is the editor's empty choice, not an item id.
  const fields = Object.entries(r.detail).filter(([k, v]) => k !== "Verify" && !(k === "DependsOn" && v === "none"));
  const keys = Object.entries(r.keys ?? {});
  const lines = [
    `${JSON.stringify(r.id || "new-resource")}: {`,
    `  "kind": ${JSON.stringify(r.kind)},`,
    `  "target": ${JSON.stringify(r.target)},`,
    `  "policy": ${JSON.stringify(r.policy)},`,
    ...(r.groups.length ? [`  "groups": [${r.groups.map((g) => JSON.stringify(g)).join(", ")}],`] : []),
    // Editor field labels map to the file's camelCase names. Config keys are user data: exact case, typed values.
    ...fields.map(([k, v]) => `  ${JSON.stringify(`${k.charAt(0).toLowerCase()}${k.slice(1)}`)}: ${JSON.stringify(v)},`),
    ...(r.kind !== "config"
      ? []
      : keys.length === 0
        ? [`  "keys": {},`]
        : [`  "keys": {`, ...keys.map(([k, v], i) => `    ${JSON.stringify(k)}: ${jsonValue(v)}${i < keys.length - 1 ? "," : ""}`), `  },`]),
    `  "verify": ${JSON.stringify(r.detail.Verify ?? DEFAULT_VERIFY[r.kind])}`,
    `}`,
  ];
  return lines.join("\n");
}

/*
 * Name and Target stop growing at readable lengths (about 240 and 360px) and Summary takes what's left, so a
 * wide window doesn't push the columns apart. Summary's 140px minimum keeps a short note like
 * "from .claude/CLAUDE.md" whole at 1280px; below their caps the other columns shrink toward their minimums.
 */
const COLS = "16px minmax(150px,240px) minmax(180px,360px) 190px 140px minmax(140px,1fr)";

/** A checkbox row per Follower Group; the whole row toggles. */
function GroupPicker({ idPrefix, value, onChange }: { idPrefix: string; value: string[]; onChange: (groups: string[]) => void }) {
  const [groups] = useGroups();
  return (
    <div className="grid gap-0.5">
      {groups.map((g) => {
        const id = `${idPrefix}-${g.name}`;
        return (
          <Label key={g.name} htmlFor={id} className="flex h-7 cursor-pointer items-center gap-2 text-base font-normal">
            <Checkbox id={id} checked={value.includes(g.name)} onCheckedChange={(c) => onChange(c ? [...value, g.name] : value.filter((x) => x !== g.name))} />
            {g.name === SECRETS_GROUP ? (
              <>
                <span>Machines that {PLAIN.secretsGroup.toLowerCase()}</span>
                <span className="truncate font-mono text-xs text-faint">{g.name}</span>
              </>
            ) : (
              <>
                <span className="font-mono text-sm">{g.name}</span>
                <span className="truncate text-sm text-faint">{g.description}</span>
              </>
            )}
          </Label>
        );
      })}
    </div>
  );
}

/** A plain policy title; the real policy id is only in its tooltip ("Canonfig calls this merge."). */
function PolicyName({ id, tip = true }: { id: string; tip?: boolean }) {
  const name = <span className="truncate">{POLICY_TITLE[id] ?? id}</span>;
  if (!tip) return <span title={`Canonfig calls this ${id}.`}>{name}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{name}</TooltipTrigger>
      <TooltipContent>Canonfig calls this {id}.</TooltipContent>
    </Tooltip>
  );
}

/** What Profile → Defaults has saved. The page header reads the name from here too. */
interface ProfileDefaults {
  name: string;
  schedule: Schedule;
}

/** Both readers must pass the same initial: the profile as onboarding created it, checked daily at 09:00. */
function useProfileDefaults() {
  const ws = useWorkspace();
  return useSharedState<ProfileDefaults>("profile-defaults", { name: ws.profileName, schedule: { cadence: "daily", days: [], time: "09:00" } });
}

/**
 * The profile file's `scheduleDefault` (src/domain/profile.ts): daily, or weekly with lowercase day names,
 * always in each follower's local time, since every scheduler backend can render only that.
 */
function scheduleDefaultOf(s: Schedule) {
  if (s.cadence === "daily") return { type: "daily", at: s.time, timezone: "local" };
  const days = s.cadence === "weekdays" ? WEEK.slice(0, 5) : WEEK.filter((d) => s.days.includes(d));
  return { type: "weekly", days: days.map((d) => d.toLowerCase()), at: s.time, timezone: "local" };
}

export function ProfileView() {
  const ws = useWorkspace();
  const [groups] = useGroups();
  const [defaults] = useProfileDefaults();
  const tab = ws.profileTab;
  const selected = ws.focus;
  const creating = selected === "new";
  const [discoverOpen, setDiscoverOpen] = useState(false);

  const proposed = ws.proposed.filter((id) => ws.resources.some((r) => r.id === id));
  const grouped = useMemo(() => KINDS.map((k) => ({ kind: k, items: ws.resources.filter((r) => r.kind === k) })).filter((g) => g.items.length), [ws.resources]);
  const current = ws.resources.find((r) => r.id === selected);

  const close = () => ws.go("profile");
  const startCreating = () => ws.go("profile", "new");

  const detail =
    tab === "resources" && (creating || current) ? (
      <ResourceEditor
        key={creating ? "new" : current!.id}
        resource={creating ? blankResource() : current!}
        isNew={creating}
        onClose={close}
        onSaved={(id) => ws.go("profile", id, { replace: creating })}
      />
    ) : undefined;

  return (
    <>
      <PageHeader
        crumbs={["Profile", defaults.name]}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDiscoverOpen(true)}>
              Discover tools
            </Button>
            <Button variant="ghost" size="sm" onClick={startCreating}>
              <Plus />
              Add item
            </Button>
            <PublishButton />
          </>
        }
      />
      <Toolbar
        right={
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-faint">
            Profile file
            <button
              type="button"
              title="Copy path"
              className="truncate rounded font-mono text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => copy(ws.profileFile, "Profile path copied")}
            >
              {ws.profileFile}
            </button>
            <Hint label="the profile file">
              The file on disk is the source of truth. Edits here are written into it in place and keep your comments. Hand edits show up here too. In this demo, edits stay in
              this browser session and no file is written.
            </Hint>
          </span>
        }
      >
        <ToolbarTab active={tab === "resources"} href={workspaceHref("source", "profile")} count={ws.resources.length}>
          Items
        </ToolbarTab>
        <ToolbarTab active={tab === "groups"} href={workspaceHref("source", "profile", { profileTab: "groups" })} count={groups.length}>
          {PLAIN.groups}
        </ToolbarTab>
        <ToolbarTab active={tab === "defaults"} href={workspaceHref("source", "profile", { profileTab: "defaults" })}>
          Defaults
        </ToolbarTab>
      </Toolbar>
      {tab === "resources" && (
        <Body detail={detail}>
          <RowPresence>
            {proposed.length > 0 && (
              <AnimatedRow key="proposed">
                <div className="flex items-center gap-3 border-b border-border bg-gold/8 px-4 py-2.5 text-sm">
                  <Sparkle weight="fill" className="size-3.5 shrink-0 text-gold" />
                  <span className="min-w-0 text-pretty">
                    Canonfig found <AnimatedNumber value={proposed.length} /> {proposed.length === 1 ? "tool" : "tools"} in your agent config. Open each one to review it, remove
                    any you don't want, then publish revision {ws.nextSequence}. Nothing reaches other machines before you publish.
                  </span>
                  <Button variant="outline" size="xs" className="ml-auto shrink-0" onClick={() => ws.go("profile", proposed[0])}>
                    Review the first
                  </Button>
                </div>
              </AnimatedRow>
            )}
          </RowPresence>
          {grouped.length === 0 ? (
            <EmptyState
              title="The profile is empty"
              body="Add the files, settings, skills and tools every machine should have, or discover tools from your config files."
              action={
                <Button variant="outline" size="sm" onClick={startCreating}>
                  Add item
                </Button>
              }
            />
          ) : (
            <>
              <ListHead cols={COLS}>
                <span />
                <span>Name</span>
                <span>Target</span>
                <span>
                  <Term term="Apply Policy">If it differs there</Term>
                </span>
                <span>Groups</span>
                <span>Summary</span>
              </ListHead>
              {grouped.map((g) => (
                <div key={g.kind}>
                  <GroupRow icon={KIND_ICON[g.kind]} label={KIND_LABEL[g.kind].label} count={g.items.length} hint={KIND_LABEL[g.kind].hint} />
                  <RowPresence>
                    {g.items.map((r) => (
                      <AnimatedRow key={r.id}>
                        <ListRow
                          cols={COLS}
                          selected={selected === r.id && !creating}
                          onClick={() => ws.go("profile", r.id)}
                          className={cn(r.change === "removed" && "text-faint line-through decoration-faint", proposed.includes(r.id) && selected !== r.id && "before:bg-gold/6")}
                        >
                          <ChangeMark change={r.change} />
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">{r.id}</span>
                            {proposed.includes(r.id) && (
                              <span className="inline-flex h-4 shrink-0 items-center rounded-[3px] bg-gold/15 px-1 text-[10px] font-semibold text-gold">Proposed</span>
                            )}
                          </span>
                          <Mono className="truncate">{r.target}</Mono>
                          <span className="text-sm text-muted-foreground">
                            <PolicyName id={r.policy} />
                          </span>
                          <GroupChips groups={r.groups} />
                          <span className="truncate text-sm text-faint" title={r.summary}>
                            {r.summary}
                          </span>
                        </ListRow>
                      </AnimatedRow>
                    ))}
                  </RowPresence>
                </div>
              ))}
            </>
          )}
          <div className="h-16" />
        </Body>
      )}
      {tab === "groups" && <GroupsTab />}
      {tab === "defaults" && <DefaultsTab />}
      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />
    </>
  );
}

function ResourceEditor({ resource, isNew, onClose, onSaved }: { resource: Resource; isNew: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const ws = useWorkspace();
  const [draft, setDraft] = useState<Resource>(resource);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<Resource>) => setDraft((d) => ({ ...d, ...patch }));
  const setDetail = (k: string, v: string) => setDraft((d) => ({ ...d, detail: { ...d.detail, [k]: v } }));
  const isConfig = draft.kind === "config";
  const contentKeys = Object.keys(draft.detail).filter((k) => !EDITOR_FIELDS.includes(k));
  const others = ws.resources.filter((r) => r.id !== resource.id);
  // A removed item disappears at the next publish, so nothing new may depend on it.
  const dependencyChoices = others.filter((r) => r.change !== "removed");
  const dependents = others.filter((r) => r.detail.DependsOn === resource.id);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const Icon = KIND_ICON[draft.kind];

  // Config keys are edited as rows so a key can be renamed, including a new one that has no name yet.
  const [rows, setRows] = useState<KeyRow[]>(() => keyRowsOf(resource));
  const [focusRow, setFocusRow] = useState<number | null>(null);
  // Unnamed rows are still edits even though they cannot enter the saved key map yet.
  const dirty = JSON.stringify(draft) !== JSON.stringify(resource)
    || JSON.stringify(rows.map(({ name, value }) => [name, value])) !== JSON.stringify(Object.entries(resource.keys ?? {}));
  const updateRows = (next: KeyRow[]) => {
    setRows(next);
    setDraft((d) => ({ ...d, keys: Object.fromEntries(next.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value])) }));
  };
  const rowError = (r: KeyRow) => {
    const name = r.name.trim();
    if (!tried) return null;
    if (!name) return "Name this key, or remove the row.";
    if (rows.some((x) => x.id !== r.id && x.name.trim() === name)) return `${name} is listed twice.`;
    return null;
  };

  // Closing, choosing another row or leaving the page asks before discarding edits. The guard sits in
  // routes.ts, which every in-app link, row, sidebar entry and palette command navigates through.
  const [leaveRequest, setLeaveRequest] = useState<(() => void) | null>(null);
  const releaseNavigation = useRef<() => void>(() => {});
  useEffect(() => {
    if (!dirty) return;
    const release = holdNavigation((proceed) => {
      setLeaveRequest(() => proceed);
      return true;
    });
    releaseNavigation.current = release;
    return release;
  }, [dirty]);
  /** For exits that already settle the draft (save, remove, Cancel on a new item), so they never ask. */
  const leaveWithoutAsking = (leave: () => void) => {
    releaseNavigation.current();
    leave();
  };

  const id = draft.id.trim();
  const idError = !id ? "Enter a name." : !/^[a-z0-9][a-z0-9-]*$/.test(id) ? "Use lowercase letters, digits and dashes." : others.some((r) => r.id === id) ? `${id} is already in the profile.` : null;
  const targetError = !draft.target.trim() ? TARGET[draft.kind].missing : null;
  const hasMode = draft.kind === "file" || draft.kind === "directory";
  // Unix permission bits: three octal digits (644), or four with the setuid/setgid/sticky digit first (0644).
  const modeError = hasMode && draft.detail.Mode !== undefined && !/^[0-7]{3,4}$/.test(draft.detail.Mode) ? "Use 3 or 4 octal digits (0 to 7), like 0644." : null;
  const dependencyError = (() => {
    const dep = draft.detail.DependsOn;
    if (!dep || dep === "none") return null;
    if (dep === id) return "An item can't depend on itself.";
    // Walk the chain as it would stand after this save: items that pointed at the old name follow the rename.
    const after = new Map(others.map((r) => [r.id, r.detail.DependsOn === resource.id ? id : r.detail.DependsOn] as const));
    const chain = [id];
    for (let at: string | undefined = dep; at && at !== "none" && chain.length <= after.size + 1; at = after.get(at)) {
      chain.push(at);
      if (at === id) return `This makes a loop: ${chain.join(" → ")}. Choose another item or Nothing.`;
    }
    return null;
  })();

  const save = (form: HTMLFormElement) => {
    setTried(true);
    const badRow = isConfig ? rows.find((r) => !r.name.trim() || rows.some((x) => x.id !== r.id && x.name.trim() === r.name.trim())) : undefined;
    if (idError || targetError || badRow || modeError || dependencyError) {
      const selector = idError ? "#res-id" : targetError ? "#res-target" : badRow ? `#res-key-${badRow.id}` : modeError ? "#res-mode" : "#res-deps";
      // Mode and Depends on live under Advanced, which renders its fields only while open.
      if (!idError && !targetError && !badRow) flushSync(() => setAdvancedOpen(true));
      form.querySelector<HTMLElement>(selector)?.focus();
      return;
    }
    const summary = isConfig ? `${rows.length} ${draft.detail.Format ?? "JSON"} ${rows.length === 1 ? "key" : "keys"}` : draft.summary || KIND_LABEL[draft.kind].label;
    const next: Resource = { ...draft, id, target: draft.target.trim(), change: isNew ? "added" : resource.change ?? "modified", summary };
    // Items that depended on the old name follow the rename, so no declaration points at a missing item.
    const renamedDependents = !isNew && id !== resource.id ? dependents : [];
    ws.setResources((prev) => {
      const saved = isNew ? [...prev, next] : prev.map((r) => (r.id === resource.id ? next : r));
      return renamedDependents.length === 0
        ? saved
        : saved.map((r) => (r.detail.DependsOn === resource.id ? { ...r, detail: { ...r.detail, DependsOn: id }, change: r.change ?? "modified" } : r));
    });
    const unpublished = ws.pending.length + (resource.change && !isNew ? 0 : 1) + renamedDependents.filter((r) => !r.change).length;
    const updated = renamedDependents.length
      ? ` ${renamedDependents.map((r) => r.id).join(", ")} now ${renamedDependents.length === 1 ? "depends" : "depend"} on ${id}.`
      : "";
    toast.success(isNew ? `Added ${id}` : `Saved ${id}`, {
      description: `Goes out with revision ${ws.nextSequence}: ${unpublished} unpublished ${unpublished === 1 ? "change" : "changes"}.${updated} Saved in this demo workspace.`,
    });
    setDraft(next);
    setRows(keyRowsOf(next));
    setTried(false);
    leaveWithoutAsking(() => onSaved(id));
  };

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{isNew ? "New item" : resource.id}</span>
        </span>
      }
      subtitle={isNew ? undefined : <ChangeMark change={resource.change} />}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-bad" onClick={() => setConfirmRemove(true)}>
              Remove…
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={isNew ? () => leaveWithoutAsking(onClose) : () => (setDraft(resource), setRows(keyRowsOf(resource)), setTried(false))}
              disabled={!isNew && !dirty}
            >
              {isNew ? "Cancel" : "Discard"}
            </Button>
            <Button type="submit" form="res-form" variant="secondary" size="sm" disabled={!isNew && !dirty}>
              {isNew ? "Add to profile" : "Save to profile"}
            </Button>
          </div>
        </>
      }
    >
      <form
        id="res-form"
        className="grid gap-4 px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          save(e.currentTarget);
        }}
      >
        <Field label="Name" htmlFor="res-id" error={tried && idError ? idError : null}>
          <Input
            id="res-id"
            value={draft.id}
            placeholder="codex-agents"
            onChange={(e) => set({ id: e.target.value })}
            aria-invalid={tried && !!idError}
            aria-describedby={tried && idError ? "res-id-note" : undefined}
            autoComplete="off"
            spellCheck={false}
            autoFocus={isNew}
            className="font-mono text-sm"
          />
        </Field>
        <Field label="Kind" htmlFor="res-kind" hint={isNew ? <>The kind of <Term term="Profile Resource">item</Term> decides how Canonfig copies and checks it.</> : undefined}>
          <Select
            value={draft.kind}
            onValueChange={(k: ResourceKind) => {
              set({ kind: k, policy: POLICIES_BY_KIND[k][0], detail: { ...DEFAULT_DETAIL[k], Verify: DEFAULT_VERIFY[k] }, keys: k === "config" ? {} : undefined });
              setRows([]);
            }}
            disabled={!isNew}
          >
            <SelectTrigger id="res-kind" className="w-full">
              <SelectValue>{KIND_LABEL[draft.kind].label}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" className="w-[var(--radix-select-trigger-width)]">
              {KINDS.map((k) => {
                const KIcon = KIND_ICON[k];
                return (
                  <SelectItem key={k} value={k} className="items-start py-1.5">
                    <KIcon className="mt-0.5 text-muted-foreground" />
                    <span className="grid gap-0.5">
                      <span className="text-base">{KIND_LABEL[k].label}</span>
                      <span className="text-xs whitespace-normal text-muted-foreground">{KIND_LABEL[k].hint}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {!isNew && <p className="text-sm text-pretty text-faint">{KIND_LABEL[draft.kind].hint}</p>}
        </Field>
        <Field label={TARGET[draft.kind].label} htmlFor="res-target" error={tried && targetError ? targetError : null}>
          <Input
            id="res-target"
            value={draft.target}
            placeholder={TARGET[draft.kind].placeholder}
            onChange={(e) => set({ target: e.target.value })}
            aria-invalid={tried && !!targetError}
            aria-describedby={tried && targetError ? "res-target-note" : undefined}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
          />
        </Field>
        <Field label={<Term term="Apply Policy">{PLAIN.applyPolicy}</Term>} htmlFor="res-policy">
          <Select value={draft.policy} onValueChange={(p) => set({ policy: p })}>
            <SelectTrigger id="res-policy" className="w-full">
              <SelectValue>
                <PolicyName id={draft.policy} tip={false} />
              </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" className="w-[var(--radix-select-trigger-width)]">
              {POLICIES_BY_KIND[draft.kind].map((p) => (
                <SelectItem key={p} value={p} className="items-start py-1.5">
                  <span className="grid gap-0.5">
                    <PolicyName id={p} tip={false} />
                    <span className="text-xs whitespace-normal text-muted-foreground">{POLICY_HINT[p]}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-pretty text-faint">{POLICY_HINT[draft.policy]}</p>
        </Field>
        <Field
          label={<Term term="Follower Group">Who gets it</Term>}
          description={draft.groups.length === 0 ? "Every machine gets this. Tick a group to send it only to that group's machines." : "Only machines in these groups get it."}
        >
          <GroupPicker idPrefix="grp" value={draft.groups} onChange={(groups) => set({ groups })} />
        </Field>

        {isConfig && (
          <div className="grid gap-2">
            <Field label="File format" htmlFor="res-format">
              <Select value={draft.detail.Format ?? "JSON"} onValueChange={(v) => setDetail("Format", v)}>
                <SelectTrigger id="res-format" className="w-32" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <SectionLabel
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    const next = Math.max(-1, ...rows.map((r) => r.id)) + 1;
                    updateRows([...rows, { id: next, name: "", value: '""' }]);
                    setFocusRow(next);
                  }}
                >
                  <Plus /> Add key
                </Button>
              }
            >
              Keys Canonfig sets
            </SectionLabel>
            {rows.length === 0 && <p className="text-sm text-faint">No keys yet. Add the first key Canonfig should set in this file.</p>}
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_24px] items-start gap-x-1.5 gap-y-1.5">
              {rows.length > 0 && (
                <>
                  <span className="text-xs text-faint">Key path</span>
                  <span className="text-xs text-faint">Value</span>
                  <span />
                </>
              )}
              {rows.map((r, i) => {
                const err = rowError(r);
                return (
                  <div key={r.id} className="contents">
                    <div className="grid gap-1">
                      <Input
                        id={`res-key-${r.id}`}
                        value={r.name}
                        aria-label={`Key ${i + 1} path`}
                        placeholder="permissions.defaultMode"
                        autoFocus={focusRow === r.id}
                        aria-invalid={!!err}
                        aria-describedby={err ? `res-key-${r.id}-note` : undefined}
                        onChange={(e) => updateRows(rows.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-7 font-mono text-sm"
                      />
                      {err && <span id={`res-key-${r.id}-note`} role="alert" className="text-xs text-bad">{err}</span>}
                    </div>
                    <Input
                      value={r.value}
                      aria-label={`Key ${i + 1} value`}
                      onChange={(e) => updateRows(rows.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-7 font-mono text-sm"
                    />
                    <Button type="button" variant="ghost" size="icon-xs" className="mt-0.5 text-faint" aria-label={`Remove key ${r.name || i + 1}`} onClick={() => updateRows(rows.filter((x) => x.id !== r.id))}>
                      <X />
                    </Button>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-pretty text-faint">Values are written as {draft.detail.Format ?? "JSON"}: put text in quotes, like "zed"; numbers and true/false without.</p>
          </div>
        )}

        {!isConfig && contentKeys.length > 0 && (
          <div className="grid gap-2">
            <SectionLabel>{draft.kind === "tool" ? "Install recipe per system" : "Content"}</SectionLabel>
            <div className="grid gap-2">
              {contentKeys.map((k) => (
                <div key={k} className="grid grid-cols-[120px_1fr] items-center gap-x-2 gap-y-1">
                  <Label htmlFor={`d-${k}`} title={k} className="truncate text-sm font-normal text-muted-foreground">
                    {k}
                  </Label>
                  <Input id={`d-${k}`} value={draft.detail[k]} onChange={(e) => setDetail(k, e.target.value)} autoComplete="off" spellCheck={false} className="h-7 font-mono text-sm" />
                </div>
              ))}
            </div>
          </div>
        )}

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1 rounded text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
            <CaretRight className="size-3.5 transition-transform duration-150 ease-snap group-data-[state=open]:rotate-90" />
            Advanced
            <span className="ml-1 font-normal text-faint">verify, file mode, depends on</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-3 pt-2 pl-4">
            <Field label="Verify with" htmlFor="res-verify">
              <Select value={draft.detail.Verify ?? DEFAULT_VERIFY[draft.kind]} onValueChange={(v) => setDetail("Verify", v)}>
                <SelectTrigger id="res-verify" className="w-full" size="sm">
                  <SelectValue>
                    <span className="font-mono text-sm">{draft.detail.Verify ?? DEFAULT_VERIFY[draft.kind]}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent position="popper">
                  {Object.entries(VERIFY).map(([v, hint]) => (
                    <SelectItem key={v} value={v} className="items-start py-1.5">
                      <span className="grid gap-0.5">
                        <span className="font-mono text-sm">{v}</span>
                        <span className="text-xs whitespace-normal text-muted-foreground">{hint}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {hasMode && (
              <Field label="File mode" htmlFor="res-mode" description="Octal permissions, applied on Linux and macOS." error={tried && modeError ? modeError : null}>
                <Input
                  id="res-mode"
                  value={draft.detail.Mode ?? "0644"}
                  onChange={(e) => setDetail("Mode", e.target.value)}
                  aria-invalid={tried && !!modeError}
                  aria-describedby="res-mode-note"
                  inputMode="numeric"
                  autoComplete="off"
                  className="h-7 w-24 font-mono text-sm tabular-nums"
                />
              </Field>
            )}
            <Field
              label="Depends on"
              htmlFor="res-deps"
              description="Applied after the chosen item, for example a tool before its settings."
              error={tried && dependencyError ? dependencyError : null}
            >
              <Select value={draft.detail.DependsOn ?? "none"} onValueChange={(v) => setDetail("DependsOn", v)}>
                <SelectTrigger id="res-deps" className="w-full" size="sm" aria-invalid={tried && !!dependencyError} aria-describedby="res-deps-note">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="none">Nothing</SelectItem>
                  {dependencyChoices.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      <span className="font-mono text-sm">{o.id}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </CollapsibleContent>
        </Collapsible>

        <Collapsible>
          <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1 rounded text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
            <CaretRight className="size-3.5 transition-transform duration-150 ease-snap group-data-[state=open]:rotate-90" />
            As written in the profile file
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <pre tabIndex={0} aria-label="This item as written in the profile file" className="overflow-x-auto rounded-md border border-border bg-canvas/70 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
              <span className="text-faint">// {ws.profileFile} → resources{"\n"}</span>
              {jsonc(draft)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </form>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {resource.id}?</DialogTitle>
            <DialogDescription className="text-base text-pretty">
              After you publish, Canonfig stops managing <span className="font-mono text-sm text-foreground">{resource.target}</span> on your machines. Their copies stay on disk.
              {dependents.length > 0 && ` ${dependents.map((r) => r.id).join(", ")} ${dependents.length === 1 ? "depends" : "depend"} on it; that dependency is dropped.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                // Dependents drop the reference now, so no declaration points at an item that is going away.
                ws.setResources((prev) =>
                  (resource.change === "added" ? prev.filter((r) => r.id !== resource.id) : prev.map((r) => (r.id === resource.id ? { ...r, change: "removed" as const } : r))).map(
                    (r) => (r.detail.DependsOn === resource.id ? withoutDependency(r) : r),
                  ),
                );
                setConfirmRemove(false);
                leaveWithoutAsking(onClose);
                toast(`Removed ${resource.id}`, {
                  description: `${dependents.length ? `${dependents.map((r) => r.id).join(", ")} no longer ${dependents.length === 1 ? "depends" : "depend"} on it. ` : ""}Publish to apply this to followers.`,
                });
              }}
            >
              Remove item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={leaveRequest !== null} onOpenChange={(o) => !o && setLeaveRequest(null)}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription className="text-base text-pretty">
              Your edits to {isNew ? "this new item" : resource.id} aren't saved. Leaving now discards them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLeaveRequest(null)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const proceed = leaveRequest;
                setLeaveRequest(null);
                if (proceed) leaveWithoutAsking(proceed);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DetailPanel>
  );
}

function GroupsTab() {
  const ws = useWorkspace();
  const [groups, setGroups] = useGroups();
  const selected = ws.focus;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [tried, setTried] = useState(false);
  const cols = "minmax(180px,1fr) minmax(220px,2fr) 110px 110px";
  const trimmed = name.trim();
  const problem = !trimmed
    ? "Enter a name."
    : !/^[a-z0-9][a-z0-9-]*$/.test(trimmed)
      ? "Use lowercase letters, digits and dashes."
      : groups.some((g) => g.name === trimmed)
        ? `${trimmed} already exists.`
        : null;
  const nameError = tried ? problem : null;
  const current = groups.find((g) => g.name === selected);

  return (
    <Body detail={current && <GroupDetail key={current.name} group={current} onClose={() => ws.navigate(workspaceHref("source", "profile", { profileTab: "groups" }))} />}>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm text-muted-foreground">
        <span className="text-pretty">
          A <Term term="Follower Group">group</Term> gets extra items on top of the base profile. A machine's groups come from its invitation; open a group to add machines.
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          onClick={() => {
            setName("");
            setDesc("");
            setTried(false);
            setOpen(true);
          }}
        >
          New group
        </Button>
      </div>
      <ListHead cols={cols}>
        <span>Group</span>
        <span>What it's for</span>
        <span>Machines</span>
        <span>Items</span>
      </ListHead>
      <RowPresence>
        {groups.map((g) => (
          <AnimatedRow key={g.name}>
            <ListRow cols={cols} selected={selected === g.name} onClick={() => ws.navigate(workspaceHref("source", "profile", { profileTab: "groups", focus: g.name }))}>
              <span className="flex min-w-0 items-center gap-1.5">
                {g.name === SECRETS_GROUP ? (
                  <>
                    <span className="truncate">{PLAIN.secretsGroup}</span>
                    <span className="shrink-0 font-mono text-xs text-faint">{g.name}</span>
                  </>
                ) : (
                  <span className="truncate font-mono text-sm">{g.name}</span>
                )}
              </span>
              <span className="truncate text-sm text-muted-foreground">{g.description}</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                <AnimatedNumber value={ws.followers.filter((f) => f.groups.includes(g.name)).length} />
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">{ws.resources.filter((r) => r.groups.includes(g.name)).length}</span>
            </ListRow>
          </AnimatedRow>
        ))}
      </RowPresence>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (problem) return;
              setGroups((g) => [...g, { name: trimmed, description: desc.trim() || "No description" }]);
              // A group is profile content, so it waits for the next revision like an item edit.
              ws.markProfileEdit({ area: "group", id: trimmed, change: "added" });
              setOpen(false);
              toast.success(`Added group ${trimmed}`, { description: `Goes out with revision ${ws.nextSequence}. Saved in this demo workspace.` });
            }}
          >
            <DialogHeader>
              <DialogTitle>New group</DialogTitle>
              <DialogDescription className="text-base text-pretty">Machines join a group through their invitation. After you add it, open the group to add machines.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Field label="Name" htmlFor="g-name" error={nameError}>
                <Input
                  id="g-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? "g-name-note" : undefined}
                  placeholder="work-laptops"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="What it's for" htmlFor="g-desc">
                <Input id="g-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Laptops used for client work" autoComplete="off" />
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="secondary">
                Add group
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Body>
  );
}

function GroupDetail({ group: g, onClose }: { group: Group; onClose: () => void }) {
  const ws = useWorkspace();
  const members = ws.followers.filter((f) => f.groups.includes(g.name));
  const outside = ws.followers.length - members.length;
  const items = ws.resources.filter((r) => r.groups.includes(g.name));
  return (
    <DetailPanel
      title={g.name === SECRETS_GROUP ? PLAIN.secretsGroup : <span className="font-mono">{g.name}</span>}
      subtitle={g.name === SECRETS_GROUP ? <Mono>{g.name}</Mono> : undefined}
      onClose={onClose}
      footer={
        <Button variant="secondary" size="sm" className="ml-auto" disabled={outside === 0} onClick={() => ws.setChangeGroups({ addGroup: g.name })}>
          Add a machine…
        </Button>
      }
    >
      <p className="border-b border-border px-4 py-3 text-base text-pretty text-muted-foreground">
        {g.name === SECRETS_GROUP ? "Only machines in this group receive the shared secrets you set in Secrets." : g.description}
      </p>
      <div className="px-4 pt-3">
        <SectionLabel>Machines in it</SectionLabel>
      </div>
      {members.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-muted-foreground">No machine yet.</p>
      ) : (
        <div className="pb-3">
          {members.map((f) => (
            <div key={f.id} className="flex h-8 items-center gap-2 px-4 text-base">
              {f.name}
              <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => ws.setChangeGroups({ followerId: f.id })}>
                Change groups…
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-border px-4 pt-3">
        <SectionLabel>Items only this group gets</SectionLabel>
        <div className="pb-3">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">None. Tick this group under “Who gets it” on an item.</p>
          ) : (
            items.map((r) => (
              <Prop key={r.id} label={KIND_LABEL[r.kind].label}>
                <span className="font-medium">{r.id}</span>
              </Prop>
            ))
          )}
        </div>
      </div>
      <p className="border-t border-border px-4 py-3 text-sm text-pretty text-faint">
        A machine's groups come from the invitation it joined with. Adding or removing one makes a new invitation, and the machine joins again with it.
      </p>
    </DetailPanel>
  );
}

function DefaultsTab() {
  const ws = useWorkspace();
  const [saved, setSaved] = useProfileDefaults();
  const [name, setName] = useState(saved.name);
  const [schedule, setSchedule] = useState<Schedule>(saved.schedule);
  const [tried, setTried] = useState(false);
  const trimmed = name.trim();
  const nameError = tried && !trimmed ? "Enter a display name." : null;
  const scheduleProblem = scheduleError(schedule);
  return (
    <Body>
      <form
        className="max-w-[560px] px-8 py-6"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!trimmed || scheduleProblem) return;
          // Saving unchanged values is not an edit, so it must not add an unpublished change.
          const changed = trimmed !== saved.name || JSON.stringify(schedule) !== JSON.stringify(saved.schedule);
          setSaved({ name: trimmed, schedule });
          if (changed) ws.markProfileEdit({ area: "defaults", id: "defaults", change: "modified" });
          setName(trimmed);
          setTried(false);
          toast.success("Defaults saved", {
            description: `${scheduleSummary(schedule, "")}.${changed ? ` Goes out with revision ${ws.nextSequence}.` : ""} Saved in this demo workspace.`,
          });
        }}
      >
        <SectionLabel>Profile</SectionLabel>
        <div className="grid gap-4 py-2">
          <Field label="Display name" htmlFor="p-name" error={nameError}>
            <Input
              id="p-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!nameError}
              aria-describedby={nameError ? "p-name-note" : undefined}
              autoComplete="off"
            />
          </Field>
          <Field label="Profile id" description="Machines pick a profile by id when they join, so it can't change once machines use it.">
            <Mono className="text-sm text-foreground">{profile.id}</Mono>
          </Field>
        </div>
        <SectionLabel className="mt-6">
          <Term term="Synchronization Schedule">Default schedule</Term>
        </SectionLabel>
        <p className="mb-3 text-sm text-pretty text-muted-foreground">New machines check for revisions at this time unless they set their own. Times are each machine's local time.</p>
        <ScheduleFields idPrefix="def" value={schedule} onChange={setSchedule} />
        {/* The default is a profile-file edit, not a command. An incomplete schedule has no valid value, so this waits for a complete one. */}
        {!scheduleProblem && (
          <div className="mt-4 grid gap-2">
            <pre
              tabIndex={0}
              aria-label="The default schedule as written in the profile file"
              className="overflow-x-auto rounded-md border border-border bg-canvas/70 p-3 font-mono text-xs leading-relaxed text-muted-foreground"
            >
              <span className="text-faint">// {ws.profileFile}{"\n"}</span>
              {`"scheduleDefault": { ${Object.entries(scheduleDefaultOf(schedule))
                .map(([k, v]) => `${JSON.stringify(k)}: ${Array.isArray(v) ? `[${v.map((d) => JSON.stringify(d)).join(", ")}]` : JSON.stringify(v)}`)
                .join(", ")} }`}
            </pre>
            <p className="text-sm text-pretty text-faint">Saving writes this into the profile file. A machine follows the default once this runs on it:</p>
            <Cli>canonfig schedule set --default</Cli>
          </div>
        )}
        <div className="mt-8">
          <Button type="submit" variant="secondary" size="sm" disabled={scheduleProblem !== null}>
            Save defaults
          </Button>
        </div>
      </form>
    </Body>
  );
}

// `source scan` reads only the named files and proposes a tool resource per command it finds there.
const SCAN_FILES = ["~/.codex/config.toml", "~/.claude.json"];

function DiscoverDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = useWorkspace();
  const [progress, setProgress] = useState(0);
  const [picked, setPicked] = useState<string[]>(["playwright-mcp", "uv"]);

  useEffect(() => {
    if (!open) return;
    setProgress(0);
    const t = window.setInterval(() => setProgress((p) => (p >= 100 ? 100 : p + 10)), 110);
    return () => window.clearInterval(t);
  }, [open]);

  const done = progress >= 100;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Discover tools</DialogTitle>
          <DialogDescription className="text-base text-pretty">
            Canonfig reads only <span className="font-mono text-sm text-foreground">{SCAN_FILES[0]}</span> and{" "}
            <span className="font-mono text-sm text-foreground">{SCAN_FILES[1]}</span>, and proposes a tool for each command it finds there. It runs nothing. This demo
            reads no files and shows example results.
          </DialogDescription>
        </DialogHeader>
        {!done ? (
          <div className="grid h-[132px] content-center gap-2" aria-live="polite">
            <DitherProgress value={progress} label="Finding tools" />
            <span className="text-sm text-muted-foreground">Finding tools…</span>
          </div>
        ) : (
          <div className="-mx-4 border-y border-border">
            {SCANNED_TOOLS.map((f) => (
              <label key={f.id} className="flex h-11 cursor-pointer items-center gap-3 border-b border-border/70 px-4 last:border-b-0 hover:bg-raised/50">
                <Checkbox checked={picked.includes(f.id)} onCheckedChange={(c) => setPicked((p) => (c ? [...p, f.id] : p.filter((x) => x !== f.id)))} />
                <span className="grid min-w-0">
                  <span className="text-base font-medium">{f.id}</span>
                  <Mono className="truncate text-faint">{f.command}</Mono>
                </span>
                <span className="ml-auto shrink-0 text-sm whitespace-nowrap text-muted-foreground" title={`${f.file}, ${f.where}`}>
                  {f.file.split("/").pop()}
                </span>
              </label>
            ))}
          </div>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <Cli className="flex-1">{`canonfig source scan${SCAN_FILES.map((f) => ` --file ${shq(f)}`).join("")}`}</Cli>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              disabled={!done || picked.length === 0}
              onClick={() => {
                const chosen = SCANNED_TOOLS.filter((f) => picked.includes(f.id)).map(toolFromScan);
                // Tools already in the profile stay as they are; the toast counts only real additions.
                const added = chosen.filter((a) => !ws.resources.some((p) => p.id === a.id));
                const present = chosen.filter((a) => !added.includes(a)).map((a) => a.id);
                const presentNote = present.length ? `${present.join(", ")} ${present.length === 1 ? "is" : "are"} already in the profile.` : "";
                if (added.length) ws.setResources((prev) => [...prev, ...added]);
                onOpenChange(false);
                if (added.length === 0) toast("Nothing new to add", { description: presentNote });
                else
                  toast.success(`Added ${added.length} ${added.length === 1 ? "tool" : "tools"}`, {
                    description: `${presentNote ? `${presentNote} ` : ""}Publish to send ${added.length === 1 ? "it" : "them"} to your machines.`,
                  });
              }}
            >
              {picked.length === 0 ? "Add tools" : `Add ${picked.length} ${picked.length === 1 ? "tool" : "tools"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
