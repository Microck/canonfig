import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { scenarios } from "./fixtures";


const logoOptions = { original: "Original film colours", mono: "Monochrome", dither: "Dithered glyph", tile: "Brand-coloured tile" };
const cardOptions = { none: "None", tint: "Brand tint", dither: "Dithered gradient" };
type Config = { logo: keyof typeof logoOptions; card: keyof typeof cardOptions; tint: number };
function initialConfig(): Config {
  const query = new URLSearchParams(location.search);
  const logo = query.get("logo");
  const card = query.get("card");
  const tint = Number(query.get("tint") ?? 18);
  return {
    logo: Object.hasOwn(logoOptions, logo ?? "") ? logo as Config["logo"] : "original",
    card: Object.hasOwn(cardOptions, card ?? "") ? card as Config["card"] : "none",
    tint: Number.isFinite(tint) ? Math.max(0, Math.min(50, tint)) : 18,
  };
}
function variables({ logo, card, tint }: Config): Record<string, string> {
  return {
    "--logo-original": logo === "original" ? "block" : "none",
    "--logo-mono": logo === "mono" ? "block" : "none",
    "--logo-dither": logo === "dither" ? "block" : "none",
    "--logo-tile": logo === "tile" ? "grid" : "none",
    "--harness-tint": card === "tint" ? `${tint}%` : "0%",
    "--tint-opacity": String(tint / 100),
    "--harness-border-tint": card === "none" ? "0%" : `${tint * 2}%`,
    "--card-dither": card === "dither" ? "block" : "none",
    "--harness-label-fill": card === "none" ? "transparent" : "var(--raised)",
  };
}
const controlClass = "mt-1 h-11 w-full rounded border border-white/20 bg-neutral-900 px-2 text-[16px] text-white focus-visible:outline-2 focus-visible:outline-white";

export function Appearance({ children, scenario, onScenario, embedded, baselineActive }: {
  children: ReactNode; scenario: string; onScenario: (value: string) => void; embedded: boolean; baselineActive: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const tintValue = useRef<HTMLOutputElement>(null);
  const configText = useRef<HTMLTextAreaElement>(null);
  const copyStatus = useRef<HTMLOutputElement>(null);
  const [initial] = useState(initialConfig);
  const config = useRef(initial);
  const [initialStyle] = useState(() => variables(initial));
  function describe() { return `logo: ${config.current.logo} · card: ${config.current.card} · tint: ${config.current.tint}%`; }
  function apply() {
    for (const [name, value] of Object.entries(variables(config.current))) root.current!.style.setProperty(name, value);
    root.current!.dataset.logo = config.current.logo;
    root.current!.dataset.card = config.current.card;
    tintValue.current!.value = `${config.current.tint}%`;
    configText.current!.value = describe();
    copyStatus.current!.value = "";
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(config.current)) url.searchParams.set(key, String(value));
    history.replaceState(null, "", url);
  }
  // React mounts only once per screen. Sliders change CSS, never the graph's React state.
  useLayoutEffect(() => { configText.current!.value = describe(); }, []);
  const overview = embedded && location.pathname === "/source/overview";
  return <div ref={root} data-prototype="map-harnesses" data-logo={initial.logo} data-card={initial.card} style={initialStyle as CSSProperties} className={`flex min-h-0 flex-col ${overview && !baselineActive ? "mx-4 mt-4 h-[620px] flex-none border border-border" : "flex-1"}`}>
    {children}
    <details className="fixed right-6 top-48 z-40 max-h-[calc(100dvh-270px)] max-w-[calc(100vw-48px)] overflow-auto rounded-xl border border-white/15 bg-neutral-950 p-3 font-[system-ui] text-[13px] leading-normal text-white shadow-xl" aria-label="Map prototype controls">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 focus-visible:outline-2 focus-visible:outline-white">Map prototype controls</summary>
      <form className="grid w-[264px] max-w-full gap-3 pt-3" onSubmit={event => event.preventDefault()}>
        <p className="text-neutral-300">{baselineActive ? "Current is unchanged. Controls apply to Film and Focus." : "Example harness reports, not live telemetry."}</p>
        <label>Scenario<select className={controlClass} value={scenario} onChange={event => onScenario(event.target.value)}>
          {embedded && <option value="demo">App demo machines</option>}
          {scenarios.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        <label>Logo style<select className={controlClass} defaultValue={initial.logo} onChange={event => { config.current.logo = event.target.value as Config["logo"]; apply(); }}>
          {Object.entries(logoOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Card colour<select className={controlClass} defaultValue={initial.card} onChange={event => { config.current.card = event.target.value as Config["card"]; apply(); }}>
          {Object.entries(cardOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label htmlFor="prototype-tint">Tint strength <output ref={tintValue} className="float-right font-mono">{initial.tint}%</output><input id="prototype-tint" className="block h-11 w-full accent-white" type="range" min="0" max="50" step="1" defaultValue={initial.tint} onInput={event => { config.current.tint = Number(event.currentTarget.value); apply(); }} /></label>
        <label>Copyable config<textarea ref={configText} readOnly rows={2} className="mt-1 block w-full resize-none rounded border border-white/20 bg-neutral-900 p-2 font-mono text-[16px]" /></label>
        <button type="button" className="min-h-11 rounded border border-white/20 px-3 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-white" onClick={() => {
          // The requested HTTP Tailscale URL is not a secure Clipboard API context.
          configText.current!.focus(); configText.current!.select();
          copyStatus.current!.value = document.execCommand("copy") ? "Copied" : "Select the config and copy it manually";
        }}>Copy config</button>
        <output ref={copyStatus} aria-live="polite" />
        <p className="text-neutral-300">1 / 2 / 3 or ← / → switch. R resets. Stylized marks are experiments, not approved brand usage.</p>
      </form>
    </details>
  </div>;
}
