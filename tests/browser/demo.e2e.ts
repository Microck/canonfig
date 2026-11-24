import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("the public demo automatically applies new Source changes", async ({ app, browser, screen }) => {
  await app.open("/demo/");
  await expect(browser).toHaveURL("/demo/source/overview");

  await expect(screen.getByText("Automatic apply", { exact: true, visible: true })).toBeVisible();
  await expect(screen.getByText("Off", { exact: true, visible: true })).toBeVisible();
  await screen.getByRole("button", { name: "Local sync", exact: true }).tap();
  await expect(screen.getByRole("heading", { name: "Local sync", exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Plan local changes" })).toBeVisible();
  const automaticApply = screen.getByRole("switch", { name: "Apply changes automatically" });
  await expect(screen.getByRole("switch", { name: "Apply changes automatically", checked: false })).toBeVisible();
  await automaticApply.tap();
  await expect(screen.getByText("Watching the Canonfig folder", { exact: true })).toBeVisible();
  const applied = screen.getByRole("heading", { name: "Local changes applied", exact: true });
  await expect(applied).toBeVisible({ timeout: 10_000 });
  await screen.getByRole("link", { name: "Overview", exact: true }).tap();
  await expect(screen.getByText("On", { exact: true, visible: true })).toBeVisible();

  await screen.getByRole("link", /^Profile/).tap();
  await screen.getByRole("button", /rules\/typescript\.md/).tap();
  await screen.getByRole("textbox", { name: "Body", exact: true }).fill("Prefer named exports.");
  await screen.getByRole("button", { name: "Save to the folder" }).tap();
  await expect(screen.getByText("Saved rules/typescript", { exact: true })).toBeVisible();
  await screen.getByRole("link", { name: "Local sync" }).tap();
  await expect(applied).toBeVisible({ timeout: 10_000 });
  await expect(screen.getByText("1 change", { exact: true })).toBeVisible();

  await automaticApply.tap();
  await expect(screen.getByRole("switch", { name: "Apply changes automatically", checked: false })).toBeVisible();

  await app.open("/demo/follower/sync");
  await expect(screen.getByRole("heading", { name: "Sync", exact: true })).toBeVisible();
  await expect(automaticApply).not.toBeVisible();
});

test("the public demo automatically retires an applied rule", async ({ app, screen }) => {
  await app.open("/demo/source/sync");
  await screen.getByRole("switch", { name: "Apply changes automatically" }).tap();
  await expect(screen.getByRole("heading", { name: "Local changes applied", exact: true })).toBeVisible({ timeout: 10_000 });

  await screen.getByRole("link", /^Profile/).tap();
  await screen.getByRole("button", /rules\/typescript\.md/).tap();
  await screen.getByRole("button", { name: "Remove…", exact: true }).tap();
  await screen.getByRole("button", { name: "Remove item", exact: true }).tap();
  await expect(screen.getByText("Removed rules/typescript", { exact: true })).toBeVisible();
  await screen.getByRole("link", { name: "Local sync" }).tap();
  await expect(screen.getByRole("button", /^Done Remove rules\/typescript/)).toBeVisible({ timeout: 10_000 });
});


test("the public demo reapplies a restored harness after it is included again", async ({ app, screen }) => {
  await app.open("/demo/source/sync");
  const automaticApply = screen.getByRole("switch", { name: "Apply changes automatically" });
  const applied = screen.getByRole("heading", { name: "Local changes applied", exact: true });
  await automaticApply.tap();
  await expect(applied).toBeVisible({ timeout: 10_000 });
  await automaticApply.tap();

  await screen.getByRole("link", { name: "Backups", exact: true }).tap();
  await screen.getByRole("button", { name: "Restore…", exact: true }).last().tap();
  const confirm = screen.getByRole("dialog", { name: "Restore OpenAI Codex, Claude Code?" });
  await confirm.getByRole("button", { name: "Restore", exact: true }).tap();
  await expect(screen.getByText("Restored OpenAI Codex, Claude Code", { exact: true })).toBeVisible();

  await screen.getByRole("link", { name: "Local settings", exact: true }).tap();
  await screen.getByRole("checkbox", { name: "Include Claude Code on this machine" }).tap();
  await screen.getByRole("link", { name: "Local sync", exact: true }).tap();
  await expect(screen.getByRole("button", { name: "Apply changes", exact: true })).toBeVisible();
  await automaticApply.tap();
  await expect(applied).toBeVisible({ timeout: 10_000 });
});


test("the public demo automatically reapplies a settings key after its claim is removed", async ({ app, screen }) => {
  await app.open("/demo/source/sync");
  await screen.getByRole("switch", { name: "Apply changes automatically" }).tap();
  await expect(screen.getByRole("heading", { name: "Local changes applied", exact: true })).toBeVisible({ timeout: 10_000 });

  await screen.getByRole("link", { name: "Local settings", exact: true }).tap();
  await screen.getByRole("button", { name: "Remove claim settings/claude-code#includeCoAuthoredBy", exact: true }).tap();
  const confirm = screen.getByRole("dialog", { name: "Let Canonfig manage includeCoAuthoredBy again?" });
  await confirm.getByRole("button", { name: "Remove", exact: true }).tap();
  await screen.getByRole("link", { name: "Local sync", exact: true }).tap();
  await expect(screen.getByRole("button", /^Done Set keys settings\/claude-code/)).toBeVisible({ timeout: 10_000 });
  await expect(screen.getByText("1 change", { exact: true })).toBeVisible();
});

test("the public demo retires projections when a surface or harness is unlisted", async ({ app, screen }) => {
  await app.open("/demo/source/sync");
  await screen.getByRole("switch", { name: "Apply changes automatically" }).tap();
  await expect(screen.getByRole("heading", { name: "Local changes applied", exact: true })).toBeVisible({ timeout: 10_000 });

  const localSync = screen.getByRole("link", { name: "Local sync", exact: true });
  await screen.getByRole("link", /^Profile/).tap();
  await screen.getByRole("link", /^Harnesses/).tap();
  await screen.getByRole("button", { name: "What Claude Code gets: Everything" }).tap();
  const rules = screen.getByRole("menuitemcheckbox", { name: "Rules", exact: true });
  await rules.tap();
  await rules.press("Escape");
  await localSync.tap();
  await expect(screen.getByRole("button", /^Done Remove rules\/typescript/)).toBeVisible({ timeout: 10_000 });

  await screen.getByRole("link", /^Profile/).tap();
  await screen.getByRole("link", /^Harnesses/).tap();
  await screen.getByRole("checkbox", { name: "List Claude Code", exact: true }).tap();
  await localSync.tap();
  await expect(screen.getByRole("button", /^Done Remove settings\/claude-code/)).toBeVisible({ timeout: 10_000 });
});

test("the public demo waits for an item collision to be settled before applying", async ({ app, screen }) => {
  await app.open("/demo/source/local-settings");
  await screen.getByRole("button", { name: "Remove overlay mcp/docs", exact: true }).tap();
  const confirm = screen.getByRole("dialog", { name: "Stop replacing mcp/docs?" });
  await confirm.getByRole("button", { name: "Remove", exact: true }).tap();

  const localSync = screen.getByRole("link", { name: "Local sync", exact: true });
  const localSettings = screen.getByRole("link", { name: "Local settings", exact: true });
  await localSync.tap();
  await screen.getByRole("switch", { name: "Apply changes automatically" }).tap();
  await expect(screen.getByText(/mcp\/docs clashes with what atlas publishes/)).toBeVisible();
  await screen.getByRole("button", { name: "Plan local changes", exact: true }).tap();
  await expect(screen.getByText("Local changes planned", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Apply changes", exact: true, disabled: true })).toBeVisible();

  await localSettings.tap();
  await screen.getByRole("button", /mcp\/docs.*Use mine/).tap();
  await localSync.tap();
  await expect(screen.getByRole("heading", { name: "Local changes applied", exact: true })).toBeVisible({ timeout: 10_000 });
});
