// Features borrowed from T3 Code, one test each: in the composer, the
// conversation, the sidebar, and the page title.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { newChat, openChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

test("↑ and ↓ walk this chat's prompts", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first recall");
  await sendAndWait(page, "second recall");
  await box(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(box(page)).toHaveValue("second recall");
  await page.keyboard.press("ArrowUp");
  await expect(box(page)).toHaveValue("first recall");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(box(page)).toHaveValue("");
});

test("Shift+Enter continues a list, Tab indents it, and an empty item ends it", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await box(page).pressSequentially("1. one");
  await page.keyboard.press("Shift+Enter");
  await expect(box(page)).toHaveValue("1. one\n2. ");
  await page.keyboard.press("Tab");
  await expect(box(page)).toHaveValue("1. one\n  2. ");
  await page.keyboard.press("Shift+Enter");
  await expect(box(page)).toHaveValue("1. one\n");
});

test("the stash parks a draft and gives it back in another chat", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await box(page).fill("park this for later");
  await page.keyboard.press("Alt+KeyS");
  await expect(box(page)).toHaveValue("");
  const stash = page.getByRole("button", { name: /^Stash \(\d+ kept\)$/ });
  await expect(stash).toBeVisible();
  // With nothing to stash, the menu still closes on Escape.
  await stash.click();
  await expect(page.getByRole("menu", { name: "Stash" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Stash" })).toBeHidden();
  await openChat(page);
  await page.getByRole("button", { name: /^Stash/ }).click();
  await page.getByRole("menuitem", { name: /park this for later/ }).click();
  await expect(box(page)).toHaveValue("park this for later");
});

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

test("a proposed plan shows as a card whose Implement sends it on", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "planned work please");
  const card = page.getByTestId("plan-card");
  await expect(card).toContainText("Split the handler");
  await card.getByRole("button", { name: "Show the whole plan" }).click();
  await expect(card).toContainText("Tell the user");
  await card.getByRole("button", { name: "Implement" }).click();
  await expect(page.getByTestId("user-prompt").last()).toHaveText("Implement the plan.");
});

test("a run stopped on a usage limit says when it resets and can continue", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ratelimit me");
  const banner = page.getByTestId("limit-recovery");
  await expect(banner).toContainText("Usage limit reached");
  await expect(banner).toContainText("resets");
  await banner.getByRole("button", { name: "Continue when it resets" }).click();
  // The appointment is the server's: it survives a reload, with no local state.
  await expect(banner).toContainText("no tab has to stay open");
  await page.reload();
  const again = page.getByTestId("limit-recovery");
  await expect(again).toContainText("no tab has to stay open");
  await again.getByRole("button", { name: "Cancel" }).click();
  await expect(again).toContainText("resets");
  await again.getByRole("button", { name: "Continue now" }).click();
  await expect(page.getByTestId("user-prompt").last()).toHaveText("Continue from where you stopped.");
  await expect(banner).toBeHidden();
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

test("search in project finds a line and puts it into the message as @path:line", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const root = await page.locator(".chat-path").getAttribute("title");
  expect(root).toBeTruthy();
  writeFileSync(path.join(root as string, "search-me.txt"), "nothing\nthe zebra-quartz line\n");
  await page.keyboard.press("Control+Shift+KeyF");
  const dialog = page.getByRole("dialog", { name: "Search in project" });
  await dialog.getByRole("searchbox", { name: "Search the project's files" }).fill("zebra-quartz");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toContainText("the zebra-quartz line");
  await dialog.getByRole("searchbox").press("Enter");
  await expect(dialog).toBeHidden();
  await expect(box(page)).toHaveValue("@search-me.txt:2");
  // One Escape closes it, even with a query typed.
  await page.keyboard.press("Control+Shift+KeyF");
  await dialog.getByRole("searchbox").fill("zebra");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("resting on a session row shows its hover card", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hover card prompt");
  await newChat(page);
  await showSidebar(page);
  await page.locator(".session", { hasText: "hover card prompt" }).first().hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("hover card prompt");
  await expect(card).toContainText("1 turn");
  await page.mouse.move(800, 400);
  await expect(card).toBeHidden();
});

test("a prompt link fills the start screen's box, hidden characters taken out", async ({ page }) => {
  await signInAndOpen(page);
  await page.goto(`/?prompt=${encodeURIComponent("look at the logs​ please")}`);
  await expect(page.getByRole("heading", { name: /^What should .* do in / })).toBeVisible();
  await expect(box(page)).toHaveValue("look at the logs please");
  await expect(page.getByText("From a link: read it before you send it. 1 hidden character was taken out.")).toBeVisible();
  await expect(page).not.toHaveURL(/prompt=/);
  // Nothing spawns until the user sends.
  await expect(page.getByTestId("user-prompt")).toHaveCount(0);
  await box(page).press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["look at the logs please"]);
});

test("the page title and favicon count a chat that finished out of sight", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow please for the title");
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page).toHaveTitle(/^\(1\) /, { timeout: 20_000 });
  await expect.poll(() => page.locator('link[rel="icon"]').first().getAttribute("href")).toMatch(/^data:image\/png/);
  await page.getByRole("tablist", { name: "Open chats" }).getByRole("tab", { name: /slow please for the title/ }).click();
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
});
