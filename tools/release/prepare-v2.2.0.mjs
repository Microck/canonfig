import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const source = execFileSync(
  "git",
  ["show", "HEAD^:tools/release/prepare-v2.2.0.mjs"],
  { encoding: "utf8" },
);
const marker = 'const readmePath = "README.md";';
if (!source.includes(marker)) throw new Error("release preparation marker is missing");
const lockRepair = `const originalLock = JSON.parse(execFileSync(
  "git",
  ["show", "HEAD:package-lock.json"],
  { encoding: "utf8" },
));
originalLock.version = newVersion;
for (const path of ["", "website"]) {
  if (originalLock.packages?.[path] !== undefined) {
    originalLock.packages[path].version = newVersion;
  }
}
writeFileSync(
  "package-lock.json",
  \`${'${JSON.stringify(originalLock, null, 2)}'}\\n\`,
  "utf8",
);

`;
const generatedPath = resolve("tools/release/.prepare-v2.2.0.generated.mjs");
writeFileSync(generatedPath, source.replace(marker, `${lockRepair}${marker}`), "utf8");
try {
  await import(pathToFileURL(generatedPath).href);
} finally {
  rmSync(generatedPath, { force: true });
}
