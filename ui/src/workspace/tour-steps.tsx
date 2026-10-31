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
import { machine } from "@/shared/data";
import type { TourStep } from "@/tour/tour";
import { getStartedItems } from "./guide";
import { workspaceHref } from "./routes";
import type { Workspace } from "./store";

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** One entry in the tour picker: the short tour ("quick") or a chapter. */
export interface TourChapter {
  id: string;
  title: string;
  /** One line in the picker saying what the chapter covers. */
  summary: string;
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
    steps: tourSteps(ws, live),
  };
  const chapters = ws.role === "source" ? sourceChapters(ws) : followerChapters(ws);
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
        body: `${machine.hostname} holds the one true copy of your setup. Your other machines copy it from here.`,
      },
      {
        target: ["nav-profile"],
        title: "Profile: what gets synced",
        body: "Add files, settings, skills and tools here. Nothing reaches another machine until you publish.",
      },
      {
        target: ["nav-machines"],
        title: "Machines",
        body: "Every machine on one map: who's up to date, why not, and where to add a new one.",
      },
      handOver,
    ];

  return [
    {
      target: ["machine"],
      title: "This machine follows atlas",
      body: `${ws.machineName} copies its setup from atlas. You change the setup there, not here.`,
    },
    {
      target: ["nav-sync"],
      title: "Sync: get the latest",
      body: "See exactly what an update would change here, then apply it.",
    },
    {
      target: ["nav-overlays"],
      title: "Keep something different",
      body: "Keep a setting on this machine only. Canonfig leaves it alone.",
    },
    handOver,
  ];
}

/** Both roles have the same Agent policy and Harness projects pages, so they share one chapter. */
function agentsChapter(ws: Workspace): TourChapter {
  return {
    id: "agents",
    title: "AI agents",
    summary: "When an AI agent may help, and what it may change.",
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
      {
        target: ["harness-projects"],
        title: "Harness projects",
        body: "Add a repository, and Canonfig writes each agent's instruction files from one .canonfig/harness.yaml in it. This is separate from the profile your machines sync.",
        before: () => ws.setView("harness"),
      },
    ],
  };
}

function sourceChapters(ws: Workspace): TourChapter[] {
  const profileTab = (tab: "groups" | "defaults") => () => ws.navigate(workspaceHref("source", "profile", { profileTab: tab }));
  return [
    {
      id: "source",
      title: "Your Source",
      summary: "What the Overview says about your profile and machines.",
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
      steps: [
        {
          target: ["profile-items"],
          title: "What your machines get",
          body: "The profile lists the files, folders, settings, skills and tools your machines get. A letter beside an item marks a change they don't have yet.",
          before: () => ws.setView("profile"),
        },
        {
          target: ["profile-add"],
          title: "Add to the profile",
          body: "Add item takes a file, folder, setting, skill or tool. Discover tools reads your agent config and proposes the tools it uses.",
          before: () => ws.setView("profile"),
        },
        {
          target: ["profile-file"],
          title: "The profile file",
          body: "This file holds the profile. Canonfig writes your edits into it and keeps your comments, and your own edits to the file show up here.",
          before: () => ws.setView("profile"),
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
    agentsChapter(ws),
    {
      id: "health",
      title: "Service and health",
      summary: "The source service, setup, installers and health check.",
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
      ],
    },
  ];
}

function followerChapters(ws: Workspace): TourChapter[] {
  return [
    {
      id: "machine",
      title: "This machine",
      summary: "Where this machine stands, and which profile it follows.",
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
          body: "Shows this machine's revision, profile, next check, kept keys and tunnel. Click Next check, Kept here or Tunnel to open that page.",
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
        {
          target: ["enrollment-profile"],
          title: "Which profile it follows",
          body: "Switch to another profile from the Source. Nothing changes here until you review the update in Sync and apply it.",
          before: () => ws.setView("machine"),
        },
      ],
    },
    {
      id: "sync",
      title: "Sync",
      summary: "What an update will change here, before it does.",
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
          target: ["sync-plan", "sync-paused"],
          title: "Every change, before it happens",
          body: "Each row says what Canonfig will do, to which file, and why. Click a row for details.",
          before: () => ws.setView("sync"),
        },
        {
          target: ["sync-paused"],
          title: "Paused items",
          body: "Canonfig pauses a file you edited here instead of overwriting it. Click it to choose between your edit and the revision's copy.",
          before: () => ws.setView("sync"),
        },
        {
          target: ["sync-apply"],
          title: "Apply changes",
          body: "Nothing changes on this machine until you apply. Paused items wait until you decide.",
          before: () => ws.setView("sync"),
        },
      ],
    },
    {
      id: "schedule",
      title: "Schedule",
      summary: "When this machine updates on its own.",
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
      summary: "Settings that stay different on this machine.",
      steps: [
        {
          target: ["overlays-list"],
          title: "Keys kept on this machine",
          body: "Canonfig doesn't overwrite these keys, and never sends their values to the Source.",
          before: () => ws.setView("overlays"),
        },
        {
          target: ["overlays-add"],
          title: "Keep a key on this machine",
          body: "Pick a settings file and the keys to keep, like a model or editor setting. Whole files can't be kept, only keys.",
          before: () => ws.setView("overlays"),
        },
        {
          target: ["sync-plan", "sync-paused"],
          title: "Kept keys during an update",
          body: "Updates leave kept keys alone. If the Source also sets one, Sync pauses that file until you decide which value wins.",
          before: () => ws.setView("sync"),
        },
      ],
    },
    {
      id: "secrets",
      title: "Secrets",
      summary: "Shared tokens and keys this machine receives.",
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
