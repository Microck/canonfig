import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const stopped = new Promise((resolve) => shutdown.signal.addEventListener("abort", resolve, { once: true }));

const outDir = await mkdtemp(join(tmpdir(), "canonfig-browser-"));
const localItems = { items: [], config: {}, canonicalConfig: { local: { allow: ["instructions"] } } };
let pending;

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}

const fixture = {
  name: "canonfig-workspace-browser-fixture",
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const route = `${request.method} ${request.url}`;
      switch (route) {
        case "GET /api/session":
          return json(response, 200, { role: "follower", machineName: "Browser fixture", folderPath: outDir, version: "7.8.0" });
        case "GET /api/status":
          return json(response, 200, { machineRole: { role: "follower" }, lifecycle: {}, tunnel: null });
        case "GET /api/local/items":
          return json(response, 200, localItems);
        case "GET /api/harnesses":
          return json(response, 200, { folder: outDir, configured: true, listed: [], excluded: [], detected: [], notInstalled: [], snapshots: 0, harnesses: [] });
        case "GET /api/local/overlays":
          return json(response, 200, {});
        case "PUT /api/local/items":
          request.resume();
          request.on("end", () => { pending = response; });
          return;
        case "GET /__test/save-pending":
          return json(response, 200, pending !== undefined);
        case "POST /__test/reject-save":
          if (!pending) return json(response, 409, { error: "No pending save" });
          json(pending, 409, { category: "usage-or-configuration", exitCode: 2, message: "Fixture rejected the save." });
          pending = undefined;
          return json(response, 200, {});
        default:
          return next();
      }
    });
  },
};

let server;
try {
  await build({ root, build: { outDir, reportCompressedSize: false } });
  if (!shutdown.signal.aborted) {
    server = await preview({ root, build: { outDir }, preview: { host: "127.0.0.1", port: 4175, strictPort: true }, plugins: [fixture] });
    await stopped;
  }
} finally {
  pending?.end();
  await server?.close();
  await rm(outDir, { recursive: true });
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
