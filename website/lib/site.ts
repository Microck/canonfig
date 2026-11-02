// Must match `basePath` in next.config.mjs.
export const basePath = "/docs";

// Absolute URL of the docs root, including the base path. Production builds
// set it to https://canonfig.micr.dev/docs (scripts/build-pages.mjs).
const configuredSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? `http://localhost:3000${basePath}`;

export const siteUrl = new URL(configuredSiteUrl);

// Resolves a docs route such as `/reference/cli` to its absolute URL with the
// trailing slash the static export serves (next.config.mjs `trailingSlash`).
// `new URL(route, siteUrl)` would drop the base path for root-relative routes.
export function absoluteDocsUrl(route: string): string {
  const path = route.endsWith("/") ? route : `${route}/`;
  return new URL(`${siteUrl.pathname.replace(/\/$/, "")}${path}`, siteUrl).href;
}

// The share image for og:image and twitter:image. The demo build at the site
// root emits it (ui/vite.config.ts), so the docs point at the domain root, not
// at their own base path.
export const shareImage = {
  url: new URL("/og-image.png", siteUrl).href,
  width: 1200,
  height: 630,
  alt: "Canonfig machine map: the Source machine atlas syncing to laptop, studio, gaming-pc and build-box, under the line: Canonfig keeps your AI agent instructions, settings, skills and tools the same on every machine.",
};
