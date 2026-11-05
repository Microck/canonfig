// The Source's Canonical Folder (~/.canonfig/) by category, with an editor in the detail panel, plus the
// folder's harness list, Follower Groups and profile defaults. The real GUI edits the folder's files and
// canonfig.jsonc in place, keeping comments; the demo keeps edits in the browser session.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CaretRight, Plus, Sparkle, X } from "@/components/icons";
import { cn, removeKeepingFocus } from "@/lib/utils";
import { workspaceHref } from "./routes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AnimatedNumber, DitherProgress, Hint, Mono, Term } from "@/shared/shared";
import {
  CATEGORY_LABEL,
  DEMO,
  HARNESS_NAMES,
  LOCAL_CATEGORIES,
  PLAIN,
  SECRETS_GROUP,
  itemPath,
  machine,
  profile,
  type HarnessId,
  type ItemCategory,
  type LocalCategory,
  type Resource,
} from "@/shared/data";
import { SCANNED_TOOLS, toolFromScan, useSharedState, useWorkspace } from "./store";
import { ScheduleFields, WEEK, scheduleError, scheduleSummary, type Schedule } from "./schedule";
import { HarnessTable } from "./harnesses";
import { SkillSummary, SkillUpstream, useMoveSkillTracking, useSkillUpdating } from "./skills";
import {
  AnimatedRow,
  Body,
  CATEGORY_ICON,
  ChangeMark,
  DetailPanel,
  EmptyState,
  Field,
  GroupChips,
  GroupRow,
  ListHead,
  ListRow,
  PageHeader,
  Prop,
  RowPresence,
  SectionLabel,
  Toolbar,
  ToolbarTab,
  copy,
  useGroups,
  useLeaveGuard,
  type Group,
} from "./kit";

const CATEGORIES = Object.keys(CATEGORY_LABEL) as ItemCategory[];

/** Categories stored as markdown files with frontmatter; the rest are keys of canonfig.jsonc. */
const MARKDOWN: Partial<Record<ItemCategory, true>> = { instructions: true, rules: true, skills: true, agents: true, commands: true };

/** src/projection/model.ts HOOK_EVENTS and CAPABILITIES. */
const HOOK_EVENTS = ["session_start", "session_end", "prompt_submit", "before_agent", "after_agent", "before_tool", "after_tool", "before_compact", "after_compact", "stop", "subagent_start", "subagent_stop"];
const CAPABILITIES = "read, write, search, shell, web, mcp, subagent, test, git";

/**
 * One editor field. `label` keys `Resource.detail`; `key` is the field's name in the file (frontmatter or
 * canonfig.jsonc), shown in the "As written" preview. Field names follow src/projection/folder.ts.
 */
interface FieldSpec {
  label: string;
  key: string;
  placeholder?: string;
  options?: readonly string[];
  /** Comma-separated in the editor, a list in the file. */
  list?: boolean;
  long?: boolean;
  hint?: string;
  required?: boolean;
  /** Only for some values of the other fields, like Command for a stdio MCP server. */
  shown?: (detail: Record<string, string>) => boolean;
}

const BODY: FieldSpec = { label: "Body", key: "body", long: true, placeholder: "What the agent should know, in Markdown." };
const stdio = (d: Record<string, string>) => (d.Transport ?? "stdio") === "stdio";

const FIELDS: Record<ItemCategory, FieldSpec[]> = {
  instructions: [{ ...BODY, placeholder: "# Working agreements" }],
  rules: [
    { label: "Description", key: "description", placeholder: "TypeScript conventions" },
    { label: "Paths", key: "paths", list: true, placeholder: "**/*.ts, **/*.tsx", hint: "Globs, separated by commas. Leave empty for a rule that applies everywhere." },
    { label: "Activation", key: "activation", options: ["always", "path", "manual", "model"], hint: "always: every session. path: files matching Paths. manual: when you ask for it. model: when the agent decides it fits." },
    BODY,
  ],
  skills: [{ label: "Description", key: "description", required: true, placeholder: "Review a diff for correctness and tests." }, BODY],
  agents: [
    { label: "Description", key: "description", required: true, placeholder: "Finds sources and summarizes them." },
    { label: "Model", key: "model", placeholder: "Each harness's default" },
    { label: "Tools", key: "tools", list: true, placeholder: "read, search", hint: `Any of ${CAPABILITIES}, separated by commas.` },
    { label: "Writable", key: "writable", options: ["false", "true"], hint: "true lets the agent change files." },
    BODY,
  ],
  commands: [
    { label: "Description", key: "description", required: true, placeholder: "Run the checks, then open a pull request." },
    { label: "Argument hint", key: "argumentHint", placeholder: "[branch]" },
    BODY,
  ],
  mcp: [
    { label: "Transport", key: "transport", options: ["stdio", "streamable-http", "sse"] },
    { label: "Command", key: "command", required: true, placeholder: "npx", shown: stdio },
    { label: "Args", key: "args", placeholder: "-y @upstash/context7-mcp@2.1.0", hint: "Separated by spaces.", shown: stdio },
    { label: "URL", key: "url", required: true, placeholder: "https://docs.example.com/mcp", shown: (d) => !stdio(d) },
  ],
  hooks: [
    { label: "Event", key: "event", options: HOOK_EVENTS },
    { label: "Run", key: "run", required: true, placeholder: "hooks/format.sh", hint: "A script in ~/.canonfig/hooks/ and its arguments." },
    { label: "Capabilities", key: "capabilities", list: true, placeholder: "write", hint: `Run only for tools with these capabilities: ${CAPABILITIES}.` },
    { label: "On failure", key: "onFailure", options: ["warn", "block", "ignore"] },
  ],
  settings: [],
  tools: [
    { label: "Executable", key: "executable", required: true, placeholder: "gh", hint: "The command machines check for after installing." },
    { label: "macOS", key: "recipes", placeholder: "brew install gh" },
    { label: "Linux", key: "recipes", placeholder: "apt install gh" },
    { label: "Windows", key: "recipes", placeholder: "winget install GitHub.cli" },
    { label: "Login", key: "login", placeholder: "gh auth login", hint: "A sign-in step only a person can do, if the tool needs one." },
  ],
  credentials: [{ label: "Reference", key: "reference", required: true, placeholder: "github-token", hint: "The name this machine's credential store keeps it under." }],
};

/** Item names in the folder: src/projection/folder.ts namePattern. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const NAME_PLACEHOLDER: Record<ItemCategory, string> = {
  instructions: "",
  rules: "typescript",
  skills: "code-review",
  agents: "researcher",
  commands: "ship",
  mcp: "context7",
  hooks: "format",
  settings: "",
  tools: "gh",
  credentials: "github-token",
};

/** The name part of an item id: `code-review` for `skills/code-review`, empty for `instructions`. */
const nameOf = (r: Resource) => (r.category === "instructions" ? "" : r.id.slice(r.category.length + 1));

function blankItem(category: ItemCategory): Resource {
  // Fields with a fixed set of values start on the first one, so the draft is valid as far as they go.
  const detail = Object.fromEntries(FIELDS[category].flatMap((f) => (f.options ? [[f.label, f.options[0]]] : [])));
  return { id: category === "instructions" ? "instructions" : "", category, path: itemPath(category, ""), groups: [], summary: "", detail, keys: category === "settings" ? {} : undefined };
}

const listOf = (text: string | undefined) => (text ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The one-line summary the list shows, from what the item holds. */
function summaryOf(r: Resource): string {
  const d = r.detail;
  switch (r.category) {
    case "instructions":
      return `${(d.Body ?? "").split("\n").length} lines`;
    case "rules":
      return d.Paths?.trim() ? d.Paths.trim() : "applies everywhere";
    case "skills":
      return d.Files ? `${d.Files.split(",").length} files` : "SKILL.md";
    case "agents":
      return d.Writable === "true" ? "may write" : "read-only";
    case "commands":
      return `/${nameOf(r)}${d["Argument hint"] ? ` ${d["Argument hint"]}` : ""}`;
    case "mcp":
      return stdio(d) ? `stdio, ${d.Command}` : (d.Transport ?? "");
    case "hooks":
      return `${d.Event}, ${d.Run}`;
    case "settings": {
      const n = Object.keys(r.keys ?? {}).length;
      return `${n} ${n === 1 ? "key" : "keys"}`;
    }
    case "tools":
      return ["macOS", "Linux", "Windows"].filter((os) => d[os]?.trim()).join(", ") || "no recipe yet";
    case "credentials":
      return "local reference";
  }
}

/** A settings value as canonfig.jsonc stores it: valid JSON text keeps its type (`42`, `false`, `"zed"`); anything else is written as a string. */
function jsonValue(text: string) {
  const t = text.trim();
  try {
    JSON.parse(t);
    return t;
  } catch {
    return JSON.stringify(text);
  }
}

/**
 * The item as written in ~/.canonfig/: a markdown file with YAML frontmatter, or its entry in canonfig.jsonc.
 * Tools are left out: their recipes carry exact versions and build policy that this editor doesn't show.
 */
function preview(r: Resource): { where: string; text: string } | null {
  const name = nameOf(r);
  const d = r.detail;
  const fields = FIELDS[r.category].filter((f) => f !== BODY && (f.shown?.(d) ?? true) && d[f.label]?.trim());
  if (MARKDOWN[r.category]) {
    const front = [
      ...(r.category === "skills" ? [`name: ${name || "new-skill"}`] : []),
      ...fields.map((f) => {
        const v = d[f.label].trim();
        return `${f.key}: ${f.list ? JSON.stringify(listOf(v)) : v === "true" || v === "false" ? v : JSON.stringify(v)}`;
      }),
    ];
    return {
      where: `~/.canonfig/${r.category === "skills" ? `${r.path}SKILL.md` : r.path}`,
      text: `${front.length ? `---\n${front.join("\n")}\n---\n` : ""}${d.Body ?? ""}`,
    };
  }
  const where = `~/.canonfig/canonfig.jsonc → ${r.category}`;
  const key = JSON.stringify(name || "new-item");
  if (r.category === "settings") {
    const keys = Object.entries(r.keys ?? {});
    const body = keys.map(([k, v], i) => `  ${JSON.stringify(k)}: ${jsonValue(v)}${i < keys.length - 1 ? "," : ""}`);
    return { where, text: keys.length ? [`${key}: {`, ...body, "}"].join("\n") : `${key}: {}` };
  }
  if (r.category === "mcp") {
    const server = stdio(d)
      ? { transport: "stdio", command: d.Command, ...(d.Args?.trim() ? { args: d.Args.trim().split(/\s+/) } : {}) }
      : { transport: d.Transport, url: d.URL };
    return { where, text: `${key}: ${JSON.stringify(server, null, 2)}` };
  }
  if (r.category === "hooks") {
    const hook = {
      id: name || "new-hook",
      event: d.Event,
      ...(d.Capabilities?.trim() ? { matcher: { capabilities: listOf(d.Capabilities) } } : {}),
      run: (d.Run ?? "").trim().split(/\s+/).filter(Boolean),
      onFailure: d["On failure"],
    };
    return { where, text: JSON.stringify(hook, null, 2) };
  }
  if (r.category === "credentials") return { where, text: `${key}: ${JSON.stringify({ reference: d.Reference ?? "" })}` };
  return null;
}

/** The "As written" text, built only while its disclosure is open: CollapsibleContent mounts it then. */
function WrittenPreview({ item }: { item: Resource }) {
  const written = preview(item);
  if (!written) return null;
  return (
    <pre tabIndex={0} aria-label="This item as written in the folder" className="overflow-x-auto rounded-md border border-border bg-canvas/70 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
      <span className="text-faint">// {written.where}{"\n"}</span>
      {written.text}
    </pre>
  );
}

/*
 * Name and Path stop growing at readable lengths (about 240 and 360px) and Summary takes what's left, so a
 * wide window doesn't push the columns apart; below their caps the columns shrink toward their minimums.
 */
const COLS = "16px minmax(150px,240px) minmax(180px,360px) 140px minmax(140px,1fr)";
// Column minimums + 4 gaps + row inset padding; narrower screens scroll the list sideways instead of clipping it.
const COLS_MIN = 16 + 150 + 180 + 140 + 140 + 4 * 12 + 20;

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

/** What Profile → Defaults has saved: canonfig.jsonc `profile.name`, `scheduleDefault` and `local.allow`. The page header reads the name from here too. */
interface ProfileDefaults {
  name: string;
  schedule: Schedule;
  localAllow: LocalCategory[];
}

/**
 * "saved" is what Profile → Defaults last saved. "published" is what the latest revision holds; it is
 * recorded when a defaults edit starts (until then the two match), so saving the published values back
 * can withdraw the edit. Both start as the profile onboarding created, checked daily at 09:00.
 */
function useProfileDefaults(which: "saved" | "published" = "saved") {
  const ws = useWorkspace();
  return useSharedState<ProfileDefaults>(which === "saved" ? "profile-defaults" : "profile-defaults-published", {
    name: ws.profileName,
    schedule: { cadence: "daily", days: [], time: "09:00" },
    localAllow: profile.localAllow,
  });
}

/** Whether two defaults write the same canonfig.jsonc values. Compares the written schedule, so days kept from a weekly choice don't count under daily. */
function sameDefaults(a: ProfileDefaults, b: ProfileDefaults) {
  return (
    a.name === b.name &&
    scheduleDefaultOf(a.schedule) === scheduleDefaultOf(b.schedule) &&
    LOCAL_CATEGORIES.every((c) => a.localAllow.includes(c) === b.localAllow.includes(c))
  );
}

/**
 * canonfig.jsonc `scheduleDefault`: `daily@HH:mm` or `weekly:Mon,Thu@HH:mm` (src/projection/folder.ts), always in
 * each follower's local time, since every scheduler backend can render only that.
 */
function scheduleDefaultOf(s: Schedule) {
  if (s.cadence === "daily") return `daily@${s.time}`;
  const days = s.cadence === "weekdays" ? WEEK.slice(0, 5) : WEEK.filter((d) => s.days.includes(d));
  return `weekly:${days.join(",")}@${s.time}`;
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
  const grouped = useMemo(() => CATEGORIES.map((c) => ({ category: c, items: ws.resources.filter((r) => r.category === c) })).filter((g) => g.items.length), [ws.resources]);
  const current = ws.resources.find((r) => r.id === selected);

  const close = () => ws.go("profile");
  const startCreating = () => ws.go("profile", "new");

  const detail =
    tab === "items" && (creating || current) ? (
      <ItemEditor
        key={creating ? "new" : current!.id}
        resource={creating ? blankItem(ws.resources.some((r) => r.id === "instructions") ? "rules" : "instructions") : current!}
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
            <Button variant="outline" size="sm" onClick={() => setDiscoverOpen(true)} data-tour="profile-add">
              Discover tools
            </Button>
            <Button variant={ws.pending.length === 0 && !detail && tab === "items" ? "primary" : "outline"} size="sm" onClick={startCreating} data-tour="profile-add">
              <Plus />
              Add item
            </Button>
            {ws.pending.length > 0 && (
              <Button size="sm" data-tour="publish" variant={detail || tab === "defaults" ? "outline" : "primary"} onClick={() => ws.setPublishOpen(true)}>
                Publish revision <AnimatedNumber value={ws.nextSequence} />
              </Button>
            )}
          </>
        }
      />
      <Toolbar
        right={
          <span data-tour="profile-folder" className="flex min-w-0 items-center gap-1.5 text-sm whitespace-nowrap text-faint">
            <span className="hidden sm:inline">Folder</span>
            <button
              type="button"
              title={`Copy path ${machine.folder}`}
              aria-label={`Copy folder path ${machine.folder}`}
              className="truncate rounded font-mono text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => copy(machine.folder, "Folder path copied")}
            >
              {machine.folder}
            </button>
            <Hint label="the Canonfig folder">
              The <Term term="Canonical Folder">Canonfig folder</Term> is the source of truth.{"\n"}Edits here are written into its files, and canonfig.jsonc keeps your comments.
              Hand edits show up here too.
              {DEMO && "\nIn this demo, edits stay in this browser session and no file is written."}
            </Hint>
          </span>
        }
      >
        <ToolbarTab active={tab === "items"} href={workspaceHref("source", "profile")} count={ws.resources.length}>
          Items
        </ToolbarTab>
        <ToolbarTab active={tab === "harnesses"} href={workspaceHref("source", "profile", { profileTab: "harnesses" })} count={ws.listed.length}>
          Harnesses
        </ToolbarTab>
        <ToolbarTab active={tab === "groups"} href={workspaceHref("source", "profile", { profileTab: "groups" })} count={groups.length}>
          {PLAIN.groups}
        </ToolbarTab>
        <ToolbarTab active={tab === "defaults"} href={workspaceHref("source", "profile", { profileTab: "defaults" })}>
          Defaults
        </ToolbarTab>
      </Toolbar>
      {tab === "items" && (
        <Body detail={detail}>
          <RowPresence>
            {proposed.length > 0 && (
              <AnimatedRow key="proposed">
                <div className="flex items-center gap-3 border-b border-border bg-gold/8 px-[18px] py-2.5 text-sm">
                  <Sparkle bold className="size-3.5 shrink-0 text-gold" />
                  <span className="min-w-0 text-pretty">
                    Canonfig found <AnimatedNumber value={proposed.length} /> {proposed.length === 1 ? "tool" : "tools"} that your folder runs. Open each one to review it, remove
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
              title="The folder is empty"
              body="Add the instructions, rules, skills, MCP servers, settings and tools every machine should have, or discover tools your folder runs."
              action={
                <Button variant="outline" size="sm" onClick={startCreating}>
                  Add item
                </Button>
              }
            />
          ) : (
            <>
              <ListHead cols={COLS} minWidth={COLS_MIN} data-tour="profile-items">
                <span />
                <span>Name</span>
                <span>In ~/.canonfig</span>
                <span>Groups</span>
                <span>Summary</span>
              </ListHead>
              {grouped.map((g) => (
                <div key={g.category} data-tour="profile-items">
                  <GroupRow
                    icon={CATEGORY_ICON[g.category]}
                    label={CATEGORY_LABEL[g.category].label}
                    count={g.items.length}
                    hint={`${CATEGORY_LABEL[g.category].where}\n${CATEGORY_LABEL[g.category].hint}`}
                    minWidth={COLS_MIN}
                  />
                  <RowPresence>
                    {g.items.map((r) => (
                      <AnimatedRow key={r.id}>
                        <ListRow
                          cols={COLS}
                          minWidth={COLS_MIN}
                          selected={selected === r.id && !creating}
                          onClick={() => ws.go("profile", r.id)}
                          className={cn(r.change === "removed" && "text-faint line-through decoration-faint", proposed.includes(r.id) && selected !== r.id && "before:bg-gold/6")}
                        >
                          <ChangeMark change={r.change} />
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">{nameOf(r) || r.id}</span>
                            {proposed.includes(r.id) && (
                              <span className="inline-flex h-4 shrink-0 items-center rounded-[3px] bg-gold/15 px-1 text-xs font-semibold text-gold">Proposed</span>
                            )}
                          </span>
                          <Mono className="truncate">{r.path}</Mono>
                          <GroupChips groups={r.groups} />
                          {r.category === "skills" ? (
                            <SkillSummary resource={r} />
                          ) : (
                            <span className="truncate text-sm text-faint" title={r.summary}>
                              {r.summary}
                            </span>
                          )}
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
      {tab === "harnesses" && <HarnessesTab />}
      {tab === "groups" && <GroupsTab />}
      {tab === "defaults" && <DefaultsTab />}
      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />
    </>
  );
}

interface KeyRow {
  id: number;
  name: string;
  value: string;
}

function keyRowsOf(r: Resource): KeyRow[] {
  return Object.entries(r.keys ?? {}).map(([name, value], i) => ({ id: i, name, value }));
}

function ItemEditor({ resource, isNew, onClose, onSaved }: { resource: Resource; isNew: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const ws = useWorkspace();
  const [draft, setDraft] = useState<Resource>(resource);
  const [name, setName] = useState(nameOf(resource));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [tried, setTried] = useState(false);
  const setDetail = (k: string, v: string) => setDraft((d) => ({ ...d, detail: { ...d.detail, [k]: v } }));
  const category = draft.category;
  const isSettings = category === "settings";
  const fields = FIELDS[category].filter((f) => f.shown?.(draft.detail) ?? true);
  const others = ws.resources.filter((r) => r.id !== resource.id);
  const Icon = CATEGORY_ICON[category];
  // AGENTS.md is one file, so a folder that has it offers no second one; each harness has one settings entry.
  const categories = CATEGORIES.filter((c) => c !== "instructions" || !others.some((r) => r.id === "instructions"));
  const freeHarnesses = (Object.keys(HARNESS_NAMES) as HarnessId[]).filter((h) => !others.some((r) => r.id === `settings/${h}`));

  // Settings keys are edited as rows so a key can be renamed, including a new one that has no name yet.
  const [rows, setRows] = useState<KeyRow[]>(() => keyRowsOf(resource));
  const [focusRow, setFocusRow] = useState<number | null>(null);
  // Unnamed rows are still edits even though they cannot enter the saved key map yet. The change marker is
  // publication state, not an edit: publishing clears it on the saved item while this editor is open, and
  // the draft must still count as matching the item it now shows, so the comparison leaves it out.
  const content = (r: Resource) => JSON.stringify({ ...r, change: undefined });
  const matches = (r: Resource) =>
    content(draft) === content(r) && name === nameOf(r) && JSON.stringify(rows.map(({ name: k, value }) => [k, value])) === JSON.stringify(Object.entries(r.keys ?? {}));
  const dirty = !matches(resource);
  // The saved item can change under an open editor: a skill update lands, or a panel reopened mid-update shows the
  // item from before it. An untouched draft follows the saved item, so the panel shows it and stays clean; a draft
  // with edits is left alone. Adjusted during render, so the stale draft never paints.
  const [shown, setShown] = useState(resource);
  if (shown !== resource) {
    setShown(resource);
    if (matches(shown)) {
      setDraft(resource);
      setName(nameOf(resource));
      setRows(keyRowsOf(resource));
    }
  }
  // A running skill update locks the editor, so no edit can land under it.
  const updating = useSkillUpdating(resource.id);
  const moveTracking = useMoveSkillTracking();
  const updateRows = (next: KeyRow[]) => {
    setRows(next);
    setDraft((d) => ({ ...d, keys: Object.fromEntries(next.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value])) }));
  };
  const rowError = (r: KeyRow) => {
    const key = r.name.trim();
    if (!tried) return null;
    if (!key) return "Name this key, or remove the row.";
    if (rows.some((x) => x.id !== r.id && x.name.trim() === key)) return `${key} is listed twice.`;
    return null;
  };

  // Closing, choosing another row or leaving the page asks before discarding edits. The guard sits in
  // routes.ts, which every in-app link, row, sidebar entry and palette command navigates through.
  // Save, remove and Cancel on a new item settle the draft, so they leave through leaveWithoutAsking.
  const { dialog: leaveDialog, leaveWithoutAsking } = useLeaveGuard(dirty, isNew ? "this new item" : resource.id);

  const trimmed = name.trim();
  const id = category === "instructions" ? "instructions" : `${category}/${trimmed}`;
  const nameError =
    category === "instructions"
      ? null
      : !trimmed
        ? isSettings
          ? "Choose a harness."
          : "Enter a name."
        : !NAME_PATTERN.test(trimmed)
          ? "Use letters, digits, - and _, starting with a letter or digit."
          : others.some((r) => r.id === id)
            ? `${id} is already in the folder. Choose another name.`
            : null;
  const fieldError = (f: FieldSpec) => (f.required && !draft.detail[f.label]?.trim() ? `Enter ${f.label === "URL" ? "the URL" : `a ${f.label.toLowerCase()}`}.` : null);
  const asWritten: Resource = { ...draft, id, path: itemPath(category, trimmed) };

  const save = (form: HTMLFormElement) => {
    setTried(true);
    const badField = fields.find(fieldError);
    const badRow = isSettings ? rows.find((r) => !r.name.trim() || rows.some((x) => x.id !== r.id && x.name.trim() === r.name.trim())) : undefined;
    if (nameError || badField || badRow) {
      const selector = nameError ? "#item-name" : badField ? `#item-${badField.label.replace(/\W/g, "")}` : `#item-key-${badRow!.id}`;
      form.querySelector<HTMLElement>(selector)?.focus();
      return;
    }
    const base: Resource = { ...draft, id, path: itemPath(category, trimmed), change: isNew ? "added" : resource.change ?? "modified" };
    const next = { ...base, summary: summaryOf(base) };
    ws.setResources((prev) => (isNew ? [...prev, next] : prev.map((r) => (r.id === resource.id ? next : r))));
    if (!isNew && category === "skills" && id !== resource.id) moveTracking(resource.id, id);
    const unpublished = ws.pending.length + (resource.change && !isNew ? 0 : 1);
    toast.success(isNew ? `Added ${id}` : `Saved ${id}`, {
      description: `Written to ${next.path}.\nGoes out with revision ${ws.nextSequence}: ${unpublished} unpublished ${unpublished === 1 ? "change" : "changes"}.${DEMO ? "\nSaved in this demo workspace." : ""}`,
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
            <Button variant="destructive" size="sm" disabled={updating} onClick={() => setConfirmRemove(true)}>
              Remove…
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={isNew ? () => leaveWithoutAsking(onClose) : () => (setDraft(resource), setName(nameOf(resource)), setRows(keyRowsOf(resource)), setTried(false))}
              disabled={updating || (!isNew && !dirty)}
            >
              {isNew ? "Cancel" : "Discard"}
            </Button>
            <Button type="submit" form="item-form" variant="primary" size="sm" disabled={updating || (!isNew && !dirty)}>
              {isNew ? "Add to the folder" : "Save to the folder"}
            </Button>
          </div>
        </>
      }
    >
      <form
        id="item-form"
        className="px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          save(e.currentTarget);
        }}
      >
        <fieldset disabled={updating} className="grid min-w-0 gap-4">
        <Field label="Kind" htmlFor="item-category" hint={isNew ? <>Where the <Term term="Profile Resource">item</Term> lives in ~/.canonfig decides which harness files it reaches.</> : undefined}>
          <Select
            value={category}
            onValueChange={(c: ItemCategory) => {
              setDraft(blankItem(c));
              setName("");
              setRows([]);
            }}
            disabled={!isNew}
          >
            <SelectTrigger id="item-category" className="w-full">
              <SelectValue>{CATEGORY_LABEL[category].label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => {
                const CIcon = CATEGORY_ICON[c];
                return (
                  <SelectItem key={c} value={c} className="items-start py-1.5">
                    <CIcon className="mt-0.5 text-muted-foreground" />
                    <span className="grid gap-0.5">
                      <span className="text-base">{CATEGORY_LABEL[c].label}</span>
                      <span className="text-xs whitespace-normal text-muted-foreground">{CATEGORY_LABEL[c].hint}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {!isNew && <p className="text-sm text-pretty text-faint">{CATEGORY_LABEL[category].hint}</p>}
        </Field>
        {isSettings ? (
          <Field label="Harness" htmlFor="item-name" error={tried ? nameError : null}>
            <Select value={trimmed} onValueChange={setName}>
              <SelectTrigger id="item-name" className="w-full" aria-invalid={tried && !!nameError} aria-describedby={tried && nameError ? "item-name-note" : undefined}>
                <SelectValue placeholder="Choose a harness">{trimmed && HARNESS_NAMES[trimmed as HarnessId]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(isNew ? freeHarnesses : [trimmed as HarnessId, ...freeHarnesses]).map((h) => (
                  <SelectItem key={h} value={h}>
                    {HARNESS_NAMES[h]}
                    <span className="font-mono text-xs text-faint">{h}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          category !== "instructions" && (
            <Field label="Name" htmlFor="item-name" error={tried ? nameError : null}>
              <Input
                id="item-name"
                value={name}
                placeholder={NAME_PLACEHOLDER[category]}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={tried && !!nameError}
                aria-describedby={tried && nameError ? "item-name-note" : undefined}
                autoComplete="off"
                spellCheck={false}
                autoFocus={isNew}
                className="font-mono text-sm"
              />
            </Field>
          )
        )}

        {fields.map((f) => {
          const fid = `item-${f.label.replace(/\W/g, "")}`;
          const error = tried ? fieldError(f) : null;
          return (
            <Field key={f.label} label={f.label} htmlFor={fid} hint={f.hint} error={error}>
              {f.options ? (
                <Select value={draft.detail[f.label] ?? f.options[0]} onValueChange={(v) => setDetail(f.label, v)}>
                  <SelectTrigger id={fid} className="w-full" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options.map((o) => (
                      <SelectItem key={o} value={o}>
                        <span className="font-mono text-sm">{o}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : f.long ? (
                <Textarea
                  id={fid}
                  value={draft.detail[f.label] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setDetail(f.label, e.target.value)}
                  spellCheck={false}
                  className="max-h-80 font-mono text-sm"
                />
              ) : (
                <Input
                  id={fid}
                  value={draft.detail[f.label] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setDetail(f.label, e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? `${fid}-note` : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-7 font-mono text-sm"
                />
              )}
            </Field>
          );
        })}

        {category === "skills" && draft.detail.Files && (
          <Prop label="Files">
            <Mono className="text-foreground">{draft.detail.Files}</Mono>
          </Prop>
        )}
        {category === "skills" && !isNew && resource.change !== "removed" && <SkillUpstream resource={resource} editing={dirty} />}
        {draft.detail.Evidence && (
          <Prop label="Found in">
            <Mono className="text-foreground">{draft.detail.Evidence}</Mono>
          </Prop>
        )}

        {isSettings && (
          <div className="grid gap-2">
            <SectionLabel
              action={
                <Button
                  type="button"
                  id="item-add-key"
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
            {rows.length === 0 && <p className="text-sm text-faint">No keys yet. Add the first key Canonfig should set in this harness's settings file.</p>}
            {/* Key paths are long dotted names; values are short scalars, so the path gets the larger share. */}
            <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)_24px] items-start gap-x-1.5 gap-y-1.5">
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
                        id={`item-key-${r.id}`}
                        value={r.name}
                        title={r.name || undefined}
                        aria-label={`Key ${i + 1} path`}
                        placeholder="permissions.defaultMode"
                        autoFocus={focusRow === r.id}
                        aria-invalid={!!err}
                        aria-describedby={err ? `item-key-${r.id}-note` : undefined}
                        onChange={(e) => updateRows(rows.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-7 font-mono text-sm"
                      />
                      {err && (
                        <span id={`item-key-${r.id}-note`} role="alert" className="text-xs text-bad">
                          {err}
                        </span>
                      )}
                    </div>
                    <Input
                      value={r.value}
                      title={r.value || undefined}
                      aria-label={`Key ${i + 1} value`}
                      onChange={(e) => updateRows(rows.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-7 font-mono text-sm"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="mt-0.5 text-faint"
                      data-remove="config-keys"
                      aria-label={`Remove key ${r.name || i + 1}`}
                      onClick={(e) => removeKeepingFocus(e.currentTarget, () => updateRows(rows.filter((x) => x.id !== r.id)), "item-add-key")}
                    >
                      <X />
                    </Button>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-pretty text-faint">
              Values are JSON: put text in quotes, like "high"; numbers and true/false without. Canonfig translates them into the harness's own file format and leaves every
              other key in that file as it is.
            </p>
          </div>
        )}

        <Field
          label={<Term term="Follower Group">Who gets it</Term>}
          description={draft.groups.length === 0 ? "Every machine gets this. Tick a group to send it only to that group's machines." : "Only machines in these groups get it."}
        >
          <GroupPicker idPrefix="grp" value={draft.groups} onChange={(groups) => setDraft((d) => ({ ...d, groups }))} />
        </Field>

        {category !== "tools" && (
          <Collapsible>
            <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1 rounded text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
              <CaretRight className="size-3.5 transition-transform duration-150 ease-snap group-data-[state=open]:rotate-90" />
              As written in ~/.canonfig
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <WrittenPreview item={asWritten} />
            </CollapsibleContent>
          </Collapsible>
        )}
        </fieldset>
      </form>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent
          className="grid-cols-[minmax(0,1fr)] sm:max-w-md"
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) returnFocus.current = active;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Confirming removes the editor; cancellation returns to its Remove button.
            const target = returnFocus.current?.isConnected && returnFocus.current !== document.body ? returnFocus.current : document.querySelector<HTMLElement>("main h1");
            if (target && !target.matches("button, a, [tabindex]")) target.tabIndex = -1;
            target?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove {resource.id}?</DialogTitle>
            <DialogDescription className="text-base text-pretty">
              Canonfig deletes it from <span className="font-mono text-sm text-foreground">{resource.path}</span>. After you publish, machines drop it from their copy of the
              folder and Canonfig removes what it wrote from it into their harnesses. A copy someone edited on a machine stays there and shows as edited.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                ws.setResources((prev) => (resource.change === "added" ? prev.filter((r) => r.id !== resource.id) : prev.map((r) => (r.id === resource.id ? { ...r, change: "removed" as const } : r))));
                if (category === "skills") moveTracking(resource.id, null);
                setConfirmRemove(false);
                leaveWithoutAsking(onClose);
                toast(`Removed ${resource.id}`, { description: "Publish to apply this to followers." });
              }}
            >
              Remove item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {leaveDialog}
    </DetailPanel>
  );
}

/** canonfig.jsonc `harnesses`: which harnesses every machine writes the folder into, where installed and not excluded. */
function HarnessesTab() {
  const ws = useWorkspace();
  return (
    <Body>
      <p data-tour="profile-harnesses" className="border-b border-border px-[18px] py-3 text-sm text-pretty text-muted-foreground">
        Canonfig writes this folder into each listed <Term term="Target Harness">harness</Term> on every machine where it's installed, this one included. Any machine can exclude
        one for itself. Removing a harness from the list stops Canonfig managing it and removes what it wrote there, unless someone edited it; its backup stays, so you can restore
        it from Backups. Use Gets to give a harness only some of the folder, such as only its MCP servers; Canonfig leaves the rest of that harness alone.
      </p>
      <HarnessTable
        edit="listed"
        onToggle={(id, on) => {
          ws.setListed((prev) => (on ? [...prev, id] : prev.filter((h) => h !== id)));
          // canonfig.jsonc refuses `surfaces` for a harness it does not list, so the choice goes with it.
          if (!on) ws.setSurfaces(({ [id]: _dropped, ...rest }) => rest);
          ws.markProfileEdit({ area: "harnesses", id: "harnesses", change: "modified" });
          toast(on ? `Listed ${HARNESS_NAMES[id]}` : `Removed ${HARNESS_NAMES[id]} from the list`, {
            description: `Goes out with revision ${ws.nextSequence}.${on ? "\nMachines that have it installed back it up, then take it over." : ""}${DEMO ? "\nSaved in this demo workspace." : ""}`,
          });
        }}
      />
      <div className="h-16" />
    </Body>
  );
}

function GroupsTab() {
  const ws = useWorkspace();
  const [groups, setGroups] = useGroups();
  const selected = ws.focus;
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [tried, setTried] = useState(false);
  const cols = "minmax(180px,1fr) minmax(220px,2fr) 110px 110px";
  const colsMin = 180 + 220 + 110 + 110 + 3 * 12 + 20;
  const trimmed = name.trim();
  const problem = !trimmed
    ? "Enter a name."
    : !NAME_PATTERN.test(trimmed)
      ? "Use letters, digits, - and _, starting with a letter or digit."
      : groups.some((g) => g.name === trimmed)
        ? `${trimmed} already exists. Choose another name.`
        : null;
  const nameError = tried ? problem : null;
  const current = groups.find((g) => g.name === selected);
  // Only an open dialog holds a draft: Cancel, Escape and Add group all close it, and reopening starts blank.
  const { dialog: leaveDialog } = useLeaveGuard(open && (name !== "" || desc !== ""), "this new group");

  return (
    <Body detail={current && <GroupDetail key={current.name} group={current} onClose={() => ws.navigate(workspaceHref("source", "profile", { profileTab: "groups" }))} />}>
      <div data-tour="profile-groups" className="flex items-center gap-3 border-b border-border px-[18px] py-2.5 text-sm text-muted-foreground">
        <span className="text-pretty">
          A <Term term="Follower Group">group</Term> gets extra items on top of the base profile; canonfig.jsonc <Mono>groups</Mono> lists them. A machine's groups come from its
          invitation; open a group to add machines.
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
      <ListHead cols={cols} minWidth={colsMin} data-tour="profile-groups">
        <span>Group</span>
        <span>What it's for</span>
        <span>Machines</span>
        <span>Items</span>
      </ListHead>
      <RowPresence>
        {groups.map((g) => (
          <AnimatedRow key={g.name}>
            <ListRow cols={cols} minWidth={colsMin} selected={selected === g.name} onClick={() => ws.navigate(workspaceHref("source", "profile", { profileTab: "groups", focus: g.name }))} data-tour="profile-groups">
              <span className="flex min-w-0 items-center gap-1.5">
                {g.name === SECRETS_GROUP ? (
                  <>
                    {/* The plain name is what people read; the raw id gives way first on narrow screens. */}
                    <span className="shrink-0">{PLAIN.secretsGroup}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-faint">{g.name}</span>
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
        <DialogContent
          className="grid-cols-[minmax(0,1fr)] sm:max-w-md"
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) returnFocus.current = active;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              // Move focus to the field so keyboard and screen-reader users land on the error.
              if (problem) return document.getElementById("g-name")?.focus();
              setGroups((g) => [...g, { name: trimmed, description: desc.trim() || "No description" }]);
              // A group is profile content, so it waits for the next revision like an item edit.
              ws.markProfileEdit({ area: "group", id: trimmed, change: "added" });
              setOpen(false);
              toast.success(`Added group ${trimmed}`, { description: `Goes out with revision ${ws.nextSequence}.${DEMO ? "\nSaved in this demo workspace." : ""}` });
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
              <Button type="submit" variant="primary">
                Add group
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {leaveDialog}
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
              <Button variant="outline" size="xs" className="ml-auto" onClick={() => ws.setChangeGroups({ followerId: f.id })}>
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
              <Prop key={r.id} label={CATEGORY_LABEL[r.category].label}>
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
  const [published, setPublished] = useProfileDefaults("published");
  const [name, setName] = useState(saved.name);
  const [schedule, setSchedule] = useState<Schedule>(saved.schedule);
  const [localAllow, setLocalAllow] = useState<LocalCategory[]>(saved.localAllow);
  const [tried, setTried] = useState(false);
  const trimmed = name.trim();
  const nameError = tried && !trimmed ? "Enter a display name." : null;
  const scheduleProblem = scheduleError(schedule);
  // Compares what Save would write, so day picks hidden under a daily cadence don't count as edits.
  const dirty = !sameDefaults({ name, schedule, localAllow }, saved);
  const { dialog: leaveDialog } = useLeaveGuard(dirty, "the profile defaults");
  const allowed = LOCAL_CATEGORIES.filter((c) => localAllow.includes(c));
  return (
    <Body>
      <form
        className="max-w-[880px] px-4 py-6 sm:px-8"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!trimmed || scheduleProblem) return;
          const next = { name: trimmed, schedule, localAllow: allowed };
          // Saving unchanged values is not an edit. Saving the published values back withdraws the edit,
          // so unpublished changes only ever list defaults that differ from the latest revision.
          const edited = ws.pending.some((c) => c.area === "defaults");
          const changed = !sameDefaults(next, saved);
          const unpublished = !sameDefaults(next, edited ? published : saved);
          if (unpublished && !edited) {
            setPublished(saved);
            ws.markProfileEdit({ area: "defaults", id: "defaults", change: "modified" });
          }
          if (!unpublished && edited) ws.removeProfileEdit({ area: "defaults", id: "defaults", change: "modified" });
          setSaved(next);
          setName(trimmed);
          setTried(false);
          const note = !changed
            ? ""
            : unpublished
              ? `\nGoes out with revision ${ws.nextSequence}.`
              : `\nBack to the published values, so the defaults no longer wait for revision ${ws.nextSequence}.`;
          toast.success("Defaults saved", { description: `${scheduleSummary(schedule, "")}.${note}${DEMO ? "\nSaved in this demo workspace." : ""}` });
        }}
      >
        <SectionLabel>Profile</SectionLabel>
        <div className="grid gap-4 py-2">
          <Field label="Display name" htmlFor="p-name" error={nameError}>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} aria-describedby={nameError ? "p-name-note" : undefined} autoComplete="off" />
          </Field>
          <Field label="Profile id" description="Every revision carries this id, and Canonfig needs it to publish.">
            <Mono className="text-sm text-foreground">{profile.id}</Mono>
          </Field>
        </div>
        <SectionLabel className="mt-6">
          <Term term="Synchronization Schedule">Default schedule</Term>
        </SectionLabel>
        <p className="mb-3 text-sm text-pretty text-muted-foreground">New machines check for revisions at this time unless they set their own. Times are each machine's local time.</p>
        <ScheduleFields idPrefix="def" value={schedule} onChange={setSchedule} />

        <SectionLabel className="mt-6">
          <Term term="Local folder">What machines may add locally</Term>
        </SectionLabel>
        <p className="mb-3 text-sm text-pretty text-muted-foreground">
          Each machine can add its own items in ~/.canonfig/local. Canonfig uses only the kinds you tick here and reports the rest on that machine. Backups and excluded
          harnesses are always the machine's own choice.
        </p>
        <div className="grid gap-0.5 sm:grid-cols-2">
          {LOCAL_CATEGORIES.map((c) => (
            <Label key={c} htmlFor={`allow-${c}`} className="flex h-7 cursor-pointer items-center gap-2 text-base font-normal">
              <Checkbox id={`allow-${c}`} checked={localAllow.includes(c)} onCheckedChange={(on) => setLocalAllow((prev) => (on ? [...prev, c] : prev.filter((x) => x !== c)))} />
              {CATEGORY_LABEL[c].label}
              <span className="font-mono text-xs text-faint">{c}</span>
            </Label>
          ))}
        </div>

        {/* The defaults are canonfig.jsonc keys, not a command. An incomplete schedule has no valid value, so its line waits for a complete one. */}
        <div className="mt-6 grid gap-2">
          <pre
            aria-label="The defaults as written in canonfig.jsonc"
            className="rounded-md border border-border bg-canvas/70 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
          >
            <span className="text-faint">// ~/.canonfig/canonfig.jsonc{"\n"}</span>
            {[
              `"profile": ${JSON.stringify({ id: profile.id, name: trimmed || saved.name })},`,
              ...(scheduleProblem ? [] : [`"scheduleDefault": ${JSON.stringify(scheduleDefaultOf(schedule))},`]),
              `"local": { "allow": [${allowed.map((c) => JSON.stringify(c)).join(", ")}] }`,
            ].join("\n")}
          </pre>
          <p className="text-sm text-pretty text-faint">
            Canonfig writes these into canonfig.jsonc when you save{DEMO && "; this demo keeps them in the browser session and writes no file"}. A machine follows the schedule
            while its Schedule page is set to follow the Source's default.
          </p>
        </div>
        {/* Same pattern as the item editor: nothing to save or discard until the form differs from what was saved. */}
        <div className="mt-8 flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={!dirty || scheduleProblem !== null}>
            Save defaults
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() => {
              setName(saved.name);
              setSchedule(saved.schedule);
              setLocalAllow(saved.localAllow);
              setTried(false);
            }}
          >
            Discard
          </Button>
        </div>
      </form>
      {leaveDialog}
    </Body>
  );
}

function DiscoverDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = useWorkspace();
  const [progress, setProgress] = useState(0);
  const [picked, setPicked] = useState<string[]>(["node", "prettier"]);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setProgress(0);
    const t = window.setInterval(() => setProgress((p) => (p >= 100 ? 100 : p + 10)), 110);
    return () => window.clearInterval(t);
  }, [open]);

  const done = progress >= 100;
  const inFolder = (id: string) => ws.resources.some((r) => r.id === `tools/${id}`);
  // Picked tools the folder already has stay as they are, so the button counts and adds only the new ones.
  const pickedTools = SCANNED_TOOLS.filter((f) => picked.includes(f.id));
  const fresh = pickedTools.filter((f) => !inFolder(f.id));
  const present = pickedTools.filter((f) => inFolder(f.id)).map((f) => f.id);
  const presentNote = present.length ? `${present.join(", ")} ${present.length === 1 ? "is" : "are"} already in the folder.` : "";
  const noneNew = picked.length === 0 ? "Tick the tools to add." : presentNote;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid-cols-[minmax(0,1fr)] sm:max-w-lg"
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) returnFocus.current = active;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Discover tools</DialogTitle>
          <DialogDescription className="text-base text-pretty">
            Canonfig reads the instructions, skills, hook scripts and MCP commands in <span className="font-mono text-sm text-foreground">{machine.folder}</span> and proposes a
            tool for each program they run. It runs nothing. Tools you add go into canonfig.jsonc, which keeps its comments.
            {DEMO && " This demo reads no files and shows example results."}
          </DialogDescription>
        </DialogHeader>
        {!done ? (
          <div className="grid h-[132px] content-center gap-2" aria-live="polite">
            <DitherProgress value={progress} label="Finding tools" />
            <span className="text-sm text-muted-foreground">Finding tools…</span>
          </div>
        ) : (
          <>
            <div className="-mx-4 border-y border-border">
              {SCANNED_TOOLS.map((f) => (
                <label key={f.id} className="flex h-11 cursor-pointer items-center gap-3 border-b border-border/70 px-4 last:border-b-0 hover:bg-raised/50">
                  <Checkbox checked={picked.includes(f.id)} onCheckedChange={(c) => setPicked((p) => (c ? [...p, f.id] : p.filter((x) => x !== f.id)))} />
                  <span className="grid min-w-0">
                    <span className="text-base font-medium">{f.id}</span>
                    <Mono className="truncate text-faint">{f.command}</Mono>
                  </span>
                  <span className="ml-auto shrink-0 text-sm whitespace-nowrap text-muted-foreground" title={`${f.file}, ${f.where}`}>
                    {inFolder(f.id) ? "In the folder" : f.file.split("/").pop()}
                  </span>
                </label>
              ))}
            </div>
            {fresh.length === 0 && (
              <p id="discover-none" className="text-sm text-pretty text-muted-foreground">
                {noneNew}
              </p>
            )}
          </>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!done || fresh.length === 0}
              aria-describedby={done && fresh.length === 0 ? "discover-none" : undefined}
              onClick={() => {
                ws.setResources((prev) => [...prev, ...fresh.map(toolFromScan)]);
                onOpenChange(false);
                toast.success(`Added ${fresh.length} ${fresh.length === 1 ? "tool" : "tools"}`, {
                  description: `${presentNote ? `${presentNote}\n` : ""}Publish to send ${fresh.length === 1 ? "it" : "them"} to your machines.`,
                });
              }}
            >
              {fresh.length === 0 ? "Add tools" : `Add ${fresh.length} ${fresh.length === 1 ? "tool" : "tools"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
