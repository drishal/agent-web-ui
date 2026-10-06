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
