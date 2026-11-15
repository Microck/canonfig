// Absolute URL of the site root. Production builds set it to
// https://canonfig.micr.dev (scripts/build-pages.mjs).
const configuredSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const siteUrl = new URL(configuredSiteUrl);

// Resolves a route such as `/docs/reference/cli` to its absolute URL with the
// trailing slash the static export serves (next.config.mjs `trailingSlash`).
export function absoluteUrl(route: string): string {
  const path = route.endsWith("/") ? route : `${route}/`;
  return new URL(path, siteUrl).href;
}

// The demo emits the share image; scripts/build-pages.mjs also copies it to the
// domain root so the landing page and docs can use the same URL.
export const shareImage = {
  url: new URL("/og-image.png", siteUrl).href,
  width: 1200,
  height: 630,
  alt: "Canonfig machine map: the Source machine atlas syncing to laptop, studio, gaming-pc and build-box, under the line: Canonfig keeps your AI agent instructions, settings, skills and tools the same on every machine.",
};
