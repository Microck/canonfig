// The tour: four stops per role, the most a tour can have before most people
// drop out (Chameleon 2025 benchmark). It covers only what a first-time user
// needs to find on day one; everything else is learned in place (page tips) or
// by doing (Get started). The last stop starts the first Get started item, so
// the tour ends in an action, not a summary.
//
// Chapters are the longer, opt-in guide: "Take the tour" lists them after the
// short tour. Each covers one area in 3-5 stops, so no single run outlasts the
// same benchmark, and together they visit every page of the role. Every stop
// switches to its own page (`before`) and points at a control that is there in
// the default demo state at desktop and phone widths; a stop whose control is
// missing in some state (Publish with nothing to publish) is skipped by the
// engine. Copy follows the glossary as the UI words it: Source, follower,
// profile, revision, Local settings.
import { Kbd } from "@/components/ui/kbd";
import type { TourStep } from "@/tour/tour";
import { getStartedItems } from "./guide";
import { workspaceHref } from "./routes";
import type { View, Workspace } from "./store";

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** One entry in the tour picker: the short tour ("quick") or a chapter. */
export interface TourChapter {
  id: string;
  title: string;
  /** One line in the picker saying what the chapter covers. */
  summary: string;
  /**
   * The sidebar pages the chapter visits, in visit order; the picker draws them as its route.
   * Kept by hand because steps switch pages in `before` callbacks, which can't be read without
   * running them, so a chapter that changes where its steps go must update this too.
   */
  pages: View[];
  steps: TourStep[];
}

/**
 * The picker's entries for this role, short tour first. Each chapter's last stop offers the
 * next chapter, so the chapters can be read straight through or one at a time.
 */
export function tourChapters(ws: Workspace, live: () => Workspace): TourChapter[] {
  const quick: TourChapter = {
    id: "quick",
    title: "Quick tour",
    summary: ws.role === "source" ? "Your Source, the profile, your machines and what to do next." : "This machine, Sync, Local settings and what to do next.",
    // The short tour points at sidebar entries rather than visiting them, then ends on Overview.
    pages: ws.role === "source" ? ["profile", "machines", "overview"] : ["sync", "local", "overview"],
    steps: tourSteps(ws, live),
  };
  const chapters = ws.capabilities.simulatedTelemetry
    ? ws.role === "source" ? sourceChapters(ws) : followerChapters(ws)
    : ws.role === "follower" ? [agentsChapter(ws)] : [];
  const linked = chapters.map((chapter, i) => {
    const next = chapters[i + 1];
    if (!next) return chapter;
    const last = chapter.steps[chapter.steps.length - 1];
    return { ...chapter, steps: [...chapter.steps.slice(0, -1), { ...last, action: { label: "Next chapter", run: () => live().startTour(next.id) } }] };
  });
  return [quick, ...linked];
}

function tourSteps(ws: Workspace, live: () => Workspace): TourStep[] {
  const firstTask = () => getStartedItems(live()).find((i) => !i.done);
  const handOver: TourStep = {
    target: ["get-started"],
    title: "Your next steps",
    body: (
      <>
        Do these in order; each one ticks itself off when it's done. Anything else, press <Kbd>{MOD} K</Kbd> and type what you want. For a closer look at each area, pick a
        chapter from Take the tour.
      </>
    ),
    before: () => ws.setView("overview"),
    action: {
      label: firstTask()?.label ?? "Done",
      run: () => firstTask()?.run(),
    },
  };

  if (ws.role === "source")
    return [
      {
        target: ["machine"],
        title: "This is your Source",
        body: `${ws.machineName} holds the one true copy of your setup. Your other machines copy it from here.`,
      },
      {
        target: ["nav-profile"],
        title: "Profile: what gets synced",
        body: "Your Canonfig folder: instructions, rules, skills, MCP servers, settings and tools. Nothing reaches another machine until you publish.",
      },
      {
        target: ["nav-machines"],
        title: "Machines",
        body: ws.capabilities.simulatedTelemetry
          ? "Every machine on one map: who's up to date, why not, and where to add a new one."
          : "See the enrolled machines and their groups. The Source does not report their sync health.",
      },
      handOver,
    ];

  return [
    {
      target: ["machine"],
      title: ws.capabilities.simulatedTelemetry ? "This machine follows atlas" : "This machine follows a Source",
      body: ws.capabilities.simulatedTelemetry
        ? `${ws.machineName} copies its setup from atlas. You change the setup there, not here.`
        : `${ws.machineName} copies its setup from its enrolled Source. You change the shared setup there, not here.`,
    },
    {
      target: ["nav-sync"],
      title: "Sync: get the latest",
      body: "See exactly what an update would change here, then apply it.",
    },
    {
      target: ["nav-local"],
      title: "Items only this machine has",
      body: "Add rules, skills, MCP servers or settings to this machine's local folder, and choose which harnesses Canonfig manages here.",
    },
    handOver,
  ];
}

/** The Agent policy page exists only on a Follower, where runs call the agent. */
function agentsChapter(ws: Workspace): TourChapter {
  return {
    id: "agents",
    title: "AI agents",
    summary: "When an AI agent may help, and what it may change.",
    pages: ["agent"],
    steps: [
      {
        target: ["agent-mode"],
        title: "When an agent may help",
        body: "Deterministic only never calls an agent. Agent proposes lets an agent draft fixes, and Agent applies lets it make them within the bounds below.",
        before: () => ws.setView("agent"),
      },
      {
        target: ["agent-harness"],
        title: "Which agent runs",
        body: "Choose codex, claude or your own command. Canonfig starts it for each job.",
        before: () => ws.setView("agent"),
      },
      {
        target: ["agent-paths"],
        title: "Where the agent may write",
        body: "The agent can write only in these folders; everything else is read-only to it. Click Save policy to keep your changes.",
        before: () => ws.setView("agent"),
      },
    ],
  };
}

function sourceChapters(ws: Workspace): TourChapter[] {
  const profileTab = (tab: "harnesses" | "groups" | "defaults") => () => ws.navigate(workspaceHref("source", "profile", { profileTab: tab }));
  return [
    {
      id: "source",
      title: "Your Source",
      summary: "What the Overview says about your profile and machines.",
      pages: ["overview"],
      steps: [
        {
          target: ["overview-head"],
          title: "Where things stand",
          body: "This band says whether your machines have everything you published, and what you haven't published yet.",
          before: () => ws.setView("overview"),
        },
        {
          target: ["overview-pending"],
          title: "Unpublished changes",
          body: "Your profile edits collect here until you publish them. Click one to open it.",
          before: () => ws.setView("overview"),
        },
        {
          target: ["overview-behind"],
          title: "Machines that are behind",
          body: "Each machine that isn't up to date says why. Click What to do to see how to fix it.",
          before: () => ws.setView("overview"),
        },
        {
          target: ["overview-grid"],
          title: "Each item on each machine",
          body: "Each square is one item on one machine. Solid is up to date, striped needs attention, and dotted isn't applied yet.",
          before: () => ws.setView("overview"),
        },
        {
          target: ["overview-this-machine"],
          title: "This machine",
          body: "Shows whether the source service runs, what the health check found and what the AI agent may do. Click a row to open its settings.",
          before: () => ws.setView("overview"),
        },
      ],
    },
    {
      id: "profile",
      title: "Profile",
      summary: "What every machine gets, and how to add to it.",
      pages: ["profile"],
      steps: [
        {
          target: ["profile-items"],
          title: "What your machines get",
          body: "Each item is a file in ~/.canonfig or an entry in its canonfig.jsonc: instructions, rules, skills, agents, commands, MCP servers, hooks, settings and tools. A letter beside an item marks a change machines don't have yet. A skill that came from a Git repository can follow it: open the skill to check for updates.",
          before: () => ws.setView("profile"),
        },
        {
          target: ["profile-folder"],
          title: "The Canonfig folder",
          body: "~/.canonfig holds the profile. Canonfig writes your edits into its files and keeps the comments in canonfig.jsonc, and your own edits to the folder show up here.",
          before: () => ws.setView("profile"),
        },
        {
          target: ["profile-harnesses"],
          title: "Harnesses",
          body: "Tick the harnesses Canonfig writes the folder into. Each machine manages the listed ones it has installed, and can exclude any for itself.",
          before: profileTab("harnesses"),
        },
        {
          target: ["profile-groups"],
          title: "Groups",
          body: "A group adds items on top of the base profile, for machines that need more. A machine's groups come from its invitation.",
          before: profileTab("groups"),
        },
        {
          target: ["schedule-when"],
          title: "Default schedule",
          body: "New machines check for revisions at this time unless they set their own. Save it, then publish so machines get it.",
          before: profileTab("defaults"),
        },
      ],
    },
    {
      id: "publishing",
      title: "Publishing and revisions",
      summary: "How changes reach your machines, and the revisions you published.",
      pages: ["revisions"],
      steps: [
        {
          target: ["revisions-next"],
          title: "Waiting to publish",
          body: "Your unpublished changes become the next revision. Your machines don't see them until you publish.",
          before: () => ws.setView("revisions"),
        },
        {
          target: ["publish"],
          title: "Publish a revision",
          body: "Canonfig checks the changes, then you note who reviewed them. Machines apply the new revision at their next check.",
          before: () => ws.setView("revisions"),
        },
        {
          target: ["revisions-list"],
          title: "Every revision you published",
          body: "A revision never changes once it's published. To go back, restore the old content in the profile and publish it as a new revision.",
          before: () => ws.setView("revisions"),
        },
      ],
    },
    {
      id: "machines",
      title: "Machines",
      summary: "Each machine's state, and how to add new ones.",
      pages: ["machines"],
      steps: [
        {
          target: ["machine-map"],
          title: "The machine map",
          body: "Each line runs from this Source to one machine. Double-click a machine to see its details and what to do.",
          before: () => ws.navigate(workspaceHref("source", "machines")),
        },
        {
          target: ["map-key"],
          title: "What the lines mean",
          body: "A line's colour and style show that machine's state. The key lists only the states on the map right now.",
          before: () => ws.navigate(workspaceHref("source", "machines")),
        },
        {
          target: ["machines-add"],
          title: "Add a machine",
          body: "Create a single-use invitation file. The new machine joins with it as a follower and gets its own identity.",
          before: () => ws.navigate(workspaceHref("source", "machines")),
        },
        {
          target: ["machines-list"],
          title: "The same machines as a list",
          body: "Compare revision, state and last update side by side. Click a row to open that machine.",
          before: () => ws.navigate(workspaceHref("source", "machines", { machinesMode: "list" })),
        },
      ],
    },
    {
      id: "secrets",
      title: "Secrets",
      summary: "Tokens and keys, and which machines receive them.",
      pages: ["secrets"],
      steps: [
        {
          target: ["secrets-about"],
          title: "Who gets secrets",
          body: "Only machines in the canonfig:secrets group receive them. This Source keeps the values in its credential store.",
          before: () => ws.setView("secrets"),
        },
        {
          target: ["secrets-list"],
          title: "Your shared secrets",
          body: "You see names and dates, never values. A value can't be viewed again after you set it.",
          before: () => ws.setView("secrets"),
        },
        {
          target: ["secrets-set"],
          title: "Set a secret",
          body: "Give it a name and a value. To change a value later, choose Replace value in its row's menu.",
          before: () => ws.setView("secrets"),
        },
        {
          target: ["secrets-share"],
          title: "Share with more machines",
          body: "Add a machine to the secrets group. Canonfig makes it a new invitation, and it receives secrets once it re-joins.",
          before: () => ws.setView("secrets"),
        },
      ],
    },
    shieldChapter(ws),
    {
      id: "health",
      title: "Service and health",
      summary: "The source service, setup, installers, health check and backups.",
      pages: ["service", "setup", "installers", "doctor", "backups"],
      steps: [
        {
          target: ["service-status"],
          title: "Source service",
          body: "Your other machines fetch revisions through this background service. Check here that it runs, and that it keeps running after you log out.",
          before: () => ws.setView("service"),
        },
        {
          target: ["setup-plan"],
          title: "Setup journal",
          body: "Setup records each step before it runs, so an interrupted setup resumes where it stopped. Approve the plan, then apply it.",
          before: () => ws.setView("setup"),
        },
        {
          target: ["installers-list"],
          title: "Installers",
          body: "Tools install through the package managers listed here. Click Check to test one.",
          before: () => ws.setView("installers"),
        },
        {
          target: ["doctor-results"],
          title: "Health check",
          body: "Run checks to test whether this machine can run Canonfig. It changes nothing, and each problem shows the command that fixes it.",
          before: () => ws.setView("doctor"),
        },
        {
          target: ["backups-about"],
          title: "Backups",
          body: "Before Canonfig first writes to a harness, it backs up what was there. Restore a backup here to put it back.",
          before: () => ws.setView("backups"),
        },
      ],
    },
  ];
}

/** Shield is per machine and reads the same on both roles. */
function shieldChapter(ws: Workspace): TourChapter {
  return {
    id: "shield",
    title: "Shield",
    summary: "Where agent installs go, and the plugins waiting for review.",
    pages: ["shield"],
    steps: [
      {
        target: ["shield-switch"],
        title: "Shield",
        body: "When an agent or installer adds a skill, MCP server or plugin, Shield puts it in your Canonfig folder instead of a harness folder.",
        before: () => ws.setView("shield"),
      },
      {
        target: ["shield-log"],
        title: "What Shield caught",
        body: "Every redirect from the last 30 days. Plugins run code, so they stay off until you review them here.",
        before: () => ws.setView("shield"),
      },
      {
        target: ["shield-harnesses"],
        title: "Harnesses",
        body: "A harness without hook support can't be stopped mid-install. Sync moves what it added instead.",
        before: () => ws.setView("shield"),
      },
    ],
  };
}

function followerChapters(ws: Workspace): TourChapter[] {
  return [
    {
      id: "machine",
      title: "This machine",
      summary: "Where this machine stands, and what it can see.",
      pages: ["overview", "machines"],
      steps: [
        {
          target: ["overview-head"],
          title: "Where things stand",
          body: "This band says which revision this machine has, and whether a newer one is ready to apply.",
          before: () => ws.setView("overview"),
        },
        {
          target: ["follower-this-machine"],
          title: "This machine at a glance",
          body: "Shows this machine's revision, next check, harnesses, local items, backups and tunnel. Click a row to open its page.",
          before: () => ws.setView("overview"),
        },
        {
          target: ["follower-runs"],
          title: "Recent updates",
          body: "Lists this machine's latest updates, newest first, and how each one ended.",
          before: () => ws.setView("overview"),
        },
        {
          target: ["machine-map"],
          title: "What this machine can see",
          body: "The map shows the Source and this machine. Followers can't see each other.",
          before: () => ws.navigate(workspaceHref("follower", "machines")),
        },
      ],
    },
    {
      id: "sync",
      title: "Sync",
      summary: "What an update will change here, before it does.",
      pages: ["sync"],
      steps: [
        {
          target: ["sync-check"],
          title: "Check for updates",
          body: "Ask the Source whether there is a newer revision. If you set a schedule, it also checks on its own.",
          before: () => ws.setView("sync"),
        },
        {
          target: ["sync-summary"],
          title: "What this update brings",
          body: "Shows the revision you're on, the one that's ready and how many changes it makes here.",
          before: () => ws.setView("sync"),
        },
        {
          target: ["sync-plan", "sync-held"],
          title: "Every change, before it happens",
          body: "Each row says what Canonfig will do, to which file, and why. Click a row for details.",
          before: () => ws.setView("sync"),
        },
        {
          target: ["sync-held"],
          title: "Items you edited here",
          body: "Canonfig never overwrites a file you edited here. It keeps your edit and holds what it writes from it. Click it to see how to settle it.",
          before: () => ws.setView("sync"),
        },
        {
          target: ["sync-apply"],
          title: "Apply changes",
          body: "Nothing changes on this machine until you apply. Items you edited here stay as you left them.",
          before: () => ws.setView("sync"),
        },
      ],
    },
    {
      id: "schedule",
      title: "Schedule",
      summary: "When this machine updates on its own.",
      pages: ["schedule"],
      steps: [
        {
          target: ["schedule-when"],
          title: "When it updates",
          body: "Follow the Source's default, or pick your own days and time. The system scheduler then checks for new revisions and applies them.",
          before: () => ws.setView("schedule"),
        },
        {
          target: ["schedule-next"],
          title: "Next check",
          body: "This is when the next automatic update runs. If the machine is asleep then, the update runs when it wakes up.",
          before: () => ws.setView("schedule"),
        },
        {
          target: ["schedule-save"],
          title: "Save schedule",
          body: "A new schedule starts once you save it. You can still update by hand from Sync.",
          before: () => ws.setView("schedule"),
        },
      ],
    },
    {
      id: "local",
      title: "Local settings",
      summary: "Items, harnesses and backups that are this machine's own.",
      pages: ["local", "backups"],
      steps: [
        {
          target: ["local-list"],
          title: "Your local folder",
          body: "Rules, skills, MCP servers and settings in ~/.canonfig/local. Canonfig adds them to what the Source publishes and never sends them to it.",
          before: () => ws.setView("local"),
        },
        {
          target: ["local-add"],
          title: "Add a local item",
          body: "Pick a kind the Source allows and a name it doesn't publish. A clashing name would stop the update until you rename one.",
          before: () => ws.setView("local"),
        },
        {
          target: ["local-harnesses"],
          title: "Harnesses on this machine",
          body: "Untick a harness to exclude it here. The Source's list stays as it is.",
          before: () => ws.setView("local"),
        },
        {
          target: ["local-backups"],
          title: "Backups",
          body: "Canonfig backs up a harness before it first writes there. Only this machine can turn that off.",
          before: () => ws.setView("local"),
        },
        {
          target: ["backups-about"],
          title: "Restore a backup",
          body: "Restoring puts back what a harness had before Canonfig, then excludes that harness here so the next update leaves it alone.",
          before: () => ws.setView("backups"),
        },
      ],
    },
    shieldChapter(ws),
    {
      id: "secrets",
      title: "Secrets",
      summary: "Shared tokens and keys this machine receives.",
      pages: ["secrets"],
      steps: [
        {
          target: ["secrets-about"],
          title: "Where secrets come from",
          body: "Machines in the canonfig:secrets group receive shared secrets from the Source. Canonfig writes them straight into this machine's credential store.",
          before: () => ws.setView("secrets"),
        },
        {
          target: ["secrets-list"],
          title: "Secrets on this machine",
          body: "The list shows each name and when the Source last changed it. Values never show here.",
          before: () => ws.setView("secrets"),
        },
        {
          target: ["secrets-update"],
          title: "Update secrets",
          body: "Fetch the latest values from the Source now.",
          before: () => ws.setView("secrets"),
        },
      ],
    },
    agentsChapter(ws),
    {
      id: "health",
      title: "Health and recovery",
      summary: "What stops updates, and how to fix it.",
      pages: ["overview", "sync", "doctor", "tunnel", "machine"],
      steps: [
        {
          target: ["follower-needs"],
          title: "Needs you",
          body: "Anything that stops an update shows up here, like an interrupted update, a file you edited, or a sign-in only you can do.",
          before: () => ws.setView("overview"),
        },
        {
          target: ["sync-recover"],
          title: "Interrupted updates",
          body: "Recover finishes the steps that didn't run. Abandon closes the update and leaves the finished steps in place.",
          before: () => ws.setView("sync"),
        },
        {
          target: ["doctor-results"],
          title: "Health check",
          body: "Run checks to test whether this machine can run Canonfig. It changes nothing, and each problem shows the command that fixes it.",
          before: () => ws.setView("doctor"),
        },
        {
          target: ["tunnel-status"],
          title: "SSH tunnel",
          body: "This machine reaches the Source through this tunnel. If it stops, updates fail until you start it again.",
          before: () => ws.setView("tunnel"),
        },
        {
          target: ["enrollment-stop"],
          title: "Stop syncing",
          body: "Stops updates and deletes this machine's identity. Files stay where they are.",
          before: () => ws.setView("machine"),
        },
      ],
    },
  ];
}
