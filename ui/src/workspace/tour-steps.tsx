// The tour: four stops per role, the most a tour can have before most people
// drop out (Chameleon 2025 benchmark). It covers only what a first-time user
// needs to find on day one; everything else is learned in place (page tips) or
// by doing (Get started). The last stop starts the first Get started item, so
// the tour ends in an action, not a summary.
import { Kbd } from "@/components/ui/kbd";
import { machine } from "@/shared/data";
import type { TourStep } from "@/tour/tour";
import { getStartedItems } from "./guide";
import type { Workspace } from "./store";

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export function tourSteps(ws: Workspace, live: () => Workspace): TourStep[] {
  const firstTask = () => getStartedItems(live()).find((i) => !i.done);
  const handOver: TourStep = {
    target: ["get-started"],
    title: "Your next steps",
    body: (
      <>
        Do these in order; each one ticks itself off when it's done. Anything else, press <Kbd>{MOD} K</Kbd> and type what you want.
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
