import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import { Logo } from "@/shared/shared";
import { MapExperience } from "./canvas";
import { makeMachines, scenarios, type Mode } from "./fixtures";
import { Picker } from "./picker";

const modes: Mode[] = ["film", "focus", "rail"];
function initialVariant() {
  const value = Number(new URLSearchParams(location.search).get("v"));
  return Number.isInteger(value) && value >= 1 && value <= modes.length ? value - 1 : 0;
}
export function App() {
  const [current, setCurrent] = useState(initialVariant);
  const [mount, setMount] = useState(0);
  const [scenario, setScenario] = useState(() => {
    const value = new URLSearchParams(location.search).get("case");
    return scenarios.find(entry => entry.id === value)?.id ?? "film";
  });
  const machines = useMemo(() => makeMachines(scenario), [scenario]);
  const replay = useCallback(() => setMount(value => value + 1), []);
  const select = useCallback((index: number) => {
    setCurrent(index);
    setMount(value => value + 1);
    const url = new URL(location.href);
    url.searchParams.set("v", String(index + 1));
    history.replaceState(null, "", url);
  }, []);
  return <main className="min-h-dvh bg-canvas px-3 pb-24 pt-4 text-foreground sm:px-6">
    <div className="mx-auto max-w-[1720px]">
      <div className="mb-4 flex flex-wrap items-center gap-3"><Logo /><span className="font-semibold">canonfig</span><p className="mr-auto text-sm text-muted-foreground">Prototype · example reports, not live data</p><label className="flex items-center gap-2 text-sm text-muted-foreground">Scenario<select className="h-11 max-w-full rounded-lg border border-input bg-panel px-2 text-[16px] text-foreground focus-visible:outline-2 focus-visible:outline-ring" value={scenario} onChange={event => { const value = event.target.value; setScenario(value); const url = new URL(location.href); url.searchParams.set("case", value); history.replaceState(null, "", url); }}>
        {scenarios.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label></div>
      <div className="mx-auto max-w-full" style={{ width: scenario === "M320" ? 320 : undefined }}>
        <MapExperience key={`${current}-${scenario}-${mount}`} mode={modes[current]} machines={machines} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">1 / 2 / 3 or ← / → switch designs. R resets the current view. Tab reaches machine and harness controls. Enter opens evidence.</p>
    </div>
    <Picker current={current} select={select} replay={replay} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
