// Small motions shared across the app: every copy button morphing the same way, checks that draw themselves,
// status words that blur in, and folds that grow without a measured height.
import { expect, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

test("a labelled copy button (a tool output sheet's Copy) says Copied for a moment and goes back", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hello tool");
  const toggle = page.getByTestId("process-toggle").last();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const rows = page.getByTestId("tool-row");
  const count = await rows.count();
  let opened = false;
  for (let i = 0; i < count && !opened; i++) {
    const row = rows.nth(i);
    await row.getByRole("button").first().click();
    const button = row.getByRole("button", { name: "Full output" });
    if ((await button.count()) > 0) {
      await button.click();
      opened = true;
    }
  }
  expect(opened).toBe(true);
  const sheet = page.getByRole("dialog", { name: /^Output · / });
  await sheet.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Copied" })).toHaveText("Copied");
  await expect(sheet.getByRole("status").filter({ hasText: "Copied" })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe("");
  await expect(sheet.getByRole("button", { name: "Copy", exact: true })).toHaveText("Copy");
});
