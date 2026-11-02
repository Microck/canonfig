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
