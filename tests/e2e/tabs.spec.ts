// Session tabs: several chats open at once, one shown; runs carry on in the
// tabs that are not.
import { expect, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const prompts = (page: Page) => page.getByTestId("user-prompt");
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open chats" }).getByRole("tab");
const tab = (page: Page, title: string) => page.getByRole("tablist", { name: "Open chats" }).getByRole("tab", { name: new RegExp(title) });
/** + on the strip: the start screen. The tab comes at the first send. */
async function newTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page.getByRole("heading", { name: /^What should .*(do in|work on)/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
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
  // Sending from the start screen adds the new chat's tab; nothing was active to take over.
  await expect(tabs(page)).toHaveCount(2);

  // Close session one's tab so Ctrl+click has one to make; it opens beside the shown one.
  await tab(page, "session one").hover();
  await tab(page, "session one").getByRole("button", { name: /^Close / }).click();
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

test("a row's menu opens its session in a new tab, next to the shown one", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "menu tab one");
  // Closed so the row's "Open in new tab" has a tab to make (the chat keeps running).
  await tab(page, "menu tab one").hover();
  await tab(page, "menu tab one").getByRole("button", { name: /^Close / }).click();
  await expect(tabs(page)).toHaveCount(0);
  await newChat(page);
  await sendAndWait(page, "menu tab two");
  await expect(tabs(page)).toHaveCount(1);

  await showSidebar(page);
  await page.getByRole("button", { name: "More for menu tab one" }).click();
  await page.getByRole("menuitem", { name: "Open in new tab" }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "menu tab one")).toHaveAttribute("aria-selected", "true");
  await expect(prompts(page)).toHaveText(["menu tab one"]);
  await expect(tab(page, "menu tab two")).toHaveAttribute("aria-selected", "false");
});

test("a row's menu opens where it was asked for, as wide as its items, inside the window", async ({ page }) => {
  // The menu pops in scaled; measure it where it settles.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "menu placed");
  await showSidebar(page);
  const row = session(page, "menu placed");
  const menu = page.getByRole("menu");
  const rowBox = (await row.boundingBox())!;

  await row.click({ button: "right", position: { x: 20, y: 10 } });
  let box = (await menu.boundingBox())!;
  expect(box.x).toBeCloseTo(rowBox.x + 20, 0);
  expect(box.y).toBeGreaterThan(rowBox.y + 10);
  expect(box.width).toBeLessThan(300);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Too near the window's bottom to open downwards: the menu opens above its ⋯ button.
  await page.setViewportSize({ width: 1280, height: Math.ceil(rowBox.y + rowBox.height) + 200 });
  const more = page.getByRole("button", { name: "More for menu placed" });
  await more.click();
  const moreBox = (await more.boundingBox())!;
  box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(moreBox.y);
  expect(box.x + box.width).toBeCloseTo(moreBox.x + moreBox.width, 0);
  expect(box.width).toBeLessThan(300);
});

test("Copy resume command puts the line that resumes a session in a terminal on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAndOpen(page);
  await newChat(page);
  // No chat exists until a send, so its actions menu appears only after one.
  await sendAndWait(page, "resume me in a terminal");
  const menu = page.getByRole("button", { name: "Chat actions" });
  const item = page.getByRole("menuitem", { name: "Copy resume command" });
  await menu.click();
  await item.click();
  const line = /^cd \S+alpha && fake --resume \S+$/;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(line);
  // The chat is open here, a second writer if left open: the banner says so and can close it.
  const banner = page.getByRole("status").filter({ hasText: "Copied: cd " });
  await expect(banner).toContainText("close the chat here first");
  await banner.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByRole("tablist", { name: "Open chats" }).getByRole("tab", { name: /resume me in a terminal/ })).toHaveCount(0);
  // Its row copies the same line, without the warning now that nothing here has it open.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await showSidebar(page);
  await session(page, "resume me in a terminal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy resume command" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(line);
  await expect(page.getByRole("status").filter({ hasText: "Copied: cd " })).not.toContainText("close the chat");
});

test("a session opens at once: its tab, title, and a loading screen show while it loads", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "slow to load");
  // Its tab closes, so the sidebar's click opens it again (the chat still runs on the server).
  await tab(page, "slow to load").hover();
  await tab(page, "slow to load").getByRole("button", { name: /^Close / }).click();
  await newChat(page);
  await sendAndWait(page, "shown meanwhile");
  // Hold the chat's snapshot back, as a slow link would.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/chats\/[\w-]+$/, async (route) => {
    if (route.request().method() === "GET") await held;
    await route.continue();
  });
  await showSidebar(page);
  await session(page, "slow to load").click();
  const splash = page.getByRole("status", { name: "Opening slow to load" });
  await expect(splash).toBeVisible();
  await expect(page.locator(".chat-header h1")).toHaveText("slow to load");
  await expect(tab(page, "slow to load")).toHaveAttribute("aria-selected", "true");
  release();
  await expect(prompts(page)).toHaveText(["slow to load"]);
  await expect(splash).toHaveCount(0);
  await page.unroute(/\/api\/chats\/[\w-]+$/);
});

test("a long chat draws its end first, then the rest above it", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  for (let i = 1; i <= 9; i++) await sendAndWait(page, `long chat turn ${i}`);
  await newTab(page);
  await page.reload();
  await tab(page, "long chat turn 1").click();
  await expect(prompts(page)).toHaveCount(9);
  await expect(prompts(page).last()).toHaveText("long chat turn 9");
  await expect(prompts(page).last()).toBeInViewport();
});
