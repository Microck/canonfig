import { globSync } from "node:fs";

import { build } from "esbuild";
import { createBuildReceipt, writeBuildReceipt } from "./build-receipt.ts";

// The compiled runtime must be able to name the sources that produced it.
// esbuild is the last writer of dist, so the identity is substituted here;
// the receipt file itself stays out of the published package.
const identity = createBuildReceipt(process.cwd());

await build({
  entryPoints: globSync("dist/**/*.js").sort(),
  outbase: "dist",
  outdir: "dist",
  allowOverwrite: true,
  bundle: false,
  define: {
    __CANONFIG_BUILD_IDENTITY__: JSON.stringify(JSON.stringify({
      sourceDigest: identity.sourceDigest,
      commit: identity.git?.commit ?? null,
    })),
  },
  format: "esm",
  minifyIdentifiers: false,
  minifySyntax: true,
  minifyWhitespace: true,
  platform: "node",
  target: "node24",
});

writeBuildReceipt(process.cwd());
