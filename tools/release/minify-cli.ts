import { globSync } from "node:fs";

import { build } from "esbuild";

await build({
  entryPoints: globSync("dist/**/*.js").sort(),
  outbase: "dist",
  outdir: "dist",
  allowOverwrite: true,
  bundle: false,
  format: "esm",
  minifyIdentifiers: false,
  minifySyntax: true,
  minifyWhitespace: true,
  platform: "node",
  target: "node24",
});
