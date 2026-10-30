import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  server: { host: "0.0.0.0", port: 5317, allowedHosts: true },
});
