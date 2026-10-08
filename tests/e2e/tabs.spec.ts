// Session tabs: several chats open at once, one shown; runs carry on in the
// tabs that are not.
import { expect, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const prompts = (page: Page) => page.getByTestId("user-prompt");
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open chats" }).getByRole("tab");
const tab = (page: Page, title: string) => page.getByRole("tablist", { name: "Open chats" }).getByRole("tab", { name: new RegExp(title) });
/** + on the strip, then wait for the new chat's hero composer. */
async function newTab(page: Page): Promise<void> {
  const before = await tabs(page).count();
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(tabs(page)).toHaveCount(before + 1);
  await expect(page.getByRole("heading", { name: /^What should .* do in / })).toBeVisible();
  await expect(page.getByTestId("connection")).toHaveText("Connected");
}
const session = (page: Page, title: string) => page.getByRole("complementary", { name: "Sessions" }).locator(".session", { hasText: title }).first();

test("+ opens another chat in its own tab; tabs switch and close", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first tab prompt");
  await expect(tabs(page)).toHaveCount(1);
  await newTab(page);
  await sendAndWait(page, "second tab prompt");
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "second tab prompt")).toHaveAttribute("aria-selected", "true");

  await tab(page, "first tab prompt").click();
  await expect(prompts(page)).toHaveText(["first tab prompt"]);
  await tab(page, "second tab prompt").click();
  await expect(prompts(page)).toHaveText(["second tab prompt"]);

  // Closing the shown tab shows its neighbour; the closed chat is still in the sidebar.
  await tab(page, "second tab prompt").getByRole("button", { name: /^Close / }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(prompts(page)).toHaveText(["first tab prompt"]);
  await showSidebar(page);
  await expect(session(page, "second tab prompt")).toBeVisible();
});

test("a sidebar click shows a session in the current tab, Ctrl-click in a new one, an open one is switched to", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "session one");
  await newChat(page);
  await sendAndWait(page, "session two");
  // "New chat" from the sidebar took over the shown tab.
  await expect(tabs(page)).toHaveCount(1);

  await showSidebar(page);
  await session(page, "session one").click({ modifiers: ["Control"] });
  await expect(prompts(page)).toHaveText(["session one"]);
  await expect(tabs(page)).toHaveCount(2);

  // Already open in a tab: switched to, not opened twice.
  await showSidebar(page);
  await session(page, "session two").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "session two")).toHaveAttribute("aria-selected", "true");
  await expect(prompts(page)).toHaveText(["session two"]);
});

test("a run keeps going in a background tab, which says when it is done", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow please");
  await newTab(page);
  await sendAndWait(page, "meanwhile here");
  const background = tab(page, "slow please");
  await expect(background.getByRole("img", { name: "Working" })).toBeVisible();
  await expect(background.getByRole("img", { name: "Finished while away" })).toBeVisible({ timeout: 20_000 });
  await background.click();
  await expect(page.getByTestId("answer").last()).toContainText("Echo: slow please");
  await expect(background.getByRole("img", { name: "Finished while away" })).toHaveCount(0);
});

test("tabs come back after a reload, and the keyboard moves between them", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "kept one");
  await newTab(page);
  await sendAndWait(page, "kept two");
  await page.reload();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "kept two")).toHaveAttribute("aria-selected", "true");
  await expect(prompts(page)).toHaveText(["kept two"]);

  await tab(page, "kept two").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "kept one")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(prompts(page)).toHaveText(["kept one"]);
  await page.keyboard.press("Delete");
  await expect(tabs(page)).toHaveCount(1);
  await expect(prompts(page)).toHaveText(["kept two"]);
});

test("Ctrl+[ and Ctrl+] step through the chats shown, Alt+Shift+T reopens a closed tab, Ctrl+Alt+Enter sends and starts a new chat", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "alpha chat");
  await newTab(page);
  await sendAndWait(page, "beta chat");

  await page.keyboard.press("Control+BracketLeft");
  await expect(prompts(page)).toHaveText(["alpha chat"]);
  await page.keyboard.press("Control+BracketRight");
  await expect(prompts(page)).toHaveText(["beta chat"]);

  await tab(page, "beta chat").getByRole("button", { name: /^Close / }).click();
  await expect(tabs(page)).toHaveCount(1);
  await page.keyboard.press("Alt+Shift+KeyT");
  await expect(tabs(page)).toHaveCount(2);
  await expect(prompts(page)).toHaveText(["beta chat"]);

  await page.getByRole("textbox", { name: "Message" }).fill("send then new");
  await page.keyboard.press("Control+Alt+Enter");
  await expect(tabs(page)).toHaveCount(3);
  await expect(page.getByRole("heading", { name: /^What should .* do in / })).toBeVisible();
  await tab(page, "beta chat").click();
  await expect(prompts(page)).toHaveText(["beta chat", "send then new"]);
});

test("the sidebar lifts what needs you and what is working, and settling can be undone", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "settle me later");
  await newTab(page);
  await send(page, "please ask first");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await tab(page, "settle me later").click();
  await showSidebar(page);
  const needs = page.getByTestId("needs-group");
  await expect(needs).toContainText("please ask first", { timeout: 10_000 });
  await expect(needs).toContainText("needs you");

  await tab(page, "please ask first").click();
  await page.getByTestId("approval-card").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await send(page, "slow stream in the background");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await tab(page, "settle me later").click();
  const working = page.getByTestId("working-group");
  await expect(working).toBeVisible({ timeout: 10_000 });
  await expect(working.getByRole("button", { name: /Working/ })).toHaveAttribute("aria-expanded", "false");
  await working.getByRole("button", { name: /Working/ }).click();
  await expect(working).toContainText("please ask first");
  await expect(working).toHaveCount(0, { timeout: 20_000 });

  const row = page.locator(".session-item", { hasText: "settle me later" }).first();
  await row.locator(".session").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle" }).click();
  await expect(page.getByTestId("toast")).toContainText("Settled “settle me later”");
  await expect(page.locator(".session-item", { hasText: "settle me later" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1 settled" })).toBeVisible();
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyZ");
  await expect(page.locator(".session-item", { hasText: "settle me later" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "1 settled" })).toHaveCount(0);
});
