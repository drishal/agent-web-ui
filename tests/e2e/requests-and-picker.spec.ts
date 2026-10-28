// An answered request folds into one line, a queued message glides into the
// conversation, and the model picker grows out of its chip (type to search).
import { expect, test } from "@playwright/test";
import { newChat, send, signInAndOpen } from "./helpers.js";

test("an answered request folds into one line naming the answer", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask before reading");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Waiting for approval");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
  const folded = page.getByTestId("approval-folded");
  await expect(folded).toHaveText("Approved: Allow tool: read");
  // It leaves by itself; the conversation keeps the record.
  await expect(folded).toHaveCount(0, { timeout: 6_000 });
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
});

test("a denied request folds into a line that says so", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask before reading");
  const card = page.getByTestId("approval-card");
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByTestId("approval-folded")).toContainText("Denied: Allow tool: read");
});
