import type { MetadataRoute } from "next";

import { absoluteDocsUrl } from "@/lib/site";
import { source } from "@/lib/source";

// `output: "export"` only accepts metadata routes it can render at build time.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: absoluteDocsUrl(page.url),
    changeFrequency: "monthly" as const,
    priority: page.url === "/" ? 1 : 0.7,
  }));
}
