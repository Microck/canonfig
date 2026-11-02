// Serves the static export in out/ under /docs, the way GitHub Pages serves it
// on https://canonfig.micr.dev, for the browser suite and local previews.
// `next start` cannot serve an `output: "export"` build.
//
// Usage: node scripts/serve-export.mjs [--hostname 127.0.0.1] [--port 3000]
//
// It mirrors the Pages behaviour the export relies on: a directory answers with
// its index.html, a directory path without its trailing slash redirects to the
// slashed path, and unknown paths get 404.html with status 404. Anything
// outside /docs is the UI demo's in production, so it gets the 404 too.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Must match `basePath` in next.config.mjs.
const basePath = "/docs";
const outDir = fileURLToPath(new URL("../out", import.meta.url));

const { values } = parseArgs({
  options: {
    hostname: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "3000" },
  },
});

// The static search index (api/search) has no extension and holds JSON.
const contentTypes = {
  "": "application/json",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

const fileAt = async (path) => {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
};

const send = (response, status, path) => {
  response.writeHead(status, {
    "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
  });
  createReadStream(path).pipe(response);
};

const notFound = (response) => send(response, 404, join(outDir, "404.html"));

createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
    notFound(response);
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice(basePath.length));
  } catch {
    notFound(response); // malformed percent-encoding
    return;
  }
  // join() normalizes "..", and a decoded "%2F.." could still climb, so check the result stays in out/.
  const path = join(outDir, relative);
  if (path !== outDir && !path.startsWith(`${outDir}${sep}`)) {
    notFound(response);
    return;
  }
  const found = await fileAt(path);
  if (found?.isDirectory()) {
    if (!pathname.endsWith("/")) {
      response.writeHead(301, { location: `${pathname}/` });
      response.end();
      return;
    }
    const index = join(path, "index.html");
    if (await fileAt(index)) send(response, 200, index);
    else notFound(response);
    return;
  }
  if (found?.isFile()) send(response, 200, path);
  else notFound(response);
}).listen(Number(values.port), values.hostname, () => {
  console.log(`serve-export: http://${values.hostname}:${values.port}${basePath}/`);
});
