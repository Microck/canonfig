// Builds the GitHub Pages site for https://canonfig.micr.dev into _site/:
// the UI demo at the root and the docs under /docs.
//
// Usage: node scripts/build-pages.mjs
// Expects dependencies installed in ui/ and the root workspace (website/);
// .github/workflows/pages.yml runs `npm ci` for both before calling it.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOMAIN = "canonfig.micr.dev";
const DOCS_URL = `https://${DOMAIN}/docs`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "ui", "dist-demo");
const docsDir = join(root, "website", "out");
const siteDir = join(root, "_site");

function fail(message) {
  console.error(`build-pages: ${message}`);
  process.exit(1);
}

function run(args, env = {}) {
  console.log(`build-pages: npm ${args.join(" ")}`);
  const result = spawnSync("npm", args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error !== undefined) fail(`could not run npm: ${result.error.message}`);
  if (result.status !== 0) fail(`npm ${args.join(" ")} exited with ${result.status}`);
}

function requireFile(path, producer) {
  if (!existsSync(path)) fail(`missing ${path}; ${producer} should have produced it`);
}

// Both builds empty their own output directory first, so a stale file from an
// earlier run cannot reach _site.
run(["--prefix", "ui", "run", "build:demo"]);
run(["--prefix", "website", "run", "build"], { NEXT_PUBLIC_SITE_URL: DOCS_URL });

requireFile(join(demoDir, "index.html"), "npm --prefix ui run build:demo");
// GitHub Pages serves the root 404.html for unknown paths, which is how the
// demo's client-side routes (/source/overview) survive a reload.
requireFile(join(demoDir, "404.html"), "npm --prefix ui run build:demo");
requireFile(join(docsDir, "index.html"), "npm --prefix website run build");
requireFile(join(docsDir, "api", "search"), "npm --prefix website run build (static search index)");

// This script owns these root paths; the demo build must not ship them.
for (const owned of ["docs", "robots.txt"]) {
  if (existsSync(join(demoDir, owned))) {
    fail(`ui/dist-demo/${owned} would collide with the file build-pages.mjs writes`);
  }
}

rmSync(siteDir, { recursive: true, force: true });
cpSync(demoDir, siteDir, { recursive: true });
cpSync(docsDir, join(siteDir, "docs"), { recursive: true });

// No CNAME or .nojekyll: a site published by a custom Actions workflow takes
// its custom domain from the repository's Pages settings and ignores CNAME,
// and GitHub serves the artifact as-is without running Jekyll.
//
// Crawlers only read robots.txt at the domain root, so it lives here rather
// than in the docs export.
writeFileSync(
  join(siteDir, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${DOCS_URL}/sitemap.xml\n`,
);

console.log(`build-pages: wrote ${siteDir}`);
