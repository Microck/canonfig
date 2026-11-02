import { useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MachineMap } from "@/shared/machine-map/machine-map";
import type { Follower, FollowerState } from "@/shared/data";
import { SourceOverview } from "@/workspace/source";
import { MachinesView } from "@/workspace/machines";
import { WorkspaceProvider, useWorkspace } from "@/workspace/store";
import { parseRoute, type Navigate } from "@/workspace/routes";

const states: FollowerState[] = ["converged", "drift", "human-action", "failed", "offline", "never-synced"];
const longName = "buildhost".repeat(18);
const longNote = "The managed configuration was edited on this machine during a deployment. Review the local changes before replacing them. The operator needs to preserve the workspace settings and credentials. ".repeat(3);
const names = ["", "Box", "Work laptop", "The development workstation used by the distributed infrastructure team during release preparation", longName, "👩🏽‍💻", "Build 🧑‍🚀 station 🚀", "جهاز التطوير الرئيسي", "خادم Canonfig رقم 42 build", "Ångström Žluťoučký हिन्दी ไทย"];
function followers(count: number, prefix: string, stress = false): Follower[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: stress ? names[i % names.length] : `workstation-${String(i + 1).padStart(2, "0")}`,
    platform: (["linux", "macos", "windows"] as const)[i % 3],
    groups: stress ? ["infrastructure".repeat(8), "gpu", "development", "regional-build", "release", "canonfig:secrets"] : ["gpu"],
    revision: i % 6 === 5 ? null : i % 6 === 0 ? 8 : 7,
    state: states[i % states.length],
    lastRun: "12 min ago",
    schedule: "Daily at 09:00",
    note: stress ? (i % 2 ? longNote : "configurationpath".repeat(25)) : "Local changes need review",
    resources: {},
  }));
}

interface Scenario {
  id: string;
  label: string;
  width: number;
  squeezed?: boolean;
  followers: Follower[];
  active?: boolean;
  role?: "source" | "follower";
}
const maps: Scenario[] = [
  { id: "M0", label: "Zero followers", width: 1100, followers: [] },
  { id: "M1", label: "One follower", width: 1100, followers: followers(1, "m1") },
  { id: "M4", label: "Four followers, typical names", width: 1100, followers: followers(4, "m4") },
  { id: "MT", label: "Ten names: empty, word, typical, sentences, unbreakable, emoji, RTL, mixed direction, tall scripts; six states", width: 1500, followers: followers(10, "mt", true) },
  { id: "M40", label: "Forty followers", width: 1100, followers: followers(40, "m40") },
  { id: "M320", label: "320px container, four followers", width: 320, followers: followers(4, "m320") },
  { id: "MS", label: "Squeezed by a 240px flex sibling inside 520px", width: 520, squeezed: true, followers: followers(4, "ms") },
  { id: "MW", label: "Very wide container", width: 1500, followers: followers(4, "mw") },
  { id: "MA", label: "Publishing and syncing with all six states", width: 1100, followers: followers(6, "ma"), active: true },
  { id: "MF", label: "Follower role at 320px, unbreakable name", width: 320, followers: [{ ...followers(1, "mf")[0], name: longName }], role: "follower" },
];
const listScenarios: Scenario[] = [
  { id: "L0", label: "Zero followers", width: 1100, followers: [] },
  { id: "L1", label: "One follower needing attention", width: 1100, followers: [{ ...followers(1, "l1")[0], state: "drift", revision: 7 }] },
  { id: "LT", label: "Ten names and long notes/groups, all six states", width: 1100, followers: followers(10, "lt", true) },
  { id: "L40", label: "Forty machines with long names and notes", width: 1500, followers: followers(40, "l40", true) },
  { id: "L320", label: "320px container, four followers", width: 320, followers: followers(4, "l320") },
  { id: "LS", label: "Squeezed by a 240px flex sibling inside 780px", width: 780, squeezed: true, followers: followers(4, "ls") },
];

const observations: Record<string, string[]> = {
  M40: ["BR-01 (medium, better-layout): Initial fit shows only the middle followers; outer followers and Add machine are outside the canvas."],
  M320: ["BR-01 (medium, better-layout): Initial fit crops outer followers and hides Add machine at 320px."],
  MS: [
    "BR-01 (medium, better-layout): Initial fit crops outer followers and hides Add machine in the 280px remaining width.",
    "BR-02 (low, better-layout): Zoom/reset controls cover the end of the Update failed legend label.",
  ],
  LT: [
    "BR-03 (medium, better-typography): Unbreakable names push state/revision text out of view; unbreakable notes clip instead of wrapping.",
    "BR-06 (medium, better-layout): The long first group chip is clipped and the five remaining groups have no visible indicator.",
  ],
  L40: [
    "BR-03 (medium, better-typography): Unbreakable names and notes clip even at 1500px; state text is cut off.",
    "BR-06 (medium, better-layout): Only the clipped first group is visible in each six-group machine row.",
  ],
  L320: [
    "BR-04 (medium, better-layout): Overview headings overlap the sidebar and the target list collapses out of view.",
    "BR-05 (medium, better-layout): Machines shows only name, system and part of groups; revision/state/update/checks are outside the visible width.",
  ],
  LS: [
    "BR-04 (medium, better-layout): Overview reasons wrap one word per line while action buttons overlap names and state labels are clipped.",
    "BR-05 (medium, better-layout): Machines cuts state labels at the right edge and leaves last-update/checks columns outside the visible width.",
  ],
};

function Frame({ scenario, children, suffix = "" }: { scenario: Scenario; children: ReactNode; suffix?: string }) {
  const id = `${scenario.id}${suffix}`;
  return <section id={id} style={{ margin: "32px 16px", width: scenario.width }}>
    <h2>{id}: {scenario.label}{suffix ? " (independent repeat)" : ""}</h2>
    {observations[scenario.id]?.map(note => <p key={note}>{note}</p>)}
    <div style={{ display: "flex", width: scenario.width }}>
      {scenario.squeezed && <aside style={{ width: 240, flexShrink: 0 }}>Sibling occupies 240px</aside>}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  </section>;
}

// Each stress case owns its navigation independently of the app URL and the other cases.
function FixtureWorkspace({ rows }: { rows: Follower[] }) {
  const [href, setHref] = useState("/source/machines/list");
  const route = parseRoute(href);
  const navigate: Navigate = (next) => setHref(next);
  if (route.kind !== "workspace") throw new Error(`Invalid fixture route: ${href}`);
  return <WorkspaceProvider route={route} navigate={navigate}><FixtureViews rows={rows} /></WorkspaceProvider>;
}

// Populate each real provider before mounting its views. No app module or saved state is patched.
function FixtureViews({ rows }: { rows: Follower[] }) {
  const ws = useWorkspace();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    ws.setFollowers(rows);
    ws.setResources([]);
    ws.setInvitations([]);
    setReady(true);
  }, [rows]);
  if (!ready) return null;
  return <>
    <h3>Overview: Not up to date, and why</h3>
    <div style={{ display: "flex", flexDirection: "column" }}><SourceOverview /></div>
    <h3>Machines: list rows (notes are not displayed here)</h3>
    <div style={{ display: "flex", flexDirection: "column" }}><MachinesView /></div>
  </>;
}

function App() {
  return <TooltipProvider delayDuration={250}>
    <header style={{ margin: 16 }}>
      <h1>Canonfig component stress report</h1>
      <p>Real components, fixture data, original global styles. One browser load under reduced motion.</p>
      <p>Run 1: MachineMap. Run 2: workspace list rows through exported views and WorkspaceProvider.</p>
      <p>Repeated instances provide a second visible reproduction without reloading. Browser zoom, focus, hover and motion changes remain manual checks.</p>
    </header>
    <h1>Run 1: MachineMap</h1>
    {maps.map(s => <Frame key={s.id} scenario={s}><div style={{ height: 460 }}><MachineMap role={s.role ?? "source"} followers={s.followers} latestRevision={8} selfId={s.followers[0]?.id} publishing={s.active} syncing={s.active ? s.followers.slice(0, 2).map(f => f.id) : []} /></div></Frame>)}
    {maps.filter(s => ["MT", "M40", "M320", "MS", "MF"].includes(s.id)).map(s => <Frame key={`${s.id}-repeat`} scenario={s} suffix="-repeat"><div style={{ height: 460 }}><MachineMap role={s.role ?? "source"} followers={s.followers} latestRevision={8} selfId={s.followers[0]?.id} /></div></Frame>)}
    <h1>Run 2: Overview and Machines list rows</h1>
    {listScenarios.map(s => <Frame key={s.id} scenario={s}><FixtureWorkspace rows={s.followers} /></Frame>)}
    {listScenarios.filter(s => ["LT", "L320", "LS"].includes(s.id)).map(s => <Frame key={`${s.id}-repeat`} scenario={s} suffix="-repeat"><FixtureWorkspace rows={s.followers} /></Frame>)}
  </TooltipProvider>;
}

createRoot(document.getElementById("root")!).render(<App />);
