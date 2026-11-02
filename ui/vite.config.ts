import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const DEMO_URL = "https://canonfig.micr.dev/";
const DEMO_TITLE = "Canonfig: interactive demo";
const DEMO_DESCRIPTION =
  "Try Canonfig's browser workspace with made-up data. Canonfig keeps your AI agent instructions, settings, skills and tools the same on every machine.";

/**
 * The public demo at canonfig.micr.dev (`vite build --mode demo`, GitHub Pages). It adds indexable meta to the
 * page and writes 404.html as a copy of index.html: Pages serves 404.html for unknown paths, so deep links such
 * as /follower/sync still boot the SPA, whose router reads the URL. The production build that `canonfig ui`
 * will serve gets neither and keeps the plain title from index.html.
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
          // --canvas in src/index.css, the colour behind the app frame.
          { tag: "meta", attrs: { name: "theme-color", content: "#080b0c" }, injectTo: "head" },
          { tag: "link", attrs: { rel: "canonical", href: DEMO_URL }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:type", content: "website" }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:site_name", content: "Canonfig" }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:title", content: DEMO_TITLE }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:description", content: DEMO_DESCRIPTION }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:url", content: DEMO_URL }, injectTo: "head" },
          // No share image exists yet, so the small card; switch to summary_large_image with og:image once one does.
          { tag: "meta", attrs: { name: "twitter:card", content: "summary" }, injectTo: "head" },
          { tag: "meta", attrs: { name: "twitter:title", content: DEMO_TITLE }, injectTo: "head" },
          { tag: "meta", attrs: { name: "twitter:description", content: DEMO_DESCRIPTION }, injectTo: "head" },
        ],
      };
    },
    // Runs after Vite's HTML plugin has emitted index.html (enforce: "post"), so the copy has the final asset URLs.
    enforce: "post",
    generateBundle(_options, bundle) {
      const index = bundle["index.html"];
      if (index?.type !== "asset") throw new Error("demo build: index.html missing from the bundle");
      this.emitFile({ type: "asset", fileName: "404.html", source: index.source });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), demoSite()],
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
