import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";

// The static export writes the whole search index to /docs/api/search once at
// build time; the client searches it in the browser (`type: "static"` in
// app/layout.tsx), since GitHub Pages cannot run a search endpoint.
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source);
