import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Discover all current docs, so a new page cannot silently escape route coverage.
const root = "website/content/docs";
function pages(directory = root): { route: string; title: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return pages(path);
    if (!entry.name.endsWith(".mdx")) return [];
    const title = readFileSync(path, "utf8").match(/^title:\s*(.+)$/m)?.[1]?.replace(/^"|"$/g, "");
    if (!title) throw new Error(`Missing title: ${path}`);
    const route = "/" + relative(root, path).split(sep).join("/").replace(/\.mdx$/, "").replace(/(^|\/)index$/, "");
    return [{ route, title }];
  });
}

// The site exports statically under /docs with trailing slashes (website/next.config.mjs),
// and website/scripts/serve-export.mjs serves it the way GitHub Pages does.
const exported = (route: string) => `/docs${route.replace(/\/?$/, "/")}`;

for (const page of pages()) {
  test(`documentation route ${page.route}`, async ({ app, browser, screen }) => {
    await app.open(exported(page.route));
    await expect(screen.getByRole("heading", { name: page.title, exact: true })).toBeVisible();
    const canonical = await browser.evaluate(() => document.querySelector('link[rel="canonical"]')?.getAttribute("href"));
    expect(new URL(canonical!).origin).toBe(new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").origin);
    expect(new URL(canonical!).pathname).toBe(exported(page.route));
  });
}

// Search runs in the browser against the static index, so it is exercised through the search dialog.
test("search finds the documented CLI and mobile home stays within the viewport", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open(exported("/"));
  await expect(screen.getByRole("heading", { name: "Canonfig", exact: true })).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await screen.getByRole("button", "Open Search").tap();
  await screen.getByPlaceholder("Search").pressSequentially("CLI reference");
  await screen.getByRole("button", /^Canonfig Reference Reference: complete CLI reference$/).tap();
  await expect(browser).toHaveURL(exported("/reference/cli"));
  await expect(screen.getByRole("heading", { name: "Reference: complete CLI reference", exact: true })).toBeVisible();
});
