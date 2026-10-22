// The start screen: the main pane with no chat — one question, a box, and the
// agent and folder chips. Nothing spawns until a send.
import { expect, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const box = "Message";
const folderChip = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^Folder: / });
const tabs = (page: import("@playwright/test").Page) => page.getByRole("tablist", { name: "Open chats" }).getByRole("tab");

test("a fresh browser lands on the start screen: a box, and a folder chip asking for one", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /What should Fake work on\?/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: box })).toBeVisible();
  const chip = folderChip(page);
  await expect(chip).toHaveText(/Choose a folder/);
  await expect(chip).toHaveClass(/is-needed/);
  // No folder is needed to show the start screen, so New chat works at once.
  await showSidebar(page);
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  // The agent chip lists every harness this server knows.
  await page.getByRole("button", { name: "Agent for this chat" }).click();
  const menu = page.getByRole("listbox", { name: "Agent" });
  await expect(menu.getByRole("option", { name: "Fake", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(menu.getByRole("option", { name: "Fake B" })).toBeVisible();
});

test("sending with no folder asks for one, keeps the draft, and the next Enter starts the chat", async ({ page }) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: box });
  await input.fill("fix the flaky test");
  await input.press("Enter");
  // The folder picker opens; the draft survives the detour.
  const dialog = page.getByRole("dialog", { name: "Choose a project folder" });
  await expect(dialog).toBeVisible();
  await dialog.locator(".picker-scroll .picker-item").first().click();
  await dialog.getByRole("button", { name: "alpha", exact: false }).click();
  await dialog.getByRole("button", { name: "Open this folder" }).click();
  await expect(dialog).toBeHidden();
  await expect(input).toHaveValue("fix the flaky test");
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  // No chat was created by the detour.
  await expect(page.getByTestId("user-prompt")).toHaveCount(0);
  await input.press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["fix the flaky test"]);
  await expect(page.getByTestId("answer").last()).toContainText("Echo: fix the flaky test");
});

test("typing and Enter create exactly one chat, with its prompt and answer", async ({ page }) => {
  await signInAndOpen(page);
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  const input = page.getByRole("textbox", { name: box });
  await input.fill("hello from the start");
  await input.press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["hello from the start"]);
  await expect(page.getByTestId("answer").last()).toContainText("Echo: hello from the start");
  // One tab, one session, and the start screen is gone.
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByRole("heading", { name: /What should/ })).toHaveCount(0);
  await showSidebar(page);
  await expect(page.locator(".session", { hasText: "hello from the start" })).toBeVisible();
});

test("a double Enter (or double click) makes exactly one chat", async ({ page }) => {
  await signInAndOpen(page);
  const input = page.getByRole("textbox", { name: box });
  await input.fill("only once");
  await input.press("Enter");
  await input.press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["only once"]);
  await expect(tabs(page)).toHaveCount(1);
  await showSidebar(page);
  await expect(page.locator(".session", { hasText: "only once" })).toHaveCount(1);
});

test("the agent chip and the sidebar's harness row pick the same thing", async ({ page }) => {
  await signInAndOpen(page, "beta");
  const chip = page.getByRole("button", { name: "Agent for this chat" });
  const row = page.getByRole("complementary", { name: "Sessions" }).getByRole("button", { name: "Harness" });
  await showSidebar(page);
  // The chip switches the harness; the sidebar's row follows.
  await chip.click();
  await page.getByRole("listbox", { name: "Agent" }).getByRole("option", { name: "Fake B" }).click();
  await expect(row).toContainText("Fake B");
  await expect(page.getByRole("heading", { name: /What should Fake B do in beta\?/ })).toBeVisible();
  // And the other way round.
  await row.click();
  await page.getByRole("listbox", { name: "Harness" }).getByRole("option", { name: "Fake", exact: true }).click();
  await expect(chip).toContainText("Fake");
  await expect(page.getByRole("heading", { name: /What should Fake do in beta\?/ })).toBeVisible();
});

test("the folder chip switches between recent folders without the dialog", async ({ page }) => {
  await signInAndOpen(page);
  await signInAndOpen(page, "beta");
  const chip = folderChip(page);
  await expect(chip).toContainText("beta");
  await chip.click();
  const menu = page.getByRole("menu", { name: "Folder" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /alpha/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /alpha/ }).click();
  await expect(menu).toBeHidden();
  await expect(chip).toContainText("alpha");
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  // The browser still opens from the chip's last entry.
  await chip.click();
  await menu.getByRole("menuitem", { name: "Choose another folder…" }).click();
  await expect(page.getByRole("dialog", { name: "Choose a project folder" })).toBeVisible();
});

test("a share's text and image wait in the start screen's box and go with the first message", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.controller !== null || new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", () => r(true))));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
  const status = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("text", "look at this screenshot");
    form.append("images", new File([bytes], "shot.png", { type: "image/png" }));
    const res = await fetch("/share", { method: "POST", body: form, redirect: "manual" });
    return res.type === "opaqueredirect" ? 303 : res.status;
  }, png);
  expect(status).toBe(303);
  await page.goto("/?share=1");
  await expect(page.getByRole("textbox", { name: box })).toHaveValue("look at this screenshot");
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("listitem")).toHaveCount(1);
  // Nothing exists until the send; then the image goes with the message.
  await expect(page.getByTestId("user-prompt")).toHaveCount(0);
  await send(page, "describe it");
  await expect(page.getByTestId("user-prompt")).toHaveText(["describe it"]);
});

test("the start screen fits a phone: chips wrap, and sending works at 360 px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  const hero = page.locator(".start-screen");
  await expect(hero).toBeVisible();
  // Nothing scrolls sideways.
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
  // The chips row wraps inside the card instead of overflowing it.
  const row = page.locator(".start-screen .composer-bar");
  const card = page.locator(".start-screen .composer-card");
  expect((await row.boundingBox())!.width).toBeLessThanOrEqual((await card.boundingBox())!.width);
  await page.getByRole("textbox", { name: box }).fill("hello from a phone");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("user-prompt")).toHaveText(["hello from a phone"]);
  await expect(page.getByTestId("answer").last()).toContainText("Echo: hello from a phone");
});
