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
  expect(await browser.evaluate(() => document.querySelector<HTMLTextAreaElement>("#local-content-0")!.value)).toBe("Draft before save");

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
