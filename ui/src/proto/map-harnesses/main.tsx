import { createRoot } from "react-dom/client";
import "@/index.css";
import { Logo } from "@/shared/shared";
import { Explorer } from "./explorer";

export function App() {
  return <main className="min-h-dvh bg-canvas px-3 pb-24 pt-4 text-foreground sm:px-6">
    <div className="mx-auto max-w-[1720px]">
      <div className="mb-4 flex items-center gap-3"><Logo /><span className="font-semibold">canonfig</span><p className="text-sm text-muted-foreground">Prototype · example reports, not live data</p></div>
      <Explorer />
      <p className="mt-3 text-xs text-muted-foreground">1 / 2 / 3 or ← / → switch designs. R resets the current view. Tab reaches machine and harness controls. Enter opens evidence.</p>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
