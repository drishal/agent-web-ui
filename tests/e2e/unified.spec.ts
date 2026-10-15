// The pieces that make the app whole, one test each: the shortcut sheet,
// search across every chat, the file viewer, saved prompts, usage, the split
// view, the checkpoint timeline, and chained follow-ups.
import { expect, test, type Page } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

test("? opens the keyboard shortcuts, which a word narrows, and Escape closes them", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // In the composer, ? is a character…
  await box(page).fill("why?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  // …outside it, the sheet.
  await page.getByRole("heading", { name: /^What should/ }).click();
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("region", { name: "Composer" })).toContainText("Stash the draft for later");
  await sheet.getByRole("searchbox", { name: "Filter shortcuts" }).fill("stash");
  await expect(sheet.locator(".keys-row")).toHaveCount(1);
  await expect(sheet.locator(".keys-row .keycap")).toHaveText(["Alt", "S"]);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // Ctrl+/ works from inside the composer too.
  await box(page).focus();
  await page.keyboard.press("Control+/");
  await expect(sheet).toBeVisible();
});

test("$ lists the harness's skills, which leave the / menu, and Tab puts one in", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await box(page).fill("/");
  const commands = page.getByRole("listbox", { name: "Commands" });
  await expect(commands.getByRole("option", { name: /fake-status/ })).toBeVisible();
  await expect(commands.getByRole("option", { name: /skill:review/ })).toHaveCount(0);
  await expect(commands).toContainText("1 skill under $");
  await box(page).fill("$rev");
  const skills = page.getByRole("listbox", { name: "Skills" });
  await expect(skills.getByRole("option")).toHaveText([/\$review\s*Review the work so far/]);
  await page.keyboard.press("Tab");
  await expect(box(page)).toHaveValue("/skill:review ");
  // A $ further in is only a character.
  await box(page).fill("costs $5");
  await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
});
