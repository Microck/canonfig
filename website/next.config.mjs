import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// The docs ship as static files under /docs of the GitHub Pages site, next to
// the UI demo at the root (see scripts/build-pages.mjs). `basePath` must match
// `basePath` in lib/site.ts, which client code uses for paths Next does not
// prefix on its own (the static search index).
/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  output: "export",
  basePath: "/docs",
  // Every page exports as <route>/index.html, which GitHub Pages serves for
  // both /docs/x and /docs/x/.
  trailingSlash: true,
};

export default withMDX(config);
