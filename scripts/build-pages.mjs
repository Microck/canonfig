// Builds the GitHub Pages site for https://canonfig.micr.dev into _site/:
// the landing page at /, the interactive demo under /demo/ and docs under /docs/.
//
// Usage: node scripts/build-pages.mjs
// Expects dependencies installed in ui/ and the root workspace (website/);
// .github/workflows/pages.yml runs `npm ci` for both before calling it.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_URL = "https://canonfig.micr.dev";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "ui", "dist-demo");
const websiteDir = join(root, "website", "out");
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
run(["--prefix", "website", "run", "build"], { NEXT_PUBLIC_SITE_URL: SITE_URL });

// Pages serves the domain's 404.html for deep links. The demo router accepts
// only /demo/ paths; missing docs and other unknown paths show a not-found page.
requireFile(join(demoDir, "404.html"), "npm --prefix ui run build:demo");
requireFile(join(websiteDir, "index.html"), "npm --prefix website run build");
requireFile(join(websiteDir, "docs", "index.html"), "npm --prefix website run build");
requireFile(join(websiteDir, "docs", "api", "search"), "npm --prefix website run build (static search index)");

// The website owns the root; the demo has its own directory. Only the demo's
// deep-link entry and shared social image are copied to the root.
for (const entry of ["demo", "robots.txt", "og-image.png"]) {
  if (existsSync(join(websiteDir, entry))) fail(`website/out/${entry} is reserved by build-pages.mjs`);
}

rmSync(siteDir, { recursive: true, force: true });
cpSync(websiteDir, siteDir, { recursive: true });
cpSync(demoDir, join(siteDir, "demo"), { recursive: true });
cpSync(join(demoDir, "404.html"), join(siteDir, "404.html"));
cpSync(join(demoDir, "og-image.png"), join(siteDir, "og-image.png"));

// No CNAME or .nojekyll: a site published by a custom Actions workflow takes
// its custom domain from the repository's Pages settings and ignores CNAME,
// and GitHub serves the artifact as-is without running Jekyll.
//
// Crawlers only read robots.txt at the domain root.
writeFileSync(
  join(siteDir, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
);

console.log(`build-pages: wrote ${siteDir}`);
