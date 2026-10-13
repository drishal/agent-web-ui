// Features borrowed from T3 Code, one test each: in the composer, the
// conversation, the sidebar, and the page title.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

test("Ctrl+F finds in the chat, opening the fold a match is in, and steps through matches", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "read a tool, walrus");
  await sendAndWait(page, "and walrus again");
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyF");
  const find = page.getByRole("searchbox", { name: "Find in chat" });
  await expect(find).toBeFocused();
  await find.fill("WALRUS");
  // Each prompt and each answer echoing it, and, in the folds the query opened, each thought quoting it.
  await expect(page.getByTestId("find-count")).toHaveText("1 of 6");
  await find.press("Enter");
  await expect(page.getByTestId("find-count")).toHaveText("2 of 6");
  await find.press("Shift+Enter");
  await find.press("Shift+Enter");
  await expect(page.getByTestId("find-count")).toHaveText("6 of 6");
  // README.md is the tool's path, inside the first turn's closed fold.
  await find.fill("README");
  await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
  await expect(page.getByText("README.md").first()).toBeVisible();
  await find.press("Escape");
  await expect(find).toBeHidden();
});

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
