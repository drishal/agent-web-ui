import { expect, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

// The tool card's later touches: a long run folded to its ends, a test run's own glyph, the working label's mark.

test("a long run shows its first three and last two calls, and one button shows the rest", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "manycalls");
  const toggle = page.getByTestId("process-toggle").last();
  await expect(toggle).toContainText("Used 12 tools");
  await toggle.click();
  const rows = page.getByTestId("tool-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(2).locator(".tool-sentence")).toContainText("part-3.ts");
  await expect(rows.nth(3).locator(".tool-sentence")).toContainText("part-11.ts");
  const more = page.getByRole("button", { name: "Show 7 more calls" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(12);
  await expect(more).toHaveCount(0);
});

test("find in chat reaches a call the fold hides", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "manycalls");
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyF");
  await page.getByRole("searchbox", { name: "Find in chat" }).fill("part-7.ts");
  await expect(page.getByTestId("process-toggle").last()).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-row")).toHaveCount(12);
  await expect(page.getByRole("button", { name: /^Show \d+ more/ })).toHaveCount(0);
});
