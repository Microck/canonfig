import { posix } from "node:path";
import { emptyModel } from "../../../src/projection/detect.ts";
import { projectionLayoutMetadata } from "../../../src/projection/layout-metadata.ts";

// Vite serializes this layout at build time. It never uses the building machine's home or environment.
const home = "/canonfig-demo";
export const demoProjection = projectionLayoutMetadata(
  { platform: "linux", home, appData: posix.join(home, ".config"), environment: () => undefined, join: posix.join },
  emptyModel(posix.join(home, ".canonfig")),
);
