import type { PluginAPI } from "tailwindcss/plugin";
import { SNAP_EASING } from "./motion-token.ts";

export default ({ addBase }: PluginAPI) => {
  addBase({ ":root": { "--canonfig-snap-easing": SNAP_EASING } });
};
