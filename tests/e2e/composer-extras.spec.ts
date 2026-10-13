// Features borrowed from T3 Code, one test each: in the composer, the
// conversation, the sidebar, and the page title.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

test("a queued follow-up can be edited or removed before it runs", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow stream for the queue");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await box(page).fill("queued one");
  await page.getByRole("button", { name: "Follow-up" }).click();
  await box(page).fill("queued two");
  await page.getByRole("button", { name: "Follow-up" }).click();
  const rows = page.getByTestId("queue-row");
  await expect(rows).toHaveCount(2);
  await rows.first().hover();
  await rows.first().getByRole("button", { name: "Edit the queued follow-up" }).click();
  const edit = rows.first().getByRole("textbox", { name: "Edit the queued follow-up" });
  await edit.fill("queued one, edited");
  await edit.press("Enter");
  await expect(rows.first()).toContainText("queued one, edited");
  await rows.last().hover();
  await rows.last().getByRole("button", { name: "Remove the queued follow-up" }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("user-prompt").last()).toHaveText("queued one, edited", { timeout: 20_000 });
});
