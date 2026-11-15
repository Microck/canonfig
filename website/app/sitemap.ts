import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/site";
import { source } from "@/lib/source";

// `output: "export"` only accepts metadata routes it can render at build time.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: absoluteUrl("/"), changeFrequency: "monthly", priority: 1 },
    ...source.getPages().map((page) => ({
      url: absoluteUrl(page.url),
      changeFrequency: "monthly" as const,
      priority: page.url === "/docs" ? 0.9 : 0.7,
    })),
  ];
}
