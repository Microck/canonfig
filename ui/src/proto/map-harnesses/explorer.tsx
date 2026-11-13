import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { MapExperience } from "./canvas";
import { makeMachines, scenarios, type Machine, type Mode } from "./fixtures";
import { Picker } from "./picker";
import { Appearance } from "./appearance";

const isolatedNames = ["Film", "Focus", "Rail"];
const inPlaceNames = ["Current", "Film", "Focus"];
const isolatedModes: Mode[] = ["film", "focus", "rail"];
const inPlaceModes: Mode[] = ["film", "focus"];

export function Explorer({ baseline, demoMachines }: { baseline?: ReactNode; demoMachines?: Machine[] }) {
  const embedded = demoMachines !== undefined;
  const [current, setCurrent] = useState(() => {
    const value = Number(new URLSearchParams(location.search).get("v"));
    return Number.isInteger(value) && value >= 1 && value <= 3 ? value - 1 : 0;
  });
  const [mount, setMount] = useState(0);
  const [scenario, setScenario] = useState(() => {
    const value = new URLSearchParams(location.search).get("case");
    return scenarios.find(entry => entry.id === value)?.id ?? (embedded ? "demo" : "film");
  });
  const machines = useMemo(() => scenario === "demo" && demoMachines ? demoMachines : makeMachines(scenario), [scenario, demoMachines]);
  const replay = useCallback(() => setMount(value => value + 1), []);
  const select = useCallback((index: number) => {
    setCurrent(index);
    setMount(value => value + 1);
    const url = new URL(location.href);
    url.searchParams.set("v", String(index + 1));
    history.replaceState(null, "", url);
  }, []);
  const changeScenario = (value: string) => {
    setScenario(value);
    const url = new URL(location.href);
    url.searchParams.set("case", value);
    history.replaceState(null, "", url);
  };
  const baselineActive = embedded && current === 0;
  return <Appearance scenario={scenario} onScenario={changeScenario} embedded={embedded} baselineActive={baselineActive}>
    <Fragment key={`${current}-${scenario}-${mount}`}>
      {baselineActive ? baseline : <div className="flex min-h-0 flex-1 flex-col" style={{ maxWidth: scenario === "M320" ? 320 : undefined }}>
        <MapExperience mode={embedded ? inPlaceModes[current - 1] : isolatedModes[current]} machines={machines} embedded={embedded} />
      </div>}
    </Fragment>
    <Picker names={embedded ? inPlaceNames : isolatedNames} current={current} select={select} replay={replay} />
  </Appearance>;
}
