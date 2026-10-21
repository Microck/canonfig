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

// The bounded native-header decoder is internal runtime code. Compress its
// local identifiers too, retaining exported names and Function.name values,
// so the additional checks fit the unchanged package-size budget.
await build({
  entryPoints: ["dist/machine/installed-scheduler-command.js"],
  outfile: "dist/machine/installed-scheduler-command.js",
  allowOverwrite: true,
  bundle: false,
  format: "esm",
  minify: true,
  keepNames: true,
  platform: "node",
  target: "node24",
});

writeBuildReceipt(process.cwd());
