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
for (const page of pages()) {
  test(`documentation route ${page.route}`, async ({ app, browser, screen }) => {
    await app.open(page.route);
    await expect(screen.getByRole("heading", { name: page.title, exact: true })).toBeVisible();
    const canonical = await browser.evaluate(() => document.querySelector('link[rel="canonical"]')?.getAttribute("href"));
    expect(new URL(canonical!).origin).toBe(new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").origin);
    expect(new URL(canonical!).pathname).toBe(page.route);
  });
}

test("legacy docs links redirect to the current CLI reference", async ({ app, browser, screen }) => {
  await app.open("/docs/reference/cli");
  await expect(browser).toHaveURL("/reference/cli");
  await expect(screen.getByRole("heading", "Reference: complete CLI reference")).toBeVisible();
});

test("search finds the documented CLI and mobile home stays within the viewport", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByRole("heading", { name: "Canonfig", exact: true })).toBeVisible();
  const search = await browser.evaluate(async () => {
    const response = await fetch("/api/search?query=CLI");
    return { status: response.status, results: await response.json() };
  });
  expect(search.status).toBe(200);
  expect(Array.isArray(search.results) && search.results.some((entry: {url:string}) =>
    new URL(entry.url, "https://canonfig.micr.dev").pathname === "/reference/cli"
  )).toBe(true);
  expect(await browser.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
