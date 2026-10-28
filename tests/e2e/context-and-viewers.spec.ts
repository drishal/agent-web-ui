// Presence in the header (how many devices have a chat open) and the context panel
// (its sparkline and its hover). Each test opens its own chat.
import { expect, test } from "@playwright/test";
import { openChat, sendAndWait, signInAndOpen } from "./helpers.js";

test("a second page on the same chat shows '2 devices' in the header, and it goes away again", async ({ page, context }) => {
  await signInAndOpen(page);
  await openChat(page);
  await expect(page.getByTestId("chat-viewers")).toHaveCount(0);
  // The same browser profile restores the open tab, so this page attaches to the same live chat.
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByTestId("chat-status")).toHaveText("Idle");
  await expect(page.getByTestId("chat-viewers")).toHaveText("2 devices", { timeout: 10_000 });
  await expect(page.getByTestId("chat-viewers")).toHaveAttribute("title", /2 devices/);
  await expect(other.getByTestId("chat-viewers")).toHaveText("2 devices", { timeout: 10_000 });
  await other.close();
  await expect(page.getByTestId("chat-viewers")).toHaveCount(0, { timeout: 10_000 });
});

test("the context panel draws how the context grew, with a name a screen reader can read", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await sendAndWait(page, "second question");
  await page.getByTestId("context-ring").click();
  const panel = page.getByRole("dialog", { name: "Context and usage" });
  await expect(panel.getByRole("img", { name: /^Context per turn: \d+% … \d+%/ })).toBeVisible();
});
