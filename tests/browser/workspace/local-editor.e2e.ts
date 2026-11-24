import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("a pending local save blocks native editing and focus until the draft unlocks", async ({ app, browser, screen }) => {
  await app.open("/follower/local-settings?focus=new");
  const content = screen.getByRole("textbox", { name: "Content", exact: true });
  await expect(content).toBeVisible();
  await content.tap();
  await browser.keyboard.press("Control+a");
  await browser.keyboard.press("Backspace");
  await content.pressSequentially("Draft before save");
  await screen.getByRole("button", { name: "Save", exact: true }).tap();

  await expect.poll(() => browser.evaluate(async () => (await fetch("/__test/save-pending")).json())).toBe(true);
  expect(await browser.evaluate(() => {
    const text = document.querySelector<HTMLTextAreaElement>("#local-content-0")!;
    text.focus();
    const controls = [...text.closest('aside[aria-label="Details"]')!.querySelectorAll("input, textarea, select")];
    return {
      disabled: controls.length > 0 && controls.every((control) => control.matches(":disabled")),
      focused: text === document.activeElement,
    };
  })).toEqual({ disabled: true, focused: false });
  await browser.keyboard.press("x");
  expect(await content.inputValue()).toBe("Draft before save");

  // A rejected save leaves the same draft mounted so the test can verify it unlocks.
  expect(await browser.evaluate(async () => (await fetch("/__test/reject-save", { method: "POST" })).ok)).toBe(true);
  await expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await content.tap();
  await browser.keyboard.press("End");
  await browser.keyboard.press("!");
  expect(await browser.evaluate(() => {
    const text = document.querySelector<HTMLTextAreaElement>("#local-content-0")!;
    return { value: text.value, focused: text === document.activeElement };
  })).toEqual({ value: "Draft before save!", focused: true });
});

test("browser Back and Forward keep a local draft until the user discards it", async ({ app, browser, screen }) => {
  await app.open("/follower/overview");
  await screen.getByRole("link", { name: "Local settings", exact: true }).tap();
  await screen.getByRole("button", { name: "Add a local item" }).tap();
  const content = screen.getByRole("textbox", { name: "Content", exact: true });
  const confirm = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
  const location = () => browser.evaluate(() => window.location.pathname + window.location.search);
  const edit = "/follower/local-settings?focus=new";
  const traverse = (offset: number) => browser.evaluate((delta) => history.go(delta), offset);

  await content.tap();
  await content.pressSequentially("Uncommitted instructions");
  await browser.evaluate(() => {
    history.back();
    history.back();
  });
  await expect(confirm).toBeVisible();
  await expect.poll(location).toBe(edit);
  await confirm.getByRole("button", { name: "Keep editing" }).tap();
  expect(await location()).toBe(edit);
  expect(await content.inputValue()).toBe("Uncommitted instructions");

  await traverse(-1);
  await confirm.getByRole("button", { name: "Discard changes" }).tap();
  await expect.poll(location).toBe("/follower/local-settings");
  await expect(content).not.toBeVisible();
  // The discarded draft does not reappear when Forward reopens the clean editor.
  await traverse(1);
  await expect(content).toBeVisible();
  expect(await content.inputValue()).toBe("");
  await screen.getByRole("link", { name: "Overview", exact: true }).tap();
  await expect.poll(location).toBe("/follower/overview");
  await traverse(-1);
  await expect(content).toBeVisible();

  await content.tap();
  await content.pressSequentially("Another draft");
  await traverse(1);
  await confirm.getByRole("button", { name: "Discard changes" }).tap();
  await expect.poll(location).toBe("/follower/overview");
  await expect(confirm).not.toBeVisible();

  await traverse(-1);
  await content.tap();
  await content.pressSequentially("Draft with a fragment");
  await browser.evaluate(() => { window.location.hash = "workspace-content"; });
  const hash = () => browser.evaluate(() => window.location.hash);
  await expect.poll(hash).toBe("#workspace-content");
  await traverse(-1);
  await expect.poll(hash).toBe("");
  await expect(confirm).not.toBeVisible();
  await traverse(1);
  await expect.poll(hash).toBe("#workspace-content");
  await expect(confirm).not.toBeVisible();
  expect(await content.inputValue()).toBe("Draft with a fragment");

  await traverse(-3);
  await confirm.getByRole("button", { name: "Keep editing" }).tap();
  await expect.poll(location).toBe(edit);
  expect(await content.inputValue()).toBe("Draft with a fragment");

  await traverse(-3);
  await expect(confirm).toBeVisible();
  await expect.poll(hash).toBe("#workspace-content");
  await traverse(-1);
  await expect.poll(hash).toBe("");
  await confirm.getByRole("button", { name: "Discard changes" }).tap();
  await expect.poll(location).toBe("/follower/overview");
  await expect(content).not.toBeVisible();
});
