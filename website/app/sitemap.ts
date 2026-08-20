import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl.href,
      changeFrequency: "monthly",
      priority: 1,
    },
    ...source.getPages().map((page) => ({
      url: new URL(page.url, siteUrl).href,
      changeFrequency: "monthly" as const,
      priority: page.url === "/docs" ? 0.9 : 0.7,
    })),
  ];
}
