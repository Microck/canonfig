import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const DEMO_URL = "https://canonfig.micr.dev/";
const DEMO_TITLE = "Canonfig: interactive demo";
const DEMO_DESCRIPTION =
  "Try Canonfig's browser workspace with made-up data. Canonfig keeps your AI agent instructions, settings, skills and tools the same on every machine.";
// The share image, rendered from scripts/og-image.html. The docs at /docs point their og:image at the same URL.
const OG_IMAGE = "og-image.png";
const OG_IMAGE_URL = `${DEMO_URL}${OG_IMAGE}`;
const OG_IMAGE_ALT = "Canonfig machine map: the Source machine atlas syncing to laptop, studio, gaming-pc and build-box, under the line: Canonfig keeps your AI agent instructions, settings, skills and tools the same on every machine.";

/**
 * The public demo at canonfig.micr.dev (`vite build --mode demo`, GitHub Pages). It adds indexable and share
 * meta to the page, emits the share image, and writes 404.html as a copy of index.html: Pages serves 404.html
 * for unknown paths, so deep links such as /follower/sync still boot the SPA, whose router reads the URL. The
 * production build that `canonfig ui` will serve gets none of these and keeps the plain title from index.html.
 */
function demoSite(): Plugin {
  return {
    name: "canonfig-demo-site",
    apply: (_config, env) => env.command === "build" && env.mode === "demo",
    transformIndexHtml(html) {
      const title = "<title>Canonfig</title>";
      if (!html.includes(title)) throw new Error(`demo build: index.html no longer contains ${title}`);
      return {
        html: html.replace(title, `<title>${DEMO_TITLE}</title>`),
        tags: [
          { tag: "meta", attrs: { name: "description", content: DEMO_DESCRIPTION }, injectTo: "head" },
          { tag: "link", attrs: { rel: "canonical", href: DEMO_URL }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:type", content: "website" }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:site_name", content: "Canonfig" }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:title", content: DEMO_TITLE }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:description", content: DEMO_DESCRIPTION }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:url", content: DEMO_URL }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:image", content: OG_IMAGE_URL }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:image:width", content: "1200" }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:image:height", content: "630" }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:image:alt", content: OG_IMAGE_ALT }, injectTo: "head" },
          { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" }, injectTo: "head" },
          { tag: "meta", attrs: { name: "twitter:title", content: DEMO_TITLE }, injectTo: "head" },
          { tag: "meta", attrs: { name: "twitter:description", content: DEMO_DESCRIPTION }, injectTo: "head" },
          { tag: "meta", attrs: { name: "twitter:image", content: OG_IMAGE_URL }, injectTo: "head" },
          { tag: "meta", attrs: { name: "twitter:image:alt", content: OG_IMAGE_ALT }, injectTo: "head" },
        ],
      };
    },
    // Runs after Vite's HTML plugin has emitted index.html (enforce: "post"), so the copy has the final asset URLs.
    enforce: "post",
    generateBundle(_options, bundle) {
      const index = bundle["index.html"];
      if (index?.type !== "asset") throw new Error("demo build: index.html missing from the bundle");
      this.emitFile({ type: "asset", fileName: "404.html", source: index.source });
      // Not in public/, which both builds copy: only the demo has a public URL to share.
      this.emitFile({ type: "asset", fileName: OG_IMAGE, source: readFileSync(path.resolve(import.meta.dirname, "scripts", OG_IMAGE)) });
    },
  };
}

/** Match DEMO exactly, using Vite's resolved DEV value without importing simulated data. */
function applicationEntrypoint(): Plugin {
  let entrypoint: string;
  let demo = false;
  return {
    name: "canonfig-application-entrypoint",
    configResolved(config) {
      demo = !config.isProduction || config.mode === "demo";
      entrypoint = path.resolve(import.meta.dirname, demo ? "./src/App.tsx" : "./src/live-app.tsx");
    },
    resolveId(id) {
      if (id === "@app") return entrypoint;
    },
    generateBundle(_options, bundle) {
      if (demo) return;
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const simulated = Object.keys(output.modules).find((id) => {
          const normalized = id.replaceAll("\\", "/");
          return normalized.endsWith("/src/shared/data.ts") || /\/src\/workspace\/simulated-(store|administration|app)\.tsx?$/.test(normalized);
        });
        if (simulated) this.error(`Production browser bundle imports simulated data: ${simulated}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), demoSite(), applicationEntrypoint()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  build: {
    rolldownOptions: {
      output: {
        // Third-party code changes far less often than app code, so it gets its own long-cached chunk that the
        // browser downloads in parallel with the app chunk.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            // Only libraries the first page needs; @xyflow and d3 stay with the lazily loaded machine map.
            { name: "vendor", test: /node_modules[\\/](?!@xyflow|d3-)/ },
          ],
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5317,
    allowedHosts: true,
    // Vite skips its own outDir, but dist-demo's index.html and 404.html would otherwise reload every open
    // dev page whenever the demo builds.
    watch: { ignored: ["**/dist-demo/**"] },
  },
});
