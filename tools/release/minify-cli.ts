import { globSync, readFileSync, writeFileSync } from "node:fs";

import { build } from "esbuild";
import ts from "typescript";
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

// Compress internal decoder and harness-renderer identifiers while retaining
// exports and Function.name values. This keeps the corrective work within
// the existing package-size budgets without removing checks or features.
await build({
  entryPoints: ["dist/machine/installed-scheduler-command.js", ...globSync("dist/harness-configuration/**/*.js")].sort(),
  outbase: "dist",
  outdir: "dist",
  allowOverwrite: true,
  bundle: false,
  format: "esm",
  minify: true,
  keepNames: true,
  platform: "node",
  target: "node24",
});

// Internal declarations retain every type and exported name, but do not ship
// duplicated source comments. Public profile-compiler declarations stay intact.
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
for (const file of globSync("dist/{harness-configuration,machine,runtime,enrollment}/**/*.d.ts").sort()) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  writeFileSync(file, printer.printFile(source));
}

writeBuildReceipt(process.cwd());
