import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// One static export for the GitHub Pages site: the landing page at /, the docs
// under /docs, beside the demo under /demo (see scripts/build-pages.mjs).
/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  output: "export",
  // Every page exports as <route>/index.html, which GitHub Pages serves for
  // both /docs/x and /docs/x/.
  trailingSlash: true,
};

export default withMDX(config);
